#!/usr/bin/env node
// start/start-new/restart --wait-ready 冒烟：隔离 --home + 真实 node 进程与本机 HTTP 服务。
// 覆盖：readyUrl 轮询到 READY 才返回 0、超时退出码 6 且进程保持 RUNNING、无就绪证据启动前
// 拒绝且不产生进程、进程早退快速失败、等待期从批次日志起点扫描（早期标记不被 5000 行窗口漏掉）。
// 用法：node scripts/test/readiness-wait-smoke.mjs（无外部依赖，Node 20+；缺进程探针时跳过）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, killTree, isWindows } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-wait-')));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const root = fs.realpathSync(proj);

if (!hasProcessProbe()) {
  console.log(`skip readiness wait smoke（未检测到进程探针 ${isWindows ? 'pwsh 7' : '/proc'}）`);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(0);
}

let failed = 0;
class Skip extends Error {}
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e instanceof Skip) { console.log(`  skip ${name}: ${e.message}`); return; }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const psMissing = (r) => r.code === 4
  && (r.json?.error?.code === 'PWSH_MISSING' || r.text.includes('PWSH_MISSING') || r.text.includes('spawnSync pwsh'));
const descFile = (d) => {
  const file = path.join(base, `desc-${d.alias}.json`);
  fs.writeFileSync(file, JSON.stringify({ root, cwd: root, entry: 'default', mode: 'node', exe: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], ...d }), 'utf8');
  return file;
};
const cli = (args, timeout = 60000) => new Promise((resolve) => {
  const child = spawn(process.execPath, [MANAGER, '--home', home, '--json', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeout);
  child.on('close', (code) => {
    clearTimeout(timer);
    let json = null;
    try { json = JSON.parse(out); } catch { /* 保留原始输出 */ }
    resolve({ code, json, text: `${out}${err}` });
  });
});
const alias = (name) => descFile({ alias: name });

const aliases = [];
const pids = [];
let server = null;
const urlWait = { requests: 0 };
try {
  await check('readyUrl 轮询：首次未就绪，READY 后返回 0 且 JSON 带 readiness 证据', async () => {
    server = http.createServer((req, res) => {
      urlWait.requests++;
      // 首次探测固定 503，保证等待器至少经历一次 NOT_READY 再进入 READY。
      const ready = urlWait.requests > 1;
      res.statusCode = ready ? 200 : 503;
      res.end(ready ? 'ready' : 'starting');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const r = await cli(['start-new', '--desc', descFile({
      alias: 'wait-url', entry: 'url', readyUrl: `http://127.0.0.1:${port}/`,
    }), '--wait-ready', '--ready-timeout', '15000']);
    aliases.push('wait-url');
    if (psMissing(r)) throw new Skip('缺 pwsh 7（进程探针）');
    assert.equal(r.code, 0, r.text);
    if (r.json?.data?.pid) pids.push(r.json.data.pid);
    assert.equal(r.json.data.readiness.state, 'READY');
    assert.equal(r.json.data.readiness.configured, true);
    assert.equal(r.json.data.readinessUntested, false);
    assert(r.json.data.readiness.waitedMs >= 200, `未发生轮询等待：${JSON.stringify(r.json.data.readiness)}`);
    const httpEvidence = r.json.data.readiness.evidence.find((e) => e.kind === 'http');
    assert(httpEvidence, `缺少 http 证据：${JSON.stringify(r.json.data.readiness)}`);
    assert.equal(httpEvidence.url, `http://127.0.0.1:${port}/`);
    assert.equal(httpEvidence.status, 200);
    assert(urlWait.requests > 1, `readyUrl 只探测了一次：${urlWait.requests}`);
    assert.equal((await cli(['stop', 'wait-url'])).code, 0);
  });

  await check('就绪超时：退出码 6/READY_TIMEOUT，进程保持 RUNNING 且 status 可查', async () => {
    const r = await cli(['start-new', '--desc', descFile({
      alias: 'wait-timeout', entry: 'timeout', readyLogPattern: 'NEVER-READY-MARKER',
    }), '--wait-ready', '--ready-timeout', '1200']);
    aliases.push('wait-timeout');
    if (psMissing(r)) throw new Skip('缺 pwsh 7（进程探针）');
    if (r.json?.data?.pid) pids.push(r.json.data.pid);
    assert.equal(r.code, 6, r.text);
    assert.equal(r.json.error.code, 'READY_TIMEOUT');
    assert.equal(r.json.error.detail.status, 'RUNNING');
    assert.equal(r.json.error.detail.readiness.state, 'NOT_READY');
    const st = await cli(['status', 'wait-timeout', '--ready']);
    assert.equal(st.code, 0, st.text);
    assert.equal(st.json.data.status, 'RUNNING');
    assert.equal(st.json.data.readiness.state, 'NOT_READY');
    const stopped = await cli(['stop', 'wait-timeout']);
    assert.equal(stopped.code, 0, stopped.text);
  });

  await check('未配置就绪证据：start-new --wait-ready 用法错误且不产生进程', async () => {
    const r = await cli(['start-new', '--desc', alias('wait-none'), '--wait-ready']);
    assert.equal(r.code, 1, r.text);
    assert.equal(r.json.error.code, 'USAGE');
    const list = await cli(['list']);
    assert(!list.json.data.apps.some((a) => a.alias === 'wait-none'), '拒绝时不应产生登记/进程');
  });

  await check('进程早退：在超时前快速失败（PROCESS_EXITED）', async () => {
    const started = Date.now();
    const r = await cli(['start-new', '--desc', descFile({
      alias: 'wait-exit', entry: 'exit', args: ['-e', 'setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000);'],
      readyLogPattern: 'NEVER-READY-MARKER',
    }), '--wait-ready', '--ready-timeout', '20000'], 30000);
    aliases.push('wait-exit');
    if (r.json?.data?.pid) pids.push(r.json.data.pid);
    const elapsed = Date.now() - started;
    if (psMissing(r)) throw new Skip('缺 pwsh 7（进程探针）');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'PROCESS_EXITED');
    assert(elapsed < 15000, `进程早退后仍空等：${elapsed}ms`);
    const st = await cli(['status', 'wait-exit']);
    assert.equal(st.json.data.status, 'STOPPED');
  });

  await check('等待期从批次日志起点扫描：早期标记不被 5000 行尾部窗口漏掉', async () => {
    const script = "console.log('EARLY-READY-MARKER-42');for(let i=0;i<6000;i++)console.log('filler-'+i);setInterval(()=>{},1000);";
    const r = await cli(['start-new', '--desc', descFile({
      alias: 'wait-log', entry: 'log', args: ['-e', script], readyLogPattern: 'EARLY-READY-MARKER-\\d+',
    }), '--wait-ready', '--ready-timeout', '15000'], 60000);
    aliases.push('wait-log');
    if (psMissing(r)) throw new Skip('缺 pwsh 7（进程探针）');
    if (r.json?.data?.pid) pids.push(r.json.data.pid);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.readiness.state, 'READY');
    const ev = r.json.data.readiness.evidence.find((e) => e.kind === 'logPattern');
    assert(ev, `缺少 logPattern 证据：${JSON.stringify(r.json.data.readiness)}`);
    assert(ev.matched.includes('EARLY-READY-MARKER-42'), `证据不是早期标记：${JSON.stringify(ev)}`);
    assert.equal((await cli(['stop', 'wait-log'])).code, 0);

    const start = await cli(['start', 'wait-log', '--wait-ready', '--ready-timeout', '15000'], 60000);
    if (psMissing(start)) throw new Skip('缺 pwsh 7（进程探针）');
    assert.equal(start.code, 0, start.text);
    assert.equal(start.json.data.readiness.state, 'READY');
    assert.equal(start.json.data.readinessUntested, false);
    pids.push(start.json.data.pid);

    const restart = await cli(['restart', 'wait-log', '--wait-ready', '--ready-timeout', '15000'], 60000);
    assert.equal(restart.code, 0, restart.text);
    assert.equal(restart.json.data.start.readiness.state, 'READY');
    assert.equal(restart.json.data.start.readinessUntested, false);
    pids.push(restart.json.data.start.pid);
    assert.equal((await cli(['stop', 'wait-log'])).code, 0);
  });

  await check('start/restart --wait-ready 无就绪证据：用法错误且不启动/不先停旧实例', async () => {
    const started = await cli(['start-new', '--desc', alias('wait-plain')]);
    aliases.push('wait-plain');
    if (psMissing(started)) throw new Skip('缺 pwsh 7（进程探针）');
    assert.equal(started.code, 0, started.text);
    pids.push(started.json.data.pid);
    assert.equal(started.json.data.readinessUntested, true);

    const start = await cli(['start', 'wait-plain', '--wait-ready']);
    assert.equal(start.code, 1, start.text);
    assert.equal(start.json.error.code, 'USAGE');

    const restart = await cli(['restart', 'wait-plain', '--wait-ready']);
    assert.equal(restart.code, 1, restart.text);
    assert.equal(restart.json.error.code, 'USAGE');
    const st = await cli(['status', 'wait-plain']);
    assert.equal(st.json.data.status, 'RUNNING', 'restart 校验失败时不得先停旧实例');
    assert.equal((await cli(['stop', 'wait-plain'])).code, 0);
  });
} finally {
  for (const name of aliases) {
    try { await cli(['stop', name, '--tree'], 20000); } catch { /* 已退出 */ }
  }
  for (const pid of pids.filter(Boolean)) {
    try { killTree(pid); } catch { /* 已退出 */ }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nreadiness wait smoke ok');
