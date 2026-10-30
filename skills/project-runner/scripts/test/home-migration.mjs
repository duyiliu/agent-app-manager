import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHome } from '../lib/home.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-home-'));
const manager = fileURLToPath(new URL('../manager.mjs', import.meta.url));
function fixture(name) {
  const userHome = path.join(base, name);
  fs.mkdirSync(userHome);
  return { userHome, old: path.join(userHome, '.project-runner'), next: path.join(userHome, '.agent-app-manager') };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map(rel => {
    const file = path.join(dir, rel);
    return [rel, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file).toString('base64')];
  });
}
function cli(f, ...args) {
  return spawnSync(process.execPath, [manager, '--json', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.userHome, USERPROFILE: f.userHome }, timeout: 30000,
  });
}
try {
  const f = fixture('legacy');
  fs.mkdirSync(path.join(f.old, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(f.old, 'runtime'));
  fs.mkdirSync(path.join(f.old, 'locks'));
  const log = path.join(f.old, 'logs', 'saved.log');
  fs.writeFileSync(log, 'before\n');
  const registry = JSON.stringify({ schemaVersion: 1, apps: {} });
  const config = JSON.stringify({ onExit: 'echo done' });
  fs.writeFileSync(path.join(f.old, 'registry.json'), registry);
  fs.writeFileSync(path.join(f.old, 'config.json'), config);
  fs.writeFileSync(path.join(f.old, 'runtime', 'saved.json'), JSON.stringify({
    schemaVersion: 1, appId: 'saved', current: null,
    prevRuns: [{ logPaths: { stdout: log }, external: path.join(f.userHome, 'external.log') }],
  }));
  const before = snapshot(f.old);
  const copied = cli(f, 'list');
  assert.equal(copied.status, 0, copied.stderr || copied.stdout);
  assert.equal(JSON.parse(copied.stdout).ok, true);
  assert.equal(fs.lstatSync(f.old).isSymbolicLink(), false, '旧目录保留实体，不创建兼容链接');
  assert.notEqual(fs.realpathSync.native(f.old), fs.realpathSync.native(f.next));
  assert.deepEqual(snapshot(f.old), before, '源目录内容完全不变');
  assert.equal(fs.readFileSync(path.join(f.next, 'registry.json'), 'utf8'), registry);
  assert.equal(fs.readFileSync(path.join(f.next, 'config.json'), 'utf8'), config);
  const saved = JSON.parse(fs.readFileSync(path.join(f.next, 'runtime', 'saved.json'), 'utf8'));
  assert.equal(saved.prevRuns[0].logPaths.stdout, path.join(f.next, 'logs', 'saved.log'));
  assert.equal(saved.prevRuns[0].external, path.join(f.userHome, 'external.log'));
  assert.equal(fs.readFileSync(saved.prevRuns[0].logPaths.stdout, 'utf8'), 'before\n');
  const newBefore = snapshot(f.next);
  resolveHome(null, true, { userHome: f.userHome });
  assert.deepEqual(snapshot(f.old), before);
  assert.deepEqual(snapshot(f.next), newBefore, '两个目录存在时重复调用零操作');

  const both = fixture('both');
  fs.mkdirSync(both.old); fs.mkdirSync(both.next);
  fs.writeFileSync(path.join(both.old, 'sentinel'), 'old');
  fs.writeFileSync(path.join(both.next, 'sentinel'), 'new');
  fs.writeFileSync(`${both.next}.migration.lock`, 'existing');
  const oldSnapshot = snapshot(both.old), newSnapshot = snapshot(both.next);
  assert.equal(resolveHome(null, true, { userHome: both.userHome }), fs.realpathSync.native(both.next));
  assert.deepEqual(snapshot(both.old), oldSnapshot);
  assert.deepEqual(snapshot(both.next), newSnapshot);
  assert.equal(fs.readFileSync(`${both.next}.migration.lock`, 'utf8'), 'existing', '已有新目录时不处理升级锁');

  const dry = fixture('dry');
  fs.mkdirSync(dry.old);
  assert.equal(resolveHome(null, true, { userHome: dry.userHome, migrate: false }), fs.realpathSync.native(dry.old));
  assert.equal(fs.existsSync(dry.next), false);
  const preview = cli(dry, 'start', 'missing', '--dry-run');
  assert.equal(preview.status, 2, preview.stderr || preview.stdout);
  assert.equal(fs.existsSync(dry.next), false, 'CLI dry-run 不复制');
  resolveHome(path.join(dry.userHome, 'custom'), false, { userHome: dry.userHome });
  assert.equal(fs.existsSync(dry.next), false, '显式 home 不复制');

  const fresh = fixture('fresh');
  assert.equal(resolveHome(null, true, { userHome: fresh.userHome }), fresh.next);
  assert.deepEqual(fs.readdirSync(fresh.userHome), []);
  resolveHome(null, false, { userHome: fresh.userHome });
  assert.equal(fs.existsSync(path.join(fresh.next, 'runtime')), true);
  assert.equal(fs.existsSync(fresh.old), false);

  const live = fixture('live');
  fs.mkdirSync(path.join(live.old, 'runtime'), { recursive: true });
  const record = path.join(live.old, 'runtime', 'active.json');
  fs.writeFileSync(record, JSON.stringify({ current: { loggerPid: process.pid } }));
  assert.equal(resolveHome(null, true, { userHome: live.userHome }), fs.realpathSync.native(live.old));
  assert.equal(fs.existsSync(live.next), false, '旧日志进程存活时暂缓复制');
  fs.writeFileSync(record, JSON.stringify({ current: null }));
  resolveHome(null, true, { userHome: live.userHome });
  assert.equal(fs.existsSync(live.next), true, '进程退出后重试复制');

  const busy = fixture('busy');
  fs.mkdirSync(busy.old);
  const lock = `${busy.next}.migration.lock`;
  fs.writeFileSync(lock, '');
  assert.throws(() => resolveHome(null, true, { userHome: busy.userHome }), { code: 'HOME_MIGRATION_BUSY' });
  assert.equal(fs.existsSync(busy.next), false);
  fs.unlinkSync(lock);
  resolveHome(null, true, { userHome: busy.userHome });
  assert.equal(fs.existsSync(lock), false);

  const command = fixture('command');
  fs.mkdirSync(path.join(command.old, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(command.old, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps: {} }));
  const commandBefore = snapshot(command.old);
  let r = cli(command, 'migrate', '--dry-run');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  let data = JSON.parse(r.stdout).data;
  assert.equal(data.action, 'copy');
  assert.equal(data.source, command.old);
  assert.equal(data.target, command.next);
  assert.equal(fs.existsSync(command.next), false);
  assert.deepEqual(snapshot(command.old), commandBefore);
  const activeRecord = path.join(command.old, 'runtime', 'active.json');
  fs.writeFileSync(activeRecord, JSON.stringify({ current: { loggerPid: process.pid } }));
  r = cli(command, 'migrate', '--dry-run');
  data = JSON.parse(r.stdout).data;
  assert.equal(data.action, 'blocked');
  assert(data.evidence.some(item => item.pid === process.pid));
  r = cli(command, 'migrate');
  assert.equal(r.status, 3, r.stdout || r.stderr);
  assert.equal(JSON.parse(r.stdout).error.code, 'HOME_MIGRATION_BUSY');
  assert.equal(fs.existsSync(command.next), false);
  fs.unlinkSync(activeRecord);
  r = cli(command, 'migrate');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).data.action, 'copied');
  assert.deepEqual(snapshot(command.old), commandBefore);
  const commandNew = snapshot(command.next);
  r = cli(command, 'migrate');
  assert.equal(JSON.parse(r.stdout).data.reason, 'target_exists');
  assert.deepEqual(snapshot(command.next), commandNew);
  r = cli(command, '--home', path.join(command.userHome, 'custom'), 'migrate');
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(command.userHome, 'custom')), false);
  const absent = fixture('absent');
  r = cli(absent, 'migrate');
  assert.equal(JSON.parse(r.stdout).data.reason, 'source_missing');
  assert.deepEqual(fs.readdirSync(absent.userHome), []);

  const failed = fixture('failed');
  fs.mkdirSync(failed.old);
  fs.writeFileSync(path.join(failed.old, 'sentinel'), 'preserve');
  const cp = fs.cpSync;
  try {
    fs.cpSync = (from, to) => { fs.writeFileSync(path.join(to, 'partial'), 'partial'); throw new Error('copy interrupted'); };
    assert.throws(() => resolveHome(null, true, { userHome: failed.userHome }), { code: 'HOME_MIGRATION_FAILED' });
  } finally { fs.cpSync = cp; }
  assert.equal(fs.readFileSync(path.join(failed.old, 'sentinel'), 'utf8'), 'preserve');
  assert.equal(fs.existsSync(failed.next), false, '失败不发布半份副本');
  assert.deepEqual(fs.readdirSync(failed.userHome), ['.project-runner'], '清理本次临时副本与锁');
  resolveHome(null, true, { userHome: failed.userHome });
  assert.equal(fs.readFileSync(path.join(failed.next, 'sentinel'), 'utf8'), 'preserve');
  console.log('home copy migration: all checks passed');
} finally {
  assert(path.resolve(base).startsWith(`${path.resolve(os.tmpdir())}${path.sep}aam-home-`));
  fs.rmSync(base, { recursive: true, force: true });
}
