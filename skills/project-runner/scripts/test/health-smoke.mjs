#!/usr/bin/env node
// 管理台健康总览测试：真实 ui server + 隔离 home，覆盖 GET /api/health 的
// READY / NOT_READY / UNTESTED、TCP 监听证据与 readyUrl/readyLogPattern 证据。
// 关键边界：监听成功但未配置就绪条件仍为 UNTESTED（监听 ≠ 业务就绪）。
// 用法：node scripts/test/health-smoke.mjs （无法核验进程身份时只覆盖非 RUNNING 路径）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { selfIdentityCapture } from '../lib/probe.mjs';
import { hasProcessProbe } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-health-smoke-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
for (const d of [
  path.join(home, 'runtime'), path.join(home, 'logs', 'aready'), path.join(home, 'logs', 'alog'),
  path.join(home, 'logs', 'auntested'), path.join(home, 'logs', 'astopped'), path.join(home, 'locks'), proj,
]) fs.mkdirSync(d, { recursive: true });
const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
const root = fs.realpathSync(proj);
const now = '2026-01-01T00:00:00Z';

// 就绪 HTTP 端点：/ready → 200，/notready → 503。404 用于验证失败证据。
const readyServer = http.createServer((req, res) => {
  if (req.url === '/ready') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/notready') { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('not ready'); return; }
  res.writeHead(404); res.end('missing');
});
await new Promise((resolve, reject) => {
  readyServer.once('error', reject);
  readyServer.listen(0, '127.0.0.1', () => { readyServer.removeListener('error', reject); resolve(); });
});
const readyPort = readyServer.address().port;
// 取一个当前无人监听的端口，验证 listening=false 也会原样作为证据返回。
const closedPort = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

let identity = null;
if (hasProcessProbe()) {
  try { identity = selfIdentityCapture(); } catch { /* 身份无法采集：只覆盖非 RUNNING 路径 */ }
}

const app = (appId, opts = {}) => ({
  appId, alias: opts.alias ?? appId, displayName: opts.alias ?? appId, root, entry: 'default', cwd: root,
  mode: 'node', exe: process.execPath, args: ['-e', 'setInterval(()=>{},500)'], envRefs: [],
  expectedPort: opts.expectedPort ?? null, readyUrl: opts.readyUrl ?? null, readyLogPattern: opts.readyLogPattern ?? null,
  sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now,
});
w(path.join(home, 'registry.json'), JSON.stringify({
  schemaVersion: 1,
  apps: {
    aready: app('aready', { expectedPort: readyPort, readyUrl: `http://127.0.0.1:${readyPort}/ready` }),
    anotready: app('anotready', { expectedPort: closedPort, readyUrl: `http://127.0.0.1:${readyPort}/notready` }),
    alog: app('alog', { expectedPort: readyPort, readyLogPattern: 'SERVER READY' }),
    auntested: app('auntested', { expectedPort: readyPort }),
    astopped: app('astopped'),
  },
}, null, 2));

