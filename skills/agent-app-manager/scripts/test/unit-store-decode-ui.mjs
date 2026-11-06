#!/usr/bin/env node
// 单元测试：store 持久化契约、decode 解码回退、errors 工厂、ui-data 路径防护。
// 用法：node scripts/test/unit-store-decode-ui.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  registryPath, runtimePath, lockPath, readRegistry, readRuntimeStrict, atomicWriteJson,
} from '../lib/store.mjs';
import { decodeText, pickDecoder } from '../lib/decode.mjs';
import {
  usageError, notFoundError, conflictError, dependencyError, dataError, readinessTimeoutError,
} from '../lib/errors.mjs';
import { uiBlocked, uiInside, uiResolveFile, uiFail, TMP_NAME_RE } from '../lib/ui-data.mjs';
import { SCHEMA_VERSION, EXIT, ManagerError } from '../lib/constants.mjs';
import {
  archiveCurrent, writeRuntime, isUnresolvedPhase, parseAckRunId, resolveAppId,
  exitSummary, runEvidence,
} from '../lib/runtime.mjs';
import { mergeStreamTails, mergeMultiTails } from '../lib/log-sources.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-store-'));
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const expectErr = (code, fn) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, `期望 ${code}，得到 ${e.code}: ${e.message}`); return e; }
  throw new Error(`期望抛出 ${code}，实际未抛`);
};

