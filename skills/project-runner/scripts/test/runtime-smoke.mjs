#!/usr/bin/env node
// 多语言受管生命周期冒烟：隔离 --home + 真实 node/python 进程，验证 start-new → status/logs → stop，
// 以及包装脚本、WindowsApps stub、非法 mode 的拒绝路径。不触碰真实注册表与业务进程。
// 用法：node scripts/test/runtime-smoke.mjs   （无外部依赖，Node 22+；缺 pwsh 7 或 python 时跳过对应检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isWindows, findExecutable, killTree, listDescendants, findProcesses } from './platform.mjs';
import { computeAppId } from '../lib/desc.mjs';
import { psProc, listListeningPorts } from '../lib/probe.mjs';
import { persistableDiscovery } from '../lib/launch.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runtime-smoke-'));
const home = path.join(base, 'home');
const projNode = path.join(base, 'node-app');
const projPy = path.join(base, 'py-app');
const projUm = path.join(base, 'um-app');
const projCmd = path.join(base, 'cmd-app');
const projAmb = path.join(base, 'amb-app');
const projNpm = path.join(base, 'npm-app');
const CMD_SENTINEL = 'PR_SMOKE_SENTINEL_DB_PASSWORD_e7c1f4a9';
const projRestart = path.join(base, 'restart-app');
const projCmdRestart = path.join(base, 'cmd-restart-app');
for (const d of [projNode, projPy, projUm, projCmd, projAmb, projNpm, projRestart, projCmdRestart]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(projNode, 'srv.js'),
  'console.log("node-ready PORT=" + (process.env.PORT ?? "<unset>"));\nsetInterval(() => {}, 1000);\n', 'utf8');
// #50 回归：detached 链路下多行 stdout 是否完整（内建/复合命令同样经过 pipe）
fs.writeFileSync(path.join(projNode, 'multi.js'),
  "console.log('multi-line-1');\nconsole.log('multi-line-2');\nconsole.log('multi-line-3');\nsetInterval(() => {}, 1000);\n", 'utf8');
fs.writeFileSync(path.join(projCmd, 'srv.js'),
  'console.log("cmd-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
// #102：wrapper 等待真实目标后以普通 0 退出，用于验证 wrapper 退出不冒充目标退出。
fs.writeFileSync(path.join(projCmd, 'detach-wrapper.bat'), '@echo off\r\nnode srv.js\r\nexit /b 0\r\n', 'utf8');
fs.writeFileSync(path.join(projCmd, 'detach-wrapper.sh'), '#!/bin/sh\nnode srv.js\nexit 0\n', 'utf8');
try { fs.chmodSync(path.join(projCmd, 'detach-wrapper.sh'), 0o755); } catch { /* Windows 无执行位 */ }
fs.writeFileSync(path.join(projAmb, 'srv.js'),
  'console.log("amb-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
// 自身再 spawn 一个 node 子进程 → wrapper 后代中稳定出现 2 个 node.exe，用于歧义拒绝
fs.writeFileSync(path.join(projAmb, 'two.js'),
  'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"ignore"});\nsetInterval(() => {}, 1000);\n', 'utf8');
// #39 --tree 验收：命令模式目标 node 在发现 settle 之后 spawn 第二个 node 后代。
// 默认 stop 应留后代存活；stop --tree 应两代都退出。延迟 spawn 避免被 discover 当成候选：
// Windows 走 pwsh 采样，发现可能耗时数秒，10s 给慢机留足余量（4s 曾在 CI 上撞出 DISCOVERY_AMBIGUOUS）。
fs.writeFileSync(path.join(projCmd, 'tree-parent.js'),
  'const{spawn}=require("node:child_process");\n'
  + 'console.log("tree-parent-ready");\n'
  + 'setTimeout(()=>{const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});c.unref();console.log("tree-child="+c.pid);},10000);\n'
  + 'setInterval(()=>{},1000);\n', 'utf8');
fs.writeFileSync(path.join(projPy, 'srv.py'),
  'import time\nprint("py-ready", flush=True)\nwhile True:\n    time.sleep(1)\n', 'utf8');
// npm run dev 回归：npm 自身也是 node，与真实目标同映像且构成单链 wrapper→npm→srv；
// 叶子折叠后应托管 srv 而不是歧义拒绝。
fs.writeFileSync(path.join(projNpm, 'package.json'), JSON.stringify({ name: 'pr-npm-smoke', scripts: { dev: 'node srv.js' } }), 'utf8');
fs.writeFileSync(path.join(projNpm, 'srv.js'),
  'console.log("npm-srv-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
// 端口诊断回归：受管 node 监听固定端口，port 命令应给出同一 pid 与完整身份
fs.writeFileSync(path.join(projNpm, 'lsn.js'),
  'require("node:http").createServer((q, s) => s.end("ok")).listen(process.env.PORT || 18123, "127.0.0.1", () => console.log("lsn-ready"));\n', 'utf8');
// 端口漂移模拟（#107）：primary 被外部占用时顺延到 fallback，与 Vite 自动换端口同形态。
fs.writeFileSync(path.join(projNpm, 'fallback.js'),
  'const http = require("node:http");\n'
  + 'const primary = Number(process.env.PORT), fallback = Number(process.env.FALLBACK_PORT);\n'
  + 'const ok = (q, s) => s.end("ok");\n'
  + 'const fallbackServer = http.createServer(ok);\n'
  + 'const primaryServer = http.createServer(ok);\n'
  + 'primaryServer.once("error", (e) => {\n'
  + '  if (e.code !== "EADDRINUSE") { console.error(e); process.exit(1); }\n'
  + '  fallbackServer.listen(fallback, "127.0.0.1", () => console.log("fallback-ready PORT=" + fallback));\n'
  + '});\n'
  + 'primaryServer.listen(primary, "127.0.0.1", () => console.log("primary-ready PORT=" + primary));\n', 'utf8');

// restartPolicy 回归：直连/命令模式各自定时异常退出；stable 由人为 stop 终止；clean 正常退出。
const crashBody = (tag) => `console.log("${tag}-start pid=" + process.pid);\n`
  + `setTimeout(() => { console.log("${tag}-exit pid=" + process.pid); process.exit(7); }, 1200);\n`;
fs.writeFileSync(path.join(projRestart, 'crash.js'), crashBody('crash'), 'utf8');
fs.writeFileSync(path.join(projRestart, 'stable.js'),
  'console.log("stable-start pid=" + process.pid);\nsetInterval(() => {}, 1000);\n', 'utf8');
fs.writeFileSync(path.join(projRestart, 'clean.js'),
  'console.log("clean-start pid=" + process.pid);\nsetTimeout(() => { console.log("clean-exit"); process.exit(0); }, 1200);\n', 'utf8');
fs.writeFileSync(path.join(projCmdRestart, 'cmd-crash.js'),
  'console.log("cmd-crash-start pid=" + process.pid);\n'
  // 15s 后才崩溃：Windows 发现 + exit-watcher 就绪可能耗数秒，6s 会让目标在 watcher
  // 就绪前退出（EXIT_WATCH_UNAVAILABLE），这不是产品缺陷而是夹具时机过紧。
  + 'setTimeout(() => { console.log("cmd-crash-exit pid=" + process.pid); process.exit(7); }, 15000);\n', 'utf8');


const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const cli = (...args) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* 保留原始输出 */ }
  return { code: r.status, json, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const descFile = (d) => {
  const f = path.join(base, `desc-${d.alias}.json`);
  fs.writeFileSync(f, JSON.stringify(d), 'utf8');
  return f;
};
const logHas = async (file, needle) => {
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(needle)) return true;
    await wait(500);
  }
  return false;
};
const waitChildPid = async (file) => {
  for (let i = 0; i < 40; i++) {
    try {
      const m = /tree-child=(\d+)/.exec(fs.readFileSync(file, 'utf8'));
      if (m) return Number(m[1]);
    } catch { /* 日志尚未落盘 */ }
    await wait(500);
  }
  return null;
};
const waitStatus = async (ref, predicate, attempts = 100) => {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = cli('status', ref);
    if (r.code === 0) {
      last = r.json.data;
      if (predicate(last)) return last;
    }
    await wait(250);
  }
  return last;
};

