#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
// This detached process is also the supervision carrier for restartPolicy=on-failure:
// it observes the target exit, applies bounded backoff/maxRestarts, writes supervision
// events into the same run record, and relaunches the same launch description.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readRuntimeStrict, atomicWriteJson } from './lib/store.mjs';
import { withLock, withLockAsync } from './lib/locks.mjs';
import { psProc } from './lib/probe.mjs';
import { effectiveRestartSettings, planRestart, exitDescription } from './lib/restart.mjs';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch { /* best effort */ }
const { file, args, cwd, outPath, errPath, home, appId, runtimeFile, runId, limit } = config;
const settings = effectiveRestartSettings(config);
const supervised = settings.restartPolicy === 'on-failure';
let outSize = 0;
let errSize = 0;
try { outSize = fs.statSync(outPath).size; } catch { /* first write */ }
try { errSize = fs.statSync(errPath).size; } catch { /* first write */ }
let outFd = fs.openSync(outPath, 'a');
let errFd = fs.openSync(errPath, 'a');
const rotatedStreams = new Set();
const recordedStreams = new Set();
const rotateFailedStreams = new Set();
const recordedFailedStreams = new Set();
let rotationRetryTimer = null;
let rotationRetryAttempts = 0;

// supervision state
let target = null;
let currentSpawnFailed = false;
let restartTimer = null;
let restartAttempt = null;
let finishing = false;
const ignoredChildren = new WeakSet();

function scheduleRotationRetry() {
  if (rotationRetryTimer || rotationRetryAttempts >= 40) return;
  const delay = Math.min(100 * (2 ** Math.min(rotationRetryAttempts, 4)), 2000);
  rotationRetryAttempts++;
  rotationRetryTimer = setTimeout(() => {
    rotationRetryTimer = null;
    persistRotationState();
  }, delay);
}

function persistRotationState() {
  if ([...rotatedStreams].every((stream) => recordedStreams.has(stream))
    && [...rotateFailedStreams].every((stream) => recordedFailedStreams.has(stream))) return;
  try {
    withLock(home, appId, 'log-rotation', () => {
      const rt = readRuntimeStrict(home, appId);
      if (rt?.current?.runId !== runId) {
        for (const stream of rotatedStreams) recordedStreams.add(stream);
        for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
        return;
      }
      const streams = new Set([...(rt.current.logRotatedStreams ?? []), ...rotatedStreams]);
      const failed = new Set([...(rt.current.logRotateFailedStreams ?? []), ...rotateFailedStreams]);
      if (streams.size) rt.current.logRotated = true;
      rt.current.logRotatedStreams = [...streams];
      if (failed.size) rt.current.logRotateFailedStreams = [...failed];
      atomicWriteJson(runtimeFile, rt);
      for (const stream of rotatedStreams) recordedStreams.add(stream);
      for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
    });
  } catch {
    scheduleRotationRetry();
  }
}

function markRotated(stream) {
  rotatedStreams.add(stream);
  persistRotationState();
}

function markRotateFailed(stream) {
  rotateFailedStreams.add(stream);
  persistRotationState();
}

function supervisorLog(message) {
  if (errFd == null) return;
  try {
    const line = `[project-runner] ${message}\n`;
    fs.writeSync(errFd, line);
    errSize += Buffer.byteLength(line);
  } catch { /* logging failure must never affect supervision/lifecycle */ }
}

function appendRestartEvent(cur, event) {
  const events = Array.isArray(cur.restartEvents) ? cur.restartEvents : [];
  events.push({ at: new Date().toISOString(), ...event });
  cur.restartEvents = events.slice(-20);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只读轮询期间不持锁：用于 BACKOFF 等待时尽快感知 stop/start/remove 已取消本次监督。
function readCurrentRun() {
  try {
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    return rt?.current ?? null;
  } catch { return undefined; }
}

async function withAppLockRetry(op, fn, attempts = 300, intervalMs = 100) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withLockAsync(home, appId, op, fn);
    } catch (e) {
      last = e;
      if (e.code !== 'LOCK_BUSY') throw e;
      await sleep(intervalMs);
    }
  }
  throw last;
}

function exitCodeFrom(exit) {
  if (exit.spawnFailed) return 1;
  return exit.code ?? (exit.signal ? 1 : 0);
}

function finalize(code) {
  if (finishing) return;
  finishing = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  try { fs.closeSync(outFd); } catch { /* already closed */ }
  try { fs.closeSync(errFd); } catch { /* already closed */ }
  process.exitCode = code ?? 0;
}

