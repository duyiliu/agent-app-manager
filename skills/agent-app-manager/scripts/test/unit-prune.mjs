#!/usr/bin/env node
// 单元测试：prune 残留回收计划与执行（retention 外的日志/陈旧锁/孤儿临时文件）。
// 用法：node scripts/test/unit-prune.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { planPrune, applyPrune } from '../lib/prune.mjs';
import { writeRuntime } from '../lib/runtime.mjs';
import { SCHEMA_VERSION } from '../lib/constants.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-prune-'));
const home = path.join(base, 'home');
const appId = 'a0123456789abcde';
const logsDir = path.join(home, 'logs', appId);
const locksDir = path.join(home, 'locks');
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(locksDir, { recursive: true });
fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

try {
  // 运行记录：current=r-cur，prevRuns 保留 r-keep；其余 runId 的日志为可回收对象
  writeRuntime(home, appId, {
    schemaVersion: SCHEMA_VERSION, appId,
    current: { runId: 'r-cur', phase: 'RUNNING', managed: true },
    prevRuns: [{ runId: 'r-keep', phase: 'STOPPED', managed: true }],
  });
  fs.writeFileSync(path.join(logsDir, 'r-cur.stdout.log'), 'cur');
  fs.writeFileSync(path.join(logsDir, 'r-keep.stdout.log'), 'keep');
  fs.writeFileSync(path.join(logsDir, 'r-old.stdout.log'), 'old');
  fs.writeFileSync(path.join(logsDir, 'r-old.stderr.log.1'), 'old-rotated');
  fs.writeFileSync(path.join(logsDir, '.r-old.pid'), '1');
  fs.writeFileSync(path.join(logsDir, 'notalog.txt'), 'x'); // 不匹配语法的文件不动

  fs.writeFileSync(path.join(locksDir, 'registry.lock.stale-123'), 'stale');
  fs.writeFileSync(path.join(locksDir, 'registry.lock'), 'live'); // 非 stale 不动

  // 孤儿临时文件：mtime 超过 60s 才回收；近期修改的视为进行中写入跳过
  const oldTmp = path.join(home, '.tmp-111-abcdef01');
  fs.writeFileSync(oldTmp, 't');
  const past = (Date.now() - 120000) / 1000;
  fs.utimesSync(oldTmp, past, past);
  const newTmp = path.join(home, '.tmp-222-abcdef01');
  fs.writeFileSync(newTmp, 't');

  check('planPrune：保留 current/prevRuns，回收其余 runId 日志与 meta', () => {
    const plan = planPrune(home);
    const files = plan.logs.flatMap((a) => a.files.map((f) => path.basename(f.file))).sort();
    assert.deepEqual(files, ['.r-old.pid', 'r-old.stderr.log.1', 'r-old.stdout.log']);
    assert.equal(plan.staleLocks.length, 1);
    assert.equal(plan.tmpOrphans.length, 1);
    assert.equal(path.basename(plan.tmpOrphans[0].file), '.tmp-111-abcdef01');
    // 近期临时文件与非法/游离条目进 skipped
    assert.ok(plan.skipped.some((s) => s.kind === 'tmp' && path.basename(s.target) === '.tmp-222-abcdef01'));
  });
  check('applyPrune：删除回收对象，保留证据不动', () => {
    const plan = planPrune(home);
    applyPrune(plan);
    assert.ok(!fs.existsSync(path.join(logsDir, 'r-old.stdout.log')));
    assert.ok(!fs.existsSync(path.join(logsDir, 'r-old.stderr.log.1')));
    assert.ok(!fs.existsSync(path.join(logsDir, '.r-old.pid')));
    assert.ok(fs.existsSync(path.join(logsDir, 'r-cur.stdout.log')));
    assert.ok(fs.existsSync(path.join(logsDir, 'r-keep.stdout.log')));
    assert.ok(fs.existsSync(path.join(logsDir, 'notalog.txt')));
    assert.ok(!fs.existsSync(path.join(locksDir, 'registry.lock.stale-123')));
    assert.ok(fs.existsSync(path.join(locksDir, 'registry.lock')));
    assert.ok(!fs.existsSync(oldTmp));
    assert.ok(fs.existsSync(newTmp));
  });
  check('planPrune：无 runtime 记录/非法 appId 目录进 skipped', () => {
    const bad1 = path.join(home, 'logs', 'noapp');
    const bad2 = path.join(home, 'logs', 'BAD ID!');
    fs.mkdirSync(bad1); fs.writeFileSync(path.join(bad1, 'r1.stdout.log'), 'x');
    fs.mkdirSync(bad2); fs.writeFileSync(path.join(bad2, 'r1.stdout.log'), 'x');
    const stray = path.join(home, 'logs', 'stray-file');
    fs.writeFileSync(stray, 'x');
    const plan = planPrune(home);
    const reasons = plan.skipped.map((s) => `${path.basename(s.target)}|${s.reason}`);
    assert.ok(reasons.some((r) => r.startsWith('noapp|') && r.includes('无运行记录')));
    assert.ok(reasons.some((r) => r.startsWith('BAD ID!|') && r.includes('不是合法 appId')));
    assert.ok(reasons.some((r) => r.startsWith('stray-file|') && r.includes('不是目录')));
  });
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nunit prune ok');
