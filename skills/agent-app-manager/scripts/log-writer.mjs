#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
// This detached process is also the supervision carrier for restartPolicy=on-failure:
// it observes the target exit, applies bounded backoff/maxRestarts, writes supervision
// events into the same run record, and relaunches the same launch description.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readRuntimeStrict, atomicWriteJson } from './lib/store.mjs';
import { withLockAsync, withLogEvidenceLock } from './lib/locks.mjs';
import { psProc, verifyRun } from './lib/probe.mjs';
import { effectiveRestartSettings, planRestart, exitDescription } from './lib/restart.mjs';
import { startTargetExitWatcherAsync } from './lib/exit-watch.mjs';
import { resolveOnExit, notifyEnv, runNotifyCommand } from './lib/notify.mjs';

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
// rename 连续失败时暂停该流写盘（#156）：继续追加会让 logMaxBytes 形同虚设，
// 单流日志无界增长。暂停换取硬上限，周期性重试轮转，成功后自动恢复。
const PAUSE_AFTER_ROTATE_FAILURES = 3;
const PAUSED_RETRY_MS = 3000;
const rotateFailStreak = { stdout: 0, stderr: 0 };
const pausedStreams = new Set();
let pausedSynced = '';
let pausedRetryTimer = null;
let rotationRetryTimer = null;
let rotationRetryAttempts = 0;

// supervision state
let target = null;
let currentSpawnFailed = false;
let restartTimer = null;
let restartAttempt = null;
let finishing = false;
// 代数守卫：自动重启后同一 runId 复用，旧 wrapper/目标的 close 不能当作新目标退出评估。
let targetEpoch = 0;
// command 模式：目标已死但 wrapper 仍存活时 'close' 不触发——轮询运行记录中
// exit-watcher 写下的退出证据，保证监督不僵尸化（#152）。
let targetExitPoll = null;
let exitWatchErrorChecked = false;
const ignoredChildren = new WeakSet();

