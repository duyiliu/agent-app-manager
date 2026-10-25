#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readRuntimeStrict, atomicWriteJson } from './lib/store.mjs';
import { withLock } from './lib/locks.mjs';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch { /* best effort */ }
const { file, args, cwd, outPath, errPath, home, appId, runtimeFile, runId, limit } = config;
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
const pendingRotationStreams = new Set();
let rotationRetryTimer = null;
let rotationRetryAttempts = 0;

function scheduleRotationRetry() {
  if (rotationRetryTimer || rotationRetryAttempts >= 40) return;
  const delay = Math.min(100 * (2 ** Math.min(rotationRetryAttempts, 4)), 2000);
  rotationRetryAttempts++;
  rotationRetryTimer = setTimeout(() => {
    rotationRetryTimer = null;
    for (const stream of [...pendingRotationStreams]) {
      try { rotateStream(stream); } catch { /* 保留 pending，下一轮再试 */ }
    }
    persistRotationState();
    if (pendingRotationStreams.size) scheduleRotationRetry();
  }, delay);
  rotationRetryTimer.unref?.();
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

// 轮转只有在 rename 成功后才允许创建新的空当前文件。rename 失败时当前文件
// 仍是本批次唯一证据：以 append 重新打开续写（绝不 open('w') 截断），标记
// logRotateFailedStreams 并由定时器稍后重试。
function rotateStream(stream) {
  const isOut = stream === 'stdout';
  const filePath = isOut ? outPath : errPath;
  const rotatePath = `${filePath}.1`;
  try { fs.closeSync(isOut ? outFd : errFd); } catch { /* already closed */ }
  try { fs.unlinkSync(rotatePath); } catch { /* absent or blocked */ }
  try {
    fs.renameSync(filePath, rotatePath);
  } catch {
    let recovered = null;
    try { recovered = fs.openSync(filePath, 'a'); } catch { /* 转为懒重开 */ }
    if (recovered == null) {
      if (isOut) outFd = null; else errFd = null;
    } else {
      const size = (() => { try { return fs.statSync(filePath).size; } catch { return isOut ? outSize : errSize; } })();
      if (isOut) { outFd = recovered; outSize = size; } else { errFd = recovered; errSize = size; }
    }
    pendingRotationStreams.add(stream);
    markRotateFailed(stream);
    scheduleRotationRetry();
    return false;
  }
  try {
    const fresh = fs.openSync(filePath, 'w');
    if (isOut) { outFd = fresh; outSize = 0; } else { errFd = fresh; errSize = 0; }
    pendingRotationStreams.delete(stream);
    rotationRetryAttempts = 0;
    markRotated(stream);
    return true;
  } catch {
    // rename 已成功，旧内容安全保留在 .1；新文件留给懒重开（append）重建。
    if (isOut) outFd = null; else errFd = null;
    pendingRotationStreams.delete(stream);
    markRotateFailed(stream);
    return false;
  }
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// pidFile 契约：spawn 同步拿到 pid 时立即写入；异步 error（ENOENT/EACCES 等）时写 0，
// manager 据此快速落 SPAWN_FAILED（无进程产生，可直接重试），不再等窗口超时后
// 误报 IDENTITY_CAPTURE_FAILED/UNKNOWN，错误原文同时落入 stderr 批次日志。
if (Number.isInteger(target.pid) && target.pid > 0) {
  fs.writeFileSync(config.pidFile, String(target.pid));
}
let spawnFailed = false;
target.on('error', (err) => {
  spawnFailed = true;
  try {
    fs.writeFileSync(config.pidFile, '0');
    const line = `[project-runner] target spawn failed: ${err.code ?? ''} ${err.message} (file=${file})\n`;
    fs.writeSync(errFd, line);
  } catch { /* 尽力而为 */ }
  process.exitCode = 1;
});
function writeChunk(stream, input) {
  const isOut = stream === 'stdout';
  let chunk = input;
  let fd = isOut ? outFd : errFd;
  let size = isOut ? outSize : errSize;
  const filePath = isOut ? outPath : errPath;
  if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
  if (fd == null) {
    // 此前轮转失败/重开失败（标记过 rotateFailed）：懒重开——append 模式，
    // 若 rename 当时也失败则旧内容仍在，append 续写不覆盖；仍失败则丢本
    // chunk 等下次再试，日志管道故障绝不波及目标进程。
    try {
      fd = fs.openSync(filePath, 'a');
      size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
      if (isOut) { outFd = fd; outSize = size; } else { errFd = fd; errSize = size; }
    } catch { return; }
  }
  if (size + chunk.length > limit && !pendingRotationStreams.has(stream)) {
    rotateStream(stream);
    fd = isOut ? outFd : errFd;
    size = isOut ? outSize : errSize;
    if (fd == null) return;
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
forward(target.stdout, true);
forward(target.stderr, false);
// 'close' 在进程终止且 stdio 管道全部关闭后才触发：退出瞬间管道里残余的数据
// 都已在 'data' 回调写完，此时再关日志 fd 不会丢临终输出；'exit' 事件无此保证。
target.on('close', (code, signal) => {
  if (rotationRetryTimer) {
    clearTimeout(rotationRetryTimer);
    rotationRetryTimer = null;
  }
  pendingRotationStreams.clear();
  persistRotationState();
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  if (!spawnFailed) process.exitCode = code ?? (signal ? 1 : 0);
});
