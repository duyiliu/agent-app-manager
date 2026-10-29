#!/usr/bin/env node
// manager logs 内容过滤（--grep/--ignore-case/--context/--since/--follow）测试。
// 隔离 --home + 临时日志，不触碰真实注册表与业务进程；覆盖命中段/组间 --、大小写、
// 非法参数 usageError、since 行首时间戳口径与无时间戳提示，以及 follow 实时过滤。
// 用法：node scripts/test/logs-filter.mjs（无外部依赖，Node 22+）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = path.resolve(SCRIPT_DIR, '..', 'manager.mjs');

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-logs-filter-')));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
for (const d of [path.join(home, 'runtime'), path.join(home, 'locks'), proj]) fs.mkdirSync(d, { recursive: true });
const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
const root = fs.realpathSync(proj);
const now = '2026-01-01T00:00:00Z';

const regApp = (appId, alias) => ({
  appId, alias, displayName: alias, root, entry: 'default', cwd: root, mode: 'java',
  exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null,
  configRevision: 1, createdAt: now, updatedAt: now,
});
const apps = {
  afilter: regApp('afilter', 'filter'),
  arel: regApp('arel', 'relative'),
  afollow: regApp('afollow', 'follow'),
};
w(path.join(home, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps }));

const rt = (id, runId, extra = {}) => {
  fs.mkdirSync(path.join(home, 'logs', id), { recursive: true });
  w(path.join(home, 'runtime', `${id}.json`), JSON.stringify({
    schemaVersion: 1, appId: id,
    current: {
      runId, phase: 'STOPPED', managed: true, mode: 'java', intentAt: now, startedAt: now,
      pid: null, creationFileTime: null, image: null, envResolved: [],
      logPaths: {
        stdout: path.join(home, 'logs', id, `${runId}.stdout.log`),
        stderr: path.join(home, 'logs', id, `${runId}.stderr.log`),
      },
      lastError: null, endedAt: now, ...extra,
    },
    prevRuns: [],
  }));
};

const fixtureLines = [
  '2026-10-25T09:00:00.000 INFO boot',
  '2026-10-25T09:01:00.000 INFO alpha',
  '2026-10-25T09:02:00.000 ERROR boom one',
  '2026-10-25T09:03:00.000 INFO after one',
  '2026-10-25T09:04:00.000 INFO quiet',
  '2026-10-25T09:05:00.000 INFO quiet2',
  '2026-10-25T09:06:00.000 FATAL boom two',
  '2026-10-25T09:07:00.000 INFO trailing',
  'no timestamp ordinary line',
  'lower error line',
];
rt('afilter', 'rfilter1');
w(path.join(home, 'logs', 'afilter', 'rfilter1.stdout.log'), `${fixtureLines.join('\n')}\n`);
w(path.join(home, 'logs', 'afilter', 'rfilter1.stderr.log'), '2026-10-25T09:02:30.000 stderr ERROR piped\n');

// 相对时长用例：old 在 2h 前，recent 在 1m 前；本地时间格式（无时区）与日志常见口径一致。
const fmtLocal = (ms) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
rt('arel', 'rrel1');
w(path.join(home, 'logs', 'arel', 'rrel1.stdout.log'),
  `${fmtLocal(Date.now() - 2 * 3600_000)} INFO old\n${fmtLocal(Date.now() - 60_000)} INFO recent\nwithout timestamp\n`);

const followLog = path.join(home, 'logs', 'afollow', 'rfollow1.stdout.log');
rt('afollow', 'rfollow1');
w(followLog, '2026-10-25T10:00:00.000 INFO boot KEEP\n2026-10-25T10:00:01.000 INFO boot DROP\n');