// 目标进程退出证据：runId 匹配当前记录时写入 current.exit（spawn 失败走 pidFile=0/lastError，不写 exit）。
// 与轮转状态共用应用锁并按 runId 二次确认，避免并发 start/stop 时记到错误的 run。
let exitInfo = null;
let exitRecorded = false;
let exitRetryTimer = null;
let exitRetryAttempts = 0;

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
  const pausedKey = [...pausedStreams].sort().join(',');
  if (pausedKey === pausedSynced
    && [...rotatedStreams].every((stream) => recordedStreams.has(stream))
    && [...rotateFailedStreams].every((stream) => recordedFailedStreams.has(stream))) return;
  try {
    withLogEvidenceLock(home, appId, 'log-rotation', () => {
      const rt = readRuntimeStrict(home, appId);
      if (rt?.current?.runId !== runId) {
        for (const stream of rotatedStreams) recordedStreams.add(stream);
        for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
        pausedSynced = pausedKey;
        return;
      }
      const streams = new Set([...(rt.current.logRotatedStreams ?? []), ...rotatedStreams]);
      const failed = new Set([...(rt.current.logRotateFailedStreams ?? []), ...rotateFailedStreams]);
      if (streams.size) rt.current.logRotated = true;
      rt.current.logRotatedStreams = [...streams];
      if (failed.size) rt.current.logRotateFailedStreams = [...failed];
      if (pausedStreams.size) rt.current.logWritePausedStreams = [...pausedStreams];
      else delete rt.current.logWritePausedStreams;
      atomicWriteJson(runtimeFile, rt);
      for (const stream of rotatedStreams) recordedStreams.add(stream);
      for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
      pausedSynced = pausedKey;
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

function scheduleExitRetry() {
  if (exitRetryTimer || exitRetryAttempts >= 40) return;
  const delay = Math.min(100 * (2 ** Math.min(exitRetryAttempts, 4)), 2000);
  exitRetryAttempts++;
  exitRetryTimer = setTimeout(() => {
    exitRetryTimer = null;
    persistExitState();
  }, delay);
}

// command 模式的直接子进程通常是 shell wrapper，manager 托管的是 discover 找到的后代。
// 只有确认直接子进程就是受管目标（例如 Linux shell exec 后 pid 不变）时，才把它的
// 退出结果写成目标 exit；否则单独写 wrapperExit，避免把 wrapper 的退出码/信号冒充目标。
function isCommandWrapper(run) {
  if (run?.kind !== 'command') return false;
  // 目标尚未发现（pid 缺失）时 wrapper 的退出绝不能当成目标退出；只有记录中
  // 有真实目标 pid、且目标与 wrapper 是同一进程（如 shell exec）时才算目标。
  if (!Number.isInteger(run.pid) || run.pid <= 0) return true;
  if (!Number.isInteger(run.wrapperPid) || run.wrapperPid <= 0) return true;
  return run.pid !== run.wrapperPid;
}

function applyExitEvidence(run) {
  if (!run || run.runId !== runId) return false;
  // 只补写同类空缺证据：manager stop 已按受管身份落下的 exit（source=manager-stop）
  // 是权威记录，不能被这里迟到的观测覆盖（exit 事件晚于 stop 落账属常态竞态）。
  if (isCommandWrapper(run)) {
    if (!run.wrapperExit) run.wrapperExit = exitInfo;
  } else if (!run.exit) {
    run.exit = exitInfo;
  }
  return true;
}

function persistExitState() {
  if (!exitInfo || exitRecorded) return;
  try {
    withLogEvidenceLock(home, appId, 'log-exit', () => {
      const rt = readRuntimeStrict(home, appId);
      // 先匹配 current；目标退出后若 manager 已因 stdio 延迟/并发 start 把旧 run
      // 归档到 prevRuns，则继续按 runId 写入历史条目，绝不改新 current。
      let matched = applyExitEvidence(rt?.current);
      if (!matched) {
        const archived = (rt?.prevRuns ?? []).find((p) => p.runId === runId);
        matched = applyExitEvidence(archived);
      }
      if (!matched) {
        exitRecorded = true;
        return;
      }
      atomicWriteJson(runtimeFile, rt);
      exitRecorded = true;
    });
  } catch {
    // 停止/启动持锁期间短暂 LOCK_BUSY：有界重试，拿到锁后按 runId 复核。
    scheduleExitRetry();
  }
}

function supervisorLog(message) {
  if (errFd == null) return;
  try {
    const line = `[agent-app-manager] ${message}\n`;
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

// onExit 通知钩子（#135）：监督型应用最终不再重启（不重启/clean-exit、重启耗尽 DEAD）
// 时退出即为实例终态，与查询路径「首次发现已退出」语义一致，认领并执行一次通知。
// BACKOFF（将自动重启）不通知；人为 stop/运行记录已切换在进入 applyExitPlan 前已返回，
// 天然不触发。认领在应用锁内（原子落账 notifiedAt 保证单次），命令在锁外有界执行，
// 结果按 runId+notifiedAt 复核后短锁补记；失败静默，不影响监督主流程。
function claimExitNotify(cur) {
  try {
    const hook = resolveOnExit(home, appId);
    if (!hook || cur.notifiedAt) return null;
    cur.notifiedAt = new Date().toISOString();
    // exit 证据可能仍在 log-exit 锁重试中未写入 cur.exit，回退到 lastExit 保证负载完整
    const curForEnv = cur.exit ? cur : {
      ...cur,
      exit: cur.lastExit ? { code: cur.lastExit.code ?? null, signal: cur.lastExit.signal ?? null } : null,
    };
    return {
      command: hook.command,
      runId: cur.runId,
      notifiedAt: cur.notifiedAt,
      env: notifyEnv(appId, hook.app, curForEnv),
    };
  } catch { return null; }
}

async function runExitNotify(notify) {
  if (!notify) return;
  let result;
  try {
    result = runNotifyCommand(notify.command, notify.env, home);
  } catch { return; }
  try {
    // await 落账后再 finalize：监督进程可能随即退出，fire-and-forget 会丢结果回写
    await withLockAsync(home, appId, 'exit-notify', () => {
      const rt3 = readRuntimeStrict(home, appId);
      if (rt3?.current?.runId === notify.runId && rt3.current.notifiedAt === notify.notifiedAt) {
        rt3.current.notifyResult = result;
        atomicWriteJson(runtimeFile, rt3);
      }
    });
  } catch { /* 结果留证失败不影响通知本身 */ }
}

// 暂停流的周期恢复：重试 rename，成功即换新文件恢复写盘，仍失败则下个周期再试。
function schedulePausedRetry() {
  if (pausedRetryTimer || !pausedStreams.size) return;
  pausedRetryTimer = setTimeout(() => {
    pausedRetryTimer = null;
    resumePausedStreams();
  }, PAUSED_RETRY_MS);
}

function resumePausedStreams() {
  if (!pausedStreams.size) return;
  for (const stream of [...pausedStreams]) {
    const isOut = stream === 'stdout';
    const filePath = isOut ? outPath : errPath;
    let fd = isOut ? outFd : errFd;
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch (e) {
      // 文件已被外部清走（ENOENT）：无需轮转，直接走下面的新建路径恢复；
      // 其余失败保持暂停与 logRotateFailedStreams 证据，下个周期再试。
      if (e.code !== 'ENOENT') continue;
    }
    try { if (fd != null) fs.closeSync(fd); } catch { /* already closed */ }
    fd = null;
    try {
      fd = fs.openSync(filePath, 'w');
      if (isOut) { outFd = fd; outSize = 0; } else { errFd = fd; errSize = 0; }
      markRotated(stream);
    } catch {
      // 新文件仍建不起来：fd 置空转懒重开路径，暂停状态保留证据后继续尝试。
      if (isOut) outFd = null; else errFd = null;
      markRotateFailed(stream);
      continue;
    }
    rotateFailStreak[stream] = 0;
    pausedStreams.delete(stream);
    supervisorLog(`日志流 ${stream} 已恢复写盘（轮转重试成功）`);
  }
  persistRotationState(); // 同步 paused 集合（含清空）
  schedulePausedRetry();
}

function finalize(code) {
  if (finishing) return;
  finishing = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (pausedRetryTimer) {
    clearTimeout(pausedRetryTimer);
    pausedRetryTimer = null;
  }
  if (targetExitPoll) {
    clearInterval(targetExitPoll);
    targetExitPoll = null;
  }
  try { fs.closeSync(outFd); } catch { /* already closed */ }
  try { fs.closeSync(errFd); } catch { /* already closed */ }
  process.exitCode = code ?? 0;
}

function writeChunk(stream, input) {
  if (pausedStreams.has(stream)) {
    schedulePausedRetry();
    return; // 丢弃本 chunk：换取单流日志的硬上限
  }
  const isOut = stream === 'stdout';
  let chunk = input;
  let fd = isOut ? outFd : errFd;
  let size = isOut ? outSize : errSize;
  const filePath = isOut ? outPath : errPath;
  if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
  if (fd == null) {
    // 此前轮转已成功移走旧文件，但创建新文件失败（标记过 rotateFailed）：
    // 懒重开——append 模式续写；仍失败则丢本 chunk 等下次再试，日志管道
    // 故障绝不波及目标进程。
    try {
      fd = fs.openSync(filePath, 'a');
      size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
      if (isOut) { outFd = fd; outSize = size; } else { errFd = fd; errSize = size; }
    } catch { return; }
  }
  if (size + chunk.length > limit) {
    // 先尝试把当前文件移走，成功后才允许截断创建新文件：Windows 上杀软扫描/
    // 短暂占用会让 rename 失败，此时若继续 open('w') 就会把当前批次唯一的
    // 证据截断。rename 直接覆盖旧的 .1（不先删除），失败时旧证据与当前 fd
    // 都保持完整；记录失败供 status/UI 透出，后续超过上限的写入再重试轮转。
    let rotated = false;
    try {
      fs.renameSync(filePath, `${filePath}.1`);
      rotated = true;
    } catch {
      markRotateFailed(stream);
    }
    if (rotated) {
      rotateFailStreak[stream] = 0;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fd = null;
      try {
        fd = fs.openSync(filePath, 'w');
        size = 0;
        markRotated(stream);
      } catch {
        // 新文件创建失败：置空 fd 转为懒重开路径，后续日志仍可继续落盘。
        fd = null;
        markRotateFailed(stream);
      }
      if (isOut) outFd = fd; else errFd = fd;
      if (fd == null) return;
    } else {
      // rename 连续失败仍追加等于移除上限：超阈值后暂停写盘并周期重试轮转，
      // 文件保持在 ~limit + 少量失败窗口增量，不再无界增长（#156）。
      rotateFailStreak[stream] += 1;
      if (rotateFailStreak[stream] >= PAUSE_AFTER_ROTATE_FAILURES) {
        pausedStreams.add(stream);
        supervisorLog(`日志流 ${stream} 轮转连续失败 ${rotateFailStreak[stream]} 次，暂停写盘防无界增长（重试中）`);
        persistRotationState();
        schedulePausedRetry();
        return;
      }
    }
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
  const epoch = ++targetEpoch;
  const child = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  target = child;
  // pidFile 契约：spawn 同步拿到 pid 时立即写入；异步 error（ENOENT/EACCES 等）时写 0，
  // manager 据此快速落 SPAWN_FAILED（无进程产生，可直接重试），不再等窗口超时后
  // 误报 IDENTITY_CAPTURE_FAILED/UNKNOWN，错误原文同时落入 stderr 批次日志。
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { fs.writeFileSync(config.pidFile, String(child.pid)); } catch { /* best effort */ }
  }
  let childSpawnFailed = false;
  child.on('error', (err) => {
    currentSpawnFailed = true;
    childSpawnFailed = true;
    try {
      fs.writeFileSync(config.pidFile, '0');
      const line = `[agent-app-manager] target spawn failed: ${err.code ?? ''} ${err.message} (file=${file})\n`;
      fs.writeSync(errFd, line);
      errSize += Buffer.byteLength(line);
    } catch { /* 尽力而为 */ }
  });
  forward(child.stdout, true);
  forward(child.stderr, false);
  // 退出证据必须在 'exit' 落账：'close' 要等 stdio 全部关闭，若目标派生的子进程继续
  // 持有 stdout/stderr 管道，会延迟到旧 run 已归档之后，导致证据丢失。
  child.on('exit', (code, signal) => {
    if (childSpawnFailed || exitRecorded) return;
    exitInfo = {
      code: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    };
    persistExitState();
  });
  child.on('close', (code, signal) => {
    persistRotationState();
    if (target === child) target = null;
    const exit = { code, signal, spawnFailed: currentSpawnFailed };
    if (ignoredChildren.has(child)) return;
    // 旧代子进程的退出：证据已随上一轮 exit/restart 事件落账，不得当作新目标退出。
    if (epoch !== targetEpoch) return;
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
  // spawn 失败本身是有证据的失败（非"证据不可得"）：折算成 code=1 计入崩溃路径，
  // 与 exitCodeFrom 的口径一致；真实"目标退出但拿不到 code/signal"才走第三态。
  const codeForPlan = exit.spawnFailed && exit.code == null ? 1 : exit.code;
  const plan = planRestart(settings, cur.restartCount ?? 0, codeForPlan, exit.signal);
  const now = new Date().toISOString();
  cur.lastExit = {
    at: now, code: exit.code ?? null, signal: exit.signal ?? null,
    spawnFailed: !!exit.spawnFailed, source: context,
  };
  appendRestartEvent(cur, { type: context === 'restart-attempt' ? 'restart-failed' : 'exit', ...cur.lastExit });
  const evidenceMissing = exit.code == null && exit.signal == null && !exit.spawnFailed;
  const label = context === 'restart-attempt' ? '自动重启尝试失败'
    : (evidenceMissing ? '目标已退出但退出证据不可用' : '进程异常退出');
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
    const notify = claimExitNotify(cur);
    atomicWriteJson(runtimeFile, rt);
    supervisorLog(`${label}（${desc}），不自动重启：${plan.reason}`);
    return { action: 'finalize', code: exitCodeFrom(exit), notify };
  }
  if (plan.action === 'dead') {
    cur.phase = 'DEAD';
    cur.endedAt = now;
    cur.restartCount = plan.restartCount;
    cur.restartState = 'DEAD';
    cur.nextRestartAt = null;
    cur.exitNote = `${label}（${desc}）；自动重启已达上限 ${plan.restartCount}/${settings.maxRestarts}，进入 DEAD`;
    appendRestartEvent(cur, { type: 'dead', reason: 'max-restarts', restartCount: plan.restartCount });
    const notify = claimExitNotify(cur);
    atomicWriteJson(runtimeFile, rt);
    supervisorLog(`自动重启已达上限（${plan.restartCount}/${settings.maxRestarts}），进入 DEAD`);
    return { action: 'finalize', code: exitCodeFrom(exit), notify };
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
  } else if (cur.phase === 'BACKOFF') {
    // 上一轮退出已评估且自动重启在排队：迟到的 wrapper/旧目标 close 不能终止监督。
    supervisorLog('BACKOFF 等待中的迟到退出事件，忽略（重启计时器继续）');
    return { action: 'none' };
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
  else if (outcome.action === 'none') { /* BACKOFF 中的迟到事件：监督继续 */ }
  else {
    await runExitNotify(outcome.notify);
    finalize(outcome.code ?? exitCodeFrom(exit));
  }
}

// 监督 + command 模式：目标已退出但 wrapper 仍存活时 wrapper 'close' 不触发——
// 轮询运行记录中 exit-watcher 写下的退出证据（毫秒级 fs 读，不拉 pwsh）。
// watcher 自身失败（exitWatchError）时核验目标一次，死了按"证据不可得"评估。
function startTargetExitPolling() {
  if (targetExitPoll || !supervised || !config.isCommand) return;
  targetExitPoll = setInterval(() => {
    if (finishing) return;
    const cur = readCurrentRun();
    if (cur === undefined || !cur || cur.runId !== runId || cur.phase !== 'RUNNING') return;
    if (cur.exit) {
      clearInterval(targetExitPoll);
      targetExitPoll = null;
      void onTargetExit({ code: cur.exit.code ?? null, signal: cur.exit.signal ?? null, spawnFailed: false });
      return;
    }
    if (!exitWatchErrorChecked && cur.exitWatchError) {
      exitWatchErrorChecked = true;
      try {
        if (verifyRun(cur).alive === false) {
          clearInterval(targetExitPoll);
          targetExitPoll = null;
          void onTargetExit({ code: null, signal: null, spawnFailed: false });
        }
      } catch { /* 核验失败保持现状，等 wrapper/下一个证据周期 */ }
    }
  }, 1000);
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
      // 旧目标的退出证据属于上一代：不带入新一轮 RUNNING，否则新目标的
      // exit 轮询/UI 会把旧 code 误当成本轮结果。
      cur.exit = null;
      cur.exitWatchError = null;
      cur.wrapperExit = null;
      cur.restartStartedAt = new Date().toISOString();
      appendRestartEvent(cur, { type: 'restarted', attempt: cur.restartCount, pid: cur.pid, image: cur.image });
      atomicWriteJson(runtimeFile, rt);
      // 新一轮目标接管 exit 证据：旧目标的退出已写入 restartEvents/lastExit。
      exitInfo = null;
      exitRecorded = false;
      attempt.state = 'succeeded';
      if (config.isCommand) {
        // command 模式的新目标与 wrapper 不同 pid 时必须重建 exit-watcher（#152）：
        // 没有它目标真实退出无人感知；失败写 exitWatchError 而非静默。
        const ready = await startTargetExitWatcherAsync(home, appId, runId, cur);
        if (!ready) {
          cur.exitWatchError = { reason: '自动重启后退出监视未能就绪', at: new Date().toISOString(), source: 'supervisor' };
          atomicWriteJson(runtimeFile, rt);
        }
        exitWatchErrorChecked = false;
      }
      supervisorLog(`自动重启成功（第 ${cur.restartCount}/${settings.maxRestarts} 次），pid=${cur.pid}`);
      startTargetExitPolling();
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
  else if (outcome.action === 'finalize') {
    await runExitNotify(outcome.notify);
    finalize(outcome.code ?? 1);
  } else if (outcome.action === 'running') {
    // 成功重启：继续持有 logger/监督进程。目标若在身份采集完成前已退出，
    // deferredExit 存在，再按正常退出路径重新评估，避免停在伪 RUNNING。
    if (outcome.deferredExit) {
      await sleep(0);
      void onTargetExit(outcome.deferredExit);
    }
  } else finalize(0);
}

spawnTarget({ initial: true });
startTargetExitPolling();
