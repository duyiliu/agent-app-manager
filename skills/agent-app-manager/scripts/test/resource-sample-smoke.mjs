// 使用本测试进程作采样目标，不启动业务应用；验证阶段与身份边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sampleAppUsage } from '../lib/commands/diagnose.mjs';
import { psProc } from '../lib/probe.mjs';
import { hasProcessProbe } from './platform.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-sample-'));
try {
  const appId = 'sample-test';
  fs.mkdirSync(path.join(base, 'runtime'));
  fs.writeFileSync(path.join(base, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps: {
    [appId]: { appId, alias: 'sample', root: base, entry: 'sample' },
  } }));
  const file = path.join(base, 'runtime', `${appId}.json`);
  const write = (phase, identity = {}) => fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, appId,
    current: { runId: 'test-run', managed: true, phase, pid: process.pid, ...identity }, prevRuns: [],
  }));
  for (const phase of ['STOPPED', 'STARTING', 'UNKNOWN', 'BACKOFF', 'DEAD']) {
    write(phase);
    const r = sampleAppUsage(base, 'sample');
    assert.equal(r.available, false, phase);
    assert.match(r.reason, /非 RUNNING/);
  }
  write('RUNNING');
  assert.equal(sampleAppUsage(base, 'sample').available, false, '缺身份证据不采样');
  if (hasProcessProbe()) {
    const identity = psProc('capture', { id: process.pid });
    assert.equal(identity.result, 'ok');
    write('RUNNING', identity);
    const r = sampleAppUsage(base, 'sample');
    assert.equal(r.available, true, JSON.stringify(r));
    assert(r.rssBytes > 0);
    write('RUNNING', { ...identity, creationFileTime: '1' });
    const reused = sampleAppUsage(base, 'sample');
    assert.equal(reused.available, false, '创建时间不同，拒绝采样复用 PID');
    assert.match(reused.reason, /复用|核验失败/);
    write('RUNNING', { ...identity, image: path.join(base, 'wrong-image.exe') });
    assert.equal(sampleAppUsage(base, 'sample').available, false, '映像不同，拒绝采样');
  } else console.log('resource sample identity checks skipped: 缺进程探针');
  console.log('resource sample guards: PASS');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
