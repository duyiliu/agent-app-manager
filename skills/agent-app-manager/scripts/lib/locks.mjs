// 跨进程互斥锁：open(file, 'wx') 由内核保证原子性，只有一个进程能创建成功。
// 锁文件里只记录持有者（pid/op/时间），用于冲突提示与 status 展示。
//
// 死锁清理刻意不做自动化：「判断持有者是否已死」在 Windows 上要起 PowerShell（数百毫秒），
// 判断与动手之间锁可能已被释放并重建，自动回收会把活锁抢走、制造两个持有者。
// 因此残留锁只在排队超时后报 LOCK_BUSY 并给出确切文件路径，由人（或 Agent）确认后删除。
// 持锁者多为收尾短写，取锁默认排队等待（flock -w 语义），超时仍报 LOCK_BUSY。
import fs from 'node:fs';
import { lockPath } from './store.mjs';
import { psProc } from './probe.mjs';
import { conflictError, dataError } from './errors.mjs';

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

// 有界等待（flock -w 语义）：拿不到锁时排队轮询，默认等 AAM_LOCK_WAIT_MS 毫秒，
// 超时仍报 LOCK_BUSY——既不 fail-fast 撞运气，也不无限死等。置 0 恢复立即失败。
// env 在取锁时读（而非模块加载），测试/调用方可在运行中调整预算。
const LOCK_WAIT_DEFAULT_MS = 10000;
const LOCK_WAIT_STEP_MS = 150;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function acquireLock(home, name, op) {
  const file = lockPath(home, name);
  const waitMs = Math.max(0, Number(process.env.AAM_LOCK_WAIT_MS ?? LOCK_WAIT_DEFAULT_MS) || 0);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Windows：文件处于删除挂起（持有者刚 unlink）时创建会报 EPERM/EACCES/EBUSY，
        // 这是瞬时竞争，同样走排队窗口，超时仍按 LOCK_BUSY 报。
        const transient = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code);
        if (!transient) throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
        if (Date.now() < deadline) { sleepSync(LOCK_WAIT_STEP_MS); continue; }
        throw conflictError('LOCK_BUSY', `锁文件正在重建（${e.code}）；稍后重试`, { code: e.code, file });
      }
      // 排队窗口内持锁者多为短写收尾（log-exit 等），等它放锁即可；超时才是冲突。
      if (Date.now() < deadline) { sleepSync(LOCK_WAIT_STEP_MS); continue; }
      const holder = readLockHolder(file);
      const who = holder ? `pid=${holder.pid}，op=${holder.op ?? '?'}` : '持有者信息不可读';
      throw conflictError('LOCK_BUSY',
        `另一 manager 正在操作（${who}）；稍后重试。若确认该进程已退出，删除 ${file} 后重试`,
        { pid: holder?.pid ?? null, op: holder?.op ?? null, file });
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }) + '\n', 'utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    return () => releaseLock(file);
  }
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
// 锁顺序固定为 app 锁 → registry 锁；忙时同样直接报 LOCK_BUSY，由调用方决定是否重试。
export function withRegistryLock(home, op, fn) {
  return withLock(home, 'registry', op, fn);
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
