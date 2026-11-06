#!/usr/bin/env node
// 批量/统计功能点冒烟：status --stats、stop --with-dependents、logs --tag、sample 命令。
// 夹具与 manager-smoke 同口径：process.execPath 作假 exe 起真实进程，隔离 --home。
// 用法：node scripts/test/batch-stats-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { hasProcessProbe } from './platform.mjs';
import { sleep, runManagerWithLockRetry } from './lib.mjs';
import { readRuntimeStrict } from '../lib/store.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-batch-stats-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const root = fs.realpathSync(proj);

const run = (args, opts) => runManagerWithLockRetry(home, args, opts);

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const lifecycle = (name, fn) => {
  if (!hasProbe) { skipped.push(name); console.log(`  skip  ${name}（缺进程探针）`); return; }
  check(name, fn);
};
const expectOk = (r) => {
  assert.equal(r.code, 0, `退出码期望 0，实际 ${r.code}\n${r.stdout}${r.stderr}`);
  assert.equal(r.json?.ok, true, `JSON ok 期望 true：${r.stdout}`);
  return r.json.data;
};
const expectErr = (r, code, errCode) => {
  assert.equal(r.code, code, `退出码期望 ${code}，实际 ${r.code}\n${r.stdout}${r.stderr}`);
  if (errCode) assert.equal(r.json?.error?.code, errCode, r.stdout);
  return r.json;
};

const hasProbe = hasProcessProbe();
if (!hasProbe) console.log('（缺进程探针：仅执行不依赖进程核验的断言）');

const descFor = (alias, extra = {}) => {
  const f = path.join(base, `desc-${alias}.json`);
  fs.writeFileSync(f, JSON.stringify({
    alias, root, entry: alias, mode: 'proc',
    exe: process.execPath,
    args: ['-e', 'console.log(`' + alias + '-ready`);setInterval(()=>{},500)'],
    ...extra,
  }));
  return f;
};
const waitPhase = (alias, want, timeoutMs = 15000) => {
  const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  const appId = Object.values(reg.apps).find((a) => a.alias === alias)?.appId;
  for (let i = 0; i < timeoutMs / 200; i++) {
    const rt = appId ? readRuntimeStrict(home, appId) : null;
    if (rt?.current?.phase === want) return rt.current;
    sleep(200);
  }
  throw new Error(`${alias} 未在 ${timeoutMs}ms 内进入 ${want}`);
};

