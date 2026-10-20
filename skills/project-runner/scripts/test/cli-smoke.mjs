#!/usr/bin/env node
// manager CLI 冒烟测试（remove / prune / logs 统一日志源）：隔离 --home + 临时记录与日志，
// 不触碰真实注册表与业务进程。覆盖：remove 的 RUNNING 拒绝/未结记录 ack 流程/证据保留、
// prune 默认 dry-run/三类残留回收/DATA_* 契约、logs --src/--list-sources/--stream both。
// 用法：node scripts/test/cli-smoke.mjs   （无外部依赖，Node 22+；未安装 pwsh 7 时
// 自动跳过依赖应用锁与进程身份核验的生命周期检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = path.resolve(SCRIPT_DIR, '..', 'manager.mjs');
const PROC_PS1 = path.resolve(SCRIPT_DIR, '..', 'ps', 'proc.ps1');

// manager 的 resolveHome 对 home 做 realpathSync.native（展开 8.3 短名等），
// 测试路径统一用 realpath 后的基目录，保证与 CLI 输出可直接比较
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cli-smoke-')));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
const hintFile = path.join(base, 'hint', 'nohup.out');
for (const d of [
  path.join(home, 'runtime'), path.join(home, 'logs', 'aok'), path.join(home, 'logs', 'astuck'),
  path.join(home, 'logs', 'aun'), path.join(home, 'locks'), proj, path.join(proj, '.tmp'),
  path.dirname(hintFile),
]) fs.mkdirSync(d, { recursive: true });

const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
// 受管应用 aok：current=rkeep1（STOPPED），prevRuns=[rkeep2]；rold1/rold2 超出保留期（可回收）
const aokLogs = path.join(home, 'logs', 'aok');
w(path.join(aokLogs, 'rkeep1.stdout.log'), 'keep1 stdout A\nkeep1 stdout B\n');
w(path.join(aokLogs, 'rkeep1.stderr.log'), 'keep1 stderr E1\nkeep1 stderr E2\n');
w(path.join(aokLogs, 'rkeep2.stdout.log'), 'keep2 stdout\n');
w(path.join(aokLogs, 'rold1.stdout.log'), 'old1 beyond retention\n');
w(path.join(aokLogs, 'rold2.stderr.log'), 'old2 beyond retention\n');
w(path.join(aokLogs, 'notes.txt'), '不是批次日志，必须保留\n');
w(path.join(proj, '.tmp', 'jrebel-local-20261020-100000.stdout.log'), 'tmp line A\ntmp line B\n');
w(path.join(proj, 'pom.xml'), '<project/>\n');
w(hintFile, 'hint line 1\nhint line 2\n');
// 死锁残留（应回收）与普通 .lock（绝不可回收）
w(path.join(home, 'locks', 'azombie.lock.stale-1700000000000'), '{"pid":999999}\n');
w(path.join(home, 'locks', 'alive.lock'), '{"pid":1,"creationFileTime":"1"}\n');
// 孤儿临时文件：旧的应回收，近期的可能是进行中的原子写（跳过）
const oldTmp1 = path.join(home, 'runtime', '.tmp-1234-deadbeef');
const oldTmp2 = path.join(aokLogs, '.tmp-5678-cafe01');
const recentTmp = path.join(home, '.tmp-777-beef02');
w(oldTmp1, 'x');
w(oldTmp2, 'x');
w(recentTmp, 'x');
const oldTime = new Date(Date.now() - 10 * 60 * 1000);
for (const f of [oldTmp1, oldTmp2]) fs.utimesSync(f, oldTime, oldTime);

