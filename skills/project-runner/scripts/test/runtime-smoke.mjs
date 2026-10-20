#!/usr/bin/env node
// 多语言受管生命周期冒烟：隔离 --home + 真实 node/python 进程，验证 start-new → status/logs → stop，
// 以及包装脚本、WindowsApps stub、非法 mode 的拒绝路径。不触碰真实注册表与业务进程。
// 用法：node scripts/test/runtime-smoke.mjs   （无外部依赖，Node 22+；缺 pwsh 7 或 python 时跳过对应检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runtime-smoke-'));
const home = path.join(base, 'home');
const projNode = path.join(base, 'node-app');
const projPy = path.join(base, 'py-app');
const projUm = path.join(base, 'um-app');
for (const d of [projNode, projPy, projUm]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(projNode, 'srv.js'),
  'console.log("node-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
fs.writeFileSync(path.join(projPy, 'srv.py'),
  'import time\nprint("py-ready", flush=True)\nwhile True:\n    time.sleep(1)\n', 'utf8');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

let failed = 0;
let skipped = false;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e.code === 'PR_SKIP') { skipped = true; console.log(`  skip ${name}: ${e.message}`); return; }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const skip = (why) => { const e = new Error(why); e.code = 'PR_SKIP'; throw e; };
// pwsh 缺失时 start-new 会在锁内失败（exit 4/PWSH_MISSING），统一判定
const pwshMissing = (r) => r.code === 4 || (r.json?.error?.code === 'PWSH_MISSING');

// ---- 预检：python 是否可用（裸名解析得到真实 exe；仅 stub 时无法受管） ----
const whereOut = spawnSync('where', ['python'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
const pyCandidates = whereOut.status === 0 ? whereOut.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
const isWinAppsAlias = (p) => {
  if (!/\\Microsoft\\WindowsApps\\/i.test(p)) return false;
  try { const s = fs.lstatSync(p); return s.size === 0 || s.isSymbolicLink(); } catch { return false; }
};
const pyReal = pyCandidates.find((p) => !isWinAppsAlias(p));
const winAppsStub = pyCandidates.find((p) => isWinAppsAlias(p));

try {
  // ---------- node 受管生命周期 ----------
  let nodeRunId = null;
  await check('node start-new 受管启动（裸名 node 解析为真实 exe）', () => {
    const r = cli('start-new', '--desc', descFile({
      alias: 'nodeapp', root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], expectedPort: null,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.mode, 'node');
    nodeRunId = r.json.data.runId;
  });
  if (nodeRunId) {
    await check('node 日志出现就绪标记', async () => {
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${cli('status', 'nodeapp').json.data.appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'node-ready'), 'stdout 未见 node-ready');
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
    await check('node restart 复用配置再启动 → 再停', () => {
      const r = cli('restart', 'nodeapp');
      assert.equal(r.code, 0, r.text);
      assert.equal(cli('status', 'nodeapp').json.data.status, 'RUNNING');
      assert.equal(cli('stop', 'nodeapp').code, 0);
    });
  }

  // ---------- python 受管生命周期 ----------
  await check('python start-new 受管启动（裸名 python 跳过 WindowsApps stub）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    if (!pyReal) skip('PATH 中无真实 python.exe');
    const r = cli('start-new', '--desc', descFile({
      alias: 'pyapp', root: projPy, mode: 'python', exe: 'python', args: ['srv.py'],
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

  // ---------- 拒绝路径 ----------
  await check('非法 mode 拒绝（USAGE 退出码 1）', () => {
    const r = cli('start-new', '--desc', descFile({
      alias: 'badmode', root: projNode, mode: 'jvm', exe: 'node', args: ['srv.js'],
    }));
    assert.equal(r.code, 1, r.text);
    assert(r.json.error.message.includes('mode'));
  });
  await check('npm 裸名拒绝（仅 .cmd/无扩展包装候选，CONFIG_INVALID 退出码 3）', () => {
    const npm = spawnSync('where', ['npm'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (npm.status !== 0) skip('无 npm');
    const r = cli('start-new', '--desc', descFile({
      alias: 'npmbad', root: projNode, mode: 'node', exe: 'npm', args: ['run', 'dev'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check('exe 直接指向 .cmd 拒绝', () => {
    const fake = path.join(base, 'fake.cmd');
    fs.writeFileSync(fake, '@echo off\r\n');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdbad', root: projNode, mode: 'proc', exe: fake, args: [],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check('WindowsApps 0 字节 stub 路径拒绝', () => {
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
  await check('list 汇总有真实 mode 展示', () => {
    if (!nodeRunId) skip('无受管实例');
    const r = cli('list');
    assert.equal(r.code, 0, r.text);
    assert(r.json.data.apps.some((a) => a.mode === 'node'));
  });
} finally {
  // 兜底：尽力停掉可能残留的受管进程
  for (const a of ['nodeapp', 'pyapp']) {
    try { cli('stop', a); } catch { /* 忽略 */ }
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 进程刚退出时日志句柄可能短暂占用，残留由 temp 目录兜底 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nruntime smoke ok');
