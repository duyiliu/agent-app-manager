#!/usr/bin/env node
// 单元测试：logs 行首时间戳/--since/过滤器/尾部读取与 envFile 解析、启动环境合并。
// 用法：node scripts/test/unit-logs-env.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  parseLeadingTimestamp, parseSinceValue, createLogFilter, filterLogEntries,
  readTailLines, readStderrTailSafe, RUN_LOG_FILE_RE, RUN_META_FILE_RE, MAX_LOG_LINES,
} from '../lib/logs.mjs';
import { parseEnvFile, prepareLaunchEnv, envSecretWarnings } from '../lib/env.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-logs-env-'));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const expectErr = (code, fn, re) => {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，得到 ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  throw new Error(`期望抛出 ${code}，实际未抛`);
};

try {
  // ---------- 文件名语法 ----------
  check('RUN_LOG_FILE_RE/RUN_META_FILE_RE：匹配与拒绝', () => {
    assert.equal(RUN_LOG_FILE_RE.exec('r1.stdout.log')[1], 'r1');
    assert.equal(RUN_LOG_FILE_RE.exec('r1.stderr.log.1')[1], 'r1');
    assert.equal(RUN_LOG_FILE_RE.exec('r1.stdout.log.2'), null);
    assert.equal(RUN_LOG_FILE_RE.exec('X.stdout.log'), null); // 大写 runId 不合法
    assert.equal(RUN_META_FILE_RE.exec('.r1.pid')[1], 'r1');
    assert.equal(RUN_META_FILE_RE.exec('.r1.sink.json')[2], 'sink.json');
    assert.equal(RUN_META_FILE_RE.exec('r1.pid'), null);
  });

  // ---------- 时间戳解析 ----------
  check('parseLeadingTimestamp：常见格式与无效值', () => {
    const t = parseLeadingTimestamp('2026-01-02T03:04:05.123Z hello');
    assert.equal(t, Date.UTC(2026, 0, 2, 3, 4, 5, 123));
    assert.equal(parseLeadingTimestamp('2026-01-02 03:04:05 msg'), new Date(2026, 0, 2, 3, 4, 5).getTime());
    assert.equal(parseLeadingTimestamp('[2026-01-02] x'), new Date(2026, 0, 2).getTime());
    assert.equal(parseLeadingTimestamp('2026-01-02T03:04:05+08:00 x'), Date.UTC(2026, 0, 2, 3, 4, 5) - 8 * 3600000);
    assert.equal(parseLeadingTimestamp('no ts'), null);
    assert.equal(parseLeadingTimestamp('2026-13-40T99:99 bad'), null);
    assert.equal(parseLeadingTimestamp('2026-01-022 粘住数字'), null);
  });
  check('parseSinceValue：相对时长与绝对时间戳', () => {
    const now = Date.UTC(2026, 0, 2);
    assert.equal(parseSinceValue('', now), null);
    assert.equal(parseSinceValue('30m', now).ms, now - 30 * 60000);
    assert.equal(parseSinceValue('2h', now).ms, now - 2 * 3600000);
    assert.equal(parseSinceValue('1d', now).ms, now - 86400000);
    assert.equal(parseSinceValue('500ms', now).ms, now - 500);
    const abs = parseSinceValue('2026-01-01T00:00:00Z', now);
    assert.equal(abs.ms, Date.UTC(2026, 0, 1));
    assert.equal(parseSinceValue('junk', now), null);
  });

  // ---------- 日志过滤器 ----------
  check('filterLogEntries：无选项全量通过', () => {
    const { lines, stats } = filterLogEntries(['a', 'b'], {});
    assert.deepEqual(lines, ['a', 'b']);
    assert.equal(stats.matched, 2);
  });
  check('createLogFilter：regex 命中与上下文分组', () => {
    const f = createLogFilter({ regex: /ERR/, context: 1 });
    assert.deepEqual(f.feed('l1'), []);
    assert.deepEqual(f.feed('ERR2'), ['l1', 'ERR2']);
    assert.deepEqual(f.feed('l3'), ['l3']); // 命中后 context 行
    assert.deepEqual(f.feed('l4'), []);
    // ctx=1 时上一条命中的后文窗口已含 l4：ERR6 的前文 l4 与其连成一组，不分隔
    assert.deepEqual(f.feed('ERR6'), ['l4', 'ERR6']);
    assert.deepEqual(f.feed('l8'), ['l8']); // ERR6 的后文 context 行
    assert.deepEqual(f.feed('m6'), []);
    assert.deepEqual(f.feed('m7'), []);
    // 间隔超过 ctx 的新命中：前文窗口（m7）随命中带出，组间加 '--'
    assert.deepEqual(f.feed('ERR9'), ['--', 'm7', 'ERR9']);
    const s = f.stats();
    assert.equal(s.matched, 3);
    assert.equal(s.groups, 2);
  });
  check('createLogFilter：since 丢弃无时间戳与过期行', () => {
    const sinceMs = Date.UTC(2026, 0, 2, 12);
    const f = createLogFilter({ sinceMs });
    assert.deepEqual(f.feed('no ts line'), []);
    assert.deepEqual(f.feed('2026-01-02T11:00:00Z old'), []);
    assert.deepEqual(f.feed('2026-01-02T13:00:00Z new'), ['2026-01-02T13:00:00Z new']);
    assert.deepEqual(f.stats().noTimestamp, 1);
    assert.deepEqual(f.stats().beforeSince, 1);
  });

  // ---------- 尾部读取 ----------
  check('readTailLines：尾部行数/截断标记/空文件', () => {
    const f = path.join(base, 't.log');
    fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n');
    const r = readTailLines(f, 5);
    assert.deepEqual(r.lines, ['line95', 'line96', 'line97', 'line98', 'line99']);
    const small = path.join(base, 's.log');
    fs.writeFileSync(small, 'a\nb\n');
    const r2 = readTailLines(small, 10);
    assert.deepEqual(r2.lines, ['a', 'b']);
    assert.equal(r2.truncated, false);
  });
  check('readTailLines：多字节字符跨窗口边界不碎', () => {
    const f = path.join(base, 'utf8.log');
    const body = '中'.repeat(30000) + '\nlast\n';
    fs.writeFileSync(f, body);
    const r = readTailLines(f, 2);
    assert.equal(r.lines[r.lines.length - 1], 'last');
    assert.ok(r.lines[0].includes('中'));
  });
  check('readTailLines：n 收敛到 MAX_LOG_LINES', () => {
    const f = path.join(base, 'many.log');
    fs.writeFileSync(f, 'x\n'.repeat(MAX_LOG_LINES + 10));
    assert.equal(readTailLines(f, MAX_LOG_LINES + 999).lines.length, MAX_LOG_LINES);
  });
  check('readStderrTailSafe：不存在文件回空串', () => {
    assert.equal(readStderrTailSafe(path.join(base, 'nope.log')), '');
    const f = path.join(base, 'err.log');
    fs.writeFileSync(f, 'boom\n');
    assert.equal(readStderrTailSafe(f), 'boom');
  });

  // ---------- envFile 解析 ----------
  check('parseEnvFile：注释/export/引号/转义/__proto__', () => {
    const vars = parseEnvFile(`
# 注释
A=1
export B=two
C="quoted val\\nline"
D='single'
E=plain  # 行内注释
__proto__=polluted
`);
    assert.equal(vars.A, '1');
    assert.equal(vars.B, 'two');
    assert.equal(vars.C, 'quoted val\nline');
    assert.equal(vars.D, 'single');
    assert.equal(vars.E, 'plain');
    assert.equal(vars.__proto__, 'polluted'); // 自有键，不触发原型 setter
    assert.deepEqual(parseEnvFile(''), {});
    assert.equal(parseEnvFile('\uFEFFA=1').A, '1'); // BOM
  });
  check('parseEnvFile：非法行/未闭合引号报错且不回显值', () => {
    const e = expectErr('ENV_FILE_INVALID', () => parseEnvFile('NO_EQUALS', 'f.env'));
    assert.match(e.message, /第 1 行/);
    assert.match(e.message, /f\.env/);
    expectErr('ENV_FILE_INVALID', () => parseEnvFile('1BAD=1'), /变量名不合法/);
    expectErr('ENV_FILE_INVALID', () => parseEnvFile('A="open'), /双引号未闭合/);
    expectErr('ENV_FILE_INVALID', () => parseEnvFile("A='open"), /单引号未闭合/);
    // 值不回显在错误里
    const e2 = expectErr('ENV_FILE_INVALID', () => parseEnvFile('A=1\nBAD LINE\nSECRET_VAL=leak', 'f.env'));
    assert.ok(!e2.message.includes('leak'));
  });
  check('prepareLaunchEnv：envRefs 缺失抛 ENV_MISSING 并列出', () => {
    const e = expectErr('ENV_MISSING', () => prepareLaunchEnv({
      envRefs: ['DEFINITELY_MISSING_XYZ_1', 'DEFINITELY_MISSING_XYZ_2'], env: {}, cwd: base,
    }));
    assert.match(e.message, /DEFINITELY_MISSING_XYZ_1/);
    assert.match(e.message, /DEFINITELY_MISSING_XYZ_2/);
  });
  check('prepareLaunchEnv：envFile 注入 + env 覆盖 + envResolved 回执', () => {
    fs.writeFileSync(path.join(base, 'app.env'), 'FILE_VAR=fromfile\nOVERRIDE=file\n');
    process.env.UNIT_HOST_VAR = 'host';
    const app = {
      envRefs: ['UNIT_HOST_VAR', 'FILE_VAR'],
      envFile: 'app.env',
      env: { OVERRIDE: 'desc', LITERAL: 'v' },
      cwd: base,
    };
    const out = prepareLaunchEnv(app);
    assert.equal(out.env.FILE_VAR, 'fromfile');
    assert.equal(out.env.OVERRIDE, 'desc'); // desc.env 覆盖 envFile
    assert.equal(out.env.UNIT_HOST_VAR, 'host');
    assert.deepEqual(out.envResolved.sort(), ['FILE_VAR', 'UNIT_HOST_VAR']);
  });
  check('envSecretWarnings：敏感名告警', () => {
    assert.deepEqual(envSecretWarnings({}), []);
    const w = envSecretWarnings({ MY_TOKEN: 'x', NORMAL: 'y' });
    assert.equal(w.length, 1);
    assert.match(w[0], /MY_TOKEN/);
  });
} finally {
  delete process.env.UNIT_HOST_VAR;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nunit logs/env ok');
