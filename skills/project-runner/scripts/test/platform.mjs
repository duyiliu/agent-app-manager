// 测试辅助：平台探测、可执行文件查找与进程树清理。
// 产品代码不依赖本文件；仅用于让冒烟测试在 Windows / Linux 上一致运行。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

// Windows 需要 pwsh 7（proc.ps1）；Linux 只需要可读的 /proc。
export function hasProcessProbe() {
  if (isWindows) {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return !r.error && r.status === 0;
  }
  if (isLinux) {
    try { fs.accessSync('/proc/self/stat', fs.constants.R_OK); return true; } catch { return false; }
  }
  return false;
}

// 跨平台查找可执行文件：Windows 用 where，Linux 按 PATH 顺序找可执行普通文件。
export function findExecutable(name) {
  if (isWindows) {
    const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status !== 0) return null;
    return r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const cand = path.join(dir, name);
    try {
      if (!fs.statSync(cand).isFile()) continue;
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch { /* 下一个 PATH 目录 */ }
  }
  return null;
}

// 测试兜底清理：Windows 结束整棵树，Linux 先尝试进程组再退化为单进程。
export function killTree(pid) {
  if (!pid) return;
  if (isWindows) {
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10000 }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); return; } catch { /* 不在同一进程组 */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
}
