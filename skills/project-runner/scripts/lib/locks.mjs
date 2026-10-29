// Cross-process advisory locks: holder identity is verified against the live
// process before a stale lock may be reclaimed; corrupted locks are never fixed.
import fs from 'node:fs';
import { lockPath } from './store.mjs';
import { psProc, selfIdentityCapture } from './probe.mjs';
import { sleepSync } from './proc.mjs';
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

// 读取锁持有者，容忍「创建完成但内容还没落盘」的极短窗口：
// - ok：读到含 pid 的持有者；
// - gone：文件已不存在——EEXIST 之后持有者恰好 release（unlink）或被并发回收，
//   这是正常竞争而不是损坏，调用方必须回到 openSync 重试；
// - incomplete：文件仍在但内容始终不可解析/缺 pid，才按 LOCK_CORRUPT 拒绝静默处理。
const HOLDER_READ_ATTEMPTS = 4;

function readHolder(file) {
  for (let i = 0; i < HOLDER_READ_ATTEMPTS; i++) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { state: 'gone' };
      return { state: 'incomplete' };
    }
    let holder = null;
    try { holder = JSON.parse(raw); } catch { holder = null; }
    if (holder && typeof holder === 'object' && typeof holder.pid === 'number') return { state: 'ok', holder };
    if (i < HOLDER_READ_ATTEMPTS - 1) sleepSync(50);
  }
  return { state: 'incomplete' };
}

// 占位持有者（pid 有值、creationFileTime 未补全）只能按 pid 查存活：进程明确
// 已退出才可回收；存活或无法核验一律保守视为存活（无法排除 PID 复用）。
function placeholderAlive(holder) {
  const r = psProc('capture', { id: holder.pid });
  if (r.result === 'notfound' || r.result === 'exited') return false;
  return true;
}

// 获取失败/回收失败都会回到循环重试：单次 EEXIST 可能只是撞上别人的释放窗口，
// 不能因为「第二次看文件不见了」就判定锁损坏。
const ACQUIRE_ATTEMPTS = 5;
let stealSeq = 0;

// 锁文件的身份戳：新锁 = 新 inode，据此判断「判死的那把锁」是否已被换掉。
function fileStamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

// 损坏锁的现场摘要：没有它，「人工核验后删除」等于让人猜。
function lockEvidence(file) {
  try {
    const s = fs.statSync(file);
    let head;
    try { head = JSON.stringify(fs.readFileSync(file, 'utf8').slice(0, 64).replace(/\s+/g, ' ')); }
    catch { head = '<不可读>'; }
    return `size=${s.size} mtime=${s.mtime.toISOString()} inode=${s.ino} head=${head}`;
  } catch {
    return '文件已消失';
  }
}

// 回收死锁：rename 是唯一的原子宣告，但 rename 只认路径、不认身份。
// 「判定持有者已死亡」到「rename」之间，锁可能已被释放并被别人重新创建
// （探针耗时可达数百毫秒），此时 rename 抢走的是一把活锁，会制造两个持有者。
// 两道校验：rename 前比对 inode 戳，rename 后重读内容确认身份；抢错就原子还原。
function reclaimDeadLock(file, holder, expectedStamp) {
  if (fileStamp(file) !== expectedStamp) return { status: 'replaced' };
  const stale = `${file}.stale-${Date.now()}-${process.pid}-${++stealSeq}`;
  try {
    fs.renameSync(file, stale);
  } catch (e) {
    return { status: 'rename-failed', error: e };
  }
  let stolen = null;
  try { stolen = JSON.parse(fs.readFileSync(stale, 'utf8')); } catch { stolen = null; }
  const sameHolder = stolen && stolen.pid === holder.pid
    && String(stolen.creationFileTime ?? '') === String(holder.creationFileTime ?? '');
  if (sameHolder) return { status: 'reclaimed', stale };
  try {
    fs.linkSync(stale, file); // 目标已存在则失败：绝不覆盖别人的新锁
    fs.unlinkSync(stale);
  } catch (e) {
    throw conflictError('LOCK_STEAL_RACE', `回收竞态：锁在判定期间被替换且无法还原（${e.message}）`);
  }
  return { status: 'replaced' };
}

