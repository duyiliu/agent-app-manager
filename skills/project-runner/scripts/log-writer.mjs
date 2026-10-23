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
let rotationRetryTimer = null;
let rotationRetryAttempts = 0;

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
  if ([...rotatedStreams].every((stream) => recordedStreams.has(stream))) return;
  try {
    withLock(home, appId, 'log-rotation', () => {
      const rt = readRuntimeStrict(home, appId);
      if (rt?.current?.runId !== runId) {
        for (const stream of rotatedStreams) recordedStreams.add(stream);
        return;
      }
      const streams = new Set([...(rt.current.logRotatedStreams ?? []), ...rotatedStreams]);
      rt.current.logRotated = true;
      rt.current.logRotatedStreams = [...streams];
      atomicWriteJson(runtimeFile, rt);
      for (const stream of rotatedStreams) recordedStreams.add(stream);
    });
  } catch {
    scheduleRotationRetry();
  }
}

function markRotated(stream) {
  rotatedStreams.add(stream);
  persistRotationState();
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// pidFile 契约：spawn 同步拿到 pid 时立即写入；异步 error（ENOENT/EACCES 等）时写 0，
// manager 据此快速落 SPAWN_FAILED（无进程产生，可直接重试），不再等窗口超时后
// 误报 IDENTITY_CAPTURE_FAILED/UNKNOWN，错误原文同时落入 stderr 批次日志。
if (Number.isInteger(target.pid) && target.pid > 0) {
  fs.writeFileSync(config.pidFile, String(target.pid));
}
target.on('error', (err) => {
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
  if (size + chunk.length > limit) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(`${filePath}.1`); } catch { /* absent */ }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* best effort */ }
    fd = fs.openSync(filePath, 'w');
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
forward(target.stdout, true);
forward(target.stderr, false);
target.on('exit', (code, signal) => {
  persistRotationState();
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  process.exitCode = code ?? (signal ? 1 : 0);
});
