#!/usr/bin/env node
// 依赖编排与登记备份冒烟（#173 / #174）：隔离 --home，不触碰真实数据目录。
// 覆盖：export→import 往返、悬空 dependsOn 只警告不拒绝、DEP_UNKNOWN 前置拒绝、
// 依赖 UNKNOWN 时给出 ack 恢复命令、依赖 STOPPED 时先行启动、依赖 RUNNING 时跳过。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { sleep, runManagerWithLockRetry } from './lib.mjs';
import { computeAppId } from '../lib/desc.mjs';
import { checksumOf } from '../lib/commands/backup.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-deps-backup-'));
const home = path.join(base, 'home');
const home2 = path.join(base, 'home2');
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const projRoot = fs.realpathSync.native(proj);
const nodeImage = path.basename(process.execPath);

// 锁空闲屏障 + LOCK_BUSY 兜底退避统一由 lib.mjs 提供（后台 log-writer 收尾窗口会盖住下一条命令）。
const runAt = (targetHome, args) => runManagerWithLockRetry(targetHome, args, { timeout: 120000 });
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

  // 7.5 #192：start --tag 批内拓扑排序、前置失败 SKIPPED_DEP、DEP_CYCLE 整体拒绝。
  const batchDescs = [
    ['batch-a', []], ['batch-b', ['batch-a']], ['batch-c', ['batch-b']],
  ];
  for (const [alias, deps] of batchDescs) {
    const f = writeDesc(`${alias}.json`, {
      alias, entry: alias, command: keeperCommand, expectedImage: nodeImage,
      dependsOn: deps, tags: ['depbatch'],
    });
    assert.equal(ok(runAt(home, ['start-new', '--desc', f])).status, 'RUNNING');
    cleanup.push({ home, alias });
  }
  ok(runAt(home, ['stop', '--tag', 'depbatch']));

  // 7.5a 注册表键序倒排后，批内执行序仍按拓扑 a→b→c，依赖命中 RUNNING 去重。
  const regFile = path.join(home, 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const reversed = { ...reg, apps: Object.fromEntries(Object.entries(reg.apps).reverse()) };
  fs.writeFileSync(regFile, JSON.stringify(reversed), 'utf8');
  const ordered = ok(runAt(home, ['start', '--tag', 'depbatch']));
  assert.deepEqual(ordered.results.map((r) => r.alias), ['batch-a', 'batch-b', 'batch-c'],
    `批内未按拓扑排序：${JSON.stringify(ordered.results.map((r) => r.alias))}`);
  assert.equal(ordered.succeeded, 3);
  assert.deepEqual(ordered.results[1].dependsOn?.skipped, ['batch-a'], '批内依赖未按已运行去重');
  ok(runAt(home, ['stop', '--tag', 'depbatch']));

  // 7.5b 批内前置失败 → 直接/间接依赖者 SKIPPED_DEP（不盲启），退出语义沿用批次约定。
  const reg2 = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const aId = Object.keys(reg2.apps).find((id) => reg2.apps[id].alias === 'batch-a');
  delete reg2.apps[aId].command;
  fs.writeFileSync(regFile, JSON.stringify(reg2), 'utf8');
  const blocked = ok(runAt(home, ['start', '--tag', 'depbatch']));
  assert.equal(blocked.results[0].alias, 'batch-a');
  assert.equal(blocked.results[0].ok, false, 'batch-a 应启动失败');
  for (const r of blocked.results.slice(1)) {
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'SKIPPED_DEP', `应为 SKIPPED_DEP：${JSON.stringify(r)}`);
  }
  assert.equal(blocked.skipped, 2, `skipped 计数异常：${JSON.stringify(blocked)}`);
  reg2.apps[aId].command = keeperCommand;
  fs.writeFileSync(regFile, JSON.stringify(reg2), 'utf8');

  // 7.5c 批内依赖环 → 整体 DEP_CYCLE，不产生半启动结果。
  const reg3 = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const cId = Object.keys(reg3.apps).find((id) => reg3.apps[id].alias === 'batch-c');
  const aId3 = Object.keys(reg3.apps).find((id) => reg3.apps[id].alias === 'batch-a');
  reg3.apps[aId3].dependsOn = ['batch-c'];
  fs.writeFileSync(regFile, JSON.stringify(reg3), 'utf8');
  failWith(runAt(home, ['start', '--tag', 'depbatch']), 'DEP_CYCLE');
  reg3.apps[aId3].dependsOn = [];
  fs.writeFileSync(regFile, JSON.stringify(reg3), 'utf8');
  void cId;

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