const run = (args) => new Promise((res) => {
  const c = spawn(process.execPath, [MANAGER, '--home', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('exit', (code) => res({ code, text: out + err, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t > ms) throw new Error('等待超时');
    await wait(100);
  }
};

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

try {
  await check('未使用过滤参数时输出与现状一致（完整尾部、无过滤元数据）', async () => {
    const r = await run(['logs', 'filter', '--lines', '50', '--json']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(r.json.data.lines, fixtureLines);
    assert.equal(r.json.data.grep, undefined);
    assert.equal(r.json.data.matched, undefined);
    assert.equal(r.json.data.note, undefined);
  });

  await check('--grep + --context 输出命中段并在组间插入 --', async () => {
    const r = await run(['logs', 'filter', '--lines', '50', '--grep', 'ERROR|FATAL', '--context', '1', '--json']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(r.json.data.lines, [
      fixtureLines[1], fixtureLines[2], fixtureLines[3],
      '--',
      fixtureLines[5], fixtureLines[6], fixtureLines[7],
    ]);
    assert.equal(r.json.data.matched, 2);
    assert.equal(r.json.data.grep, 'ERROR|FATAL');
    assert.equal(r.json.data.context, 1);
  });

  await check('--grep 默认大小写敏感，--ignore-case 生效', async () => {
    const sensitive = await run(['logs', 'filter', '--grep', 'error', '--json']);
    assert.equal(sensitive.code, 0, sensitive.text);
    assert.deepEqual(sensitive.json.data.lines, [fixtureLines[9]]);
    const insensitive = await run(['logs', 'filter', '--grep', 'error', '--ignore-case', '--json']);
    assert.equal(insensitive.code, 0, insensitive.text);
    assert.deepEqual(insensitive.json.data.lines, [fixtureLines[2], fixtureLines[9]]);
    assert.equal(insensitive.json.data.ignoreCase, true);
  });

  await check('--grep 与 --src/--stream both 正交', async () => {
    const src = await run(['logs', 'filter', '--src', 'run:rfilter1.stdout', '--grep', 'FATAL', '--json']);
    assert.equal(src.code, 0, src.text);
    assert.deepEqual(src.json.data.lines, [fixtureLines[6]]);
    const both = await run(['logs', 'filter', '--stream', 'both', '--grep', 'ERROR', '--json']);
    assert.equal(both.code, 0, both.text);
    assert(both.json.data.lines.some((l) => l.stream === 'stdout' && l.line === fixtureLines[2]));
    assert(both.json.data.lines.some((l) => l.stream === 'stderr' && l.line.includes('stderr ERROR')));
    assert.equal(both.json.data.lines.some((l) => l.stream === 'stdout' && l.line === fixtureLines[1]), false);
  });

  await check('--since 按行首时间戳过滤，无时间戳行跳过并 note 提示', async () => {
    const r = await run(['logs', 'filter', '--lines', '50', '--since', '2026-10-25T09:04:00', '--json']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(r.json.data.lines, fixtureLines.slice(4, 8));
    assert.equal(r.json.data.since, '2026-10-25T09:04:00');
    assert.equal(r.json.data.sinceSkipped, 2);
    assert.match(r.json.data.note, /2 行无时间戳已跳过/);
    const combined = await run(['logs', 'filter', '--lines', '50', '--since', '2026-10-25T09:04:00', '--grep', 'FATAL', '--json']);
    assert.equal(combined.code, 0, combined.text);
    assert.deepEqual(combined.json.data.lines, [fixtureLines[6]]);
    assert.equal(combined.json.data.matched, 1);
    assert.equal(combined.json.data.sinceSkipped, 2);
  });

  await check('--since 相对时长生效，方括号/逗号毫秒时间戳可解析', async () => {
    const r = await run(['logs', 'relative', '--since', '30m', '--json']);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.lines.length, 1);
    assert.match(r.json.data.lines[0], /INFO recent$/);
    assert.equal(r.json.data.sinceSkipped, 1);
    const fmt = fmtLocal(Date.now() - 60_000).replace('T', ' ');
    w(path.join(home, 'logs', 'arel', 'rrel1.stdout.log'), `[${fmt.replace('.', ',')}] INFO recent bracket\n`);
    const bracket = await run(['logs', 'relative', '--since', '30m', '--json']);
    assert.equal(bracket.code, 0, bracket.text);
    assert.deepEqual(bracket.json.data.lines, [`[${fmt.replace('.', ',')}] INFO recent bracket`]);
    assert.equal(bracket.json.data.sinceSkipped, 0);
  });

  await check('非法正则/负数 context/无效 since 报 usageError（退出码 1）', async () => {
    for (const args of [
      ['logs', 'filter', '--grep', '['],
      ['logs', 'filter', '--grep', 'ERROR', '--context', '-1'],
      ['logs', 'filter', '--grep', 'ERROR', '--context', 'x'],
      ['logs', 'filter', '--since', 'not-a-time'],
      ['logs', 'filter', '--ignore-case'],
    ]) {
      const r = await run([...args, '--json']);
      assert.equal(r.code, 1, `${args.join(' ')} 应退出码 1：${r.text}`);
      assert.equal(r.json?.error?.code, 'USAGE', `${args.join(' ')} 应返回 USAGE`);
    }
  });

  await check('--grep 人类可读输出保持命中段与 -- 分隔', async () => {
    const r = await run(['logs', 'filter', '--lines', '50', '--grep', 'ERROR|FATAL', '--context', '1']);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.out.trimEnd(), [
      fixtureLines[1], fixtureLines[2], fixtureLines[3],
      '--',
      fixtureLines[5], fixtureLines[6], fixtureLines[7],
    ].join('\n'));
  });

  await check('--follow --grep 实时过滤新增日志', async () => {
    const child = spawn(process.execPath, [MANAGER, '--home', home, 'logs', 'follow', '--follow', '--grep', 'KEEP'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    try {
      await waitFor(() => out.includes('boot KEEP'));
      fs.appendFileSync(followLog, '2026-10-25T10:00:02.000 INFO new DROP\n2026-10-25T10:00:03.000 INFO new KEEP\n');
      await waitFor(() => out.includes('new KEEP'));
      assert.equal(out.includes('DROP'), false, `follow 不应输出未命中行：${out}\n${err}`);
      assert.equal(out.split('\n').filter((l) => l.includes('KEEP')).length, 2, out);
    } finally {
      child.kill();
      await new Promise((res) => { child.once('exit', res); setTimeout(res, 2000); });
    }
  });

  await check('--follow --grep --context 流式输出前后文与组间 --', async () => {
    w(followLog, ['a DROP', 'b KEEP', 'c DROP', 'd DROP', 'e DROP', 'f KEEP'].join('\n') + '\n');
    const child = spawn(process.execPath, [MANAGER, '--home', home, 'logs', 'follow', '--follow', '--grep', 'KEEP', '--context', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    try {
      await waitFor(() => out.includes('f KEEP'));
      assert.deepEqual(out.trimEnd().split('\n'), ['a DROP', 'b KEEP', 'c DROP', '--', 'e DROP', 'f KEEP'], `${out}\n${err}`);
      fs.appendFileSync(followLog, 'z KEEP\n');
      await waitFor(() => out.includes('z KEEP'));
    } finally {
      child.kill();
      await new Promise((res) => { child.once('exit', res); setTimeout(res, 2000); });
    }
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failed) {
  console.log(`logs filter checks failed: ${failed}`);
  process.exit(1);
}
console.log('logs filter checks passed');
