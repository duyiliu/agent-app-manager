#!/usr/bin/env node
// 单元测试：desc 启动描述契约（校验/归一化/注册表 upsert）与 detect 项目探测。
// 用法：node scripts/test/unit-desc-detect.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  parseTagFilters, computeAppId, newRunId, loadManagedDesc, loadUnmanagedDesc,
  canonicalizeDesc, upsertApp, ID_RE, MAX_TAGS, RUN_LOG_MAX_BYTES,
} from '../lib/desc.mjs';
import { detectProjects } from '../lib/detect.mjs';
import { SCHEMA_VERSION } from '../lib/constants.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-desc-'));
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const root = fs.realpathSync(proj);

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
const writeDesc = (d) => {
  const f = path.join(base, `desc-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(d));
  return f;
};
const validManaged = () => ({
  alias: 'demo', root, exe: '/bin/true',
});

try {
  // ---------- desc.mjs ----------
  check('parseTagFilters：重复/逗号/去重/非法', () => {
    assert.deepEqual(parseTagFilters(['web']), ['web']);
    assert.deepEqual(parseTagFilters(['a,b', 'A', ' c ']), ['a', 'b', 'c']);
    expectErr('USAGE', () => parseTagFilters([]));
    expectErr('USAGE', () => parseTagFilters(['  ,  ']));
    expectErr('USAGE', () => parseTagFilters(['bad tag!']));
  });
  check('computeAppId/newRunId：格式与稳定性', () => {
    const id = computeAppId(root, 'default');
    assert.ok(ID_RE.test(id), id);
    assert.equal(id, computeAppId(root, 'default'));
    assert.notEqual(id, computeAppId(root, 'other'));
    const rid = newRunId();
    assert.match(rid, /^r[a-z0-9]+-[0-9a-f]{8}$/);
    assert.notEqual(rid, newRunId());
  });
  check('loadManagedDesc：最小合法 desc 归一化默认', () => {
    const d = loadManagedDesc(writeDesc(validManaged()));
    assert.equal(d.alias, 'demo');
    assert.equal(d.displayName, 'demo');
    assert.equal(d.entry, 'default');
    assert.equal(d.cwd, root);
    assert.equal(d.mode, 'java');
    assert.equal(d.restartPolicy, 'never');
    assert.equal(d.logMaxBytes, RUN_LOG_MAX_BYTES);
    assert.deepEqual(d.tags, []);
    assert.deepEqual(d.dependsOn, []);
  });
  check('loadManagedDesc：必填/互斥/格式校验', () => {
    expectErr('USAGE', () => loadManagedDesc(null), /--desc/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), alias: 'Bad!' })), /alias 需匹配/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), root: 'rel' })), /root 必须是绝对路径/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), exe: null })), /exe 或 command 必填其一/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), command: 'ls' })), /exe 与 command 只能填一个/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), exe: null, command: 'ls', args: ['-l'] })), /args/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), mode: 'bogus' })), /mode 只能是/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), tags: ['a', 'A'] })), /tags 不能重复/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), tags: Array(MAX_TAGS + 1).fill('t') })), /tags 最多/);
  });
  check('loadManagedDesc：未知键报错并给拼写建议，x- 前缀豁免', () => {
    const e = expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), readyUrl2: 'http://x' })));
    assert.match(e.message, /未知键 readyUrl2（是否想写 readyUrl？）/);
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), zzzqqq: 1 })), /未知键 zzzqqq/);
    const d = loadManagedDesc(writeDesc({ ...validManaged(), 'x-custom': { a: 1 } }));
    assert.deepEqual(d['x-custom'], { a: 1 });
  });
  check('loadManagedDesc：command 模式期望 expectedImage', () => {
    expectErr('USAGE', () => loadManagedDesc(writeDesc({ ...validManaged(), exe: null, command: 'java -jar a.jar' })), /expectedImage/);
    const d = loadManagedDesc(writeDesc({ ...validManaged(), exe: null, command: 'java -jar a.jar', expectedImage: 'java' }));
    assert.equal(d.command, 'java -jar a.jar');
    assert.equal(d.exe, null);
  });
  check('loadUnmanagedDesc：宽松校验与白名单', () => {
    const d = loadUnmanagedDesc(writeDesc({ alias: 'ext', root, mode: 'proc', expectedPort: 8080 }));
    assert.equal(d.alias, 'ext');
    expectErr('USAGE', () => loadUnmanagedDesc(writeDesc({ alias: 'ext', root: 'rel' })), /root 必须是绝对路径/);
    expectErr('USAGE', () => loadUnmanagedDesc(writeDesc({ alias: 'ext', root, mode: 'bogus' })), /mode 只能是/);
    expectErr('USAGE', () => loadUnmanagedDesc(writeDesc({ alias: 'ext', root, expectedPort: 0 })), /expectedPort 需 1-65535/);
    expectErr('USAGE', () => loadUnmanagedDesc(writeDesc({ alias: 'ext', root, bogusKey: 1 })), /未知键 bogusKey/);
  });
  check('canonicalizeDesc：realpath 化 root/cwd，command 模式 exe 置空', () => {
    const d = canonicalizeDesc({ ...validManaged(), cwd: root, command: 'x', expectedImage: 'y', exe: '/bin/true' });
    assert.equal(d.root, root);
    assert.equal(d.exe, null);
    expectErr('CONFIG_INVALID', () => canonicalizeDesc({ ...validManaged(), root: path.join(base, 'nope') }));
  });
  check('upsertApp：alias 冲突/覆盖重建/configRevision 递增', () => {
    const reg = { schemaVersion: SCHEMA_VERSION, apps: {} };
    const desc = { ...validManaged(), displayName: 'demo', entry: 'default', cwd: root, mode: 'node', tags: [], args: [], env: {} };
    const a1 = upsertApp(reg, 'a0123456789abcde', desc);
    assert.equal(a1.configRevision, 1);
    assert.equal(a1.alias, 'demo');
    // 缺省字段必须归一化为 null/默认常量（?? null 的 undefined 变异必须被杀）
    assert.equal(a1.command, null);
    assert.equal(a1.expectedImage, null);
    assert.equal(a1.envFile, null);
    assert.equal(a1.expectedPort, null);
    assert.equal(a1.expectedPortConfidence, null);
    assert.equal(a1.readyUrl, null);
    assert.equal(a1.readyLogPattern, null);
    assert.equal(a1.maxRestarts, null);
    assert.equal(a1.backoffMs, null);
    assert.equal(a1.onExit, null);
    assert.equal(a1.discoverTimeoutMs, null);
    assert.equal(a1.sourceFingerprint, null);
    assert.equal(a1.logMaxBytes, RUN_LOG_MAX_BYTES);
    assert.equal(a1.restartPolicy, 'never');
    // alias 大小写不敏感冲突
    expectErr('ALIAS_TAKEN', () => upsertApp(reg, 'a111111111111111', { ...desc, alias: 'DEMO' }));
    // 覆盖重建：旧 env/x- 字段被清理，configRevision+1，createdAt 保留
    reg.apps['a0123456789abcde'].env = { OLD: '1' };
    reg.apps['a0123456789abcde']['x-stale'] = true;
    reg.apps['a0123456789abcde'].internalKind = 'k';
    const created = a1.createdAt;
    const a2 = upsertApp(reg, 'a0123456789abcde', desc);
    assert.equal(a2.configRevision, 2);
    assert.equal(a2.createdAt, created);
    assert.equal(a2.internalKind, 'k');
    assert.deepEqual(a2.env, {});
    assert.equal(a2['x-stale'], undefined);
  });

  // ---------- detect.mjs ----------
  check('detectProjects：root 校验', () => {
    expectErr('USAGE', () => detectProjects(path.join(base, 'nope')), /detect root 不存在/);
    const f = path.join(base, 'afile');
    fs.writeFileSync(f, 'x');
    expectErr('USAGE', () => detectProjects(f), /必须是目录/);
  });
  check('detectProjects：空目录返回 suggestion', () => {
    const r = detectProjects(path.join(base, 'empty') && fs.mkdirSync(path.join(base, 'empty'), { recursive: true }) && path.join(base, 'empty'));
    assert.equal(r.candidates.length, 0);
    assert.ok(r.suggestion);
  });
  check('detectProjects：package.json dev 脚本生成 node 候选', () => {
    const dir = path.join(base, 'nodeapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite' }, devDependencies: { vite: '^5' },
    }));
    const { candidates } = detectProjects(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].desc.mode, 'node');
    assert.equal(candidates[0].desc.command, 'npm run dev');
    assert.equal(candidates[0].confidence, 'high');
    assert.match(candidates[0].desc.expectedImage, /^node/);
  });
  check('detectProjects：无脚本的 package.json 落 notes 不编造', () => {
    const dir = path.join(base, 'noapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.js' }));
    const { candidates, notes } = detectProjects(dir);
    assert.equal(candidates.length, 0);
    assert.match(notes[0].suggestion, /无 dev\/start\/serve\/dev:\* 脚本/);
  });
  check('detectProjects：flask 标记 + app.py 生成 python 候选', () => {
    const dir = path.join(base, 'pyapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask\n');
    fs.writeFileSync(path.join(dir, 'app.py'), 'from flask import Flask\napp = Flask(__name__)\n');
    const { candidates } = detectProjects(dir);
    const c = candidates.find((x) => x.desc.mode === 'python');
    assert.ok(c, '应有 python 候选');
    assert.match(c.desc.command, /flask --app app run/);
  });
  check('detectProjects：忽略 node_modules 与隐藏目录', () => {
    const dir = path.join(base, 'ign');
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }));
    fs.writeFileSync(path.join(dir, '.hidden', 'package.json'), JSON.stringify({ scripts: { dev: 'x' } }));
    const { candidates } = detectProjects(dir);
    assert.equal(candidates.length, 0);
  });
  check('detectProjects：composer artisan 生成 php 候选并去重同目录入口文件', () => {
    const dir = path.join(base, 'phpapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n');
    fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); // 已有候选的目录不再产出低置信入口候选
    const { candidates } = detectProjects(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].desc.command, 'php artisan serve');
    assert.equal(candidates[0].evidence.rule, 'composer-laravel:artisan');
    assert.match(candidates[0].desc.expectedImage, /^php/);
  });
  check('detectProjects：public/index.php 需端口证据才产出 php -S', () => {
    const dir = path.join(base, 'phpweb');
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    fs.writeFileSync(path.join(dir, 'public', 'index.php'), '<?php\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=8765\n');
    let r = detectProjects(dir);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].desc.command, 'php -S 127.0.0.1:8765 -t public');
    assert.equal(r.candidates[0].desc.expectedPort, 8765);
    // 无端口证据：只留 notes，不默认绑 8000
    const dir2 = path.join(base, 'phpweb2');
    fs.mkdirSync(path.join(dir2, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'composer.json'), '{}');
    fs.writeFileSync(path.join(dir2, 'public', 'index.php'), '<?php\n');
    r = detectProjects(dir2);
    assert.equal(r.candidates.length, 0);
    assert.match(r.notes[0].suggestion, /未发现端口证据/);
  });
  check('detectProjects：入口文件低置信候选（python/node 各一）', () => {
    const dir = path.join(base, 'entryapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    const { candidates } = detectProjects(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].desc.mode, 'python');
    assert.equal(candidates[0].confidence, 'low');
    assert.match(candidates[0].desc.command, /app\.py$/);
    const dir2 = path.join(base, 'entrynode');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'server.js'), 'require("http")\n');
    const r2 = detectProjects(dir2);
    assert.equal(r2.candidates.length, 1);
    assert.equal(r2.candidates[0].desc.mode, 'node');
    assert.equal(r2.candidates[0].desc.command, 'node server.js');
  });
  check('detectProjects：cargo 单 [[bin]] 出候选、元字符 bin 名拒绝', () => {
    const dir = path.join(base, 'rustapp');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n\n[[bin]]\nname = "my-bin"\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    const { candidates } = detectProjects(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].desc.command, 'cargo run --bin my-bin');
    assert.equal(candidates[0].evidence.rule, 'cargo-bin:my-bin');
    const bad = path.join(base, 'rustbad');
    fs.mkdirSync(path.join(bad, 'src'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n\n[[bin]]\nname = "evil;rm"\n');
    fs.writeFileSync(path.join(bad, 'src', 'main.rs'), 'fn main() {}\n');
    const r = detectProjects(bad);
    assert.equal(r.candidates.length, 0);
    assert.match(r.notes[0].suggestion, /shell 元字符/);
  });
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不判负 */ }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nunit desc/detect ok');