try {
  // ---------- status --stats / --history 统计 ----------
  lifecycle('status --stats：聚合运行历史为统计', () => {
    expectOk(run(['start-new', '--desc', descFor('statsapp')]));
    waitPhase('statsapp', 'RUNNING');
    // 第一次人为停止 → stopped
    expectOk(run(['stop', 'statsapp']));
    // 重启后杀掉进程（SIGKILL）→ status 首次观测落账为 crash
    expectOk(run(['restart', 'statsapp']));
    const cur = waitPhase('statsapp', 'RUNNING');
    try { process.kill(cur.pid, 'SIGKILL'); } catch { /* 已退出则按既有证据断言 */ }
    for (let i = 0; i < 50; i++) {
      const st = expectOk(run(['status', 'statsapp']));
      if (st.status !== 'RUNNING') break;
      sleep(200);
    }
    const st = expectOk(run(['status', 'statsapp', '--stats']));
    const s = st.stats;
    assert.ok(s.runs >= 2, `runs>=2：${JSON.stringify(s)}`);
    assert.ok(s.stoppedByUser >= 1, `stoppedByUser>=1：${JSON.stringify(s)}`);
    assert.ok(s.crashes + s.dead >= 1, `crashes/dead>=1：${JSON.stringify(s)}`);
    assert.ok(s.avgDurationMs != null && s.maxDurationMs != null, `时长聚合缺失：${JSON.stringify(s)}`);
    assert.ok(s.lastCrash, `lastCrash 缺失：${JSON.stringify(s)}`);
    // 未结束历史为空时的形状
    expectOk(run(['start-new', '--desc', descFor('freshapp')]));
    waitPhase('freshapp', 'RUNNING');
    const fs0 = expectOk(run(['status', 'freshapp', '--stats']));
    assert.equal(fs0.stats.runs, 0);
    assert.match(fs0.stats.note ?? '', /无已结束运行历史/);
    expectOk(run(['stop', 'freshapp']));
  });

  // ---------- stop --with-dependents ----------
  lifecycle('stop --with-dependents：依赖方先停、目标后停', () => {
    expectOk(run(['start-new', '--desc', descFor('dep-b')]));
    waitPhase('dep-b', 'RUNNING');
    expectOk(run(['start-new', '--desc', descFor('dep-a', { dependsOn: ['dep-b'] })]));
    waitPhase('dep-a', 'RUNNING');
    const r = expectOk(run(['stop', 'dep-b', '--with-dependents']));
    assert.deepEqual(r.dependentsStopped?.map((d) => d.alias), ['dep-a'], JSON.stringify(r));
    const stA = expectOk(run(['status', 'dep-a']));
    const stB = expectOk(run(['status', 'dep-b']));
    assert.notEqual(stA.status, 'RUNNING', `dep-a 应先被停止：${stA.status}`);
    assert.notEqual(stB.status, 'RUNNING', `dep-b 应已停止：${stB.status}`);
    // 依赖方已停时再停目标：dependents 重试成功（已停不报错）
    const again = expectOk(run(['stop', 'dep-b', '--with-dependents']));
    assert.equal(again.result, 'alreadyStopped');
  });

  // ---------- logs --tag 批量合并 ----------
  lifecycle('logs --tag：多应用 current 批次交错合并 + 跳过无批次', () => {
    expectOk(run(['start-new', '--desc', descFor('tl-a', { tags: ['loggrp'] })]));
    expectOk(run(['start-new', '--desc', descFor('tl-b', { tags: ['loggrp'] })]));
    waitPhase('tl-a', 'RUNNING');
    waitPhase('tl-b', 'RUNNING');
    // 无批次的登记应用同标签：应在 skipped 中被注明而不是整体失败
    const f = path.join(base, 'desc-unmanaged.json');
    fs.writeFileSync(f, JSON.stringify({ alias: 'tl-c', root, mode: 'proc', tags: ['loggrp'] }));
    expectOk(run(['record-unmanaged', '--desc', f]));

    const d = expectOk(run(['logs', '--tag', 'loggrp']));
    assert.equal(d.tagMode, true);
    const aliases = new Set(d.apps.map((a) => a.alias));
    assert.deepEqual(aliases, new Set(['tl-a', 'tl-b']));
    assert.ok(d.lines.some((l) => l.alias === 'tl-a' && l.line.includes('tl-a-ready')), JSON.stringify(d.lines.slice(0, 5)));
    assert.ok(d.lines.some((l) => l.alias === 'tl-b' && l.line.includes('tl-b-ready')));
    assert.ok(d.lines.every((l) => typeof l.src === 'string' && l.src.startsWith('run:')), '行内应带 src 定位符');
    assert.ok(d.skipped?.some((s) => s.alias === 'tl-c'), `tl-c 应进 skipped：${JSON.stringify(d.skipped)}`);
    assert.match(d.note ?? '', /跳过/);
    // --stream stdout 单流模式
    const d2 = expectOk(run(['logs', '--tag', 'loggrp', '--stream', 'stdout']));
    assert.ok(d2.lines.every((l) => l.stream === 'stdout'));
    expectOk(run(['stop', '--tag', 'loggrp']));
    expectOk(run(['stop', '--tag', 'loggrp'])); // tl-c 非受管，幂等
  });
  check('logs --tag：互斥与参数校验', () => {
    expectErr(run(['logs', '--tag', 'loggrp', '--src', 'run:x']), 1, 'USAGE');
    expectErr(run(['logs', '--tag', 'loggrp', '--run', 'r1']), 1, 'USAGE');
    expectErr(run(['logs', '--tag', 'loggrp', '--lines', '0']), 1, 'USAGE');
    expectErr(run(['logs', '--tag', 'no-such-tag-xyz']), 2, 'NOT_FOUND');
  });

  // ---------- sample 命令 ----------
  lifecycle('sample 命令：RUNNING 采样 → STOPPED 不采样', () => {
    expectOk(run(['start-new', '--desc', descFor('sampler')]));
    const cur = waitPhase('sampler', 'RUNNING');
    const d = expectOk(run(['sample', 'sampler']));
    assert.equal(d.alias, 'sampler');
    assert.equal(d.runId, cur.runId);
    assert.ok(d.available, `RUNNING 应可采样：${JSON.stringify(d)}`);
    assert.ok(d.rssBytes > 0, `rssBytes>0：${JSON.stringify(d)}`);
    expectOk(run(['stop', 'sampler']));
    const d2 = expectOk(run(['sample', 'sampler']));
    assert.equal(d2.available, false, `STOPPED 不应采样：${JSON.stringify(d2)}`);
    expectErr(run(['sample', 'ghost-alias']), 2, 'NOT_FOUND');
  });
} finally {
  // 尽力清理可能存活的假进程
  for (const alias of ['statsapp', 'freshapp', 'dep-a', 'dep-b', 'tl-a', 'tl-b', 'sampler']) {
    try { run(['stop', alias]); } catch { /* 已停或从未启动 */ }
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟：清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺进程探针）`);
console.log('\nbatch stats smoke ok');