const root = fs.realpathSync(proj);
const regApp = (appId, alias, mode = 'java') => ({
  appId, alias, displayName: alias, root, entry: 'default', cwd: root, mode,
  exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null,
  configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const registryApps = { aok: regApp('aok', 'ok'), astuck: regApp('astuck', 'stuck'), aun: regApp('aun', 'unman') };

const pwshOk = (() => {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PROC_PS1, '-Action', 'capture', '-Id', String(process.pid)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return !r.error && r.status === 0 && /"result":"ok"/.test(r.stdout ?? '');
})();
if (pwshOk) {
  // RUNNING 拒绝移除的受管应用：预登记 arun（别名 busy），运行记录在检查时用真实存活进程写入
  fs.mkdirSync(path.join(home, 'logs', 'arun'), { recursive: true });
  w(path.join(home, 'logs', 'arun', 'rrun1.stdout.log'), 'running log line\n');
  registryApps.arun = regApp('arun', 'busy');
}
w(path.join(home, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps: registryApps }));

const rt = (id, cur, prev = []) => w(path.join(home, 'runtime', `${id}.json`), JSON.stringify({ schemaVersion: 1, appId: id, current: cur, prevRuns: prev }));
const now = '2026-01-01T00:00:00Z';
rt('aok', {
  runId: 'rkeep1', phase: 'STOPPED', managed: true, mode: 'java', intentAt: now, startedAt: now,
  pid: 99999, creationFileTime: '0', image: 'java.exe', envResolved: [],
  logPaths: { stdout: path.join(aokLogs, 'rkeep1.stdout.log'), stderr: path.join(aokLogs, 'rkeep1.stderr.log') },
  lastError: null, endedAt: now, exitNote: 'smoke',
}, [{ runId: 'rkeep2', phase: 'STOPPED', managed: true, startedAt: now, endedAt: now, archivedAt: now }]);
rt('astuck', {
  runId: 'rstuck1', phase: 'STARTING', managed: true, mode: 'java', intentAt: now, startedAt: null,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  lastError: null, endedAt: null,
});
rt('aun', {
  runId: 'runman1', phase: 'UNKNOWN', managed: false, mode: 'java', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  logHints: [hintFile], lastError: null, endedAt: null, note: '非受管',
});

// 直接 import manager 数据层：验证 CLI --src 与 ui（同一 resolveSource）读到相同内容
const mgr = await import(pathToFileURL(MANAGER).href);

const run = (args) => new Promise((res) => {
  const c = spawn(process.execPath, [MANAGER, '--home', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  // JSON 信封始终走 stdout；stderr 只做诊断展示（如运行器警告），不参与解析
  c.on('exit', (code) => res({ code, text: out + err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
});
const registryOnDisk = () => JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

console.log(pwshOk ? 'pwsh 7 可用：执行全部检查' : '未检测到 pwsh 7：跳过依赖应用锁/身份核验的生命周期检查');

// ---------- detect 只读启动描述候选 ----------
const detectRoot = path.join(base, 'detect-fixtures');
const viteRoot = path.join(detectRoot, 'vite-app');
const mavenRoot = path.join(detectRoot, 'maven-app');
const flaskRoot = path.join(detectRoot, 'flask-app');
const emptyRoot = path.join(detectRoot, 'empty');
for (const d of [viteRoot, mavenRoot, flaskRoot, emptyRoot]) fs.mkdirSync(d, { recursive: true });
w(path.join(viteRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }));
w(path.join(mavenRoot, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
w(path.join(mavenRoot, 'mvnw'), '');
w(path.join(flaskRoot, 'requirements.txt'), 'Flask==3.0\n');
w(path.join(flaskRoot, 'app.py'), 'app = None\n');
await check('detect vite/maven/flask 生成与 start-new schema 对齐的候选', async () => {
  const before = fs.readFileSync(path.join(home, 'registry.json'), 'utf8');
  const r = await run(['detect', '--root', detectRoot, '--json']);
  assert.equal(r.code, 0, r.text);
  const rows = r.json.data.candidates;
  assert.equal(rows.length, 3);
  const vite = rows.find((x) => x.evidence.rule.includes('package-script:dev'));
  assert.equal(vite.desc.command, 'npm run dev');
  assert.equal(vite.desc.expectedImage, 'node.exe');
  const maven = rows.find((x) => x.evidence.rule.startsWith('maven-spring-boot'));
  assert.equal(maven.desc.command, 'mvnw.cmd spring-boot:run');
  assert.equal(maven.desc.mode, 'java');
  const flask = rows.find((x) => x.evidence.rule === 'flask-app.py');
  assert.equal(flask.desc.command, 'python -m flask --app app run');
  assert.equal(flask.desc.mode, 'python');
  assert(rows.every((x) => x.confidence && x.evidence.file));
  assert.equal(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'), before, 'detect 不得修改注册表');
  assert.equal(fs.readdirSync(home, { recursive: true }).some((x) => String(x).includes('locks')), true);
});
await check('detect 空目录返回空数组和建议，不报错', async () => {
  const r = await run(['detect', '--root', emptyRoot, '--json']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.json.data.candidates, []);
  assert(r.json.data.suggestion);
});
await check('detect 缺 root 使用参数错误契约', async () => {
  assert.equal((await run(['detect', '--json'])).code, 1);
});

// ---------- logs 统一日志源 ----------

await check('list-sources：JSON 输出与 ui 同一数据（hint + .tmp + 批次）', async () => {
  const ls = await run(['logs', 'unman', '--list-sources', '--json']);
  assert.equal(ls.code, 0);
  assert.equal(ls.json.ok, true);
  assert.equal(ls.json.command, 'logs');
  const srcs = ls.json.data.sources.map((s) => s.src);
  assert(srcs.includes('hint:0'), `缺 hint:0：${srcs.join(',')}`);
  assert(srcs.some((s) => s.startsWith('tmp:jrebel-local-')), `缺 .tmp 兼容日志：${srcs.join(',')}`);
});
await check('list-sources：受管应用列批次源，人类可读输出可用', async () => {
  const ls = await run(['logs', 'ok', '--list-sources']);
  assert.equal(ls.code, 0);
  assert(ls.text.includes('run:rkeep1.stdout'));
  assert(ls.text.includes('run:rold1.stdout'));
});
await check('--src hint:0 与 ui 同源同内容', async () => {
  const hint = await run(['logs', 'unman', '--src', 'hint:0', '--json']);
  assert.equal(hint.code, 0);
  const t = mgr.resolveSource(home, 'unman', 'hint:0'); // ui /api/tail 用同一解析
  assert.equal(hint.json.data.file, t.file);
  assert.equal(hint.json.data.src, 'hint:0');
  assert.equal(hint.json.data.lines.join('\n'), fs.readFileSync(t.file, 'utf8').trimEnd());
});
await check('--src tmp:<name> 与 ui 同源同内容', async () => {
  const tmpLog = await run(['logs', 'unman', '--src', 'tmp:jrebel-local-20261020-100000.stdout.log', '--json']);
  assert.equal(tmpLog.code, 0);
  const t = mgr.resolveSource(home, 'unman', 'tmp:jrebel-local-20261020-100000.stdout.log');
  assert.equal(tmpLog.json.data.file, t.file);
  assert.equal(tmpLog.json.data.lines.join('\n'), fs.readFileSync(t.file, 'utf8').trimEnd());
});
await check('--src run:<历史批次> 可读旧日志', async () => {
  const r = await run(['logs', 'ok', '--src', 'run:rkeep2.stdout', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.lines, ['keep2 stdout']);
});
await check('--src 与 --lines 组合有界读取', async () => {
  const r = await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--lines', '1', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.lines, ['keep1 stdout B']);
  assert.equal(r.json.data.truncated, true);
});
await check('--src 与 --run/--stream、--list-sources 与 --run 互斥（退出码 1）', async () => {
  assert.equal((await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--run', 'rkeep1'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--src', 'run:rkeep1.stdout', '--stream', 'stderr'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--list-sources', '--run', 'rkeep1'])).code, 1);
});
await check('--stream both 合并双流（JSON 带流标记）', async () => {
  const both = await run(['logs', 'ok', '--stream', 'both', '--run', 'rkeep1', '--json']);
  assert.equal(both.code, 0);
  assert.equal(both.json.data.stream, 'both');
  const lines = both.json.data.lines;
  assert(lines.some((l) => l.stream === 'stdout' && l.line === 'keep1 stdout A'));
  assert(lines.some((l) => l.stream === 'stderr' && l.line === 'keep1 stderr E1'));
  assert.deepEqual(both.json.data.missingStreams, []);
});
await check('--stream both 人类可读输出带流前缀', async () => {
  const both = await run(['logs', 'ok', '--stream', 'both', '--run', 'rkeep1']);
  assert.equal(both.code, 0);
  assert(both.text.includes('[stdout] keep1 stdout A'));
  assert(both.text.includes('[stderr] keep1 stderr E1'));
});
await check('--stream both + --follow、--follow + --json 退出码 1', async () => {
  assert.equal((await run(['logs', 'ok', '--stream', 'both', '--follow'])).code, 1);
  assert.equal((await run(['logs', 'ok', '--follow', '--json'])).code, 1);
});
await check('非受管默认 logs 报错并指引 --src hint:N（退出码 2）', async () => {
  const r = await run(['logs', 'unman']);
  assert.equal(r.code, 2);
  assert(r.text.includes('非受管'));
  assert(r.text.includes('nohup.out'));
  assert(r.text.includes('--src hint:N'));
});

// ---------- prune ----------

await check('prune 默认 dry-run：列出将删内容且不删除任何文件', async () => {
  const pd = await run(['prune', '--json']);
  assert.equal(pd.code, 0, pd.text);
  assert.equal(pd.json.ok, true);
  assert.equal(pd.json.data.dryRun, true);
  if (pwshOk) {
    const files = pd.json.data.logs.flatMap((a) => a.files).map((f) => f.file);
    assert(files.includes(path.join(aokLogs, 'rold1.stdout.log')), `应列出超保留期日志：${files.join(',')}`);
    assert(files.includes(path.join(aokLogs, 'rold2.stderr.log')));
  } else {
    assert(pd.json.data.skipped.some((s) => s.kind === 'logs' && s.reason.includes('PWSH_MISSING')));
  }
  assert(pd.json.data.staleLocks.some((f) => f.file.endsWith('azombie.lock.stale-1700000000000')));
  assert(pd.json.data.tmpOrphans.some((f) => f.file === oldTmp1));
  assert(pd.json.data.tmpOrphans.some((f) => f.file === oldTmp2));
  assert(pd.json.data.skipped.some((s) => s.kind === 'tmp' && s.target === recentTmp));
  assert(fs.existsSync(path.join(aokLogs, 'rold1.stdout.log')), 'dry-run 不得删除文件');
  assert(fs.existsSync(path.join(home, 'locks', 'azombie.lock.stale-1700000000000')));
});
await check('prune --dry-run 与 --apply 互斥（退出码 1）', async () => {
  assert.equal((await run(['prune', '--dry-run', '--apply'])).code, 1);
});
await check('prune --apply：回收超保留期日志、死锁残留与孤儿临时文件', async () => {
  const pa = await run(['prune', '--apply', '--json']);
  assert.equal(pa.code, 0, pa.text);
  assert.equal(pa.json.data.dryRun, false);
  if (pwshOk) {
    assert(!fs.existsSync(path.join(aokLogs, 'rold1.stdout.log')));
    assert(!fs.existsSync(path.join(aokLogs, 'rold2.stderr.log')));
  }
  assert(!fs.existsSync(path.join(home, 'locks', 'azombie.lock.stale-1700000000000')));
  assert(!fs.existsSync(oldTmp1));
  assert(!fs.existsSync(oldTmp2));
});
await check('prune 不删 current/保留期日志、证据与非残留文件', () => {
  assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stdout.log')));
  assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stderr.log')));
  assert(fs.existsSync(path.join(aokLogs, 'rkeep2.stdout.log')));
  assert(fs.existsSync(path.join(aokLogs, 'notes.txt')));
  assert(fs.existsSync(path.join(home, 'locks', 'alive.lock')), '普通 .lock 不可回收');
  assert(fs.existsSync(recentTmp), '近期临时文件跳过');
  for (const f of ['aok', 'astuck', 'aun']) assert(fs.existsSync(path.join(home, 'runtime', `${f}.json`)));
  assert(fs.existsSync(path.join(home, 'registry.json')));
});
await check('损坏运行记录按 DATA_CORRUPT 整体拒绝且不删任何文件', async () => {
  w(path.join(home, 'runtime', 'acorrupt.json'), '{broken json');
  fs.mkdirSync(path.join(home, 'logs', 'acorrupt'), { recursive: true });
  w(path.join(home, 'logs', 'acorrupt', 'rx1.stdout.log'), 'corrupt app log\n');
  w(path.join(aokLogs, 'rold9.stdout.log'), 'old9 beyond retention\n');
  const stale2 = path.join(home, 'locks', 'zombie2.lock.stale-42');
  const oldTmp3 = path.join(home, 'runtime', '.tmp-42-aaaa');
  w(stale2, 'x');
  w(oldTmp3, 'x');
  fs.utimesSync(oldTmp3, oldTime, oldTime);
  const pc = await run(['prune', '--json']);
  assert.equal(pc.code, 5, `应退出码 5：${pc.text}`);
  assert.equal(pc.json.error.code, 'DATA_CORRUPT');
  assert(fs.existsSync(path.join(aokLogs, 'rold9.stdout.log')), 'DATA 错误时不得删除');
  assert(fs.existsSync(path.join(home, 'logs', 'acorrupt', 'rx1.stdout.log')));
  assert(fs.existsSync(stale2));
  assert(fs.existsSync(oldTmp3));
});

// ---------- remove ----------

if (pwshOk) {
  await check('remove 缺 ref / 未知 ref 退出码 1/2', async () => {
    assert.equal((await run(['remove'])).code, 1);
    const r0 = await run(['remove', 'nope', '--json']);
    assert.equal(r0.code, 2);
    assert.equal(r0.json.error.code, 'NOT_FOUND');
  });
  await check('remove RUNNING 受管实例拒绝（退出码 3 INSTANCE_RUNNING）', async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const cap = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PROC_PS1, '-Action', 'capture', '-Id', String(live.pid)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const identity = JSON.parse(cap.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
      assert.equal(identity.result, 'ok');
      rt('arun', {
        runId: 'rrun1', phase: 'RUNNING', managed: true, mode: 'java', intentAt: now, startedAt: now,
        pid: live.pid, creationFileTime: identity.creationFileTime, image: identity.image, envResolved: [],
        logPaths: { stdout: path.join(home, 'logs', 'arun', 'rrun1.stdout.log'), stderr: null },
        lastError: null, endedAt: null,
      });
      const r6 = await run(['remove', 'busy', '--json']);
      assert.equal(r6.code, 3, r6.text);
      assert.equal(r6.json.error.code, 'INSTANCE_RUNNING');
      assert(registryOnDisk().apps.arun, '拒绝时注册表不得变化');
    } finally {
      live.kill();
      await new Promise((res) => live.on('exit', res));
    }
  });
  await check('确认退出后再 remove 成功；运行证据保留', async () => {
    const r7 = await run(['remove', 'busy', '--json']);
    assert.equal(r7.code, 0, r7.text);
    assert.equal(r7.json.data.removed, true);
    const rtArun = JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'arun.json'), 'utf8'));
    assert.equal(rtArun.current.phase, 'STOPPED', 'RUNNING→STOPPED 应按 OS 事实落账');
    assert(fs.existsSync(path.join(home, 'logs', 'arun', 'rrun1.stdout.log')));
  });
  const astuckBefore = fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8');
  await check('remove 未结记录默认拒绝（UNRESOLVED_RUN 退出码 3）', async () => {
    const r1 = await run(['remove', 'stuck', '--json']);
    assert.equal(r1.code, 3, r1.text);
    assert.equal(r1.json.error.code, 'UNRESOLVED_RUN');
    assert(registryOnDisk().apps.astuck, '拒绝时注册表不得变化');
    assert.equal(fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8'), astuckBefore);
  });
  await check('remove --ack-unresolved runId 不一致拒绝（ACK_MISMATCH）', async () => {
    const r2 = await run(['remove', 'stuck', '--ack-unresolved', 'rwrong1', '--json']);
    assert.equal(r2.code, 3);
    assert.equal(r2.json.error.code, 'ACK_MISMATCH');
  });
  await check('remove --ack-unresolved 通过后移除；证据归档保留', async () => {
    const r3 = await run(['remove', 'stuck', '--ack-unresolved', 'rstuck1', '--json']);
    assert.equal(r3.code, 0, r3.text);
    assert.equal(r3.json.data.abandonedRunId, 'rstuck1');
    assert.equal(r3.json.data.abandonedReason, 'abandoned-by-ack');
    assert(!registryOnDisk().apps.astuck, '注册表条目应已移除');
    const rtStuck = JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'astuck.json'), 'utf8'));
    assert.equal(rtStuck.current, null);
    assert.equal(rtStuck.prevRuns[0].runId, 'rstuck1');
    assert.equal(rtStuck.prevRuns[0].archiveReason, 'abandoned-by-ack');
  });
  await check('remove 非受管登记直接移除；运行记录保留', async () => {
    const r4 = await run(['remove', 'unman', '--json']);
    assert.equal(r4.code, 0, r4.text);
    assert(!registryOnDisk().apps.aun);
    assert(fs.existsSync(path.join(home, 'runtime', 'aun.json')));
  });
  await check('remove 后 list 不再显示该应用；日志证据保留', async () => {
    const r5 = await run(['remove', 'ok', '--json']);
    assert.equal(r5.code, 0, r5.text);
    const lst = await run(['list', '--json']);
    assert.equal(lst.code, 0);
    assert(!lst.json.data.apps.some((a) => a.alias === 'ok'), 'list 不应再显示已移除应用');
    assert(fs.existsSync(path.join(home, 'runtime', 'aok.json')));
    assert(fs.existsSync(path.join(aokLogs, 'rkeep1.stdout.log')));
  });
} else {
  console.log('  skip（缺 pwsh 7：remove/prune 日志回收依赖应用锁与身份核验）');
}

fs.rmSync(base, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\ncli smoke ok');
