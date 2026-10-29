#!/usr/bin/env node
// manager CLI 生命周期冒烟测试：隔离 --home + process.execPath 作假 JVM exe，不触碰真实 ~/.project-runner/。
// 覆盖：start-new→RUNNING、重复 start→ALREADY_RUNNING、杀进程后 status 自动落账 STOPPED、
// stop/alreadyStopped、restart 新 runId+归档、伪造未结记录的 UNRESOLVED_RUN 与 --ack-unresolved 正反例、
// list 与单条 status 核验一致性、退出码/--json 抽查。
// 用法：node scripts/test/manager-smoke.mjs   （无外部依赖，Node 22+；缺 pwsh 7 时按惯例跳过核验类断言）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, isWindows } from './platform.mjs';
import { MANAGER_VERSION } from '../lib/constants.mjs';
import { psProc, verifyRuns } from '../lib/probe.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-manager-smoke-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
const proj = fs.realpathSync(path.join(base, 'proj'));

// 同步休眠（主线程，用于轮询进程退出落账）
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitLogPid = (file, re) => {
  let pid = null;
  for (let i = 0; i < 50 && pid == null; i++) {
    try {
      const m = re.exec(fs.readFileSync(file, 'utf8'));
      if (m) pid = Number(m[1]);
    } catch { /* 日志尚未落盘 */ }
    if (pid == null) sleep(100);
  }
  return pid;
};