function writeChunk(stream, input) {
  const isOut = stream === 'stdout';
  let chunk = input;
  let fd = isOut ? outFd : errFd;
  let size = isOut ? outSize : errSize;
  const filePath = isOut ? outPath : errPath;
  if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
  if (fd == null) {
    // 此前轮转 reopen 失败（标记过 rotateFailed）：懒重开——append 模式，
    // 若 rename 当时也失败则旧内容仍在，append 续写不覆盖；仍失败则丢本
    // chunk 等下次再试，日志管道故障绝不波及目标进程。
    try {
      fd = fs.openSync(filePath, 'a');
      size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
      if (isOut) { outFd = fd; outSize = size; } else { errFd = fd; errSize = size; }
    } catch { return; }
  }
  if (size + chunk.length > limit) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(`${filePath}.1`); } catch { /* absent */ }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* best effort */ }
    try {
      fd = fs.openSync(filePath, 'w');
    } catch {
      // reopen 失败：置空 fd 转为懒重开路径，并持久化 logRotateFailedStreams
      // 供 status/UI 透出——不再静默丢后续全部日志。
      if (isOut) outFd = null; else errFd = null;
      markRotateFailed(stream);
      return;
    }
    size = 0;
    if (isOut) outFd = fd; else errFd = fd;
    markRotated(stream);
  }
  fs.writeSync(fd, chunk);
  size += chunk.length;
  if (isOut) outSize = size; else errSize = size;
}

function forward(stream, isOut) {
  stream.on('data', (input) => {
    try {
      writeChunk(isOut ? 'stdout' : 'stderr', input);
    } catch { /* logging failure must not terminate the target */ }
  });
}

function waitForSpawn(child) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    child.once('spawn', () => done(true));
    child.once('error', () => done(false));
  });
}

function cleanupOwnedChild(child) {
  if (!child) return;
  try {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  } catch { /* best effort */ }
}

// Spawn the launch description (direct target or command wrapper). `attempt` is set
// for supervised relaunches so an exit during identity capture can be deferred instead
// of being double-counted by the normal close handler.
function spawnTarget({ initial, attempt = null }) {
  currentSpawnFailed = false;
  const child = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  target = child;
  // pidFile 契约：spawn 同步拿到 pid 时立即写入；异步 error（ENOENT/EACCES 等）时写 0，
  // manager 据此快速落 SPAWN_FAILED（无进程产生，可直接重试），不再等窗口超时后
  // 误报 IDENTITY_CAPTURE_FAILED/UNKNOWN，错误原文同时落入 stderr 批次日志。
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { fs.writeFileSync(config.pidFile, String(child.pid)); } catch { /* best effort */ }
  }
  child.on('error', (err) => {
    currentSpawnFailed = true;
    try {
      fs.writeFileSync(config.pidFile, '0');
      const line = `[project-runner] target spawn failed: ${err.code ?? ''} ${err.message} (file=${file})\n`;
      fs.writeSync(errFd, line);
      errSize += Buffer.byteLength(line);
    } catch { /* 尽力而为 */ }
  });
  forward(child.stdout, true);
  forward(child.stderr, false);
  child.on('close', (code, signal) => {
    persistRotationState();
    if (target === child) target = null;
    const exit = { code, signal, spawnFailed: currentSpawnFailed };
    if (ignoredChildren.has(child)) return;
    if (attempt && restartAttempt === attempt && attempt.child === child && attempt.state === 'launching') {
      attempt.deferredExit = exit;
      return;
    }
    if (attempt && attempt.child === child && attempt.state === 'failed') return;
    void onTargetExit(exit);
  });
  // 初始启动时由 manager 负责身份采集；重启由 performRestart 自己采集。
  void initial;
  return child;
}