function acquireLock(home, name, op, { light = false } = {}) {
  const file = lockPath(home, name);
  // 身份采集只读自身 pid，与锁无关。放在创建锁之前：Windows 上 pwsh 冷启动可达 1 秒，
  // 留在临界区内会把持锁时间放大四个数量级，顺带放大所有回收/BUSY 竞态窗口。
  const me = light ? null : selfIdentityCapture();
  const selfFt = me ? String(me.creationFileTime) : null;
  let lastStealError = null;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
      const read = readHolder(file);
      // 持有者在我们 open 失败后立刻释放：直接重试创建，不等待也不判损坏。
      if (read.state === 'gone') { sleepSync(10); continue; }
      if (read.state !== 'ok') {
        throw dataError('LOCK_CORRUPT', `锁文件损坏，拒绝静默处理；人工核验后删除：${file}（${lockEvidence(file)}）`);
      }
      const holder = read.holder;
      holder.name = name;
      // 判定用的快照：探针期间（可达数百毫秒）锁可能被换掉，戳变了就必须重新竞争。
      const heldStamp = fileStamp(file);
      let alive;
      try {
        alive = holder.creationFileTime ? holderAlive(holder) : placeholderAlive(holder);
      } catch (e3) {
        if (e3.code === 'PWSH_MISSING' || e3.code === 'LOCK_CORRUPT' || e3.code === 'IDENTITY_UNAVAILABLE') throw e3;
        alive = true; // 权限等未知情形：保守视为存活，拒绝回收
      }
      if (alive) throw conflictError('LOCK_BUSY', `另一操作进行中（${holder.op ?? '?'}，pid=${holder.pid}），拒绝并发执行`, { pid: holder.pid, op: holder.op ?? null });
      const r = reclaimDeadLock(file, holder, heldStamp);
      if (r.status === 'reclaimed' || r.status === 'replaced') { sleepSync(5); continue; }
      if (r.status === 'rename-failed') {
        const c = r.error.code;
        if (c === 'ENOENT') continue; // 已被持有者释放或被其他进程回收
        // Windows：源文件处于删除挂起（并发释放）时 rename 报 EPERM/EACCES/EBUSY，
        // 短暂让出后重试；真正无权限时由循环出口按最后一次错误报告。
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(c)) {
          lastStealError = r.error;
          sleepSync(20);
          continue;
        }
        throw conflictError('LOCK_STEAL_FAILED', `死锁回收失败：${r.error.message}`);
      }
      continue;
    }
    let wrote = false;
    try {
      // 身份已在锁外采集完毕，锁内只做一次写：持锁时间从 ~1s 降到 ~100µs（#22）。
      const holder = light
        ? { pid: process.pid, op, at: new Date().toISOString() }
        : { pid: process.pid, creationFileTime: selfFt, op, at: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(holder) + '\n', 'utf8');
      wrote = true;
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      if (!wrote) {
        // 持有者信息未写入（如磁盘满）时必须删掉刚创建的空锁，
        // 否则残留空文件会让后续每次调用都报 LOCK_CORRUPT 而永久卡死该应用。
        try { fs.unlinkSync(file); } catch { /* 已被删/回收则忽略 */ }
      }
    }
    // 释放只删自己的锁：持有期间锁可能被回收/替换（死锁误判、PID 复用），
    // 无条件 unlink 会把别人的锁删掉，等于给下一个进程开门。
    return () => {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      if (!holder || holder.pid !== process.pid) return;
      if (selfFt && String(holder.creationFileTime ?? '') !== selfFt) return;
      try { fs.unlinkSync(file); } catch { /* 已被回收则忽略 */ }
    };
  }
  if (lastStealError) throw conflictError('LOCK_STEAL_FAILED', `死锁回收失败：${lastStealError.message}`);
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

export function withLock(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op);
  try {
    return fn();
  } finally {
    release();
  }
}

// 异步版 withLock：fn 返回 Promise 时锁一直保持到其 settle（用于异步 launch 阶段）。
export async function withLockAsync(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op);
  try {
    return await fn();
  } finally {
    release();
  }
}

// log-writer 专用轻量锁：只写 pid-only 持有者，不做 pwsh 身份采集。
// 仅用于日志轮转/退出证据这类毫秒级内部写；生命周期操作仍用 withLock 的完整身份。
export function withLogEvidenceLock(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op, { light: true });
  try {
    return fn();
  } finally {
    release();
  }
}

// log-writer 每次写完日志轮转/退出证据都可能持有应用锁（Windows 首次建锁需自证身份，
// 可能持续数百毫秒）。这类内部短写不应让用户的 start/stop 偶发 LOCK_BUSY：
// 仅当当前持有者确为 log-* 内部操作时做有界短重试；真实并发启停仍按原语义拒绝。
function acquireLockWithEvidenceRetry(home, name, op, options = {}) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return acquireLock(home, name, op, options);
    } catch (e) {
      const internal = e.code === 'LOCK_BUSY' && typeof e.detail?.op === 'string' && e.detail.op.startsWith('log-');
      if (!internal || attempt === 59) throw e;
      sleepSync(50);
    }
  }
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

// 注册表全局短时锁：任何 readRegistry→修改→atomicWriteJson 序列都必须在其中执行，
// 否则不同 appId 并发写入会丢更新（#22）。锁顺序固定为 app 锁 → registry 锁。
// 持有者每次只读写一瞬间，忙时做有界短重试而不是直接拒绝并发启动。
export function withRegistryLock(home, op, fn) {
  for (let i = 0; i < 100; i++) {
    try {
      return withLock(home, 'registry', op, fn);
    } catch (e) {
      // LOCK_STEAL_RACE：回收死锁时发现锁已被替换且无法还原，属于瞬时竞争，退避重试。
      if (e.code !== 'LOCK_BUSY' && e.code !== 'LOCK_STEAL_RACE') throw e;
      sleepSync(50 + Math.floor(Math.random() * 50));
    }
  }
  throw conflictError('LOCK_BUSY', '注册表锁竞争超时，拒绝执行');
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