const running = (appId, logText = '') => ({
  runId: `r${appId}`, phase: 'RUNNING', managed: true, mode: 'node', intentAt: now, startedAt: now,
  pid: process.pid, creationFileTime: identity.creationFileTime, image: identity.image,
  envResolved: [], logPaths: {
    stdout: path.join(home, 'logs', appId, `r${appId}.stdout.log`),
    stderr: path.join(home, 'logs', appId, `r${appId}.stderr.log`),
  },
  lastError: null, endedAt: null, exitNote: null,
});
const stopped = (appId) => ({
  runId: `r${appId}`, phase: 'STOPPED', managed: true, mode: 'node', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [],
  logPaths: { stdout: path.join(home, 'logs', appId, `r${appId}.stdout.log`), stderr: path.join(home, 'logs', appId, `r${appId}.stderr.log`) },
  lastError: null, endedAt: now, exitNote: 'smoke',
});
const rt = (appId, cur) => w(path.join(home, 'runtime', `${appId}.json`), JSON.stringify({ schemaVersion: 1, appId, current: cur, prevRuns: [] }, null, 2));
rt('astopped', stopped('astopped'));
if (identity) {
  w(path.join(home, 'logs', 'alog', 'ralog.stdout.log'), `boot\nSERVER READY on 127.0.0.1:${readyPort}\n`);
  rt('aready', running('aready'));
  rt('anotready', running('anotready'));
  rt('alog', running('alog'));
  rt('auntested', running('auntested'));
} else {
  rt('aready', stopped('aready'));
  rt('anotready', stopped('anotready'));
  rt('alog', stopped('alog'));
  rt('auntested', stopped('auntested'));
}

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const child = spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = '';
child.stdout.on('data', (d) => { banner += d; });
child.stderr.on('data', (d) => { banner += d; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${port}${p}`, (rs) => {
    let b = '';
    rs.on('data', (d) => { b += d; });
    rs.on('end', () => res({ status: rs.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
  }).on('error', rej);
});

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await get('/api/apps')).status === 200; } catch { /* 未就绪 */ }
    if (!up) await wait(200);
  }
  assert(up, 'manager ui 未在 10s 内就绪（端口未监听）');
  assert(banner.includes(`http://127.0.0.1:${port}/`));

  const health = (await get('/api/health')).json.data;
  await check('健康总览返回全部应用与 summary', () => {
    assert.equal(health.apps.length, 5);
    assert.equal(health.summary.total, 5);
    assert(health.note.includes('监听（TCP）≠ 业务就绪'));
  });
  await check('STOPPED 应用：UNTESTED 且不做端口/就绪探测', () => {
    const s = health.apps.find((a) => a.appId === 'astopped');
    assert.equal(s.status, 'STOPPED');
    assert.equal(s.state, 'UNTESTED');
    assert.equal(s.listening, null);
    assert.equal(s.readiness.note, '非 RUNNING，未做端口/就绪探测');
  });

  if (!identity) {
    console.log('  skip  RUNNING 健康断言（无法采集进程身份，仅覆盖非 RUNNING 路径）');
  } else {
    await check('READY：readyUrl 200 + TCP 监听证据', () => {
      const h = health.apps.find((a) => a.appId === 'aready');
      assert.equal(h.status, 'RUNNING');
      assert.equal(h.state, 'READY');
      assert.equal(h.listening, true);
      const httpEv = h.readiness.evidence.find((e) => e.kind === 'http');
      assert(httpEv, `缺少 HTTP 证据：${JSON.stringify(h)}`);
      assert.equal(httpEv.status, 200);
      assert.equal(httpEv.failed, undefined);
    });
    await check('NOT_READY：readyUrl 503 + 端口未监听', () => {
      const h = health.apps.find((a) => a.appId === 'anotready');
      assert.equal(h.state, 'NOT_READY');
      assert.equal(h.listening, false);
      const httpEv = h.readiness.evidence.find((e) => e.kind === 'http');
      assert.equal(httpEv.status, 503);
      assert.equal(httpEv.failed, true);
    });
    await check('READY：readyLogPattern 命中当前批次日志并返回匹配行', () => {
      const h = health.apps.find((a) => a.appId === 'alog');
      assert.equal(h.state, 'READY');
      assert.equal(h.listening, true);
      const logEv = h.readiness.evidence.find((e) => e.kind === 'logPattern');
      assert(logEv, `缺少日志证据：${JSON.stringify(h)}`);
      assert.equal(logEv.stream, 'stdout');
      assert(logEv.matched.includes('SERVER READY'));
    });
    await check('监听成功但未配置就绪条件：仍为 UNTESTED（监听 ≠ 就绪）', () => {
      const h = health.apps.find((a) => a.appId === 'auntested');
      assert.equal(h.state, 'UNTESTED');
      assert.equal(h.listening, true);
      assert.equal(h.readiness.configured, false);
    });
    await check('summary 按 RUNNING 就绪状态计数', () => {
      assert.equal(health.summary.running, 4);
      assert.equal(health.summary.ready, 2);
      assert.equal(health.summary.notReady, 1);
      assert.equal(health.summary.untested, 1);
    });
  }
} finally {
  child.kill();
  await new Promise((resolve) => readyServer.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nhealth smoke ok');