try {
  // ---------- errors.mjs ----------
  check('errors 工厂：code/exitCode/detail 契约', () => {
    assert.deepEqual(
      [usageError('m').code, notFoundError('m').code, conflictError('C', 'm').code,
       dependencyError('m').code, dataError('D', 'm').code, readinessTimeoutError('m').code],
      ['USAGE', 'NOT_FOUND', 'C', 'PWSH_MISSING', 'D', 'READY_TIMEOUT']);
    assert.deepEqual(
      [usageError('m').exitCode, notFoundError('m').exitCode, conflictError('C', 'm').exitCode,
       dependencyError('m').exitCode, dataError('D', 'm').exitCode, readinessTimeoutError('m').exitCode],
      [EXIT.USAGE, EXIT.NOT_FOUND, EXIT.CONFLICT, EXIT.DEPENDENCY, EXIT.DATA, EXIT.READY_TIMEOUT]);
    const e = usageError('m', { k: 1 });
    assert.ok(e instanceof ManagerError);
    assert.deepEqual(e.detail, { k: 1 });
  });

  // ---------- decode.mjs ----------
  check('decodeText：UTF-8 正常、GBK 回退', () => {
    assert.equal(decodeText(Buffer.from('hello', 'utf8')), 'hello');
    assert.equal(decodeText(Buffer.from('中文', 'utf8')), '中文');
    // GBK 编码的"中"（0xD6 0xD0）不是合法 UTF-8 → 回退 GBK
    assert.equal(decodeText(Buffer.from([0xD6, 0xD0])), '中');
  });
  check('pickDecoder：可用编码原样、未知编码回退 utf-8', () => {
    const d = pickDecoder('utf-8');
    assert.equal(d.encoding, 'utf-8');
    assert.equal(pickDecoder('no-such-encoding').encoding, 'utf-8');
  });

  // ---------- store.mjs ----------
  check('路径助手：registry/runtime/lock', () => {
    assert.equal(registryPath('/h'), path.join('/h', 'registry.json'));
    assert.equal(runtimePath('/h', 'a1'), path.join('/h', 'runtime', 'a1.json'));
    assert.equal(lockPath('/h', 'n'), path.join('/h', 'locks', 'n.lock'));
  });
  check('readRegistry：缺文件回默认空注册表', () => {
    const h2 = path.join(base, 'empty-home');
    fs.mkdirSync(h2);
    assert.deepEqual(readRegistry(h2), { schemaVersion: SCHEMA_VERSION, apps: {} });
  });
  check('readRegistry：损坏/schema 不符/缺 apps 均拒绝', () => {
    const file = registryPath(home);
    fs.writeFileSync(file, '{bad');
    expectErr('DATA_CORRUPT', () => readRegistry(home));
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, apps: {} }));
    expectErr('DATA_UNSUPPORTED', () => readRegistry(home));
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
    expectErr('DATA_CORRUPT', () => readRegistry(home));
    fs.unlinkSync(file);
  });
  check('readRuntimeStrict：缺文件回 null，appId 不匹配拒绝', () => {
    const h3 = path.join(base, 'h3');
    fs.mkdirSync(path.join(h3, 'runtime'), { recursive: true });
    assert.equal(readRuntimeStrict(h3, 'a1'), null);
    const file = runtimePath(h3, 'a1');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, appId: 'other' }));
    expectErr('DATA_CORRUPT', () => readRuntimeStrict(h3, 'a1'));
  });
  check('atomicWriteJson：写入可读回、无临时文件残留', () => {
    const file = path.join(home, 'registry.json');
    atomicWriteJson(file, { schemaVersion: SCHEMA_VERSION, apps: { a: { alias: 'x' } } });
    assert.deepEqual(readRegistry(home).apps, { a: { alias: 'x' } });
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.tmp-')), []);
  });

  // ---------- ui-data.mjs ----------
  check('TMP_NAME_RE：兼容 jrebel/runner 两类命名', () => {
    assert.ok(TMP_NAME_RE.test('jrebel-local-abc.stdout.log'));
    assert.ok(TMP_NAME_RE.test('runner-local-x_y.stderr.log'));
    assert.ok(!TMP_NAME_RE.test('other.stdout.log'));
    assert.ok(!TMP_NAME_RE.test('runner-local-a/b.stdout.log'));
  });
  check('uiBlocked：机密名与密钥扩展名命中', () => {
    for (const n of ['.git', 'node_modules', '.env', '.env.local', '.ssh', '.aws', '.npmrc', '.netrc',
      'id_rsa', 'id_ed25519.pub', 'credentials', 'credentials.json',
      'server.pem', 'tls.key', 'cert.p12', 'store.jks']) {
      assert.ok(uiBlocked(n), n);
    }
    for (const n of ['src', 'main.py', 'logs', 'public', 'keyfile.txt', 'keyboard.js']) {
      assert.ok(!uiBlocked(n), n);
    }
  });
  check('uiInside：内部/越界判定', () => {
    const root = path.join(base, 'proj');
    fs.mkdirSync(root, { recursive: true });
    assert.ok(uiInside(root, root));
    assert.ok(uiInside(root, path.join(root, 'a', 'b')));
    assert.ok(!uiInside(root, base));
    assert.ok(!uiInside(root, path.join(root, '..', 'x')));
  });
  check('uiResolveFile：穿越/符号链接/被屏蔽名均 403', () => {
    const root = path.join(base, 'proj2');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), 'hi');
    assert.equal(uiResolveFile(root, 'sub/ok.txt'), fs.realpathSync(path.join(root, 'sub', 'ok.txt')));
    for (const bad of ['../x', 'sub/../../x', '/etc/passwd', 'a\\b', '.env', 'sub/../.env', 'x\0y']) {
      try { uiResolveFile(root, bad); throw new Error(`应拒绝 ${bad}`); }
      catch (e) { assert.equal(e.status, 403, bad); }
    }
    // 符号链接拒绝
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'o');
    fs.symlinkSync(outside, path.join(root, 'link.txt'));
    try { uiResolveFile(root, 'link.txt'); throw new Error('应拒绝符号链接'); }
    catch (e) { assert.equal(e.status, 403); }
  });
  check('uiFail：错误携带 status', () => {
    const e = uiFail(404, 'no');
    assert.equal(e.status, 404);
    assert.equal(e.message, 'no');
  });

  // ---------- runtime.mjs ----------
  const appId = 'a0123456789abcde';
  const makeRt = (cur, prevRuns = []) => ({ schemaVersion: SCHEMA_VERSION, appId, current: cur, prevRuns });

  check('resolveAppId：appId 直配、alias 大小写不敏感、未命中抛 NOT_FOUND', () => {
    const reg = { apps: { [appId]: { appId, alias: 'Demo-App' } } };
    assert.equal(resolveAppId(reg, appId), appId);
    assert.equal(resolveAppId(reg, 'demo-app'), appId);
    expectErr('NOT_FOUND', () => resolveAppId(reg, 'nope'));
  });
  check('archiveCurrent：迁入 prevRuns 且截断到 PREV_RUNS_KEEP', () => {
    const rt = makeRt({ runId: 'r1', phase: 'STOPPED', managed: true, startedAt: 't0' });
    for (let i = 0; i < 25; i++) {
      archiveCurrent(rt);
      rt.current = { runId: `r${i + 2}`, phase: 'STOPPED', managed: true };
    }
    assert.equal(rt.prevRuns.length, 20);
    assert.equal(rt.prevRuns[0].runId, 'r25');
    assert.equal(rt.current.runId, 'r26');
    archiveCurrent(rt);
    assert.equal(rt.current, null);
  });
  check('archiveCurrent：reason 时保留 ack 证据字段', () => {
    const rt = makeRt({
      runId: 'r9', phase: 'STARTING', managed: true, intentAt: 'ti', pid: 1,
      logPaths: { stdout: '/x.log' }, envResolved: ['A'],
    });
    archiveCurrent(rt, { reason: 'abandoned-by-ack' });
    const e = rt.prevRuns[0];
    assert.equal(e.archiveReason, 'abandoned-by-ack');
    assert.equal(e.intentAt, 'ti');
    assert.deepEqual(e.envResolved, ['A']);
    assert.deepEqual(e.logPaths, { stdout: '/x.log' });
  });
  check('isUnresolvedPhase：白名单外一律未结', () => {
    for (const p of ['RUNNING', 'STOPPED', 'BACKOFF', 'DEAD']) assert.equal(isUnresolvedPhase(p), false, p);
    for (const p of ['STARTING', 'UNKNOWN', 'garbage', '', null, undefined]) assert.equal(isUnresolvedPhase(p), true, String(p));
  });
  check('parseAckRunId：合法 runId 通过，非法抛 USAGE', () => {
    assert.equal(parseAckRunId(null), null);
    assert.equal(parseAckRunId(undefined), null);
    assert.equal(parseAckRunId('a0123456789abcde'), 'a0123456789abcde');
    expectErr('USAGE', () => parseAckRunId('bad id!'));
  });
  check('exitSummary：信号/正常/异常/缺证', () => {
    assert.equal(exitSummary(null), null);
    assert.equal(exitSummary({}), null);
    assert.equal(exitSummary({ exit: { signal: 'SIGTERM' } }), '被信号终止（signal=SIGTERM）');
    assert.equal(exitSummary({ exit: { code: 0 } }), '正常退出（code=0）');
    assert.equal(exitSummary({ exit: { code: 2 } }), '异常退出（code=2）');
    assert.equal(exitSummary({ exit: {} }), '退出码/信号不可用');
  });
  check('writeRuntime + readRuntimeStrict 回环', () => {
    fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
    const rt = makeRt({ runId: 'r1', phase: 'RUNNING', managed: true });
    writeRuntime(home, appId, rt);
    const back = readRuntimeStrict(home, appId);
    assert.equal(back.current.runId, 'r1');
  });
  check('runEvidence：关键字段抽取', () => {
    const ev = runEvidence(home, appId, { runId: 'r1', phase: 'STARTING', managed: true, pid: 9 });
    assert.equal(ev.runId, 'r1');
    assert.equal(ev.pid, 9);
    assert.equal(ev.runtimeFile, runtimePath(home, appId));
  });

  // ---------- log-sources 归并 ----------
  check('mergeStreamTails：按比例交错、各源内保序', () => {
    assert.deepEqual(mergeStreamTails(['a'], []), [{ stream: 'stdout', line: 'a' }]);
    assert.deepEqual(mergeStreamTails([], ['e']), [{ stream: 'stderr', line: 'e' }]);
    const out = mergeStreamTails(['o1', 'o2'], ['e1', 'e2']);
    assert.deepEqual(out.map((x) => x.line), ['o1', 'e1', 'o2', 'e2']);
    assert.deepEqual(out.map((x) => x.stream), ['stdout', 'stderr', 'stdout', 'stderr']);
  });
  check('mergeMultiTails：多源按比例交错并带来源', () => {
    const parts = [
      { alias: 'a1', appId: 'app1', runId: 'r1', lines: [{ stream: 'stdout', line: 'x1' }, { stream: 'stdout', line: 'x2' }] },
      { alias: 'a2', appId: 'app2', runId: 'r2', lines: [{ stream: 'stdout', line: 'y1' }] },
    ];
    const out = mergeMultiTails(parts);
    // a 源（2 行）与 b 源（1 行）按比例归并：x1(1/2) → x2(2/2 先取到) → y1
    assert.deepEqual(out.map((x) => x.line), ['x1', 'x2', 'y1']);
    assert.equal(out[0].alias, 'a1');
    assert.equal(out[2].alias, 'a2');
    assert.deepEqual(mergeMultiTails([]), []);
  });
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nunit store/decode/ui/runtime ok');
