#!/usr/bin/env node
// 锁回归：EEXIST 之后持有者恰好释放属于正常竞争，不能被误判成 LOCK_CORRUPT；
// 真正的损坏锁仍必须拒绝静默处理。不触碰真实 ~/.project-runner/。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { withLock, lockState } from '../lib/locks.mjs';
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

// #22 回归：open(file,'wx') 拿到 EEXIST 后，持有者在我们读锁文件之前 release（unlink）。
// 旧实现会在同一路径上空读 4 次并判 LOCK_CORRUPT；正确行为是回到 openSync 重试创建。
check('EEXIST 后锁被释放：重试创建成功，不误判 LOCK_CORRUPT', () => {
  const file = lockOf('gone');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, creationFileTime: 'x', op: 'other' }) + '\n');
  const realRead = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (p, ...rest) {
    if (!injected && path.resolve(String(p)) === path.resolve(file)) {
      injected = true;
      fs.unlinkSync(file); // 持有者紧跟着释放
      const e = new Error('ENOENT: no such file or directory, open');
      e.code = 'ENOENT';
      throw e;
    }
    return realRead.call(fs, p, ...rest);
  };
  try {
    const out = withLock(home, 'gone', 'probe', () => 'acquired');
    assert.equal(out, 'acquired');
    assert.ok(injected, '未注入「锁消失」场景，用例失效');
    assert.ok(!fs.existsSync(file), 'fn 结束后锁应已释放');
  } finally {
    fs.readFileSync = realRead;
  }
});

// 语义保持：内容始终不可解析才是真损坏，必须拒绝并保留现场。
check('锁内容始终非法：拒绝为 LOCK_CORRUPT 且不改写现场', () => {
  const file = lockOf('corrupt');
  fs.writeFileSync(file, 'not-json\n');
  assert.throws(() => withLock(home, 'corrupt', 'probe', () => {}),
    (e) => e.code === 'LOCK_CORRUPT', '期望 LOCK_CORRUPT');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not-json\n', '损坏锁不得被静默删除或改写');
});

// 只读查询与 acquire 同口径：查询期间锁被释放属于正常竞争，
// 不能返回 corrupt，否则 status 会把已释放的启动锁一直显示成「启动中」。
check('lockState：查询期间锁被释放 → 未持有，不误报 corrupt', () => {
  const file = lockOf('state-gone');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, creationFileTime: 'x', op: 'other' }) + '\n');
  const realRead = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (p, ...rest) {
    if (!injected && path.resolve(String(p)) === path.resolve(file)) {
      injected = true;
      fs.unlinkSync(file);
      const e = new Error('ENOENT: no such file or directory, open');
      e.code = 'ENOENT';
      throw e;
    }
    return realRead.call(fs, p, ...rest);
  };
  try {
    const st = lockState(home, 'state-gone');
    assert.equal(st.held, false, `期望未持有：${JSON.stringify(st)}`);
    assert.equal(st.alive, false, `期望 alive=false：${JSON.stringify(st)}`);
  } finally {
    fs.readFileSync = realRead;
  }
});

// 真损坏仍然保守：查询方不能把无法解释的内容当成「锁已释放」。
check('lockState：内容持续非法 → corrupt 且保守视为持有', () => {
  const file = lockOf('state-corrupt');
  fs.writeFileSync(file, 'not-json\n');
  const st = lockState(home, 'state-corrupt');
  assert.equal(st.held, true);
  assert.equal(st.alive, true);
  assert.equal(st.corrupt, true, JSON.stringify(st));
});

// 占位持有者（pid-only）仍存活：保守视为占用，不能回收也不能判损坏。
if (!hasProbe) skip('占位持有者存活 → LOCK_BUSY', '缺进程探针');
else check('占位持有者存活 → LOCK_BUSY', () => {
  const file = lockOf('busy');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, op: 'other', at: new Date().toISOString() }) + '\n');
  assert.throws(() => withLock(home, 'busy', 'probe', () => {}),
    (e) => e.code === 'LOCK_BUSY', '期望 LOCK_BUSY');
  assert.ok(fs.existsSync(file), '存活者的锁不得被回收');
});

// 死锁回收：持有者已退出 → 回收并把现场留成 .stale-*。
if (!hasProbe) skip('死锁持有者已退出 → 回收并保留现场', '缺进程探针');
else check('死锁持有者已退出 → 回收并保留现场', () => {
  const dead = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(dead.pid > 0, `未能取得已退出进程 pid：${dead.error?.message ?? dead.status}`);
  const file = lockOf('stale');
  fs.writeFileSync(file, JSON.stringify({ pid: dead.pid, creationFileTime: '1', op: 'dead' }) + '\n');
  assert.equal(withLock(home, 'stale', 'probe', () => 'acquired'), 'acquired');
  assert.ok(!fs.existsSync(file), '回收后新锁应在 fn 结束时释放');
  assert.ok(fs.readdirSync(locksDir).some((n) => n.startsWith('stale.lock.stale-')),
    `未保留回收现场：${JSON.stringify(fs.readdirSync(locksDir))}`);
});

console.log(failed ? `\n${failed} 项失败` : `\nlocks smoke ok${skipped.length ? `（跳过 ${skipped.length} 项）` : ''}`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