function applyExitPlan(cur, rt, exit, context) {
  const plan = planRestart(settings, cur.restartCount ?? 0, exit.code, exit.signal);
  const now = new Date().toISOString();
  cur.lastExit = {
    at: now, code: exit.code ?? null, signal: exit.signal ?? null,
    spawnFailed: !!exit.spawnFailed, source: context,
  };
  appendRestartEvent(cur, { type: context === 'restart-attempt' ? 'restart-failed' : 'exit', ...cur.lastExit });
  const label = context === 'restart-attempt' ? '自动重启尝试失败' : '进程异常退出';
  const desc = exitDescription(exit.code, exit.signal);
  if (plan.action === 'stop') {
    cur.phase = 'STOPPED';
    cur.endedAt = now;
    cur.restartState = null;
    cur.nextRestartAt = null;
    cur.exitNote = plan.reason === 'clean-exit'
      ? `${label}（${desc}）；restartPolicy=on-failure 不重启正常退出`
      : `${label}（${desc}）；不自动重启：${plan.reason}`;
    appendRestartEvent(cur, { type: 'no-restart', reason: plan.reason });
    atomicWriteJson(runtimeFile, rt);
    supervisorLog(`${label}（${desc}），不自动重启：${plan.reason}`);
    return { action: 'finalize', code: exitCodeFrom(exit) };
  }
  if (plan.action === 'dead') {
    cur.phase = 'DEAD';
    cur.endedAt = now;
    cur.restartCount = plan.restartCount;
    cur.restartState = 'DEAD';
    cur.nextRestartAt = null;
    cur.exitNote = `${label}（${desc}）；自动重启已达上限 ${plan.restartCount}/${settings.maxRestarts}，进入 DEAD`;
    appendRestartEvent(cur, { type: 'dead', reason: 'max-restarts', restartCount: plan.restartCount });
    atomicWriteJson(runtimeFile, rt);
    supervisorLog(`自动重启已达上限（${plan.restartCount}/${settings.maxRestarts}），进入 DEAD`);
    return { action: 'finalize', code: exitCodeFrom(exit) };
  }
  const nextAt = new Date(Date.now() + plan.delayMs).toISOString();
  cur.phase = 'BACKOFF';
  cur.endedAt = now;
  cur.restartCount = plan.restartCount;
  cur.restartState = 'BACKOFF';
  cur.nextRestartAt = nextAt;
  cur.exitNote = `${label}（${desc}）；${plan.delayMs}ms 后第 ${plan.restartCount}/${settings.maxRestarts} 次自动重启`;
  appendRestartEvent(cur, {
    type: 'backoff', attempt: plan.restartCount, delayMs: plan.delayMs, nextRestartAt: nextAt,
  });
  atomicWriteJson(runtimeFile, rt);
  supervisorLog(`${label}（${desc}），${plan.delayMs}ms 后自动重启（第 ${plan.restartCount}/${settings.maxRestarts} 次）`);
  return { action: 'schedule', delayMs: plan.delayMs };
}

function evaluateTargetExit(exit) {
  const rt = readRuntimeStrict(home, appId);
  const cur = rt?.current;
  if (!cur || cur.runId !== runId) {
    supervisorLog('目标退出后运行记录已切换，停止监督');
    return { action: 'finalize', code: 0 };
  }
  if (cur.phase === 'STOPPED' && !cur.stopRequested) {
    // status 查询可能先按 OS 事实把 RUNNING 落成 STOPPED；这不是人为 stop，
    // 仍应按 exit code 走 restartPolicy（人为 stop 会写 stopRequested=true）。
    supervisorLog('目标退出先被 status 落为 STOPPED（非人为 stop），继续按 restartPolicy 评估');
  } else if (cur.phase !== 'RUNNING') {
    supervisorLog(`目标退出后 phase=${cur.phase}（人为停止/未结记录），不自动重启`);
    return { action: 'finalize', code: 0 };
  }
  return applyExitPlan(cur, rt, exit, 'target-exit');
}

async function onTargetExit(exit) {
  if (finishing) return;
  if (!supervised) {
    finalize(exitCodeFrom(exit));
    return;
  }
  let outcome;
  try {
    outcome = await withAppLockRetry('restart-evaluate', () => evaluateTargetExit(exit));
  } catch (e) {
    supervisorLog(`监督状态更新失败（${e.code ?? 'UNKNOWN'}）：${e.message}`);
    finalize(exitCodeFrom(exit));
    return;
  }
  if (outcome.action === 'schedule') scheduleRestart(outcome.delayMs);
  else finalize(outcome.code ?? exitCodeFrom(exit));
}

// BACKOFF 等待按小步轮询：人为 stop/start/remove 改写 phase 或 runId 后，
// 监督进程应尽快退出，而不是把长 backoff 变成“僵尸 logger”。
function scheduleRestart(delayMs) {
  const due = Date.now() + Math.max(0, delayMs);
  const step = Math.min(500, Math.max(50, delayMs || 50));
  const tick = () => {
    if (finishing) return;
    if (Date.now() >= due) {
      restartTimer = null;
      void performRestart();
      return;
    }
    const cur = readCurrentRun();
    if (cur !== undefined && (!cur || cur.runId !== runId || cur.phase !== 'BACKOFF')) {
      supervisorLog('自动重启已取消（运行记录已停止或切换）');
      restartTimer = null;
      finalize(0);
      return;
    }
    restartTimer = setTimeout(tick, Math.min(step, Math.max(1, due - Date.now())));
  };
  restartTimer = setTimeout(tick, Math.min(step, Math.max(0, delayMs)));
}

