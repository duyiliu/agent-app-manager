#!/usr/bin/env node
// 依赖编排与登记备份冒烟（#173 / #174）：隔离 --home，不触碰真实数据目录。
// 覆盖：export→import 往返、悬空 dependsOn 只警告不拒绝、DEP_UNKNOWN 前置拒绝、
// 依赖 UNKNOWN 时给出 ack 恢复命令、依赖 STOPPED 时先行启动、依赖 RUNNING 时跳过。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { computeAppId } from '../lib/desc.mjs';
import { checksumOf } from '../lib/commands/backup.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-deps-backup-'));
const home = path.join(base, 'home');
const home2 = path.join(base, 'home2');
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const projRoot = fs.realpathSync.native(proj);
const nodeImage = path.basename(process.execPath);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const runOnce = (targetHome, args) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', targetHome, '--json', ...args],
    { encoding: 'utf8', timeout: 120000, windowsHide: true });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}`, json };
};
// 上一个用例的 detached log-writer 可能仍在写退出记录并持有应用锁：调用方按约定退避重试。
const runAt = (targetHome, args) => {
  let r = runOnce(targetHome, args);
  for (let i = 0; i < 6 && (r.json?.error?.code === 'LOCK_BUSY' || r.json?.error?.detail?.cause === 'LOCK_BUSY'); i++) {
    sleep(250);
    r = runOnce(targetHome, args);
  }
  return r;
};
const ok = (r) => {
  assert.equal(r.json?.ok, true, r.text);
  return r.json.data;
};
const failWith = (r, code) => {
  assert.equal(r.json?.ok, false, r.text);
  assert.equal(r.json.error.code, code, r.text);
  return r.json.error;
};

fs.writeFileSync(path.join(base, 'keeper.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
const keeperCommand = `${process.execPath} ${path.join(base, 'keeper.js')}`;
const writeDesc = (name, desc) => {
  const file = path.join(base, name);
  fs.writeFileSync(file, JSON.stringify({ root: projRoot, cwd: projRoot, mode: 'node', ...desc }), 'utf8');
  return file;
};
const cleanup = [];

try {
  // 1. 依赖应用：登记后停止，用于验证「依赖 STOPPED 时先行启动」。
  const depFile = writeDesc('dep.json', {
    alias: 'dep-a', entry: 'dep', command: keeperCommand, expectedImage: nodeImage,
  });
  assert.equal(ok(runAt(home, ['start-new', '--desc', depFile])).status, 'RUNNING');
  cleanup.push({ home, alias: 'dep-a' });
  ok(runAt(home, ['stop', 'dep-a']));

  // 2. 依赖 STOPPED → 根应用启动时依赖先行启动，结果里 started 指名依赖。
  const rootFile = writeDesc('root.json', {
    alias: 'root-b', entry: 'root', command: keeperCommand, expectedImage: nodeImage, dependsOn: ['dep-a'],
  });
  const rootStart = ok(runAt(home, ['start-new', '--desc', rootFile]));
  cleanup.push({ home, alias: 'root-b' });
  assert.deepEqual(rootStart.dependsOn?.started, ['dep-a'], `依赖未先行启动：${JSON.stringify(rootStart.dependsOn)}`);

  // 3. 依赖已 RUNNING → 跳过而不是重复启动。
  ok(runAt(home, ['stop', 'root-b']));
  const again = ok(runAt(home, ['start', 'root-b']));
  assert.deepEqual(again.dependsOn?.skipped, ['dep-a'], `依赖未按已运行跳过：${JSON.stringify(again.dependsOn)}`);
  ok(runAt(home, ['stop', 'root-b']));

  // 4. export → import 往返：新 home 只登记不启动，干净清单无 warning。
  const backupFile = path.join(base, 'backup.json');
  assert.equal(ok(runAt(home, ['export', '--out', backupFile])).appCount, 2);
  const imported = ok(runAt(home2, ['import', '--from', backupFile]));
  assert.equal(imported.imported.length, 2, `导入条目数异常：${imported.imported.length}`);
  assert.deepEqual(imported.warnings, [], `干净清单不应有 warning：${JSON.stringify(imported.warnings)}`);

  // 5. 悬空 dependsOn：只警告不拒绝，dry-run 输出 danglingDependsOn（#173）。
  const payload = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  payload.apps.find((a) => a.desc.alias === 'root-b').desc.dependsOn = ['ghost-dep'];
  payload.checksum = checksumOf(payload.apps);
  const danglingFile = path.join(base, 'backup-dangling.json');
  fs.writeFileSync(danglingFile, JSON.stringify(payload), 'utf8');
  const dry = ok(runAt(home2, ['import', '--from', danglingFile, '--dry-run', '--force']));
  assert.equal(dry.danglingDependsOn?.length, 1, `dry-run 未报告悬空依赖：${JSON.stringify(dry.danglingDependsOn)}`);
  assert.equal(dry.danglingDependsOn[0].dependency, 'ghost-dep');
  assert(dry.warnings.some((w) => w.includes('ghost-dep')), `warning 未指名缺失依赖：${JSON.stringify(dry.warnings)}`);
  const applied = ok(runAt(home2, ['import', '--from', danglingFile, '--force']));
  assert.equal(applied.danglingDependsOn?.length, 1, '正式导入也应报告悬空依赖');
  assert.equal(applied.warnings.filter((w) => w.includes('ghost-dep')).length, 1, '警告不应重复累积');

  // 6. DEP_UNKNOWN：依赖别名未登记时启动前即拒绝。
  const ghostFile = writeDesc('ghost.json', {
    alias: 'ghost-root', entry: 'ghost', command: keeperCommand, expectedImage: nodeImage, dependsOn: ['no-such-dep'],
  });
  const ghostErr = failWith(runAt(home, ['start-new', '--desc', ghostFile]), 'DEP_UNKNOWN');
  assert.match(ghostErr.message, /no-such-dep/);

  // 7. DEP_UNRESOLVED：依赖留下未结记录时，错误直接给出 ack 恢复命令模板。
  const depId = computeAppId(projRoot, 'dep');
  const rtFile = path.join(home, 'runtime', `${depId}.json`);
  const original = fs.readFileSync(rtFile, 'utf8');
  const rt = JSON.parse(original);
  rt.current = { ...rt.current, runId: 'fake-unresolved', phase: 'STARTING', managed: true, pid: null, loggerPid: null, wrapperPid: null };
  fs.writeFileSync(rtFile, JSON.stringify(rt), 'utf8');
  const unresolvedErr = failWith(runAt(home, ['start', 'root-b']), 'DEP_UNRESOLVED');
  assert.match(unresolvedErr.message, /--ack-unresolved fake-unresolved/, `未给出 ack 命令：${unresolvedErr.message}`);
  assert.equal(unresolvedErr.detail?.recover, 'manager start dep-a --ack-unresolved fake-unresolved');
  fs.writeFileSync(rtFile, original, 'utf8');

  console.log('deps/backup smoke ok');
} finally {
  for (const { home: h, alias } of cleanup) runAt(h, ['stop', alias]);
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); break; }
    catch { sleep(100); }
  }
}
