#!/usr/bin/env node
// 单元测试：store 持久化契约、decode 解码回退、errors 工厂、ui-data 路径防护。
// 用法：node scripts/test/unit-store-decode-ui.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
  exitSummary, runEvidence, computeStatus, loggerAliveNote, resolveUnresolvedRun,
} from '../lib/runtime.mjs';
import {
  mergeStreamTails, mergeMultiTails, resolveLogFile, listRuns, listSources,
  resolveSource, listTree, readProjectFile,
} from '../lib/log-sources.mjs';

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
    // 默认非 fatal：非法 UTF-8 序列产出替代符而不抛（fatal 默认值变异必须被杀）
    assert.equal(pickDecoder('utf-8').decode(Buffer.from([0xC0, 0xAF])), '\uFFFD\uFFFD');
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
    // 落盘格式是 2 空格缩进的 JSON（stringify 缩进参数变异必须被杀）
    assert.match(fs.readFileSync(file, 'utf8'), /\n {2}"schemaVersion": 1,\n {2}"apps": \{\n {4}"a"/);
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
    // base 经符号链接进入：词法上在 root 内、realpath 落在 root 外 → realpath 复核必须 403
    const realDir = path.join(base, 'proj-real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'ok.txt'), 'x');
    const linkBase = path.join(base, 'proj-link');
    fs.symlinkSync(realDir, linkBase);
    try { uiResolveFile(linkBase, 'ok.txt'); throw new Error('应拒绝 realpath 越界'); }
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
    // 归档条目缺省字段必须是 null/0（?? null / ?? 0 变异必须被杀）
    assert.equal(e.endedAt, null);
    assert.equal(e.wrapperPid, null);
    assert.equal(e.wrapperCreationFileTime, null);
    assert.equal(e.lastError, null);
    assert.equal(e.wrapperExit, null);
    assert.equal(e.restartPolicy, null);
    assert.equal(e.restartCount, 0);
    assert.equal(e.restartState, null);
    assert.equal(e.lastExit, null);
    assert.equal(e.stopRequested, null);
    assert.equal(e.exitNote, null);
    assert.equal(e.resources, null);
    assert.equal(e.creationFileTime, null);
    assert.equal(e.kind, 'direct');
    // stopRequested 显式 true 才落 true
    const rt2 = makeRt({ runId: 'r10', phase: 'STOPPED', managed: true, stopRequested: true });
    archiveCurrent(rt2);
    assert.equal(rt2.prevRuns[0].stopRequested, true);
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
    assert.equal(exitSummary({ exit: 'x' }), null); // 非对象 exit 视为无证据
    assert.equal(exitSummary({ exit: { code: '0' } }), '退出码/信号不可用'); // code 非整数
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
    // 缺省证据字段必须抽为 null（?? null 变异必须被杀）
    assert.equal(ev.intentAt, null);
    assert.equal(ev.startedAt, null);
    assert.equal(ev.lastError, null);
    assert.equal(ev.exit, null);
    assert.equal(ev.logPaths, null);
  });
  check('resolveUnresolvedRun：无未结/ack 缺失/不匹配/无 pid 放行', () => {
    const rtEmpty = makeRt(null);
    assert.equal(resolveUnresolvedRun(home, appId, rtEmpty, null), null);
    const em = expectErr('ACK_MISMATCH', () => resolveUnresolvedRun(home, appId, rtEmpty, 'rX'));
    assert.equal(em.detail.current, null);
    // STOPPED/managed=false 都不算未结
    assert.equal(resolveUnresolvedRun(home, appId, makeRt({ runId: 'r-s', phase: 'STOPPED', managed: true }), null), null);
    assert.equal(resolveUnresolvedRun(home, appId, makeRt({ runId: 'r-u', phase: 'STARTING', managed: false }), null), null);
    const rtUnres = makeRt({ runId: 'r-ack', phase: 'STARTING', managed: true, pid: null });
    expectErr('UNRESOLVED_RUN', () => resolveUnresolvedRun(home, appId, rtUnres, null));
    expectErr('ACK_MISMATCH', () => resolveUnresolvedRun(home, appId, rtUnres, 'other-run'));
    const ok = resolveUnresolvedRun(home, appId, rtUnres, 'r-ack');
    assert.equal(ok.runId, 'r-ack');
    assert.equal(ok.evidence.runId, 'r-ack');
  });

  // ---------- log-sources 归并 ----------
  check('mergeStreamTails：按比例交错、各源内保序', () => {
    assert.deepEqual(mergeStreamTails(['a'], []), [{ stream: 'stdout', line: 'a' }]);
    assert.deepEqual(mergeStreamTails([], ['e']), [{ stream: 'stderr', line: 'e' }]);
    const out = mergeStreamTails(['o1', 'o2'], ['e1', 'e2']);
    assert.deepEqual(out.map((x) => x.line), ['o1', 'e1', 'o2', 'e2']);
    assert.deepEqual(out.map((x) => x.stream), ['stdout', 'stderr', 'stdout', 'stderr']);
  });
  check('computeStatus：phase → status 决策矩阵', () => {
    const mk = (cur) => ({ schemaVersion: SCHEMA_VERSION, appId, current: cur });
    assert.equal(computeStatus(home, appId, null).status, 'UNKNOWN');
    assert.equal(computeStatus(home, appId, { current: null }).status, 'UNKNOWN');
    const unm = computeStatus(home, appId, mk({ managed: false, runId: 'ru' }));
    assert.equal(unm.status, 'UNKNOWN');
    assert.equal(unm.managed, false);
    assert.match(unm.note, /非受管记录/);
    // STARTING + 无锁（隔离 home）→ 启动中断而非 STARTING
    const s1 = computeStatus(home, appId, mk({ managed: true, runId: 'r1', phase: 'STARTING', intentAt: 't0' }));
    assert.equal(s1.status, 'UNKNOWN');
    assert.match(s1.note, /启动中断（启动锁已释放/);
    const s2 = computeStatus(home, appId, mk({ managed: true, runId: 'r2', phase: 'BACKOFF', restartCount: 2, nextRestartAt: 'T99' }));
    assert.equal(s2.status, 'BACKOFF');
    assert.equal(s2.managed, true);
    assert.equal(s2.restartState, 'BACKOFF');
    assert.match(s2.note, /第 2 次已排程/);
    assert.match(s2.note, /T99/);
    // restartCount 缺省按 0 展示（?? 0 边界变异必须被杀）
    const s2b = computeStatus(home, appId, mk({ managed: true, runId: 'r2b', phase: 'BACKOFF' }));
    assert.match(s2b.note, /第 0 次已排程/);
    const s3 = computeStatus(home, appId, mk({ managed: true, runId: 'r3', phase: 'DEAD', pid: 4321 }));
    assert.equal(s3.status, 'DEAD');
    assert.equal(s3.pid, 4321);
    assert.match(s3.note, /重启次数已耗尽/);
    const s4 = computeStatus(home, appId, mk({ managed: true, runId: 'r4', phase: 'STOPPED', exit: { code: 0 } }));
    assert.equal(s4.status, 'STOPPED');
    assert.equal(s4.managed, true);
    assert.deepEqual(s4.exit, { code: 0 });
    // stoppedNote 归并：summary 与 exitNote 并存取「summary；note」，note 重复只留 summary
    const s4b = computeStatus(home, appId, mk({ managed: true, runId: 'r4b', phase: 'STOPPED', exit: { code: 2 }, exitNote: '人工停止' }));
    assert.equal(s4b.note, '异常退出（code=2）；人工停止');
    const s4c = computeStatus(home, appId, mk({ managed: true, runId: 'r4c', phase: 'STOPPED', exit: { code: 0 }, exitNote: '正常退出（code=0）' }));
    assert.equal(s4c.note, '正常退出（code=0）');
    // 无 exit + exitWatchError → 看门狗失败原因透传
    const s4d = computeStatus(home, appId, mk({ managed: true, runId: 'r4d', phase: 'STOPPED', exitWatchError: { reason: 'watcher-died' } }));
    assert.equal(s4d.note, '退出码/信号不可用（watcher-died）');
    // 无 exit 无 watchError 只有 exitNote → 原样返回
    const s4e = computeStatus(home, appId, mk({ managed: true, runId: 'r4e', phase: 'STOPPED', exitNote: 'grace-killed' }));
    assert.equal(s4e.note, 'grace-killed');
    const s5 = computeStatus(home, appId, mk({ managed: true, runId: 'r5', phase: 'UNKNOWN', lastError: '炸了' }));
    assert.equal(s5.status, 'UNKNOWN');
    assert.equal(s5.managed, true);
    assert.equal(s5.note, '炸了');
    const s5b = computeStatus(home, appId, mk({ managed: true, runId: 'r5b', phase: 'UNKNOWN' }));
    assert.equal(s5b.note, '状态未知');
    const s6 = computeStatus(home, appId, mk({ managed: true, runId: 'r6', phase: 'PHASE_X' }));
    assert.equal(s6.status, 'UNKNOWN');
    assert.equal(s6.managed, true);
    assert.match(s6.note, /未知 phase=PHASE_X/);
  });
  check('computeStatus：RUNNING 就地落账为 STOPPED', () => {
    const mk = (cur) => ({ schemaVersion: SCHEMA_VERSION, appId, current: cur });
    // prefetched 探针结果走 interpretVerifyResult：exited → gone
    const rt1 = mk({ managed: true, runId: 'r9', phase: 'RUNNING', pid: 99999 });
    const s9 = computeStatus(home, appId, rt1, { result: 'exited' });
    assert.equal(s9.status, 'STOPPED');
    assert.equal(s9.writeback, true);
    assert.equal(s9.pid, 99999);
    assert.equal(rt1.current.phase, 'STOPPED');
    assert.equal(rt1.current.exitNote, '进程已退出');
    assert.ok(rt1.current.endedAt);
    // mismatch → PID 复用话术
    const rt2 = mk({ managed: true, runId: 'r10', phase: 'RUNNING', pid: 5 });
    const s10 = computeStatus(home, appId, rt2, { result: 'mismatch' });
    assert.equal(s10.status, 'STOPPED');
    assert.match(s10.note, /PID 被复用/);
    // ok → 仍 RUNNING，不改写 phase
    const rt3 = mk({ managed: true, runId: 'r11', phase: 'RUNNING', pid: 7, exit: { code: 0 } });
    const s11 = computeStatus(home, appId, rt3, { result: 'ok' });
    assert.equal(s11.status, 'RUNNING');
    assert.equal(rt3.current.phase, 'RUNNING');
    assert.deepEqual(s11.exit, { code: 0 });
  });
  check('loggerAliveNote：缺证/死 pid/预取退出/创建时间不符', () => {
    assert.equal(loggerAliveNote(null), null);
    assert.equal(loggerAliveNote({}), null);
    assert.equal(loggerAliveNote({ loggerPid: 0 }), null);
    // 死 pid：process.kill(pid,0) ESRCH → 断流提示；不可探测路径（EPERM）属等价分支
    assert.equal(
      loggerAliveNote({ loggerPid: 0x3fffffff }),
      'logger 进程已退出：日志管道断流，可能丢失尾部输出，请人工核验');
    // 预取结果直取：exited/notfound → 断流提示，不走 process.kill
    assert.equal(
      loggerAliveNote({ loggerPid: 1 }, { result: 'exited' }),
      'logger 进程已退出：日志管道断流，可能丢失尾部输出，请人工核验');
    assert.equal(
      loggerAliveNote({ loggerPid: 1 }, { result: 'notfound' }),
      'logger 进程已退出：日志管道断流，可能丢失尾部输出，请人工核验');
    // ok + creationFileTime 不一致 → PID 复用提示
    assert.equal(
      loggerAliveNote({ loggerPid: 1, loggerCreationFileTime: '111' }, { result: 'ok', creationFileTime: '222' }),
      'logger PID 已被复用：日志管道状态不可信，请人工核验');
    // ok + 时间一致 → 无提示；ok 但无记录时间 → 不比对直接无提示
    assert.equal(
      loggerAliveNote({ loggerPid: 1, loggerCreationFileTime: '111' }, { result: 'ok', creationFileTime: '111' }),
      null);
    assert.equal(loggerAliveNote({ loggerPid: 1 }, { result: 'ok', creationFileTime: 'zzz' }), null);
    // 其他结果（如探针失败）保守不提示
    assert.equal(loggerAliveNote({ loggerPid: 1 }, { result: 'error' }), null);
  });
  // ---------- log-sources 确定性路径（follow* 为事件循环跟随，走集成冒烟） ----------
  const lsAppId = 'b0123456789abcde';
  const lsHome = path.join(base, 'ls-home');
  const projRoot = path.join(base, 'ls-root');
  const hintFile = path.join(base, 'external-hint.log');
  fs.mkdirSync(path.join(lsHome, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(lsHome, 'logs', lsAppId), { recursive: true });
  fs.mkdirSync(path.join(projRoot, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(projRoot, '.tmp'), { recursive: true });
  fs.writeFileSync(path.join(projRoot, 'ok.txt'), 'alpha-beta');
  fs.writeFileSync(path.join(projRoot, 'sub', 'f2.txt'), 'x');
  fs.writeFileSync(path.join(projRoot, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(projRoot, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(projRoot, '.tmp', 'runner-local-a.stdout.log'), 'tmp log');
  fs.writeFileSync(path.join(projRoot, '.tmp', 'runner-local-a.stderr.log'), 'tmp err');
  fs.writeFileSync(path.join(projRoot, '.tmp', 'not-a-tmp.log'), 'x');
  fs.writeFileSync(hintFile, 'hint bytes');
  fs.writeFileSync(path.join(lsHome, 'logs', lsAppId, 'run-cur.stdout.log'), 'cur out');
  fs.writeFileSync(path.join(lsHome, 'logs', lsAppId, 'run-cur.stderr.log'), 'cur err');
  fs.writeFileSync(path.join(lsHome, 'logs', lsAppId, 'run-old.stdout.log'), 'old out');
  fs.writeFileSync(path.join(lsHome, 'logs', lsAppId, 'run-old.stdout.log.1'), 'old rotated');
  fs.writeFileSync(path.join(lsHome, 'logs', lsAppId, 'zzz.log'), 'junk');
  const lsReg = {
    schemaVersion: SCHEMA_VERSION,
    apps: {
      [lsAppId]: { appId: lsAppId, alias: 'lsapp', root: projRoot, cwd: projRoot, envFile: '.env' },
      c0123456789abcde: { appId: 'c0123456789abcde', alias: 'unapp', root: projRoot, cwd: projRoot },
      d0123456789abcde: { appId: 'd0123456789abcde', alias: 'nrtapp', root: projRoot, cwd: projRoot },
    },
  };
  fs.writeFileSync(path.join(lsHome, 'registry.json'), JSON.stringify(lsReg));
  atomicWriteJson(runtimePath(lsHome, lsAppId), {
    schemaVersion: SCHEMA_VERSION, appId: lsAppId,
    current: { runId: 'run-cur', phase: 'RUNNING', managed: true, logHints: [hintFile, 'rel-not-abs', 42] },
    prevRuns: [
      { runId: 'run-old', phase: 'STOPPED', managed: true, endedAt: 'e1', archivedAt: 'a1' },
      { runId: 'run-un2', phase: 'STOPPED', managed: false },
    ],
  });
  atomicWriteJson(runtimePath(lsHome, 'c0123456789abcde'), {
    schemaVersion: SCHEMA_VERSION, appId: 'c0123456789abcde',
    current: { runId: 'run-un', phase: 'RUNNING', managed: false, logHints: [hintFile] },
    prevRuns: [],
  });
  const hintLoc = `hint:${crypto.createHash('sha256').update(hintFile).digest('hex').slice(0, 12)}`;

  check('resolveLogFile：批次归属/流名校验/非受管拒绝', () => {
    assert.equal(resolveLogFile(lsHome, 'lsapp', null).file, path.join(lsHome, 'logs', lsAppId, 'run-cur.stdout.log'));
    assert.equal(resolveLogFile(lsHome, 'lsapp', 'run-old', 'stderr').file, path.join(lsHome, 'logs', lsAppId, 'run-old.stderr.log'));
    expectErr('USAGE', () => resolveLogFile(lsHome, 'lsapp', null, 'nope'));
    expectErr('NOT_FOUND', () => resolveLogFile(lsHome, 'lsapp', 'run-x'));
    expectErr('USAGE', () => resolveLogFile(lsHome, 'lsapp', 'BAD ID'));
    // 非受管 current：点名拒绝并附日志线索
    const e = expectErr('NOT_FOUND', () => resolveLogFile(lsHome, 'unapp', null));
    assert.match(e.message, /非受管记录/);
    assert.match(e.message, /external-hint\.log/);
    // 非受管历史批次：runId 命中 prevRuns 但 managed=false → 同样拒绝
    const e2 = expectErr('NOT_FOUND', () => resolveLogFile(lsHome, 'lsapp', 'run-un2'));
    assert.match(e2.message, /非受管记录/);
    // rt 缺文件：无任何批次记录
    expectErr('NOT_FOUND', () => resolveLogFile(lsHome, 'nrtapp', 'run-x'));
    expectErr('NOT_FOUND', () => resolveLogFile(lsHome, 'nrtapp', null));
  });
  check('listRuns：当前批次 + prevRuns 映射', () => {
    const r = listRuns(lsHome, 'lsapp');
    assert.equal(r.current.runId, 'run-cur');
    assert.equal(r.current.managed, true);
    assert.deepEqual(r.current.logHints, [hintFile, 'rel-not-abs', 42]);
    assert.equal(r.prevRuns.length, 2);
    assert.deepEqual(
      [r.prevRuns[0].runId, r.prevRuns[0].managed, r.prevRuns[0].endedAt, r.prevRuns[0].archivedAt, r.prevRuns[0].archiveReason],
      ['run-old', true, 'e1', 'a1', null]);
    // prevRuns 条目缺省字段一律映射为 null（?? null 用 deepEqual 观测）
    assert.deepEqual(
      [r.prevRuns[1].runId, r.prevRuns[1].managed, r.prevRuns[1].endedAt, r.prevRuns[1].archivedAt, r.prevRuns[1].archiveReason],
      ['run-un2', false, null, null, null]);
    // 无 current 字段的应用：current 为 null
    assert.equal(listRuns(lsHome, 'nrtapp').current, null);
    assert.deepEqual(listRuns(lsHome, 'unapp').current.logPaths, null);
  });
  check('listSources：五类源枚举、去重、排序', () => {
    const { sources } = listSources(lsHome, 'lsapp');
    const srcs = sources.map((s) => s.src);
    assert.ok(srcs.includes('run:run-cur.stdout'));
    assert.ok(srcs.includes('run:run-cur.stderr'));
    assert.ok(srcs.includes('merge:run-cur'));
    assert.ok(srcs.includes('run:run-old.stdout'));
    assert.ok(srcs.includes('run:run-old.stdout.1'));
    assert.ok(srcs.includes(hintLoc));
    assert.ok(srcs.includes('tmp:runner-local-a.stdout.log'));
    assert.ok(srcs.includes('tmp:runner-local-a.stderr.log'));
    // 非批次命名、非 tmp 命名不进列表
    assert.ok(!srcs.some((s) => s.includes('zzz.log')));
    assert.ok(!srcs.some((s) => s.includes('not-a-tmp')));
    // 排序契约：rank=当前 stdout/hint(0) > 当前 stderr(1) > 当前合并(1.5) > 历史(2/2.5)
    assert.deepEqual(sources.slice(0, 4).map((s) => s.src),
      ['run:run-cur.stdout', hintLoc, 'run:run-cur.stderr', 'merge:run-cur']);
    assert.equal(sources[0].current, true);
    assert.equal(sources[1].current, true);
    assert.equal(sources[2].current, true);
    assert.equal(sources[3].current, true);
    // 轮转源标记、合并源 merged 标记
    assert.match(sources.find((s) => s.src === 'run:run-old.stdout.1').label, /轮转前/);
    assert.equal(sources.find((s) => s.src === 'merge:run-cur').merged, true);
    // hint 非绝对路径与非字符串被过滤：只产生 1 个 hint 源
    assert.equal(sources.filter((s) => s.kind === 'hint').length, 1);
  });
  check('resolveSource：五类定位符回解与失败契约', () => {
    assert.equal(resolveSource(lsHome, 'lsapp', 'run:run-cur.stdout').file, fs.realpathSync(path.join(lsHome, 'logs', lsAppId, 'run-cur.stdout.log')));
    const rot = resolveSource(lsHome, 'lsapp', 'run:run-old.stdout.1');
    assert.match(rot.file, /run-old\.stdout\.log\.1$/);
    const merged = resolveSource(lsHome, 'lsapp', 'merge:run-cur');
    assert.equal(merged.merged, true);
    assert.equal(merged.stream, 'both');
    assert.ok(fs.existsSync(merged.files.stdout));
    assert.equal(resolveSource(lsHome, 'lsapp', hintLoc).file, fs.realpathSync(hintFile));
    const tmp = resolveSource(lsHome, 'lsapp', 'tmp:runner-local-a.stdout.log');
    assert.equal(tmp.stream, 'stdout');
    assert.match(tmp.file, /runner-local-a\.stdout\.log$/);
    // 失败契约
    expectErr('NOT_FOUND', () => resolveSource(lsHome, 'lsapp', 'run:no-such.stdout'));
    expectErr('NOT_FOUND', () => resolveSource(lsHome, 'lsapp', 'merge:no-such'));
    expectErr('NOT_FOUND', () => resolveSource(lsHome, 'lsapp', 'hint:0')); // 旧版下标定位符
    expectErr('NOT_FOUND', () => resolveSource(lsHome, 'lsapp', 'hint:ffffffffffff'));
    expectErr('USAGE', () => resolveSource(lsHome, 'lsapp', 'tmp:../ok.txt'));
    expectErr('USAGE', () => resolveSource(lsHome, 'lsapp', 'nonsense'));
    expectErr('USAGE', () => resolveSource(lsHome, 'lsapp', 42));
  });
  check('listTree：目录优先排序、屏蔽名与符号链接、envFile 剔除', () => {
    fs.symlinkSync(path.join(projRoot, 'ok.txt'), path.join(projRoot, 'link.txt'));
    const { entries, root } = listTree(lsHome, 'lsapp');
    assert.equal(root, fs.realpathSync.native(projRoot));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('ok.txt'));
    assert.ok(names.includes('sub'));
    assert.ok(!names.includes('link.txt'));
    assert.ok(!names.includes('.env')); // envFile 机密防回显
    // 目录排文件前
    assert.equal(entries[0].directory, true);
    assert.equal(entries[0].name, 'sub' === entries[0].name ? 'sub' : '.tmp');
    expectErr('NOT_FOUND', () => listTree(lsHome, 'lsapp', 'no-such-dir'));
    try { listTree(lsHome, 'lsapp', 'ok.txt'); throw new Error('应拒绝'); }
    catch (e) { assert.equal(e.status, 400); }
  });
  check('readProjectFile：分页回读/offset 钳制/二进制/envFile 403/目录 400', () => {
    const r = readProjectFile(lsHome, 'lsapp', 'ok.txt');
    assert.equal(r.text, 'alpha-beta');
    assert.equal(r.size, 10);
    assert.equal(r.offset, 0);
    assert.equal(r.nextOffset, 10);
    assert.equal(r.hasMore, false);
    assert.equal(r.binary, false);
    // offset 超过大小：钳制到 size-1，只读末字节
    const r2 = readProjectFile(lsHome, 'lsapp', 'ok.txt', 999);
    assert.equal(r2.offset, 9);
    assert.equal(r2.text, 'a');
    assert.equal(r2.hasMore, false);
    // 二进制：\x00 → binary:true text null
    const rb = readProjectFile(lsHome, 'lsapp', 'bin.dat');
    assert.equal(rb.binary, true);
    assert.equal(rb.text, null);
    try { readProjectFile(lsHome, 'lsapp', '.env'); throw new Error('应拒绝'); }
    catch (e) { assert.equal(e.status, 403); }
    expectErr('NOT_FOUND', () => readProjectFile(lsHome, 'lsapp', 'no-such.txt'));
    try { readProjectFile(lsHome, 'lsapp', 'sub'); throw new Error('应拒绝'); }
    catch (e) { assert.equal(e.status, 400); }
    try { readProjectFile(lsHome, 'lsapp', '../outside'); throw new Error('应拒绝'); }
    catch (e) { assert.equal(e.status, 403); }
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
