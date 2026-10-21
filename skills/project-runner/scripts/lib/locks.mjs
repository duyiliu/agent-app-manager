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
      holder.name = name;
      let alive;
      try {
        alive = holderAlive(holder);
      } catch (e3) {
        if (e3.code === 'PWSH_MISSING') throw e3;
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
