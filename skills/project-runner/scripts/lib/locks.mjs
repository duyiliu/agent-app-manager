// Cross-process advisory locks: holder identity is verified against the live
// process before a stale lock may be reclaimed; corrupted locks are never fixed.
import fs from 'node:fs';
import { lockPath } from './store.mjs';
import { psProc, selfIdentityCapture } from './probe.mjs';
import { conflictError, dataError } from './errors.mjs';

function holderAlive(holder) {
  if (!holder || typeof holder.pid !== 'number' || typeof holder.creationFileTime !== 'string') {
    throw dataError('LOCK_CORRUPT', `锁文件信息不完整，拒绝静默处理；人工核验后删除：${lockPath(holder ? holder.name : '')}`);
  }
  const r = psProc('capture', { id: holder.pid });
  if (r.result === 'notfound' || r.result === 'exited') return false; // 明确已退出 → 持有者已死
  if (r.result !== 'ok') return true; // 权限不足等未知情形：保守视为存活，拒绝回收
  return String(r.creationFileTime) === String(holder.creationFileTime); // 复用 → 视为死锁可回收
}

function acquireLock(home, name, op) {
  const file = lockPath(home, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
      let holder;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e2) {
        throw dataError('LOCK_CORRUPT', `锁文件损坏，拒绝静默处理；人工核验后删除：${file}（${e2.message}）`);
      }
      if (!holder || typeof holder !== 'object') {
        throw dataError('LOCK_CORRUPT', `锁文件内容不是持有者对象，拒绝静默处理；人工核验后删除：${file}`);
      }
      holder.name = name;
      let alive;
      try {
        alive = holderAlive(holder);
      } catch (e3) {
        if (e3.code === 'PWSH_MISSING' || e3.code === 'LOCK_CORRUPT' || e3.code === 'IDENTITY_UNAVAILABLE') throw e3;
        alive = true; // 权限等未知情形：保守视为存活，拒绝回收
      }
      if (alive) throw conflictError('LOCK_BUSY', `另一操作进行中（${holder.op ?? '?'}，pid=${holder.pid}），拒绝并发执行`);
      try {
        fs.renameSync(file, `${file}.stale-${Date.now()}`); // 回收死锁，保留现场
      } catch (e4) {
        if (e4.code !== 'ENOENT') throw conflictError('LOCK_STEAL_FAILED', `死锁回收失败：${e4.message}`);
      }
      continue;
    }
    let wrote = false;
    try {
      const me = selfIdentityCapture();
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, creationFileTime: me.creationFileTime, op, at: new Date().toISOString() }) + '\n', 'utf8');
      wrote = true;
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      if (!wrote) {
        // 持有者信息未写入（如 pwsh 不可用）时必须删掉刚创建的空锁，
        // 否则残留空文件会让后续每次调用都报 LOCK_CORRUPT 而永久卡死该应用。
        try { fs.unlinkSync(file); } catch { /* 已被删/回收则忽略 */ }
      }
    }
    return () => {
      try { fs.unlinkSync(file); } catch { /* 已被回收则忽略 */ }
    };
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

export function lockHeld(home, name) {
  return fs.existsSync(lockPath(home, name));
}

// 只读查询锁状态：文件不存在 → 未持有；持有者已退出/PID 复用 → alive=false。
// 锁损坏或权限不足时保守视为仍持有（alive=true），不把无法核验误判成启动中断。
export function lockState(home, name) {
  const file = lockPath(home, name);
  if (!fs.existsSync(file)) return { held: false, alive: false };
  let holder;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { held: true, alive: true, corrupt: true }; }
  if (!holder || typeof holder !== 'object') return { held: true, alive: true, corrupt: true };
  holder.name = name;
  try {
    return { held: true, alive: holderAlive(holder), pid: holder.pid, op: holder.op ?? null };
  } catch (e) {
    return { held: true, alive: true, error: e.code ?? 'UNKNOWN' };
  }
}
