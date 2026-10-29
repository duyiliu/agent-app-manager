// 跨进程互斥锁：open(file, 'wx') 由内核保证原子性，只有一个进程能创建成功。
// 锁文件里只记录持有者（pid/op/时间），用于冲突提示与 status 展示。
//
// 死锁清理刻意不做自动化：「判断持有者是否已死」在 Windows 上要起 PowerShell（数百毫秒），
// 判断与动手之间锁可能已被释放并重建，自动回收会把活锁抢走、制造两个持有者。
// 因此残留锁只报 LOCK_BUSY 并给出确切文件路径，由人（或 Agent）确认后删除。
import fs from 'node:fs';
import { lockPath } from './store.mjs';
import { psProc } from './probe.mjs';
import { sleepSync } from './proc.mjs';
import { conflictError, dataError } from './errors.mjs';

// 并发抢锁时的短暂重试：EEXIST 可能只是持有者刚释放；
// 重试 open 不依赖对锁内容的任何解释，因此不会引入误判。
const ACQUIRE_ATTEMPTS = 4;
const ACQUIRE_RETRY_MS = 5;
const REGISTRY_RETRIES = 40;

export function readLockHolder(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const holder = JSON.parse(raw);
    return holder && typeof holder === 'object' && Number.isInteger(holder.pid) ? holder : null;
  } catch {
    return null;
  }
}

// pid 存活判断：只用于 status 展示与冲突提示，不参与任何自动回收动作。
export function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = psProc('capture', { id: pid });
  return !(r.result === 'notfound' || r.result === 'exited');
}

function releaseLock(file) {
  // 只删自己的锁：持有期间文件可能已被替换，无条件 unlink 会删掉别人的锁。
  const holder = readLockHolder(file);
  if (!holder || holder.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* 已不存在 */ }
}

function acquireLock(home, name, op) {
  const file = lockPath(home, name);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
      if (attempt < ACQUIRE_ATTEMPTS - 1) {
        sleepSync(ACQUIRE_RETRY_MS);
        continue;
      }
      const holder = readLockHolder(file);
      const who = holder ? `pid=${holder.pid}，op=${holder.op ?? '?'}` : '持有者信息不可读';
      throw conflictError('LOCK_BUSY',
        `另一 manager 正在操作（${who}）；确认该进程已退出后删除 ${file} 再重试`,
        { pid: holder?.pid ?? null, op: holder?.op ?? null, file });
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }) + '\n', 'utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    return () => releaseLock(file);
  }
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

export function withLock(home, name, op, fn) {
  const release = acquireLock(home, name, op);
  try {
    return fn();
  } finally {
    release();
  }
}

// 异步版 withLock：fn 返回 Promise 时锁一直保持到其 settle（用于异步 launch 阶段）。
export async function withLockAsync(home, name, op, fn) {
  const release = acquireLock(home, name, op);
  try {
    return await fn();
  } finally {
    release();
  }
}

// log-writer 的短写与用户命令共用同一把锁；持锁只有一次 write，无需单独路径。
export function withLogEvidenceLock(home, name, op, fn) {
  return withLock(home, name, op, fn);
}

// 注册表全局锁：读改写序列必须串行，否则并发写入会丢更新（#22）。
// 锁顺序固定为 app 锁 → registry 锁；忙时退避重试，不直接拒绝并发启动。
export function withRegistryLock(home, op, fn) {
  for (let i = 0; i < REGISTRY_RETRIES; i++) {
    try {
      return withLock(home, 'registry', op, fn);
    } catch (e) {
      if (e.code !== 'LOCK_BUSY') throw e;
      sleepSync(50 + Math.floor(Math.random() * 50));
    }
  }
  throw conflictError('LOCK_BUSY', '注册表锁竞争超时，拒绝执行');
}

export function lockHeld(home, name) {
  return fs.existsSync(lockPath(home, name));
}

// 只读查询：文件不存在 → 未持有；内容不可解析 → 保守视为持有（corrupt）。
export function lockState(home, name) {
  const file = lockPath(home, name);
  if (!fs.existsSync(file)) return { held: false, alive: false };
  const holder = readLockHolder(file);
  if (!holder) return { held: true, alive: true, corrupt: true };
  try {
    return { held: true, alive: holderAlive(holder.pid), pid: holder.pid, op: holder.op ?? null };
  } catch (e) {
    return { held: true, alive: true, error: e.code ?? 'UNKNOWN' };
  }
}
