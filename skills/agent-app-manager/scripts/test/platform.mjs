// 测试辅助：平台探测、可执行文件查找与进程树清理。
// 产品代码不依赖本文件；仅用于让冒烟测试在 Windows / Linux 上一致运行。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnPwsh } from '../lib/probe.mjs';

export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

// Windows 需要 pwsh 7；Linux 需要 /proc 与可用的 Python pidfd API。
export function hasProcessProbe() {
  if (isWindows) {
    // 与产品同口径：PATH 命中 WindowsApps 别名（EPERM）时回退常见安装路径。
    const r = spawnPwsh(['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return !r.error && r.status === 0;
  }
  if (isLinux) {
    try { fs.accessSync('/proc/self/stat', fs.constants.R_OK); } catch { return false; }
    for (const python of ['python3', 'python']) {
      const r = spawnSync(python, ['-c', 'import os,signal; fd=os.pidfd_open(os.getpid()); signal.pidfd_send_signal(fd, 0); os.close(fd)'],
        { encoding: 'utf8', timeout: 10000 });
      if (!r.error && r.status === 0) return true;
      if (r.error?.code !== 'ENOENT') return false;
    }
    return false;
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

// 枚举某 pid 的当前直接子进程：Windows 用 CIM，Linux 用 /proc 的 ppid 字段。
export function childrenOf(pid) {
  if (isWindows) {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout.trim().split(/\r?\n/).map((s) => Number(s.trim())).filter(Number.isInteger);
  }
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return []; }
  const kids = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw;
    try { raw = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    const close = raw.lastIndexOf(')');
    if (close < 0) continue;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    if (Number.parseInt(fields[1], 10) === pid) kids.push(Number(name));
  }
  return kids;
}

// 枚举当时仍在的全部子孙（含多级）；父已死时 Windows 仍保留旧 ppid，Linux 用 /proc。
export function listDescendants(pid) {
  const out = [];
  const seen = new Set();
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf(cur)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// 按命令行/参数匹配进程（用于断言“本轮启动的进程都已退出”）。
export function findProcesses(pattern) {
  const re = new RegExp(pattern);
  if (isWindows) {
    // 排除查询进程自身：它的命令行里带有 pattern 文本，否则会把自己算成匹配项。
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' -and $_.CommandLine -notmatch 'Get-CimInstance' } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout.trim().split(/\r?\n/).map((s) => Number(s.trim())).filter(Number.isInteger);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.trim().split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length > 1 && re.test(parts.slice(1).join(' ')))
    .map((parts) => Number(parts[0]))
    .filter(Number.isInteger);
}

// 测试兜底清理：Windows 结束整棵树，Linux 先尝试进程组再退化为单进程。
// 返回是否成功：清理失败必须由调用方显式报告（不得静默，#46）。
export function killTree(pid) {
  if (!pid) return false;
  if (isWindows) {
    const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 15000 });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* 不在同一进程组 */ }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { /* 已退出 */ }
  return false;
}
