#!/usr/bin/env node
// 锁回归：只覆盖「创建即互斥」这条主路径。
// 死锁残留不再自动回收（那正是双持有者的来源），由 LOCK_BUSY 提示人工删除。
// 取锁默认排队等待（flock -w 语义），本文件把预算压小让 busy 用例保持快速。
process.env.AAM_LOCK_WAIT_MS = '500';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { withLock, lockState, readLockHolder } from '../lib/locks.mjs';
import { hasProcessProbe } from './platform.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-locks-smoke-'));
const home = path.join(base, 'home');
const locksDir = path.join(home, 'locks');
fs.mkdirSync(locksDir, { recursive: true });
const lockOf = (name) => path.join(locksDir, `${name}.lock`);

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const skip = (name, why) => { skipped.push(name); console.log(`  skip  ${name}（${why}）`); };
const hasProbe = hasProcessProbe();

check('获取后写入自己的 pid，fn 结束后释放', () => {
  const file = lockOf('basic');
  const seen = withLock(home, 'basic', 'probe', () => readLockHolder(file));
  assert.equal(seen?.pid, process.pid, `锁内应记录持有者 pid：${JSON.stringify(seen)}`);
  assert.equal(seen?.op, 'probe');
  assert.ok(!fs.existsSync(file), 'fn 结束后锁应释放');
});

// 并发抢锁：EEXIST 只是「有人先到」，不能删别人的锁，也不能静默当成自己拿到。
check('持有者存活 → LOCK_BUSY，且不动别人的锁', () => {
  const file = lockOf('held');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, op: 'other', at: new Date().toISOString() }) + '\n');
  assert.throws(() => withLock(home, 'held', 'probe', () => {}),
    (e) => e.code === 'LOCK_BUSY', '期望 LOCK_BUSY');
  assert.equal(readLockHolder(file)?.pid, process.pid, '持有者的锁不得被删除或改写');
  fs.unlinkSync(file);
});

// 内容不可读时同样只报冲突：不猜、不删、不自动修复。
check('锁内容不可读 → LOCK_BUSY，保留现场', () => {
  const file = lockOf('unreadable');
  fs.writeFileSync(file, 'not-json\n');
  let err;
  assert.throws(() => withLock(home, 'unreadable', 'probe', () => {}), (e) => {
    err = e;
    return e.code === 'LOCK_BUSY';
  });
  assert.ok(err.message.includes('不可读'), `错误信息应说明持有者不可读：${err.message}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not-json\n', '不可读的锁不得被静默删除');
  fs.unlinkSync(file);
});

// 释放只删自己的：持有期间锁被替换（人工清理后重建、PID 复用）时不能误删。
check('释放时不删别人的锁', () => {
  const file = lockOf('replaced');
  const out = withLock(home, 'replaced', 'probe', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, op: 'other' }) + '\n');
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.ok(fs.existsSync(file), '锁已被替换时不得删除别人的锁');
  assert.equal(readLockHolder(file)?.pid, 999999);
  fs.unlinkSync(file);
});

// 内部证据写也不特殊对待：排队超时后同样报 LOCK_BUSY，不擅自删除。
check('持有者是 log-* 内部写入 → 排队超时同样报 LOCK_BUSY', () => {
  const file = lockOf('internal');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, op: 'log-exit' }) + '\n');
  let err;
  assert.throws(() => withLock(home, 'internal', 'stop', () => {}), (e) => {
    err = e;
    return e.code === 'LOCK_BUSY';
  });
  assert.equal(err.detail?.op, 'log-exit', `detail 应带持有者 op：${JSON.stringify(err.detail)}`);
  assert.ok(fs.existsSync(file), '不得擅自删除内部写入的锁');
  fs.unlinkSync(file);
});

// 新契约（flock -w 语义）：忙时锁内排队重试，窗口内放锁即拿到，不必返回 LOCK_BUSY。
check('排队等待：窗口内放锁即拿到（open 重试 >1 次）', () => {
  const file = lockOf('queued');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, op: 'other' }) + '\n');
  const realOpen = fs.openSync;
  let opens = 0;
  fs.openSync = function (p, flags, ...rest) {
    if (String(flags) === 'wx' && path.resolve(String(p)) === path.resolve(file)) {
      opens++;
      if (opens < 3) { const e = new Error('busy'); e.code = 'EEXIST'; throw e; }
      fs.unlinkSync(file); // 模拟持有者在窗口内放锁
    }
    return realOpen.call(fs, p, flags, ...rest);
  };
  try {
    const out = withLock(home, 'queued', 'probe', () => 'got');
    assert.equal(out, 'got', '窗口内放锁应排队拿到而不是报忙');
    assert(opens >= 3, `锁内应重试 open：实际 ${opens} 次`);
    assert(!fs.existsSync(file), '拿到锁跑完 fn 后应已释放');
  } finally {
    fs.openSync = realOpen;
    try { fs.unlinkSync(file); } catch { /* 已释放 */ }
  }
});

// 排队预算耗尽仍报错：错误面与旧契约一致（LOCK_BUSY + 持有者详情）。
check('排队超时仍报 LOCK_BUSY', () => {
  const file = lockOf('queued-timeout');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, op: 'log-exit', at: new Date().toISOString() }) + '\n');
  const t0 = Date.now();
  let err;
  assert.throws(() => withLock(home, 'queued-timeout', 'stop', () => {}), (e) => {
    err = e;
    return e.code === 'LOCK_BUSY';
  });
  assert(Date.now() - t0 >= 400, `超时应等到预算耗尽：实际 ${Date.now() - t0}ms`);
  assert.equal(err.detail?.op, 'log-exit', 'detail 仍应带持有者 op');
  fs.unlinkSync(file);
});

check('lockState：文件不存在 → 未持有', () => {
  const st = lockState(home, 'absent');
  assert.equal(st.held, false);
  assert.equal(st.alive, false);
});

if (!hasProbe) skip('lockState：持有者已退出 → alive=false', '缺进程探针');
else check('lockState：持有者已退出 → alive=false', () => {
  const file = lockOf('state-dead');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, op: 'other' }) + '\n');
  const st = lockState(home, 'state-dead');
  assert.equal(st.held, true);
  assert.equal(st.alive, false, JSON.stringify(st));
  fs.unlinkSync(file);
});

console.log(failed ? `\n${failed} 项失败` : `\nlocks smoke ok${skipped.length ? `（跳过 ${skipped.length} 项）` : ''}`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
