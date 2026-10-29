// 隔离 home + 假项目：验证真实受管启动、配置复用、端口隔离与停止。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-workbench-'));
const home = path.join(base, 'home');
const manager = fileURLToPath(new URL('../manager.mjs', import.meta.url));
const cli = (...args) => {
  const p = spawnSync(process.execPath, [manager, '--json', '--home', home, ...args], { encoding: 'utf8', timeout: 120000 });
  if (p.error) throw p.error;
  let result; try { result = JSON.parse(p.stdout); } catch { throw new Error(`invalid manager output: ${p.stdout} ${p.stderr}`); }
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};
function project(name) {
  const root = path.join(base, name), dir = path.join(root, 'scenario-test');
  fs.mkdirSync(path.join(dir, '.scenario-test'), { recursive: true });
  if (process.env.SCENARIO_TEST_REPO) {
    const repo = process.env.SCENARIO_TEST_REPO;
    fs.cpSync(path.join(repo, 'examples', 'basic'), dir, { recursive: true });
    fs.cpSync(path.join(repo, 'dist'), path.join(dir, '.scenario-test'), { recursive: true });
  } else {
    fs.writeFileSync(path.join(dir, 'scenario.config.js'), 'throw new Error("discovery must not execute config")');
    fs.writeFileSync(path.join(dir, 'index.html'), name);
    fs.writeFileSync(path.join(dir, '.scenario-test', 'scenario-test-cli.cjs'), `const http=require('http'); const p=Number(process.argv[process.argv.indexOf('--port')+1]); http.createServer((req,res)=>res.end(${JSON.stringify(name)})).listen(p,'127.0.0.1');`);
  }
  return root;
}
function register(alias, root, entry) {
  const file = path.join(base, `${alias}.json`);
  fs.writeFileSync(file, JSON.stringify({ alias, root, entry, mode: 'node' }));
  cli('record-unmanaged', '--desc', file);
}
const started = [];
let ui;
function loggerPids() {
  const dir = path.join(home, 'runtime');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).current?.loggerPid).filter(Number.isInteger) : [];
}
try {
  const first = project('first'), second = project('second');
  register('one', first, 'one'); register('one-other', first, 'other'); register('two', second, 'one');
  assert.equal(cli('workbench', 'status', 'one').state, 'STOPPED');
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  ui = spawn(process.execPath, [manager, '--home', home, 'ui', '--port', String(port)], { stdio: 'ignore', windowsHide: true });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(origin + '/api/meta')).ok; } catch {} if (!ready) await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert(ready, 'UI not ready');
  started.push('one');
  const opening = fetch(origin + '/api/workbench?app=one&op=open', { method: 'POST', headers: { Origin: origin } });
  assert((await fetch(origin + '/api/meta')).ok, 'UI must stay responsive during launch');
  assert((await fetch(origin + '/api/status?app=one')).ok, 'app status must remain available during launch');
  const response = await opening; const payload = await response.json(); assert(response.ok, JSON.stringify(payload));
  const a = payload.data; assert.equal(a.state, 'RUNNING', JSON.stringify(a));
  const page = await (await fetch(a.url)).text();
  assert(process.env.SCENARIO_TEST_REPO ? page.includes('ScenarioTest') : page === 'first');
  if (process.env.SCENARIO_TEST_REPO) {
    assert((await fetch(new URL('/dist/scenario-test.umd.js', a.url))).ok, 'scenario-test browser runtime missing');
    assert((await fetch(new URL('/scenario.config.js', a.url))).ok, 'scenario-test config missing');
  }
  const same = cli('workbench', 'open', 'one-other'); assert.equal(same.pid, a.pid); assert.equal(same.url, a.url);
  started.push('two'); const b = cli('workbench', 'open', 'two'); assert.equal(b.state, 'RUNNING', JSON.stringify(b)); assert.notEqual(b.url, a.url);
  assert.equal(cli('list').apps.length, 3);
  cli('workbench', 'stop', 'one'); started.splice(started.indexOf('one'), 1);
  assert.equal(cli('workbench', 'status', 'two').state, 'RUNNING');
  fs.unlinkSync(path.join(second, 'scenario-test', '.scenario-test', 'scenario-test-cli.cjs'));
  const incomplete = cli('workbench', 'status', 'two'); assert.equal(incomplete.state, 'INCOMPLETE'); assert.equal(incomplete.pid, b.pid);
  cli('workbench', 'stop', 'two'); started.splice(started.indexOf('two'), 1);
  console.log(`workbench smoke (${process.env.SCENARIO_TEST_REPO ? 'real scenario-test' : 'fixture'}): PASS`);
} finally {
  if (ui) ui.kill();
  const loggers = loggerPids();
  let cleanupFailed = false;
  for (const alias of started) { try { cli('workbench', 'stop', alias); } catch (e) { cleanupFailed = true; console.error('cleanup:', e.message); } }
  const deadline = Date.now() + 30000;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (loggers.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (loggers.some(alive)) { cleanupFailed = true; console.error('logger still running:', loggers.filter(alive)); }
  if (cleanupFailed) console.error(`fixture retained: ${base}`);
  else fs.rmSync(base, { recursive: true, force: true });
}