const run = (args, { json = true } = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, ...(json ? ['--json'] : []), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON（文本模式或崩溃） */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const runAt = (targetHome, args, { json = true } = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', targetHome, ...(json ? ['--json'] : []), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
// dry-run 零写入断言：比较 registry/runtime 内容、locks 目录与 logs 文件清单。
const walkNames = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${e.isDirectory() ? 'd' : 'f'}:${path.relative(home, p)}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
};
const snapshotLaunchState = () => ({
  registry: fs.existsSync(path.join(home, 'registry.json')) ? fs.readFileSync(path.join(home, 'registry.json'), 'utf8') : null,
  runtime: walkNames(path.join(home, 'runtime')).map((x) => (x.startsWith('f:')
    ? `${x}:${fs.readFileSync(path.join(home, x.slice(2))).toString('base64')}`
    : x)),
  locks: walkNames(path.join(home, 'locks')),
  logs: walkNames(path.join(home, 'logs')),
});
const isPsMissing = (r) => r.code === 4
  && (r.json?.error?.code === 'PWSH_MISSING' || r.stdout.includes('PWSH_MISSING') || r.stderr.includes('PWSH_MISSING'));

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
class Skip extends Error { }
// 核验类断言：整条链路（锁/身份采集/核验/终止）依赖 pwsh，缺 pwsh 7 时按惯例跳过；
// 跳过时输出底层响应，区分「未安装」与「pwsh 瞬时失败」（如 Add-Type 偶发崩溃重试后仍失败）
const lifecycle = (name, fn) => {
  if (!hasPwsh) { skipped.push(name); console.log(`  skip  ${name}（缺进程探针，跳过核验类断言）`); return; }
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e instanceof Skip) {
      skipped.push(name);
      console.log(`  skip  ${name}（缺进程探针，跳过核验类断言；底层响应：${e.message}）`);
      return;
    }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const expectOk = (r) => {
  if (isPsMissing(r)) throw new Skip(JSON.stringify(r.json?.error ?? { code: r.code, stderr: r.stderr.slice(0, 200) }));
  assert.equal(r.code, 0, `退出码期望 0，实际 ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.json?.ok, true, `JSON ok 期望 true：${r.stdout}`);
  return r.json;
};
const expectFail = (r, code, errCode) => {
  if (isPsMissing(r)) throw new Skip(JSON.stringify(r.json?.error ?? { code: r.code, stderr: r.stderr.slice(0, 200) }));
  assert.equal(r.code, code, `退出码期望 ${code}，实际 ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  if (errCode) assert.equal(r.json?.error?.code, errCode, `错误码期望 ${errCode}：${r.stdout}`);
  return r.json;
};

// ---------- 进程探针（一次，决定核验类断言是否执行） ----------
const hasPwsh = hasProcessProbe();
if (!hasPwsh) console.log(`（未检测到进程探针 ${isWindows ? 'pwsh 7' : '/proc'}：仅覆盖不依赖核验的检查，核验类断言跳过）`);

let currentPid = null;
try {
  // ---------- 基础检查（不依赖 pwsh）：退出码与 --json 形状 ----------
  check('list 空注册表（--json 形状 schemaVersion/ok/command/data）', () => {
    const r = run(['list']);
    assert.equal(r.code, 0);
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.command, 'list');
    assert.deepEqual(r.json.data.apps, []);
    assert(r.json.data.note.includes('注册表为空'));
  });
  check('未知命令退出码 1（USAGE，--json error 形状）', () => {
    const r = run(['no-such-command']);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'USAGE');
    assert(r.json.error.message.includes('未知命令'));
  });
  check('status 未登记别名退出码 2（NOT_FOUND，--json error 形状）', () => {
    const r = run(['status', 'ghost']);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.command, 'status');
    assert.equal(r.json.error.code, 'NOT_FOUND');
  });

  check('只读命令在空 home 上不创建数据目录', () => {
    const emptyHome = path.join(base, 'empty-home');
    assert.equal(runAt(emptyHome, ['list']).code, 0);
    assert.equal(runAt(emptyHome, ['logs', 'ghost']).code, 2);
    assert.equal(runAt(emptyHome, ['prune']).code, 0);
    assert.equal(runAt(emptyHome, ['version']).code, 0);
    assert.equal(runAt(emptyHome, ['start', 'ghost', '--dry-run']).code, 2);
    assert.equal(runAt(emptyHome, ['restart', 'ghost', '--dry-run']).code, 2);
    assert.equal(fs.existsSync(emptyHome), false, '只读命令与 dry-run 不应创建 home');
  });

  check('version/--version/-v 输出版本号（与 MANAGER_VERSION 一致）', () => {
    for (const arg of ['version', '--version', '-v']) {
      const r = runAt(path.join(base, 'empty-home'), ['--json', arg]);
      assert.equal(r.code, 0, `${arg} 退出码`);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.data.version, MANAGER_VERSION, `${arg} 版本号`);
      assert.match(r.json.data.version, /^\d+\.\d+\.\d+$/, 'semver 形状');
    }
  });

  check('doctor 逐项收集损坏记录并继续输出其余诊断', () => {
    const dh = path.join(base, 'doctor-home');
    fs.mkdirSync(path.join(dh, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(dh, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(dh, 'logs'), { recursive: true });
    const homeReal = fs.realpathSync.native(dh);
    const registryFile = path.join(homeReal, 'registry.json');
    const corruptRuntime = path.join(homeReal, 'runtime', 'abad.json');
    const goodRuntime = path.join(homeReal, 'runtime', 'agood.json');
    fs.writeFileSync(registryFile, '{broken');
    fs.writeFileSync(corruptRuntime, '{broken');
    fs.writeFileSync(goodRuntime, JSON.stringify({ schemaVersion: 1, appId: 'agood', current: null, prevRuns: [] }));
    fs.writeFileSync(path.join(homeReal, 'locks', 'agood.lock'), '{}');
    const orphan = path.join(homeReal, '.tmp-1234-deadbeef');
    fs.writeFileSync(orphan, 'x');
    const r = runAt(homeReal, ['doctor']);
    assert.equal(r.code, 0, `doctor 应正常退出：${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert(r.json.data.problems.find((p) => p.file === registryFile), '缺少损坏注册表');
    assert(r.json.data.problems.find((p) => p.file === corruptRuntime), '缺少损坏运行记录');
    assert(r.json.data.runtime.some((x) => x.appId === 'agood'), '健康运行记录应继续输出');
    assert(r.json.data.locks.includes('agood.lock'), '锁诊断不应被阻断');
    assert(r.json.data.orphanTmpFiles.includes(orphan), '临时文件诊断不应被阻断');
  });

  // POSIX 专属：shell 脚本是包装进程，真实目标会变成解释器子进程，必须拒绝。
  if (!isWindows) {    check('POSIX: exe 指向 #! 脚本被拒绝（CONFIG_INVALID，退出码 3）', () => {
      const fake = path.join(base, 'fake.sh');
      fs.writeFileSync(fake, '#!/bin/sh\necho hi\n');
      fs.chmodSync(fake, 0o755);
      const f = path.join(base, 'desc-shebang.json');
      fs.writeFileSync(f, JSON.stringify({ alias: 'shebang', root: proj, mode: 'proc', exe: fake, args: [] }));
      const r = run(['start-new', '--desc', f]);
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'CONFIG_INVALID');
      assert(r.json.error.message.includes('#!'));
    });
  }

  check('--tag 参数校验：与 ref 互斥、无匹配 NOT_FOUND', () => {
    const both = run(['status', 'ghost', '--tag', 'no-such-tag']);
    assert.equal(both.code, 1);
    assert.equal(both.json?.error?.code, 'USAGE');
    const none = run(['status', '--tag', 'no-such-tag']);
    assert.equal(none.code, 2);
    assert.equal(none.json?.error?.code, 'NOT_FOUND');
  });

  check('desc tags 非法（类型/重复/字符）在启动前拒绝（USAGE）', () => {
    const f = path.join(base, 'desc-invalid-tags.json');
    for (const tags of ['backend', ['backend', 'Backend'], ['bad tag']]) {
      fs.writeFileSync(f, JSON.stringify({ alias: 'bad-tags', root: proj, mode: 'proc', exe: process.execPath, tags }));
      const r = run(['start-new', '--desc', f]);
      assert.equal(r.code, 1, `tags=${JSON.stringify(tags)} 应退出 1：${r.stdout}${r.stderr}`);
      assert.equal(r.json?.error?.code, 'USAGE');
      assert(r.json.error.message.includes('tags'), r.json.error.message);
    }
  });

  const descFile = path.join(base, 'desc.json');
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'smoke', root: proj, entry: 'default', mode: 'java',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envRefs: ['SMOKE_SECRET', 'SMOKE_MISSING_113'], expectedPort: 18080,
  }, null, 2));
  // start-new 的 ENV_MISSING 预检要求 envRefs 全部命中：两个变量都由宿主环境提供，
  // dry-run 用例再临时撤掉 SMOKE_MISSING_113 验证 present=false。
  const secretValue = 'pr-smoke-secret-113';
  const missingValue = 'pr-smoke-present-113';
  process.env.SMOKE_SECRET = secretValue;
  process.env.SMOKE_MISSING_113 = missingValue;
  let appId = null;
  let firstRunId = null;

  lifecycle('start-new → RUNNING（readinessUntested=true）', () => {
    const j = expectOk(run(['start-new', '--desc', descFile]));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.managed, true);
    assert.equal(j.data.readinessUntested, true);
    assert(Number.isInteger(j.data.pid) && j.data.pid > 0, `pid 异常：${j.data.pid}`);
    assert(j.data.runId && /^[a-z0-9][a-z0-9-]{0,47}$/.test(j.data.runId), `runId 异常：${j.data.runId}`);
    firstRunId = j.data.runId;
    currentPid = j.data.pid;
  });

  lifecycle('list 核验：RUNNING + expectedPort 列 + 数据层含 appId', () => {
    const j = expectOk(run(['list']));
    const row = j.data.apps.find((a) => a.alias === 'smoke');
    assert(row, 'list 缺少 smoke 行');
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.pid, currentPid);
    assert.equal(row.expectedPort, 18080);
    appId = row.appId;
  });

  lifecycle('status 单条核验与 list 结果一致（RUNNING）', () => {
    const j = expectOk(run(['status', 'smoke']));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.run.runId, firstRunId);
    assert.equal(j.data.run.pid, currentPid);
  });

  lifecycle('批量核验 verify-batch 与逐条核验结果一致', () => {
    const cur = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8')).current;
    const one = psProc('verify', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
    const batch = verifyRuns([{ pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image }]);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].result, one.result, `批量与逐条不一致：${JSON.stringify(batch[0])} vs ${JSON.stringify(one)}`);
  });
  lifecycle('status --ready → 未配置就绪证据时报 UNTESTED', () => {
    const j = expectOk(run(['status', 'smoke', '--ready']));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.readiness.state, 'UNTESTED');
    assert.equal(j.data.readiness.configured, false);
    assert.equal(j.data.readinessUntested, true);
  });

  lifecycle('status --resources → 直连单进程 RSS/CPU 单次采样', () => {
    const j = expectOk(run(['status', 'smoke', '--resources']));
    const res = j.data.resources;
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(res?.available, true, JSON.stringify(res));
    assert.equal(res.scope, 'process');
    assert.equal(res.processCount, 1);
    assert(Number.isFinite(res.rssBytes) && res.rssBytes > 0, `rss 异常：${res.rssBytes}`);
    assert(Number.isFinite(res.cpuPercent) && res.cpuPercent >= 0, `cpuPercent 异常：${res.cpuPercent}`);
    assert(Number.isFinite(res.cpuTimeMs) && res.cpuTimeMs >= 0, `cpuTimeMs 异常：${res.cpuTimeMs}`);
    assert.equal(res.processes[0].pid, currentPid);
  });

  lifecycle('list 内存列来自单点采样（RUNNING 行有 RSS）', () => {
    const j = expectOk(run(['list']));
    const row = j.data.apps.find((a) => a.alias === 'smoke');
    assert.equal(row.status, 'RUNNING');
    assert(Number.isFinite(row.memoryBytes) && row.memoryBytes > 0, `memoryBytes 异常：${row.memoryBytes}`);
    assert(Number.isFinite(row.cpuPercent) && row.cpuPercent >= 0, `cpuPercent 异常：${row.cpuPercent}`);
  });

  lifecycle('restart --dry-run 输出停止+启动计划且零写入', () => {
    delete process.env.SMOKE_MISSING_113;
    const before = snapshotLaunchState();
    const r = run(['restart', 'smoke', '--dry-run']);
    process.env.SMOKE_MISSING_113 = missingValue;
    const j = expectOk(r);
    assert.equal(j.data.dryRun, true);
    assert.equal(j.data.stop.expected, 'stopped');
    assert.equal(j.data.stop.runId, firstRunId);
    assert.equal(j.data.start.alias, 'smoke');
    assert.equal(j.data.start.kind, 'direct');
    assert.deepEqual(j.data.start.envRefs, [
      { name: 'SMOKE_SECRET', present: true },
      { name: 'SMOKE_MISSING_113', present: false },
    ]);
    assert.deepEqual(snapshotLaunchState(), before, 'restart dry-run 不得停止旧实例或写 registry/runtime');
  });

  lifecycle('重复 start → ALREADY_RUNNING（退出码 3）', () => {
    const j = expectFail(run(['start', 'smoke']), 3, 'ALREADY_RUNNING');
    assert(j.error.message.includes('已有受管实例在运行'));
  });

  lifecycle('stop → stopped（有界强制终止）', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'stopped');
    assert.equal(j.data.runId, firstRunId);
  });

  lifecycle('status --resources 非 RUNNING 时明确不采样', () => {
    const j = expectOk(run(['status', 'smoke', '--resources']));
    assert.equal(j.data.status, 'STOPPED');
    assert.equal(j.data.resources?.available, false);
    assert.match(String(j.data.resources?.reason), /非 RUNNING/);
  });

  lifecycle('重复 stop → alreadyStopped', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'alreadyStopped');
  });

  lifecycle('start --dry-run 输出解析计划且零写入；envRefs 只报命中不回显值', () => {
    delete process.env.SMOKE_MISSING_113;
    const before = snapshotLaunchState();
    const r = run(['start', 'smoke', '--dry-run']);
    process.env.SMOKE_MISSING_113 = missingValue;
    const j = expectOk(r);
    assert.equal(j.data.dryRun, true);
    assert.equal(j.data.appId, appId);
    assert.equal(j.data.cwd, fs.realpathSync.native(proj));
    const expectedExe = isWindows ? path.resolve(process.execPath) : fs.realpathSync.native(process.execPath);
    assert.equal(j.data.exe, expectedExe);
    assert.deepEqual(j.data.envRefs, [
      { name: 'SMOKE_SECRET', present: true },
      { name: 'SMOKE_MISSING_113', present: false },
    ]);
    assert.deepEqual(j.data.envNames, []);
    assert.equal(j.data.expectedPort, 18080);
    assert.equal(j.data.port.checked, true);
    assert.equal(j.data.port.conflict, false);
    assert(!r.stdout.includes(secretValue) && !r.stderr.includes(secretValue), 'dry-run 不得回显 envRefs 值');
    assert.match(j.data.note, /dry-run/);
    assert.deepEqual(snapshotLaunchState(), before, 'dry-run 不得写 registry/runtime/locks/logs');
  });

  let secondRunId = null;
  lifecycle('restart → 已停实例直接起新 runId，旧批次归档 prevRuns', () => {
    const j = expectOk(run(['restart', 'smoke']));
    assert.equal(j.data.stop.result, 'alreadyStopped');
    assert.equal(j.data.start.status, 'RUNNING');
    assert.notEqual(j.data.start.runId, firstRunId, 'restart 未产生新 runId');
    secondRunId = j.data.start.runId;
    currentPid = j.data.start.pid;
    const st = expectOk(run(['status', 'smoke']));
    assert.equal(st.data.status, 'RUNNING');
    assert(st.data.prevRuns.some((p) => p.runId === firstRunId), '旧 runId 未归档到 prevRuns');
  });

  lifecycle('杀进程后 status 自动落账 STOPPED（运行记录写回）', () => {
    process.kill(currentPid, 'SIGKILL');
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = run(['status', 'smoke']);
      if (st.code === 0 && st.json?.data?.status === 'STOPPED') break;
      sleep(250);
    }
    expectOk(st);
    assert.equal(st.json.data.status, 'STOPPED');
    // 落账：运行记录文件本身写回 STOPPED（带退出证据），而非只在响应里显示
    const rtFile = path.join(home, 'runtime', `${appId}.json`);
    const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
    assert.equal(rt.current.phase, 'STOPPED');
    assert(rt.current.endedAt, '缺少 endedAt 退出证据');
    assert.equal(rt.current.notifiedAt ?? null, null, '未配置 onExit 时不应有通知留证');
  });

  lifecycle('list 与单条核验一致（进程已退出 → STOPPED）', () => {
    const j = expectOk(run(['list']));
    assert.equal(j.data.apps.find((a) => a.alias === 'smoke').status, 'STOPPED');
  });

  // ---------- 未结记录与 --ack-unresolved 正反例 ----------
  const rtFile = () => path.join(home, 'runtime', `${appId}.json`);
  lifecycle('残留锁 + STARTING → status 显示启动中断（UNKNOWN）', () => {
    const saved = fs.readFileSync(rtFile(), 'utf8');
    const lockFile = path.join(home, 'locks', `${appId}.lock`);
    const rt = JSON.parse(saved);
    rt.current = {
      runId: 'rstale1', phase: 'STARTING', managed: true, mode: 'java',
      intentAt: new Date().toISOString(), startedAt: null,
      pid: null, creationFileTime: null, image: null, envResolved: [],
      logPaths: null, lastError: null, endedAt: null, exitNote: null,
    };
    fs.writeFileSync(rtFile(), JSON.stringify(rt, null, 2));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, creationFileTime: '1', op: 'start', at: new Date().toISOString() }));
    try {
      const st = expectOk(run(['status', 'smoke']));
      assert.equal(st.data.status, 'UNKNOWN');
      assert(st.data.note.includes('启动中断'), `note 未提示启动中断：${st.data.note}`);
      // 残留锁不再自动回收：先报 LOCK_BUSY 并给出确切文件，人工清理后才轮到未结记录判定
      const busy = expectFail(run(['start', 'smoke']), 3, 'LOCK_BUSY');
      assert(busy.error.message.includes(path.basename(lockFile)), `错误信息未给出残留锁路径：${busy.error.message}`);
      fs.unlinkSync(lockFile);
      expectFail(run(['start', 'smoke']), 3, 'UNRESOLVED_RUN');
    } finally {
      fs.writeFileSync(rtFile(), saved);
      try { fs.unlinkSync(lockFile); } catch { /* 已删除 */ }
    }
  });
  lifecycle('伪造 STARTING 未结记录 → start 默认拒绝（UNRESOLVED_RUN）', () => {
    const rt = JSON.parse(fs.readFileSync(rtFile(), 'utf8'));
    rt.current = {
      runId: 'rfakestuck1', phase: 'STARTING', managed: true, mode: 'java',
      intentAt: new Date().toISOString(), startedAt: null,
      pid: null, creationFileTime: null, image: null, envResolved: [],
      logPaths: {
        stdout: path.join(home, 'logs', appId, 'rfakestuck1.stdout.log'),
        stderr: path.join(home, 'logs', appId, 'rfakestuck1.stderr.log'),
      },
      lastError: null, endedAt: null, exitNote: null,
    };
    fs.writeFileSync(rtFile(), JSON.stringify(rt, null, 2));
    const j = expectFail(run(['start', 'smoke']), 3, 'UNRESOLVED_RUN');
    assert(j.error.message.includes('rfakestuck1'), '错误信息未给出 runId');
    assert(j.error.message.includes('--ack-unresolved'), '错误信息未给出恢复指引');
  });

  lifecycle('--ack-unresolved 与未结 runId 不一致 → ACK_MISMATCH（退出码 3）', () => {
    expectFail(run(['start', 'smoke', '--ack-unresolved', 'rwrongrun1']), 3, 'ACK_MISMATCH');
  });

  lifecycle('--ack-unresolved 正例 → 显式放弃旧账并启动', () => {
    const j = expectOk(run(['start', 'smoke', '--ack-unresolved', 'rfakestuck1']));
    assert.equal(j.data.abandonedRunId, 'rfakestuck1');
    assert.equal(j.data.abandonedReason, 'abandoned-by-ack');
    assert.equal(j.data.status, 'RUNNING');
    currentPid = j.data.pid;
    const st = expectOk(run(['status', 'smoke']));
    const archived = st.data.prevRuns.find((p) => p.runId === 'rfakestuck1');
    assert(archived, 'rfakestuck1 未归档到 prevRuns');
    assert.equal(archived.archiveReason, 'abandoned-by-ack');
  });

  lifecycle('stop 后无未结记录时带 --ack-unresolved → ACK_MISMATCH', () => {
    expectOk(run(['stop', 'smoke']));
    expectFail(run(['start', 'smoke', '--ack-unresolved', 'rfakestuck1']), 3, 'ACK_MISMATCH');
  });

  lifecycle('并发 start-new 不同 alias 双双登记（#22 registry 全局锁防丢更新）', () => {
    const mkDesc = (alias) => {
      const f = path.join(base, `desc-${alias}.json`);
      fs.writeFileSync(f, JSON.stringify({
        alias, root: proj, entry: alias, mode: 'java',
        exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [],
      }));
      return f;
    };
    const files = [mkDesc('conc-a'), mkDesc('conc-b')];
    const driver = path.join(base, 'concurrent-driver.cjs');
    // 锁本身不重试：调用方（这里模拟 Agent）遇到 LOCK_BUSY 自己退避重试。
    fs.writeFileSync(driver,
      `const {spawn}=require('child_process');`
      + `const M=${JSON.stringify(MANAGER)},H=${JSON.stringify(home)},F=${JSON.stringify(files)};`
      + 'const once=(f)=>new Promise((res)=>{'
      + "const c=spawn(process.execPath,[M,'--home',H,'--json','start-new','--desc',f]);"
      + "let o='';c.stdout.on('data',(d)=>{o+=d;});"
      + "c.on('close',(code)=>res({code,out:o}));});"
      + 'const retry=async(f)=>{let r;for(let i=0;i<60;i++){r=await once(f);'
      + "if(r.code===0||!r.out.includes('LOCK_BUSY'))return r;"
      + 'await new Promise((s)=>setTimeout(s,50));}return r;};'
      + 'Promise.all(F.map(retry)).then((rs)=>console.log(JSON.stringify(rs)));');
    const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 120000 });
    const rs = JSON.parse(r.stdout);
    assert.equal(rs.length, 2, `驱动输出异常：${r.stdout}${r.stderr}`);
    for (const x of rs) {
      const j = JSON.parse(x.out);
      assert(j.ok, `并发 start-new 失败（code=${x.code}）：${x.out}`);
    }
    const list = expectOk(run(['list']));
    const aliases = list.data.apps.map((a) => a.alias);
    assert(aliases.includes('conc-a') && aliases.includes('conc-b'), `注册表丢更新：${JSON.stringify(aliases)}`);
    expectOk(run(['stop', 'conc-a']));
    expectOk(run(['stop', 'conc-b']));
  });

  // ---------- tags 分组批量启停（#110） ----------
  const groupDescs = [
    { alias: 'tag-a', tags: ['Integration', 'backend'] },
    { alias: 'tag-b', tags: ['integration', 'frontend'] },
  ].map(({ alias, tags }) => {
    const f = path.join(base, `desc-${alias}.json`);
    fs.writeFileSync(f, JSON.stringify({
      alias, root: proj, entry: alias, mode: 'java', tags,
      exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [],
    }));
    return f;
  });

  lifecycle('tags：start-new 透传 tags，list/status 展示', () => {
    for (const f of groupDescs) expectOk(run(['start-new', '--desc', f]));
    const list = expectOk(run(['list']));
    const a = list.data.apps.find((x) => x.alias === 'tag-a');
    assert.deepEqual(a.tags, ['Integration', 'backend'], `list tags 丢失：${JSON.stringify(a)}`);
    const text = run(['list'], { json: false });
    assert(text.stdout.includes('Integration'), `list 文本未展示 tags：${text.stdout.split('\n')[0]}`);
    const st = expectOk(run(['status', 'tag-a']));
    assert.deepEqual(st.data.tags, ['Integration', 'backend']);
  });

  lifecycle('status --tag → 批量查询（大小写不敏感）', () => {
    const j = expectOk(run(['status', '--tag', 'INTEGRATION']));
    assert.equal(j.data.batch, true);
    assert.equal(j.data.matched, 2);
    assert.equal(j.data.failed, 0);
    assert.deepEqual(new Set(j.data.results.map((r) => r.alias)), new Set(['tag-a', 'tag-b']));
    assert(j.data.results.every((r) => r.ok && r.status === 'RUNNING' && r.run.runId), JSON.stringify(j.data.results));
  });

  lifecycle('start --tag 部分失败：失败继续、不回滚已完成部分', () => {
    expectOk(run(['stop', 'tag-a']));
    const j = expectOk(run(['start', '--tag', 'integration']));
    assert.equal(j.data.matched, 2);
    assert.equal(j.data.succeeded, 1, JSON.stringify(j.data.results));
    assert.equal(j.data.failed, 1, JSON.stringify(j.data.results));
    assert.equal(j.data.partialFailure, true);
    const a = j.data.results.find((r) => r.alias === 'tag-a');
    const b = j.data.results.find((r) => r.alias === 'tag-b');
    assert(a?.ok && a.status === 'RUNNING', `tag-a 应继续启动：${JSON.stringify(a)}`);
    assert.equal(b?.ok, false);
    assert.equal(b.error.code, 'ALREADY_RUNNING');
    const st = expectOk(run(['status', '--tag', 'integration']));
    assert(st.data.results.every((r) => r.status === 'RUNNING'), JSON.stringify(st.data.results));
  });

  lifecycle('restart --tag：--tree/--grace 逐条透传并起新 runId', () => {
    const before = expectOk(run(['status', '--tag', 'integration']));
    const beforeRuns = new Map(before.data.results.map((r) => [r.alias, r.run.runId]));
    const j = expectOk(run(['restart', '--tag', 'integration', '--tree', '--grace', '3000']));
    assert.equal(j.data.succeeded, 2, JSON.stringify(j.data.results));
    for (const r of j.data.results) {
      assert(r.ok, JSON.stringify(r));
      assert.equal(r.stop.result, 'stopped', `${r.alias} 停旧实例结果：${JSON.stringify(r.stop)}`);
      assert(Array.isArray(r.stop.treeKilled), `${r.alias} 未透传 --tree：${JSON.stringify(r.stop)}`);
      assert.equal(r.start.status, 'RUNNING');
      assert.notEqual(r.start.runId, beforeRuns.get(r.alias), `${r.alias} 未产生新 runId`);
    }
  });

  lifecycle('stop --tag：--tree 逐条透传并全部停止', () => {
    const j = expectOk(run(['stop', '--tag', 'integration', '--tree']));
    assert.equal(j.data.matched, 2);
    assert.equal(j.data.failed, 0, JSON.stringify(j.data.results));
    for (const r of j.data.results) {
      assert(r.ok, JSON.stringify(r));
      assert.equal(r.result, 'stopped');
      assert(Array.isArray(r.treeKilled), `${r.alias} 未透传 --tree`);
    }
    const st = expectOk(run(['status', '--tag', 'integration']));
    assert(st.data.results.every((r) => r.status === 'STOPPED'), JSON.stringify(st.data.results));
  });

  // ---------- stop --tree / --grace（#39 后代连带终止 + 优雅退出） ----------
  const treeProj = path.join(base, 'tree-proj');
  fs.mkdirSync(treeProj, { recursive: true });
  const treeRoot = fs.realpathSync(treeProj);
  fs.writeFileSync(path.join(treeRoot, 'parent.js'),
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},500)'],{detached:true,stdio:'ignore'});c.unref();console.log('child='+c.pid);setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-tree.json'), JSON.stringify({
    alias: 'smoke-tree', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['parent.js'], envRefs: [],
  }));

  lifecycle('stop --tree → 连带终止后代（treeKilled 含子进程身份）', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-tree.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /child=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到子进程 pid');
    const j = expectOk(run(['stop', 'smoke-tree', '--tree']));
    assert.equal(j.data.result, 'stopped');
    const killed = j.data.treeKilled ?? [];
    const entry = killed.find((k) => k.pid === childPid);
    assert(entry, `treeKilled 不含子进程 ${childPid}：${JSON.stringify(j.data)}`);
    assert(entry.image, 'treeKilled 缺少后代映像证据');
    const cap = psProc('capture', { id: childPid });
    assert(cap.result === 'notfound' || cap.result === 'exited', `后代进程仍存活：${JSON.stringify(cap)}`);
  });

  fs.writeFileSync(path.join(treeRoot, 'gone.js'),
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),200)'],{detached:true,stdio:'ignore'});c.unref();console.log('gone='+c.pid);setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-gone.json'), JSON.stringify({
    alias: 'smoke-gone', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['gone.js'], envRefs: [],
  }));

  lifecycle('stop --tree 后代已自行退出：跳过且不报错', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-gone.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /gone=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到已退出子进程 pid');
    let cap = null;
    for (let i = 0; i < 50; i++) {
      cap = psProc('capture', { id: childPid });
      if (cap.result === 'notfound' || cap.result === 'exited') break;
      sleep(100);
    }
    assert(cap.result === 'notfound' || cap.result === 'exited', `子进程尚未退出：${JSON.stringify(cap)}`);
    const j = expectOk(run(['stop', 'smoke-gone', '--tree']));
    assert.equal(j.data.result, 'stopped');
    assert.ok(Array.isArray(j.data.treeKilled), 'treeKilled 应为数组');
    assert(!j.data.treeKilled.some((k) => k.pid === childPid), `已退出的后代不应被记为终止：${JSON.stringify(j.data)}`);
  });

  lifecycle('restart --tree → 停旧实例时连带终止后代并起新实例', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-tree.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /child=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到重启前子进程 pid');
    const j = expectOk(run(['restart', 'smoke-tree', '--tree']));
    assert.equal(j.data.stop.result, 'stopped');
    const entry = (j.data.stop.treeKilled ?? []).find((k) => k.pid === childPid);
    assert(entry, `restart --tree 的 treeKilled 不含子进程 ${childPid}：${JSON.stringify(j.data)}`);
    const cap = psProc('capture', { id: childPid });
    assert(cap.result === 'notfound' || cap.result === 'exited', `重启前子进程仍存活：${JSON.stringify(cap)}`);
    assert.equal(j.data.start.status, 'RUNNING');
    expectOk(run(['stop', 'smoke-tree', '--tree'])); // 新实例也可能已派生后代，一并清理
  });

  fs.writeFileSync(path.join(treeRoot, 'gracer.js'),
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-grace.json'), JSON.stringify({
    alias: 'smoke-grace', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['gracer.js'], envRefs: [],
  }));

  lifecycle('stop --grace → 优雅信号先行，仍存活则强制', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-grace.json')]));
    const j = expectOk(run(['stop', 'smoke-grace', '--grace', '3000']));
    assert.equal(j.data.result, 'stopped');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8'));
    // Linux：SIGTERM 被捕获应优雅退出；Windows 控制台进程 taskkill 无 /F 多半失败 → grace 超时后强制
    assert(rt.current.exitNote.includes('grace'), `exitNote 未记录 grace 过程：${rt.current.exitNote}`);
    if (!isWindows) {
      // 发出 SIGTERM ≠ 目标被信号终止：gracer.js 捕获 SIGTERM 后 process.exit(0)，
      // 退出证据必须来自实际 exit 事件（code=0/signal=null），不能写成 SIGTERM。
      let exit = null;
      for (let i = 0; i < 40; i++) {
        exit = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8')).current.exit ?? null;
        if (exit) break;
        sleep(100);
      }
      assert.equal(exit?.code, 0, `grace 后目标退出码应为 0：${JSON.stringify(exit)}`);
      assert.equal(exit?.signal, null, `捕获 SIGTERM 后正常退出不应记 signal：${JSON.stringify(exit)}`);
    }
  });

  // ---------- onExit 退出通知钩子（#135）：查询首次发现退出触发一次，人工 stop 不触发 ----------
  const notifyOut = path.join(base, 'notify-out.jsonl');
  const notifySink = path.join(base, 'notify-sink.cjs');
  fs.writeFileSync(notifySink,
    `require('fs').appendFileSync(${JSON.stringify(notifyOut)}, JSON.stringify({`
    + 'runId:process.env.PROJECT_RUNNER_RUN_ID,alias:process.env.PROJECT_RUNNER_ALIAS,'
    + 'appId:process.env.PROJECT_RUNNER_APP_ID,pid:process.env.PROJECT_RUNNER_PID,'
    + 'note:process.env.PROJECT_RUNNER_EXIT_NOTE,endedAt:process.env.PROJECT_RUNNER_ENDED_AT'
    + `})+'\\n');\n`);
  // 测试命令不含引号（测试路径无空格）：Node 在 Windows 会对含空格的参数再包引号并转义
  // 内部引号，与 cmd /s /c 的首尾剥引号叠加会拆坏命令——用户侧回调同理应避免依赖嵌套引号。
  const notifyCmd = `${process.execPath} ${notifySink}`;
  const readNotifies = () => (fs.existsSync(notifyOut)
    ? fs.readFileSync(notifyOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const notiDesc = path.join(base, 'desc-noti.json');
  fs.writeFileSync(notiDesc, JSON.stringify({
    alias: 'smoke-noti', root: proj, entry: 'noti', mode: 'java',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [], onExit: notifyCmd,
  }));
  const waitStopped = (alias) => {
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = run(['status', alias]);
      if (st.code === 0 && st.json?.data?.status === 'STOPPED') break;
      sleep(250);
    }
    return st;
  };

  lifecycle('onExit：杀进程后 status 首次发现触发一次回调（负载+落账），再查不重复', () => {
    const s = expectOk(run(['start-new', '--desc', notiDesc]));
    process.kill(s.data.pid, 'SIGKILL');
    const st = waitStopped('smoke-noti');
    expectOk(st);
    assert.equal(st.json.data.status, 'STOPPED');
    const hits = readNotifies();
    assert.equal(hits.length, 1, `回调次数期望 1，实际 ${hits.length}：${JSON.stringify(hits)}`);
    assert.equal(hits[0].runId, s.data.runId);
    assert.equal(hits[0].alias, 'smoke-noti');
    assert.equal(hits[0].appId, s.data.appId);
    assert.equal(String(hits[0].pid), String(s.data.pid));
    // 落账：运行记录 notifiedAt + notifyResult；再次查询的响应可透出
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8'));
    assert(rt.current.notifiedAt, '运行记录缺少 notifiedAt');
    assert.equal(rt.current.notifyResult, 'ok', `notifyResult 异常：${rt.current.notifyResult}`);
    const st2 = expectOk(run(['status', 'smoke-noti']));
    assert.equal(st2.data.run.notifiedAt, rt.current.notifiedAt);
    expectOk(run(['list']));
    assert.equal(readNotifies().length, 1, '同一 run 重复触发了回调');
  });

  lifecycle('onExit：人工 stop 不触发回调', () => {
    expectOk(run(['start', 'smoke-noti']));
    expectOk(run(['stop', 'smoke-noti']));
    assert.equal(readNotifies().length, 1, '人工 stop 不应触发 onExit 回调');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${expectOk(run(['status', 'smoke-noti'])).data.appId}.json`), 'utf8'));
    assert.equal(rt.current.notifiedAt ?? null, null, 'stop 落的账不应带 notifiedAt');
  });

  lifecycle('onExit：应用未配置时全局 config.json 兜底触发', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ onExit: notifyCmd }));
    const f2 = path.join(base, 'desc-noti2.json');
    fs.writeFileSync(f2, JSON.stringify({
      alias: 'smoke-noti2', root: proj, entry: 'noti2', mode: 'java',
      exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [],
    }));
    try {
      const s = expectOk(run(['start-new', '--desc', f2]));
      process.kill(s.data.pid, 'SIGKILL');
      const st = waitStopped('smoke-noti2');
      expectOk(st);
      assert.equal(st.json.data.status, 'STOPPED');
      const hits = readNotifies();
      assert.equal(hits.length, 2, `全局兜底未触发：${JSON.stringify(hits)}`);
      assert.equal(hits[1].runId, s.data.runId);
      assert.equal(hits[1].alias, 'smoke-noti2');
    } finally {
      try { fs.unlinkSync(path.join(home, 'config.json')); } catch { /* 已删 */ }
    }
  });

  lifecycle('onExit：回调命令超时/失败静默，不影响 status 主路径', () => {
    const f3 = path.join(base, 'desc-noti3.json');
    fs.writeFileSync(f3, JSON.stringify({
      alias: 'smoke-noti3', root: proj, entry: 'noti3', mode: 'java',
      exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [],
      onExit: 'exit 7',
    }));
    const s = expectOk(run(['start-new', '--desc', f3]));
    process.kill(s.data.pid, 'SIGKILL');
    const st = waitStopped('smoke-noti3');
    expectOk(st);
    assert.equal(st.json.data.status, 'STOPPED', '回调失败影响了 status 结果');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8'));
    assert(rt.current.notifiedAt, '失败回调也应落账 notifiedAt（同一 run 只试一次）');
    assert.equal(rt.current.notifyResult, 'exit:7', `notifyResult 异常：${rt.current.notifyResult}`);
    assert.equal(readNotifies().length, 2, '失败回调不应触碰正常 sink');
  });

  lifecycle('onExit：restartPolicy 监督型应用 BACKOFF 不触发、重启耗尽 DEAD 触发一次', () => {
    const f4 = path.join(base, 'desc-noti4.json');
    fs.writeFileSync(f4, JSON.stringify({
      alias: 'smoke-noti4', root: proj, entry: 'noti4', mode: 'java',
      // 存活 3s：确保 start-new 的身份采集窗口内进程仍在线（Windows 上 wrapper/logger 拉起较慢）
      exe: process.execPath, args: ['-e', 'console.log("noti4-start"); setTimeout(() => process.exit(42), 3000)'], envRefs: [],
      restartPolicy: 'on-failure', maxRestarts: 1, backoffMs: 300, onExit: notifyCmd,
    }));
    const s = expectOk(run(['start-new', '--desc', f4]));
    let st = null;
    for (let i = 0; i < 80; i++) {
      st = run(['status', 'smoke-noti4']);
      if (st.code === 0 && st.json?.data?.run?.restartState === 'DEAD') break;
      sleep(250);
    }
    expectOk(st);
    assert.equal(st.json.data.status, 'DEAD');
    assert.equal(st.json.data.run.restartCount, 1, '重启次数应为 1（maxRestarts=1）');
    const hits = readNotifies();
    assert.equal(hits.length, 3, `监督型 DEAD 应触发一次回调（此前共 2 次），实际 ${hits.length}：${JSON.stringify(hits)}`);
    assert.equal(hits[2].runId, s.data.runId, '回调 runId 应为监督 run');
    assert.equal(hits[2].alias, 'smoke-noti4');
    // 落账：DEAD 记录带 notifiedAt/notifyResult，重复查询不重复触发
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8'));
    assert(rt.current.notifiedAt, 'DEAD 记录缺少 notifiedAt');
    assert.equal(rt.current.notifyResult, 'ok', `notifyResult 异常：${rt.current.notifyResult}`);
    expectOk(run(['status', 'smoke-noti4']));
    expectOk(run(['list']));
    assert.equal(readNotifies().length, 3, 'DEAD 后重复查询重复触发了回调');
  });

  lifecycle('文本模式人类可读输出抽查（status 含 port/状态）', () => {
    const r = run(['status', 'smoke'], { json: false });
    assert.equal(r.code, 0);
    assert(r.stdout.includes('status=STOPPED'), r.stdout);
    assert(r.stdout.includes('run=') && r.stdout.includes('证据:'), r.stdout);
  });

  lifecycle('list 人类可读输出含 port 列', () => {
    const r = run(['list'], { json: false });
    assert.equal(r.code, 0);
    assert(r.stdout.split('\n')[0].includes('port'), r.stdout.split('\n')[0]);
    assert(r.stdout.includes('18080'), r.stdout);
  });

  // ---------- 退出码/信号证据展示（#102；纯读，不依赖进程探针） ----------
  check('status/list 展示退出码与信号，旧记录无 exit 仍可读', () => {
    // 生命周期测试在没有进程探针的主机上会跳过；为纯读展示断言提供独立的
    // STOPPED fixture，避免依赖前面的 start-new 是否执行。
    if (!appId) {
      appId = 'asmoke';
      const runtimeDir = path.join(home, 'runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const regFile = path.join(home, 'registry.json');
      const reg = fs.existsSync(regFile)
        ? JSON.parse(fs.readFileSync(regFile, 'utf8'))
        : { schemaVersion: 1, apps: {} };
      reg.apps[appId] = {
        appId, alias: 'smoke', displayName: 'smoke', root: proj, entry: 'default',
        cwd: proj, mode: 'java', exe: process.execPath, args: [], envRefs: [], env: {},
        expectedPort: 18080, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
      fs.writeFileSync(path.join(runtimeDir, `${appId}.json`), JSON.stringify({
        schemaVersion: 1, appId,
        current: {
          runId: 'r-smoke-exit-evidence', phase: 'STOPPED', managed: true, mode: 'java',
          pid: null, startedAt: null, endedAt: new Date().toISOString(),
          exitNote: '进程已退出', logPaths: { stdout: null, stderr: null },
        },
        prevRuns: [],
      }, null, 2));
    }
    const file = path.join(home, 'runtime', `${appId}.json`);
    const saved = fs.readFileSync(file, 'utf8');
    const writeExit = (exit) => {
      const rt = JSON.parse(saved);
      rt.current.phase = 'STOPPED';
      rt.current.exit = exit;
      rt.current.exitNote = null;
      fs.writeFileSync(file, JSON.stringify(rt, null, 2));
    };
    try {
      writeExit({ code: 7, signal: null, at: '2026-01-01T00:00:00.000Z' });
      const st = expectOk(run(['status', 'smoke']));
      assert.equal(st.data.status, 'STOPPED');
      assert.equal(st.data.run.exit.code, 7);
      assert.match(st.data.run.exitSummary, /异常退出（code=7）/);
      assert.match(st.data.note, /异常退出（code=7）/, `status note 未展示异常退出：${st.data.note}`);
      const row = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(row.exit.code, 7);
      assert.match(row.exitSummary, /异常退出（code=7）/);
      assert(run(['status', 'smoke'], { json: false }).stdout.includes('code=7'), 'status 文本未展示 code');
      assert(run(['list'], { json: false }).stdout.includes('code=7'), 'list 文本未展示 code');

      writeExit({ code: null, signal: 'SIGKILL', at: '2026-01-01T00:00:01.000Z' });
      const sig = expectOk(run(['status', 'smoke']));
      assert.equal(sig.data.run.exit.signal, 'SIGKILL');
      assert.match(sig.data.note, /被信号终止（signal=SIGKILL）/, `status note 未展示信号：${sig.data.note}`);
      const sigRow = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(sigRow.exit.signal, 'SIGKILL');

      // 旧 runtime 记录没有 exit 字段：沿用原有“进程已退出”文案，不报错。
      const legacy = JSON.parse(saved);
      legacy.current.phase = 'STOPPED';
      delete legacy.current.exit;
      legacy.current.exitNote = '进程已退出';
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
      const old = expectOk(run(['status', 'smoke']));
      assert.equal(old.data.status, 'STOPPED');
      assert.equal(old.data.run.exit, null);
      assert.match(old.data.note, /进程已退出/);
      assert.equal(expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke').exit, null);

      // watcher 无法取得真实退出状态时必须显式透出不可用原因，不能静默伪装成已采集。
      legacy.current.exitWatchError = { reason: 'target reaped before status', at: '2026-01-01T00:00:02.000Z' };
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
      const watchErr = expectOk(run(['status', 'smoke']));
      assert.match(watchErr.data.note, /退出码\/信号不可用（target reaped before status）/);
      assert.equal(watchErr.data.run.exitWatchError.reason, 'target reaped before status');
      const watchErrRow = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(watchErrRow.exitWatchError.reason, 'target reaped before status');
    } finally {
      fs.writeFileSync(file, saved);
    }
  });
} finally {
  try { run(['stop', '--tag', 'integration', '--tree']); } catch { /* 测试中途失败时尽力清理组内进程 */ }
  if (currentPid) {
    try { process.kill(currentPid, 'SIGKILL'); } catch { /* 已退出 */ }
    if (isWindows) {
      try { spawnSync('taskkill', ['/pid', String(currentPid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    }
  }
  // Windows 上被杀进程的句柄释放有延迟，rmSync 可能 EBUSY。清理失败只告警，不让已完成的断言判负。
  let cleaned = false;
  for (let i = 0; i < 150; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleaned = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (!cleaned) console.warn(`[warn] 临时目录清理超时，已跳过（不影响断言）：${base}`);
}

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺 pwsh 7）`);
console.log('\nmanager smoke ok');
