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

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-manager-smoke-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
const proj = fs.realpathSync(path.join(base, 'proj'));

// 同步休眠（主线程，用于轮询进程退出落账）
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const runAt = (h, args, { json = true } = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', h, ...(json ? ['--json'] : []), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON（文本模式或崩溃） */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const run = (args, opts) => runAt(home, args, opts);
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
  if (!hasPwsh) { skipped.push(name); console.log(`  skip  ${name}（缺 pwsh 7，跳过核验类断言）`); return; }
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e instanceof Skip) {
      skipped.push(name);
      console.log(`  skip  ${name}（缺 pwsh 7，跳过核验类断言；底层响应：${e.message}）`);
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

// ---------- pwsh 探测（一次，决定核验类断言是否执行） ----------
const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
const hasPwsh = !probe.error && probe.status === 0;
if (!hasPwsh) console.log('（未安装 pwsh 7：仅覆盖不依赖核验的检查，核验类断言跳过）');

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

  // ---------- 只读命令不创建缺失的 home ----------
  const roHome = path.join(base, 'read-only-home');
  check('list 空 home 不创建数据目录', () => {
    const r = runAt(roHome, ['list']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.apps, []);
    assert.equal(fs.existsSync(roHome), false, 'list 不应创建 home');
  });
  check('logs / prune --dry-run 空 home 不创建数据目录', () => {
    const logs = runAt(roHome, ['logs', 'ghost']);
    assert.equal(logs.code, 2);
    assert.equal(logs.json.error.code, 'NOT_FOUND');
    const prune = runAt(roHome, ['prune', '--dry-run']);
    assert.equal(prune.code, 0);
    assert.equal(prune.json.data.dryRun, true);
    assert.equal(fs.existsSync(roHome), false, 'logs/prune 不应创建 home');
  });

  // ---------- doctor 逐项收集损坏数据 ----------
  const doctorHome = path.join(base, 'doctor-home');
  const doctorRuntime = path.join(doctorHome, 'runtime');
  const doctorLocks = path.join(doctorHome, 'locks');
  fs.mkdirSync(doctorRuntime, { recursive: true });
  fs.mkdirSync(doctorLocks, { recursive: true });
  fs.mkdirSync(path.join(doctorHome, 'logs', 'agood'), { recursive: true });
  const doctorRegistry = path.join(doctorHome, 'registry.json');
  const goodRegistry = { schemaVersion: 1, apps: { agood: { appId: 'agood', alias: 'good', expectedPort: null } } };
  fs.writeFileSync(doctorRegistry, JSON.stringify(goodRegistry));
  fs.writeFileSync(path.join(doctorRuntime, 'agood.json'), JSON.stringify({ schemaVersion: 1, appId: 'agood', current: null, prevRuns: [] }));
  const corruptRuntime = path.join(doctorRuntime, 'abad.json');
  fs.writeFileSync(corruptRuntime, '{broken');
  const orphanTmp = path.join(doctorHome, '.tmp-1234-deadbeef');
  fs.writeFileSync(orphanTmp, 'x');
  fs.writeFileSync(path.join(doctorLocks, 'agood.lock'), '{}');
  check('doctor 收集损坏运行记录并继续输出其余诊断', () => {
    const r = runAt(doctorHome, ['doctor']);
    assert.equal(r.code, 0, `doctor 应正常退出：${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, true);
    const problem = r.json.data.problems.find((p) => p.file === corruptRuntime);
    assert(problem, `problems 缺少损坏运行记录：${JSON.stringify(r.json.data.problems)}`);
    assert.equal(problem.code, 'DATA_CORRUPT');
    assert(problem.message);
    const appIds = r.json.data.runtime.map((x) => x.appId);
    assert(appIds.includes('agood') && appIds.includes('abad'), `runtime 扫描不完整：${appIds.join(',')}`);
    assert(r.json.data.locks.includes('agood.lock'), '损坏运行记录不应阻断 locks 输出');
    assert(r.json.data.orphanTmpFiles.includes(orphanTmp), '损坏运行记录不应阻断 tmp 输出');
    assert.equal(new Set(r.json.data.orphanTmpFiles).size, r.json.data.orphanTmpFiles.length, '孤儿临时文件重复列出');
  });
  check('doctor 注册表损坏时仍输出 locks/tmp 并显式列出问题', () => {
    fs.writeFileSync(doctorRegistry, '{broken');
    try {
      const r = runAt(doctorHome, ['doctor']);
      assert.equal(r.code, 0, `doctor 应正常退出：${r.stdout}${r.stderr}`);
      const problem = r.json.data.problems.find((p) => p.file === doctorRegistry);
      assert(problem, `problems 缺少损坏注册表：${JSON.stringify(r.json.data.problems)}`);
      assert.equal(problem.code, 'DATA_CORRUPT');
      assert(r.json.data.locks.includes('agood.lock'), '注册表损坏不应阻断 locks 输出');
      assert(r.json.data.orphanTmpFiles.includes(orphanTmp), '注册表损坏不应阻断 tmp 输出');
    } finally {
      fs.writeFileSync(doctorRegistry, JSON.stringify(goodRegistry));
    }
  });

  // ---------- 生命周期（依赖 pwsh） ----------
  const descFile = path.join(base, 'desc.json');
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'smoke', root: proj, entry: 'default', mode: 'java',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envRefs: [], expectedPort: 18080,
  }, null, 2));
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

  lifecycle('重复 start → ALREADY_RUNNING（退出码 3）', () => {
    const j = expectFail(run(['start', 'smoke']), 3, 'ALREADY_RUNNING');
    assert(j.error.message.includes('已有受管实例在运行'));
  });

  lifecycle('stop → stopped（有界强制终止）', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'stopped');
    assert.equal(j.data.runId, firstRunId);
  });

  lifecycle('重复 stop → alreadyStopped', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'alreadyStopped');
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
  });

  lifecycle('list 与单条核验一致（进程已退出 → STOPPED）', () => {
    const j = expectOk(run(['list']));
    assert.equal(j.data.apps.find((a) => a.alias === 'smoke').status, 'STOPPED');
  });

  // ---------- 未结记录与 --ack-unresolved 正反例 ----------
  const rtFile = () => path.join(home, 'runtime', `${appId}.json`);
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
} finally {
  try { if (currentPid) process.kill(currentPid, 'SIGKILL'); } catch { /* 已退出 */ }
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺 pwsh 7）`);
console.log('\nmanager smoke ok');
