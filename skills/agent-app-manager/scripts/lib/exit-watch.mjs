// command 模式的目标退出 watcher：log-writer 只能看到 shell wrapper，真实目标由
// discover 找到；目标与 wrapper 不同 pid 时启动 detached watcher，用目标自身身份
// 等待其真实退出，避免把 wrapper 的普通退出当成目标 code/signal。
// launch.mjs 首启路径与 log-writer.mjs 自动重启路径共用：同步版（启动管道内
// Atomics.wait）与异步版（监督进程内不冻结事件循环）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXIT_WATCHER = path.join(SCRIPTS_DIR, 'exit-watcher.mjs');
const READY_TIMEOUT_ITERATIONS = 250; // 250 × 20ms = 5s

function needsWatcher(cur) {
  if (!Number.isInteger(cur?.pid) || cur.pid <= 0 || !cur.creationFileTime) return false;
  // shell exec 后 wrapper 就是目标，log-writer 自身已有精确 exit 事件，无需 watcher。
  if (Number.isInteger(cur.wrapperPid) && cur.pid === cur.wrapperPid) return false;
  return true;
}

function spawnWatcher(home, appId, runId, cur, readyFile) {
  const watcher = spawn(process.execPath, [
    EXIT_WATCHER, home, appId, runId, String(cur.pid), String(cur.creationFileTime), readyFile,
  ], { cwd: path.dirname(readyFile), detached: true, windowsHide: true, stdio: 'ignore' });
  watcher.unref();
}

export function startTargetExitWatcher(home, appId, runId, cur) {
  if (!needsWatcher(cur)) return true;
  const logDir = cur.logPaths ? path.dirname(cur.logPaths.stdout) : SCRIPTS_DIR;
  const readyFile = path.join(logDir, `.${runId}.exit-watch.ready`);
  let ready = false;
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  try {
    spawnWatcher(home, appId, runId, cur, readyFile);
    // 等 helper 真正持有目标句柄/pidfd 后再返回启动成功；否则目标可能在 watcher
    // 就绪前退出并被 wrapper 回收，真实退出证据永久缺失。
    for (let i = 0; i < READY_TIMEOUT_ITERATIONS && !fs.existsSync(readyFile); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    ready = fs.existsSync(readyFile);
  } catch { /* 下面按未就绪处理 */ }
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  return ready;
}

export async function startTargetExitWatcherAsync(home, appId, runId, cur) {
  if (!needsWatcher(cur)) return true;
  const logDir = cur.logPaths ? path.dirname(cur.logPaths.stdout) : SCRIPTS_DIR;
  const readyFile = path.join(logDir, `.${runId}.exit-watch.ready`);
  let ready = false;
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  try {
    spawnWatcher(home, appId, runId, cur, readyFile);
    // 与同步版同语义的就绪等待，但用异步 sleep 避免冻结监督进程的事件循环。
    for (let i = 0; i < READY_TIMEOUT_ITERATIONS && !fs.existsSync(readyFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ready = fs.existsSync(readyFile);
  } catch { /* 下面按未就绪处理 */ }
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  return ready;
}