function discoverCommandTarget(child) {
  let wrapperCap = null;
  try { wrapperCap = psProc('capture', { id: child.pid }); } catch { /* wrapper may already be gone */ }
  let d;
  try {
    d = psProc('discover', {
      id: child.pid, image: config.expectedImage,
      ...(config.discoverTimeoutMs != null ? { waitMs: config.discoverTimeoutMs } : {}),
    });
  } catch (e) {
    d = { result: 'error', code: 'discover_failed', message: e.message };
  }
  if (d.result !== 'found' || !Array.isArray(d.candidates) || d.candidates.length !== 1) return null;
  let cap;
  try { cap = psProc('capture', { id: d.candidates[0].pid }); } catch { return null; }
  if (cap.result !== 'ok') return null;
  return {
    pid: d.candidates[0].pid,
    creationFileTime: cap.creationFileTime,
    image: cap.image,
    wrapperCreationFileTime: wrapperCap?.result === 'ok' ? wrapperCap.creationFileTime : null,
    wrapperImage: wrapperCap?.result === 'ok' ? wrapperCap.image : null,
  };
}

async function captureDirectTarget(pid) {
  let last = null;
  // 与 manager 启动窗口同量级：冷启动/杀毒扫描时 capture 可能需要数秒。
  for (let i = 0; i < 50; i++) {
    try { last = psProc('capture', { id: pid }); }
    catch (e) { last = { result: 'error', message: e.message }; }
    if (last.result === 'ok') return { pid, creationFileTime: last.creationFileTime, image: last.image };
    if (last.result === 'exited' || last.result === 'notfound') return null;
    await sleep(100);
  }
  return null;
}

async function performRestart() {
  if (finishing) return;
  const attempt = { child: null, state: 'launching', deferredExit: null };
  restartAttempt = attempt;
  let outcome;
  try {
    outcome = await withAppLockRetry('restart-launch', async () => {
      const rt = readRuntimeStrict(home, appId);
      const cur = rt?.current;
      if (!cur || cur.runId !== runId || cur.phase !== 'BACKOFF') return { action: 'abort' };
      cur.phase = 'STARTING';
      cur.restartState = 'RESTARTING';
      cur.restartAttemptAt = new Date().toISOString();
      cur.lastError = null;
      atomicWriteJson(runtimeFile, rt);

      const child = spawnTarget({ initial: false, attempt });
      attempt.child = child;
      const spawned = await waitForSpawn(child);
      if (!spawned) {
        const exit = { code: null, signal: null, spawnFailed: true };
        attempt.state = 'failed';
        ignoredChildren.add(child);
        if (target === child) target = null;
        cleanupOwnedChild(child);
        return applyExitPlan(cur, rt, exit, 'restart-attempt');
      }

      const identity = config.isCommand ? discoverCommandTarget(child) : await captureDirectTarget(child.pid);
      if (!identity) {
        const exit = attempt.deferredExit ?? { code: null, signal: null, spawnFailed: true };
        attempt.state = 'failed';
        ignoredChildren.add(child);
        if (target === child) target = null;
        cleanupOwnedChild(child);
        return applyExitPlan(cur, rt, exit, 'restart-attempt');
      }

      cur.phase = 'RUNNING';
      cur.stopRequested = false;
      cur.pid = identity.pid;
      cur.creationFileTime = identity.creationFileTime;
      cur.image = identity.image;
      if (config.isCommand) {
        cur.wrapperPid = child.pid;
        cur.wrapperCreationFileTime = identity.wrapperCreationFileTime ?? null;
        cur.wrapperImage = identity.wrapperImage ?? null;
      }
      cur.restartState = null;
      cur.nextRestartAt = null;
      cur.endedAt = null;
      cur.exitNote = null;
      cur.lastError = null;
      cur.restartStartedAt = new Date().toISOString();
      appendRestartEvent(cur, { type: 'restarted', attempt: cur.restartCount, pid: cur.pid, image: cur.image });
      atomicWriteJson(runtimeFile, rt);
      attempt.state = 'succeeded';
      supervisorLog(`自动重启成功（第 ${cur.restartCount}/${settings.maxRestarts} 次），pid=${cur.pid}`);
      return { action: 'running', deferredExit: attempt.deferredExit };
    });
  } catch (e) {
    supervisorLog(`自动重启失败（${e.code ?? 'UNKNOWN'}）：${e.message}`);
    attempt.state = 'failed';
    if (attempt.child) {
      ignoredChildren.add(attempt.child);
      cleanupOwnedChild(attempt.child);
    }
    finalize(1);
    return;
  } finally {
    if (restartAttempt === attempt) restartAttempt = null;
  }

  if (outcome.action === 'schedule') scheduleRestart(outcome.delayMs);
  else if (outcome.action === 'finalize') finalize(outcome.code ?? 1);
  else if (outcome.action === 'running') {
    // 成功重启：继续持有 logger/监督进程。目标若在身份采集完成前已退出，
    // deferredExit 存在，再按正常退出路径重新评估，避免停在伪 RUNNING。
    if (outcome.deferredExit) {
      await sleep(0);
      void onTargetExit(outcome.deferredExit);
    }
  } else finalize(0);
}

spawnTarget({ initial: true });