let failed = 0;
let skipped = false;
let strayWrapperPids = []; // 歧义/超时场景残留的命令模式 wrapper，兜底清理
const strayPids = [];      // 当时仍在的后代进程（wrapper 可能先死，按 PID 定位更可靠）
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e.code === 'PR_SKIP') { skipped = true; console.log(`  skip ${name}: ${e.message}`); return; }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const skip = (why) => { const e = new Error(why); e.code = 'PR_SKIP'; throw e; };
// pwsh 缺失时 start-new 会在锁内失败（exit 4/PWSH_MISSING），统一判定；Linux 不应出现。
const pwshMissing = (r) => isWindows && (r.code === 4 || (r.json?.error?.code === 'PWSH_MISSING'));

// ---- 预检：python 是否可用（Windows 可能有 WindowsApps stub；Linux 回退 python3） ----
const NODE_IMAGE = isWindows ? 'node.exe' : 'node';
const isWinAppsAlias = (p) => {
  if (!isWindows || !/\\Microsoft\\WindowsApps\\/i.test(p)) return false;
  try { const s = fs.lstatSync(p); return s.size === 0 || s.isSymbolicLink(); } catch { return false; }
};
const pyCandidates = isWindows
  ? (() => {
    const r = spawnSync('where', ['python'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return r.status === 0 ? r.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  })()
  : [];
const pyReal = isWindows
  ? pyCandidates.find((p) => !isWinAppsAlias(p))
  : (findExecutable('python') ?? findExecutable('python3'));
const winAppsStub = isWindows ? pyCandidates.find(isWinAppsAlias) : null;

try {
  await check('appId 遵循平台路径大小写语义', () => {
    const upper = computeAppId('/tmp/Project', 'Main');
    const lower = computeAppId('/tmp/project', 'main');
    assert.equal(upper === lower, isWindows);
  });
  await check('discovery 候选持久化投影：丢弃原始 cmd，仅保留身份与长度/摘要', () => {
    const raw = {
      result: 'error', code: 'cimFailed',
      candidates: [{ pid: 1, image: '/usr/bin/node', comm: 'node', creationFileTime: 'boot:1', cmd: `node --db-password=${CMD_SENTINEL}` }],
    };
    const projected = persistableDiscovery(raw);
    assert.equal(projected.code, 'cimFailed');
    assert.equal(projected.candidates[0].pid, 1);
    assert.equal(projected.candidates[0].image, '/usr/bin/node');
    assert.equal(projected.candidates[0].comm, 'node');
    assert.equal(projected.candidates[0].cmd, undefined, '投影仍保留原始 cmd');
    assert.equal(projected.candidates[0].cmdLength, raw.candidates[0].cmd.length);
    assert.match(projected.candidates[0].cmdHash, /^[0-9a-f]{16}$/);
    assert(!JSON.stringify(projected).includes(CMD_SENTINEL), '投影仍包含哨兵原文');
  });
  if (process.platform === 'linux') {
    await check('Linux pidfd 终止在身份不匹配时拒绝发送信号', () => {
      const r = psProc('terminate', { id: process.pid, creationFileTime: 'wrong-boot:0', image: '/wrong/image' });
      assert.equal(r.result, 'mismatch');
    });
    await check('Linux freeze helper 处理非 ASCII comm 且不遗留停止进程', async () => {
      if (!pyReal) skip('PATH 中无真实 python');
      // /proc/<pid>/stat 的 comm 可含非 UTF-8/ASCII 字节；helper 必须以可容错解码读取，
      // 且冻结后任何失败路径都不能把进程留在 SIGSTOP 状态。
      const code = "import ctypes,time; ctypes.CDLL(None).prctl(15, bytes([255,254,253]), 0, 0, 0); time.sleep(30)";
      const child = spawn(pyReal, ['-c', code], { stdio: 'ignore' });
      try {
        let id = null;
        for (let i = 0; i < 50; i++) {
          id = psProc('capture', { id: child.pid });
          if (id.result === 'ok') break;
          await wait(100);
        }
        assert.equal(id?.result, 'ok', `子进程未就绪：${JSON.stringify(id)}`);
        const r = psProc('terminate', { id: child.pid, creationFileTime: id.creationFileTime, image: id.image, freeze: true });
        assert.equal(r.result, 'terminated', `freeze 终止失败：${JSON.stringify(r)}`);
        const after = psProc('capture', { id: child.pid });
        assert(after.result === 'notfound' || after.result === 'exited', `进程仍存活：${JSON.stringify(after)}`);
      } finally {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    });
  }

  // ---------- node 受管生命周期 ----------
  let nodeRunId = null;
  await check('node start-new 持久化 env，desc 值覆盖当前进程环境', () => {
    const previousPort = process.env.PORT;
    process.env.PORT = '9999';
    let r;
    try {
      r = cli('start-new', '--desc', descFile({
        alias: 'nodeapp', root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], env: { PORT: '3001' }, expectedPort: null,
      }));
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.mode, 'node');
    nodeRunId = r.json.data.runId;
  });
  if (nodeRunId) {
    await check('node 日志出现就绪标记与 desc 环境值', async () => {
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${cli('status', 'nodeapp').json.data.appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'node-ready PORT=3001'), 'stdout 未见 PORT=3001');
      const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
      assert.equal(Object.values(reg.apps)[0].env.PORT, '3001');
    });
    await check('node status=RUNNING 且 logs 可读', () => {
      const s = cli('status', 'nodeapp');
      assert.equal(s.json.data.status, 'RUNNING');
      assert.equal(s.json.data.run.managed, true);
      const l = cli('logs', 'nodeapp', '--lines', '50');
      assert.equal(l.code, 0, l.text);
    });
    await check('node stop → STOPPED，进程确已退出', () => {
      const r = cli('stop', 'nodeapp');
      assert.equal(r.code, 0, r.text);
      assert.equal(cli('status', 'nodeapp').json.data.status, 'STOPPED');
    });
    await check('跨 node 进程 start 在 PORT 未设置时仍传递持久化值', async () => {
      const childEnv = { ...process.env };
      delete childEnv.PORT;
      const start = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', 'start', 'nodeapp'],
        { encoding: 'utf8', windowsHide: true, timeout: 60000, env: childEnv });
      assert.equal(start.status, 0, `${start.stdout}${start.stderr}`);
      assert.equal(cli('status', 'nodeapp').json.data.env.PORT, '3001');
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${cli('status', 'nodeapp').json.data.appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'node-ready PORT=3001'), '跨进程 start 未见 PORT=3001');
      assert.equal(cli('stop', 'nodeapp').code, 0);
    });
    await check('node restart 复用配置再启动 → 再停', () => {
      const r = cli('restart', 'nodeapp');
      assert.equal(r.code, 0, r.text);
      assert.equal(cli('status', 'nodeapp').json.data.status, 'RUNNING');
      assert.equal(cli('stop', 'nodeapp').code, 0);
    });
  }

  // ---------- python 受管生命周期 ----------
  await check('python start-new 受管启动（Windows 跳过 WindowsApps stub；Linux 用真实解释器）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    if (!pyReal) skip('PATH 中无真实 python');
    const r = cli('start-new', '--desc', descFile({
      alias: 'pyapp', root: projPy, mode: 'python', exe: isWindows ? 'python' : pyReal, args: ['srv.py'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.mode, 'python');
    const appId = r.json.data.appId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'py-ready'), 'stdout 未见 py-ready');
    assert.equal(cli('status', 'pyapp').json.data.status, 'RUNNING');
    assert.equal(cli('stop', 'pyapp').code, 0);
    assert.equal(cli('status', 'pyapp').json.data.status, 'STOPPED');
  });

  // ---------- 命令模式受管（cmd wrapper + 后代发现） ----------
  let cmdRunId = null;
  await check('command 模式 start-new：cmd wrapper → 后代发现 node → 受管', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdapp', root: projCmd, mode: 'node',
      command: 'node srv.js', expectedImage: NODE_IMAGE,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.kind, 'command');
    assert.ok(r.json.data.wrapperPid > 0, '缺少 wrapperPid 证据');
    cmdRunId = r.json.data.runId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'cmd-ready'), 'stdout 未见 cmd-ready');
    assert.equal(cli('status', 'cmdapp').json.data.status, 'RUNNING');
    assert.equal(cli('status', 'cmdapp').json.data.run.kind, 'command');
    assert.equal(cli('stop', 'cmdapp').code, 0);
    assert.equal(cli('status', 'cmdapp').json.data.status, 'STOPPED');
    // restart 复用 command 配置：重放命令+重新发现
    assert.equal(cli('restart', 'cmdapp').code, 0);
    assert.equal(cli('status', 'cmdapp').json.data.status, 'RUNNING');
    assert.equal(cli('stop', 'cmdapp').code, 0);
  });
  await check('command 模式歧义拒绝：多候选 DISCOVERY_AMBIGUOUS 不任选', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdamb', root: projAmb, entry: 'amb', mode: 'node',
      command: `node two.js --db-password=${CMD_SENTINEL}`, expectedImage: NODE_IMAGE, discoverTimeoutMs: 15000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    for (const c of (r.json.error?.detail?.candidates ?? [])) strayPids.push(c.pid);
    strayWrapperPids.push(r.json.error?.detail?.wrapperPid ?? r.json.data?.wrapperPid ?? 0);
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_AMBIGUOUS');
    const s = cli('status', 'cmdamb');
    assert.equal(s.json.data.status, 'UNKNOWN');
    // 安全回归：命令带哨兵参数，歧义证据的 CLI 输出、status 输出与 runtime JSON 均不得出现原文。
    const runtimeRaw = fs.readFileSync(path.join(home, 'runtime', `${s.json.data.appId}.json`), 'utf8');
    for (const [label, text] of [['CLI', r.text], ['status', s.text], ['runtime JSON', runtimeRaw]]) {
      assert(!text.includes(CMD_SENTINEL), `${label} 泄露候选命令行原文`);
    }
    const candidates = r.json.error.detail.candidates;
    assert(candidates.length >= 2, '歧义候选数不足，无法验证投影');
    for (const c of candidates) {
      assert.equal(c.cmd, undefined, 'CLI 候选仍携带原始 cmd');
      assert.equal(typeof c.cmdLength, 'number', '候选缺少 cmdLength 证据');
      assert.match(c.cmdHash, /^[0-9a-f]{16}$/, '候选缺少 cmdHash 证据');
    }
    const persisted = JSON.parse(runtimeRaw).current.lastError;
    assert(!/"cmd"\s*:/.test(persisted), `runtime lastError 仍含原始 cmd：${persisted}`);
  });
  await check('cleanup-wrapper 清理歧义残留 wrapper，UNKNOWN 证据保留', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('cleanup-wrapper', 'cmdamb');
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert(['terminated', 'exited', 'notfound', 'mismatch'].includes(r.json.data.result), r.text);
    const s = cli('status', 'cmdamb').json.data;
    assert.equal(s.status, 'UNKNOWN');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.appId}.json`), 'utf8'));
    assert.equal(rt.current.wrapperCleaned, true);
  });
  await check('cleanup-wrapper 拒绝清理已 exec 成目标候选的 wrapper（Linux 映像变化）', async () => {
    if (isWindows) skip('仅 Linux /bin/sh exec 语义');
    if (!nodeRunId && skipped) skip('前置受管启动已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdexec', root: projCmd, entry: 'exec', mode: 'node',
      // 先让 discover 超时落 UNKNOWN，再等 wrapper 自己 exec 成目标；若目标在超时前出现，
      // 该用例会错误地变成成功启动，无法覆盖恢复边界。
      command: 'sleep 8; exec node srv.js', expectedImage: NODE_IMAGE, discoverTimeoutMs: 3000,
    }));
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_TIMEOUT');
    const st = cli('status', 'cmdexec');
    assert.equal(st.code, 0, st.text);
    assert.equal(st.json.data.status, 'UNKNOWN');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${st.json.data.appId}.json`), 'utf8'));
    const wrapperPid = rt.current.wrapperPid;
    assert(Number.isInteger(wrapperPid) && wrapperPid > 0, '缺少 wrapperPid 证据');
    strayPids.push(wrapperPid);
    let before = psProc('capture', { id: wrapperPid });
    for (let i = 0; i < 80; i++) {
      before = psProc('capture', { id: wrapperPid });
      if (before.result === 'ok' && String(before.image) !== String(rt.current.wrapperImage)) break;
      await wait(250);
    }
    assert.equal(before.result, 'ok', `exec 后的目标未存活：${JSON.stringify(before)}`);
    assert.notEqual(String(before.image), String(rt.current.wrapperImage), 'wrapper 未发生 exec，场景不成立');
    const c = cli('cleanup-wrapper', 'cmdexec');
    assert.equal(c.code, 3, c.text);
    assert.equal(c.json.error.code, 'IDENTITY_UNKNOWN');
    const after = psProc('capture', { id: wrapperPid });
    assert.equal(after.result, 'ok', `cleanup-wrapper 误杀了已 exec 的目标进程：${JSON.stringify(after)}`);
    // 该 PID 已属目标候选，由人工核验后显式清理；测试里按采集身份自行收尾。
    const cleaned = psProc('terminate', { id: wrapperPid, creationFileTime: after.creationFileTime, image: after.image });
    assert(['terminated', 'exited', 'notfound', 'mismatch'].includes(cleaned.result), `目标清理失败：${JSON.stringify(cleaned)}`);
  });
  await check('command 模式发现超时：DISCOVERY_TIMEOUT 留证 UNKNOWN', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdtmo', root: projAmb, entry: 'tmo', mode: 'node',
      command: isWindows ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30', expectedImage: NODE_IMAGE, discoverTimeoutMs: 5000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    const tmoWrapper = r.json.error?.detail?.wrapperPid ?? 0;
    strayWrapperPids.push(tmoWrapper);
    // 超时场景没有 candidates：枚举 wrapper 当时仍在的后代作为兜底证据（#46）
    if (tmoWrapper) for (const pid of listDescendants(tmoWrapper)) strayPids.push(pid);
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_TIMEOUT');
  });
  await check('command 模式命令即死：wrapperExited → SPAWN_FAILED（可重试）', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdfail', root: projAmb, entry: 'fail', mode: 'node',
      command: 'node missing-module-for-runtime-smoke.js', expectedImage: NODE_IMAGE, discoverTimeoutMs: 5000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'SPAWN_FAILED');
    assert.match(r.json.error.detail.stderrTail, /Cannot find module/);
    assert.equal(cli('status', 'cmdfail').json.data.status, 'STOPPED');
  });
  await check('command 模式 wrapper 退出不冒充受管目标退出证据', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    // wrapper 等待真实目标后主动以普通 0 退出；目标被杀时 wrapper 仍返回 0，
    // log-writer 不得把这个 wrapper 结果写成 target.exit。
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmddetach', root: projCmd, entry: 'detach', mode: 'node',
      // 显式 .\ 相对路径：部分环境设置了 NoDefaultCurrentDirectoryInExePath=1
      // （本机与 GitHub Windows runner 均有），cmd 不再搜索当前目录，裸文件名会报
      // “不是内部或外部命令”，与产品行为无关。
      command: isWindows ? '.\\detach-wrapper.bat' : './detach-wrapper.sh', expectedImage: NODE_IMAGE, discoverTimeoutMs: 15000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    if (r.code !== 0) strayWrapperPids.push(r.json.error?.detail?.wrapperPid ?? 0);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    const rtFile = path.join(home, 'runtime', `${r.json.data.appId}.json`);
    process.kill(r.json.data.pid, 'SIGKILL');
    let wrapperExit = null;
    let targetExit = null;
    let watchError = null;
    for (let i = 0; i < 100; i++) {
      const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
      wrapperExit = rt.current.wrapperExit ?? null;
      targetExit = rt.current.exit ?? null;
      watchError = rt.current.exitWatchError ?? null;
      if (wrapperExit && (targetExit || watchError)) break;
      await wait(100);
    }
    assert.equal(wrapperExit?.code, 0, `wrapper 普通退出证据缺失：${JSON.stringify(wrapperExit)}`);
    if (process.platform !== 'linux') {
      // Windows 句柄在父进程回收后仍可读退出码，必须拿到真实证据。
      assert(targetExit, 'exit-watcher 未记录受管目标的真实退出');
      assert(!(targetExit.code === 0 && targetExit.signal == null), `目标被 SIGKILL 后仍记为 wrapper 的正常退出：${JSON.stringify(targetExit)}`);
    } else {
      // Linux 内核限制（已在 CI 实测）：非父进程 waitid(P_PIDFD) 一律 ECHILD，而 sh
      // wrapper 会同步回收目标，僵尸窗口为 0——真实退出状态原理上不可得。此时
      // watcher 必须明确落 unavailable 证据；能拿到时仍要求真实信号、不得冒充。
      assert(targetExit || watchError, 'exit-watcher 未记录退出证据也未标记不可用');
      if (targetExit) {
        assert(!(targetExit.code === 0 && targetExit.signal == null), `目标被 SIGKILL 后仍记为 wrapper 的正常退出：${JSON.stringify(targetExit)}`);
        assert.equal(targetExit.signal, 'SIGKILL');
      } else {
        assert.match(watchError.reason, /reaped before exit status/, `watcher 未给出明确的不可用原因：${JSON.stringify(watchError)}`);
      }
    }
    // stop 自己终止目标时，受管目标必须有独立于 wrapper 的退出证据。
    assert.equal(cli('stop', 'cmddetach').code, 0);
    const started = cli('start', 'cmddetach');
    assert.equal(started.code, 0, started.text);
    assert.equal(started.json.data.status, 'RUNNING');
    assert.equal(cli('stop', 'cmddetach').code, 0);
    const after = JSON.parse(fs.readFileSync(rtFile, 'utf8')).current;
    assert(after.exit, 'stop 应落受管目标退出证据');
    assert(!(after.exit.code === 0 && after.exit.signal == null), 'stop 后仍显示 wrapper 的正常退出');
    if (process.platform === 'linux') assert.equal(after.exit.signal, 'SIGKILL');
    const st = cli('status', 'cmddetach').json.data;
    assert(st.run.exit && !(st.run.exit.code === 0 && st.run.exit.signal == null), `status 未展示目标退出：${JSON.stringify(st.run.exit)}`);
  });
  await check('command 模式多行 stdout 经 detached 链路完整（#50 回归）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'mline', root: projNode, mode: 'node', command: 'node multi.js', expectedImage: NODE_IMAGE,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'multi-line-1'), 'stdout 缺失 multi-line-1');
    assert(await logHas(rt.current.logPaths.stdout, 'multi-line-3'), 'stdout 缺失 multi-line-3');
    assert.equal(cli('stop', 'mline').code, 0);
  });
  // 回归：npm 与目标同映像（node）且构成单链，叶子折叠后应托管真实目标而非 DISCOVERY_AMBIGUOUS
  await check('command 模式 npm run dev：同映像单链折叠到真实目标', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    if (!findExecutable('npm')) skip('PATH 无 npm');
    const r = cli('start-new', '--desc', descFile({
      alias: 'npmdev', root: projNpm, mode: 'node', command: 'npm run dev', expectedImage: NODE_IMAGE, discoverTimeoutMs: 30000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    // 失败也先留证：wrapper 与候选进程交给 finally 兑底清理，避免残留孤儿
    if (r.code !== 0) {
      strayWrapperPids.push(r.json.error?.detail?.wrapperPid ?? 0);
      for (const c of (r.json.error?.detail?.candidates ?? [])) strayPids.push(c.pid);
    }
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.kind, 'command');
    const appId = r.json.data.appId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'npm-srv-ready'), 'stdout 未见 npm-srv-ready');
    // 托管的必须是 srv.js 目标而非 npm-cli 本身：pid 有身份且映像为 node
    assert(rt.current.creationFileTime && rt.current.image, '目标身份证据缺失');
    assert.match(rt.current.image.replace(/\\/g, '/'), /node(\.exe)?$/, '托管目标映像不是 node');
    assert.notEqual(rt.current.pid, rt.current.wrapperPid, '托管了 wrapper 自身');
    const stopR = cli('stop', 'npmdev', '--tree'); // --tree 连带终止残留的 npm-cli 进程
    assert.equal(stopR.code, 0, stopR.text);
    assert.equal(cli('status', 'npmdev').json.data.status, 'STOPPED');
  });
  // ---------- restartPolicy：受管监督重启 ----------
  await check('restartPolicy 校验：非法值/限界错配/范围外拒绝（USAGE）', () => {
    const cases = [
      { alias: 'rpbad1', restartPolicy: 'always' },
      { alias: 'rpbad2', restartPolicy: 'never', maxRestarts: 1 },
      { alias: 'rpbad3', restartPolicy: 'on-failure', maxRestarts: -1 },
      { alias: 'rpbad4', restartPolicy: 'on-failure', backoffMs: 1.5 },
    ];
    for (const c of cases) {
      const r = cli('start-new', '--desc', descFile({
        root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], ...c,
      }));
      assert.equal(r.code, 1, `${c.alias}: ${r.text}`);
    }
  });
  await check('restartPolicy=on-failure：直连进程崩溃自动重启，达上限进入 DEAD', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'restartapp', root: projRestart, mode: 'node', exe: 'node', args: ['crash.js'],
      restartPolicy: 'on-failure', maxRestarts: 2, backoffMs: 100,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const firstPid = r.json.data.pid;
    const mid = await waitStatus('restartapp', (d) => (d.run?.restartCount ?? 0) >= 1 && d.run?.pid !== firstPid);
    assert(mid, '未观察到自动重启后的新 pid');
    assert.notEqual(mid.run.pid, firstPid, '自动重启后 pid 未变化');
    assert.equal(mid.run.restartPolicy, 'on-failure');
    assert.equal(mid.run.maxRestarts, 2);
    const dead = await waitStatus('restartapp', (d) => d.status === 'DEAD');
    assert(dead, '连续崩溃未进入 DEAD');
    assert.equal(dead.status, 'DEAD');
    assert.equal(dead.run.restartCount, 2, `restartCount 异常：${dead.run.restartCount}`);
    assert(dead.run.restartEvents?.some((e) => e.type === 'dead'), 'restartEvents 缺少 dead 事件');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${dead.appId}.json`), 'utf8'));
    assert.equal(rt.current.phase, 'DEAD');
    const list = cli('list');
    assert(list.json.data.apps.find((a) => a.alias === 'restartapp')?.status === 'DEAD', 'list 未显示 DEAD');
  });
  await check('restartPolicy=on-failure：人为 stop 不触发自动重启', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'restartstop', root: projRestart, mode: 'node', exe: 'node', args: ['stable.js'],
      restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 100,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const stopped = cli('stop', 'restartstop');
    assert.equal(stopped.code, 0, stopped.text);
    await wait(1200);
    const st = cli('status', 'restartstop');
    assert.equal(st.code, 0, st.text);
    assert.equal(st.json.data.status, 'STOPPED');
    assert.equal(st.json.data.run.restartCount, 0, '人为 stop 后不应发生自动重启');
  });
  await check('restartPolicy=on-failure：正常 code=0 退出不自动重启', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'restartclean', root: projRestart, mode: 'node', exe: 'node', args: ['clean.js'],
      restartPolicy: 'on-failure', maxRestarts: 3, backoffMs: 100,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const st = await waitStatus('restartclean', (d) => d.status === 'STOPPED' && /restartPolicy=on-failure/.test(d.run?.exitNote ?? ''));
    assert(st, '正常退出后未落 STOPPED');
    assert.equal(st.status, 'STOPPED');
    assert.equal(st.run.restartCount, 0, '正常退出不应触发自动重启');
    assert.match(st.run.exitNote ?? '', /restartPolicy=on-failure/, `exitNote 缺少策略说明：${st.run.exitNote}`);
  });
  await check('restartPolicy=on-failure：命令模式 wrapper 监督重启后代并进入 DEAD', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    try {
      const r = cli('start-new', '--desc', descFile({
        alias: 'cmdrestart', root: projCmdRestart, mode: 'node',
        command: 'node cmd-crash.js', expectedImage: NODE_IMAGE, discoverTimeoutMs: 15000,
        restartPolicy: 'on-failure', maxRestarts: 1, backoffMs: 100,
      }));
      if (pwshMissing(r)) skip('缺 pwsh 7');
      assert.equal(r.code, 0, r.text);
      const firstPid = r.json.data.pid;
      const firstWrapper = r.json.data.wrapperPid;
      const dead = await waitStatus('cmdrestart', (d) => d.status === 'DEAD', 240);
      assert(dead, '命令模式连续崩溃未进入 DEAD');
      assert.equal(dead.run.restartCount, 1, `restartCount 异常：${dead.run.restartCount}`);
      assert.notEqual(dead.run.pid, firstPid, '命令模式重启后目标 pid 未变化');
      assert.notEqual(dead.run.wrapperPid, firstWrapper, '命令模式重启后 wrapper pid 未变化');
      assert(dead.run.restartEvents?.some((e) => e.type === 'restarted'), 'restartEvents 缺少 restarted 事件');
      assert(dead.run.restartEvents?.some((e) => e.type === 'dead'), 'restartEvents 缺少 dead 事件');
    } finally {
      // 启动/发现失败可能留下仍在运行的 wrapper 与后代；兜底清理，避免污染后续发现场景。
      try { cli('stop', 'cmdrestart', '--tree'); } catch { /* best effort */ }
    }
  });
  // ---------- stop --tree：命令模式 node 目标 + node 后代（#39） ----------
  await check('默认 stop 不触碰目标后代（存活留证）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    let childPid = null;
    try {
      const r = cli('start-new', '--desc', descFile({
        alias: 'cmdtree', root: projCmd, entry: 'tree', mode: 'node',
        command: 'node tree-parent.js', expectedImage: NODE_IMAGE,
      }));
      if (pwshMissing(r)) skip('缺 pwsh 7');
      assert.equal(r.code, 0, r.text);
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
      childPid = await waitChildPid(rt.current.logPaths.stdout);
      assert(childPid, '未从 stdout 日志读到 tree-child pid');
      strayPids.push(childPid);
      const childId = psProc('capture', { id: childPid });
      assert.equal(childId.result, 'ok', `后代未存活：${JSON.stringify(childId)}`);
      // 命令模式资源采样必须聚合目标 + 后代（tree），而不是只看受管目标自身。
      const res = cli('status', 'cmdtree', '--resources').json.data.resources;
      assert.equal(res?.available, true, JSON.stringify(res));
      assert.equal(res.scope, 'tree');
      assert(res.processCount >= 2, `tree 采样进程数不足：${JSON.stringify(res)}`);
      const resPids = res.processes.map((p) => p.pid);
      assert(resPids.includes(rt.current.pid), `未包含目标 ${rt.current.pid}：${resPids}`);
      assert(resPids.includes(childPid), `未包含后代 ${childPid}：${resPids}`);
      assert(Number.isFinite(res.rssBytes) && res.rssBytes > 0, `聚合 RSS 异常：${res.rssBytes}`);
      const stop = cli('stop', 'cmdtree');
      assert.equal(stop.code, 0, stop.text);
      assert.equal(stop.json.data.result, 'stopped');
      assert.ok(!stop.json.data.treeKilled?.length, '不带 --tree 不应返回 treeKilled 证据');
      const cap = psProc('capture', { id: childPid });
      assert.equal(cap.result, 'ok', `不带 --tree 时后代被误杀：${JSON.stringify(cap)}`);
      assert.equal(cli('status', 'cmdtree').json.data.status, 'STOPPED');
      // 清理这一轮的后代，避免影响下一场景；按采集到的身份同句柄终止。
      const cleaned = psProc('terminate', { id: childPid, creationFileTime: childId.creationFileTime, image: childId.image });
      assert(['terminated', 'notfound', 'exited'].includes(cleaned.result), `后代清理失败：${JSON.stringify(cleaned)}`);
    } finally {
      // 失败时 wrapper/后代可能仍在（DISCOVERY_AMBIGUOUS 会保留 wrapper），必须连带清理。
      try { cli('stop', 'cmdtree', '--tree'); } catch { /* best effort */ }
      if (childPid) {
        try {
          const cap = psProc('capture', { id: childPid });
          if (cap.result === 'ok') psProc('terminate', { id: childPid, creationFileTime: cap.creationFileTime, image: cap.image });
        } catch { /* best effort */ }
      }
    }
  });
  await check('stop --tree 连带终止目标与后代两代并留证', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    try {
      const rr = cli('restart', 'cmdtree');
      assert.equal(rr.code, 0, rr.text);
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${rr.json.data.appId}.json`), 'utf8'));
      const childPid = await waitChildPid(rt.current.logPaths.stdout);
      assert(childPid, '重启后未从 stdout 日志读到 tree-child pid');
      strayPids.push(childPid);
      const childId = psProc('capture', { id: childPid });
      assert.equal(childId.result, 'ok', `重启后后代未存活：${JSON.stringify(childId)}`);
      const targetPid = rr.json.data.start.pid;
      const stop = cli('stop', 'cmdtree', '--tree');
      assert.equal(stop.code, 0, stop.text);
      const killed = stop.json.data.treeKilled ?? [];
      const entry = killed.find((k) => k.pid === childPid);
      assert(entry, `treeKilled 未包含后代 ${childPid}：${JSON.stringify(stop.json.data)}`);
      assert(entry.image, 'treeKilled 缺少后代映像证据');
      for (const [label, pid] of [['目标', targetPid], ['后代', childPid]]) {
        const cap = psProc('capture', { id: pid });
        assert(cap.result === 'notfound' || cap.result === 'exited', `${label} ${pid} 仍存活：${JSON.stringify(cap)}`);
      }
      assert.equal(cli('status', 'cmdtree').json.data.status, 'STOPPED');
    } finally {
      // restart 发现歧义时 wrapper 仍在运行；兜底 stop --tree 防止目标与后代残留。
      try { cli('stop', 'cmdtree', '--tree'); } catch { /* best effort */ }
    }
  });
  // 回归：port 诊断单次调用给出占用者完整身份（与 capture 同源 image）
  await check('port 诊断：受管监听进程的 pid/身份与 status 一致', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const PORT = 18123;
    const pre = cli('port', String(PORT));
    if (pre.code === 0 && pre.json?.data?.occupants?.length) skip(`端口 ${PORT} 已被占用`);
    const r = cli('start-new', '--desc', descFile({
      alias: 'portapp', root: projNpm, entry: 'lsn', mode: 'node', exe: 'node', args: ['lsn.js'], env: { PORT: String(PORT) }, expectedPort: PORT,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const base = cli('status', 'portapp').json.data;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${base.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'lsn-ready'), 'stdout 未见 lsn-ready');
    const st = cli('status', 'portapp', '--probe').json.data;
    const p = cli('port', String(PORT));
    assert.equal(p.code, 0, p.text);
    const occ = (p.json.data.occupants ?? []).find((o) => o.pid === st.run.pid);
    assert(occ, `port 未报告受管 pid=${st.run.pid}：${JSON.stringify(p.json.data.occupants)}`);
    assert.equal(occ.identity?.result, 'ok', `身份采集失败：${JSON.stringify(occ)}`);
    assert(occ.executablePath, '缺少 executablePath');
    assert.match(occ.executablePath.replace(/\\/g, '/'), /node(\.exe)?$/);
    assert.deepEqual(st.actualPorts, [PORT], `status --probe 实际端口不符：${JSON.stringify(st.actualPorts)}`);
    assert.equal(st.portMismatch, false);
    assert(cli('stop', 'portapp').code === 0);
  });
  // #107 验收：5173→5174 同类场景（expectedPort 被外部占用，受管进程顺延到另一端口）
  await check('status --probe 返回 actualPorts；端口漂移时 portMismatch=true，停止后不再返回旧端口', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const primary = await freePort();
    let fallback = await freePort();
    while (fallback === primary) fallback = await freePort();
    const occupant = net.createServer((q, s) => s.end('occupied'));
    await new Promise((resolve, reject) => { occupant.once('error', reject); occupant.listen(primary, '127.0.0.1', resolve); });
    let started = false;
    try {
      const r = cli('start-new', '--desc', descFile({
        alias: 'portdrift', root: projNpm, entry: 'drift', mode: 'node', exe: 'node', args: ['fallback.js'],
        env: { PORT: String(primary), FALLBACK_PORT: String(fallback) }, expectedPort: primary,
      }), '--force');
      if (pwshMissing(r)) skip('缺 pwsh 7');
      assert.equal(r.code, 0, r.text);
      started = true;
      const appId = r.json.data.appId;
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'fallback-ready'), 'stdout 未见 fallback-ready');
      const st = cli('status', 'portdrift', '--probe').json.data;
      assert.deepEqual(st.actualPorts, [fallback], `actualPorts 应为 [${fallback}]：${JSON.stringify(st.actualPorts)}`);
      assert.equal(st.portMismatch, true);
      assert.equal(st.expectedPort, primary);
      assert(listListeningPorts(st.run.pid).some((e) => e.localPort === fallback), 'listListeningPorts 未返回实际端口');
      const listRow = cli('list').json.data.apps.find((a) => a.alias === 'portdrift');
      assert.deepEqual(listRow.actualPorts, [fallback], `list actualPorts 不符：${JSON.stringify(listRow.actualPorts)}`);
      const stop = cli('stop', 'portdrift');
      assert.equal(stop.code, 0, stop.text);
      started = false;
      const after = cli('status', 'portdrift', '--probe').json.data;
      assert.deepEqual(after.actualPorts, [], `停止后不应返回旧端口：${JSON.stringify(after.actualPorts)}`);
      assert.equal(after.portMismatch, false);
    } finally {
      if (started) { try { cli('stop', 'portdrift', '--tree'); } catch { /* 兜底清理 */ } }
      await new Promise((resolve) => occupant.close(resolve));
    }
  });
  await check('desc 校验：command 缺 expectedImage / 与 exe 混填均拒绝', () => {
    const r1 = cli('start-new', '--desc', descFile({
      alias: 'nocmd', root: projAmb, mode: 'node', command: 'node srv.js',
    }));
    assert.equal(r1.code, 1, r1.text);
    const r2 = cli('start-new', '--desc', descFile({
      alias: 'both', root: projAmb, mode: 'node', exe: 'node', command: 'node srv.js', expectedImage: NODE_IMAGE,
    }));
    assert.equal(r2.code, 1, r2.text);
  });

  // ---------- 拒绝路径 ----------
  await check('非法 env 键名或非字符串值拒绝（USAGE 退出码 1）', () => {
    for (const env of [{ 'BAD-NAME': 'x' }, { PORT: 3001 }]) {
      const r = cli('start-new', '--desc', descFile({
        alias: `badenv${Object.keys(env)[0].length}`, root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], env,
      }));
      assert.equal(r.code, 1, r.text);
    }
  });
  await check('非法 mode 拒绝（USAGE 退出码 1）', () => {
    const r = cli('start-new', '--desc', descFile({
      alias: 'badmode', root: projNode, mode: 'jvm', exe: 'node', args: ['srv.js'],
    }));
    assert.equal(r.code, 1, r.text);
    assert(r.json.error.message.includes('mode'));
  });
  await check('npm 裸名拒绝（仅 .cmd/无扩展包装候选，CONFIG_INVALID 退出码 3）', () => {
    if (!findExecutable('npm')) skip('无 npm');
    const r = cli('start-new', '--desc', descFile({
      alias: 'npmbad', root: projNode, mode: 'node', exe: 'npm', args: ['run', 'dev'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check(isWindows ? 'exe 直接指向 .cmd 拒绝' : 'exe 直接指向 #! 脚本拒绝', () => {
    const fake = path.join(base, isWindows ? 'fake.cmd' : 'fake.sh');
    fs.writeFileSync(fake, isWindows ? '@echo off\r\n' : '#!/bin/sh\necho hi\n');
    if (!isWindows) fs.chmodSync(fake, 0o755);
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdbad', root: projNode, mode: 'proc', exe: fake, args: [],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check('WindowsApps 0 字节 stub 路径拒绝', () => {
    if (!isWindows) skip('仅 Windows 有 WindowsApps 执行别名');
    if (!winAppsStub) skip('本机无 WindowsApps python stub');
    const r = cli('start-new', '--desc', descFile({
      alias: 'stubbad', root: projPy, mode: 'python', exe: winAppsStub, args: ['srv.py'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
    assert(r.json.error.message.includes('WindowsApps'));
  });
  await check('record-unmanaged 登记非受管记录并保留 mode', () => {
    const r = cli('record-unmanaged', '--desc', descFile({
      alias: 'pyum', root: projUm, mode: 'python',
    }), '--log-hints', path.join(projUm, '.tmp', 'runner-local-x.stdout.log'));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.managed, false);
    const s = cli('status', 'pyum');
    assert.equal(s.json.data.mode, 'python');
  });
  await check('record-unmanaged 同 appId 已有受管登记时拒绝，--force 才覆盖', () => {
    if (!nodeRunId) skip('无受管登记可构造冲突');
    const r = cli('record-unmanaged', '--desc', descFile({ alias: 'dup', root: projNode, mode: 'node' }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'ALREADY_REGISTERED');
    const f = cli('record-unmanaged', '--desc', descFile({ alias: 'dup2', root: projNode, mode: 'node' }), '--force');
    assert.equal(f.code, 0, f.text);
    assert.equal(f.json.data.replacedManaged, true);
  });
  await check('list 汇总有真实 mode 展示', () => {
    if (!nodeRunId) skip('无受管实例');
    const r = cli('list');
    assert.equal(r.code, 0, r.text);
    assert(r.json.data.apps.some((a) => a.mode === 'node'));
  });
} finally {
  // 兜底：按当时仍在的后代 PID 清理，不只依赖 wrapper PID（wrapper 可能先死，#46）
  for (const a of ['nodeapp', 'pyapp', 'cmdapp', 'mline', 'npmdev', 'portapp', 'portdrift', 'cmdtree', 'cmdamb', 'cmdtmo', 'cmdfail', 'cmdexec', 'cmddetach', 'restartapp', 'restartstop', 'restartclean', 'cmdrestart']) {
    try { cli('stop', a, '--tree'); } catch { /* 忽略 */ }
  }
  const cleanupFailures = [];
  for (const p of [...strayWrapperPids, ...strayPids].filter(Boolean)) {
    if (!killTree(p)) cleanupFailures.push(p); // 多数情况是 wrapper 先死；最终由下方残留断言判定
  }
  if (cleanupFailures.length) console.log(`  note 清理未命中（进程可能已退出）：${cleanupFailures.join(', ')}`);
  // 进程退出后句柄释放需要一点时间：轮询删除，仍失败则显式报告（不静默）
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); removed = true; }
    catch { await wait(100); }
  }
  if (!removed) {
    failed++;
    console.log(`  FAIL 临时目录未能清理：${base}（进程可能仍占用句柄）`);
  }
  // 回归断言：本轮启动的临时进程都已退出（kill 后进程退出需要一点时间，轮询等待）
  let leftover = [];
  for (let i = 0; i < 20; i++) {
    leftover = findProcesses('two\\.js|srv\\.js|multi\\.js|lsn\\.js|crash\\.js|stable\\.js|clean\\.js|cmd-crash\\.js|npm-cli\\.js run dev|setInterval|sleep 30').filter((pid) => pid !== process.pid);
    if (!leftover.length) break;
    await wait(250);
  }
  if (leftover.length) {
    failed++;
    console.log(`  FAIL 残留进程未退出：${leftover.join(', ')}`);
  }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nruntime smoke ok');
