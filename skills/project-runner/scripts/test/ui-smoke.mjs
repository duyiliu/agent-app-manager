#!/usr/bin/env node
// manager ui 冒烟测试：隔离 --home + 临时应用记录，不触碰真实注册表与业务进程。
// 覆盖：Host 校验/只读边界、应用列表、状态、批次列表、日志 tail、非受管 logs 报错、未结记录拒启。
// 用法：node scripts/test/ui-smoke.mjs   （无外部依赖，Node 22+；未安装 pwsh 7 时跳过生命周期检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ui-smoke-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
const hintFile = path.join(base, 'hint', 'nohup.out');
for (const d of [path.join(home, 'runtime'), path.join(home, 'logs', 'ahis'), path.join(home, 'locks'), path.join(proj, '.tmp'), path.dirname(hintFile)]) {
  fs.mkdirSync(d, { recursive: true });
}
const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
w(path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), 'JRebel:  on\nINFO started\nERROR boom\n    at x.y(Z.java:1)\n');
w(path.join(home, 'logs', 'ahis', 'rtest1.stderr.log'), 'stderr line\n');
w(path.join(home, 'logs', 'ahis', 'rold1.stdout.log'), 'old run line\n');
w(path.join(proj, '.tmp', 'jrebel-local-20261020-100000.stdout.log'), 'tmp line A\n');
w(path.join(proj, '.tmp', 'runner-local-20261021-100000.stderr.log'), 'tmp line B\n');
w(path.join(proj, 'pom.xml'), '<project/>\n');
w(path.join(proj, '.env'), 'SECRET=x\n');
fs.mkdirSync(path.join(proj, '.ssh'), { recursive: true });
w(path.join(proj, '.ssh', 'id_ecdsa'), 'PRIVATE KEY\n');
w(path.join(proj, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
w(hintFile, 'hint 1\n');
const root = fs.realpathSync(proj);

w(path.join(home, 'registry.json'), JSON.stringify({
  schemaVersion: 1,
  apps: {
    ahis: { appId: 'ahis', alias: 'his', displayName: 'HIS', root, entry: 'default', cwd: root, mode: 'jrebel', exe: process.execPath, args: [], envRefs: [], expectedPort: 8080, sourceFingerprint: null, configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    arep: { appId: 'arep', alias: 'report', displayName: '报表', root, entry: 'default', cwd: root, mode: 'java', exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    astuck: { appId: 'astuck', alias: 'stuck', displayName: '卡住的服务', root, entry: 'default', cwd: root, mode: 'jrebel', exe: process.execPath, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    aghost: { appId: 'aghost', alias: 'ghost', displayName: '幽灵', root: path.join(base, 'missing-proj'), entry: 'default', cwd: path.join(base, 'missing-proj'), mode: 'java', exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  },
}));
const rt = (id, cur, prev = []) => w(path.join(home, 'runtime', `${id}.json`), JSON.stringify({ schemaVersion: 1, appId: id, current: cur, prevRuns: prev }));
const now = '2026-01-01T00:00:00Z';
rt('ahis', {
  runId: 'rtest1', phase: 'STOPPED', managed: true, mode: 'jrebel', intentAt: now, startedAt: now,
  pid: 99999, creationFileTime: '0', image: 'java.exe', envResolved: [],
  logPaths: { stdout: path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), stderr: path.join(home, 'logs', 'ahis', 'rtest1.stderr.log') },
  lastError: null, endedAt: now, exitNote: 'smoke',
}, [{ runId: 'rold1', phase: 'STOPPED', managed: true, startedAt: now, endedAt: now, archivedAt: now }]);
rt('arep', {
  runId: 'rtest2', phase: 'UNKNOWN', managed: false, mode: 'java', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  logHints: [hintFile], lastError: null, endedAt: null, note: '非受管',
});
rt('astuck', {
  runId: 'rstuck1', phase: 'UNKNOWN', managed: true, mode: 'jrebel', intentAt: now, startedAt: now,
  pid: null, creationFileTime: null, image: null, envResolved: [], logPaths: null,
  lastError: 'identity_capture_failed: smoke', endedAt: null,
});

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const child = spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = '';
child.stdout.on('data', (d) => { banner += d; });
child.stderr.on('data', (d) => { banner += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, { method = 'GET', host, headers: extra } = {}) => new Promise((res, rej) => {
  const headers = { ...extra };
  if (host) headers.Host = host;
  const url = `http://127.0.0.1:${port}${p}`;
  const r = http.request(url, { method, headers }, (rs) => {
    let b = '';
    rs.on('data', (d) => { b += d; });
    rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
  });
  r.on('error', rej);
  r.end();
});
const exitInfo = (c) => new Promise((res) => {
  let text = '';
  c.stdout.on('data', (d) => { text += d; });
  c.stderr.on('data', (d) => { text += d; });
  c.on('exit', (code) => res({ code, text }));
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

  await check('启动横幅含 URL（无令牌，可收藏）', () => assert(banner.includes(`http://127.0.0.1:${port}/`) && !banner.includes('token=')));

  const page = await get('/');
  await check('管理台页面含过滤输入框与只看错误开关', () => {
    assert.equal(page.status, 200);
    for (const marker of ['id="logFilter"', 'id="errorsBtn"', 'id="followBtn"', '/api/health', 'healthPill']) {
      assert(page.body.includes(marker), `页面缺少 ${marker}`);
    }
  });
  await check('管理台页面禁止被 iframe 嵌入（防点击劫持）', () => {
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  });
  await check('Sec-Fetch-Dest: iframe 请求直接拒绝（403）', async () => {
    const r = await get('/', { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(r.status, 403);
  });
  await check('管理台页面内嵌脚本语法有效', () => {
    const m = /<script>([\s\S]*?)<\/script>/.exec(page.body);
    assert(m, '页面缺少内嵌脚本');
    new vm.Script(m[1]); // 只编译不执行
  });

  await check('Host 不匹配返回 403', async () => assert.equal((await get('/api/apps', { host: 'evil.example' })).status, 403));
  await check('POST 拒绝（405）', async () => assert.equal((await get('/api/apps', { method: 'POST' })).status, 405));

  await check('GET /api/port 参数校验与 Host 校验', async () => {
    assert.equal((await get('/api/port?port=' + port, { host: 'evil.example' })).status, 403);
    assert.equal((await get('/api/port?port=0')).status, 400);
    assert.equal((await get('/api/port?port=not-a-port')).status, 400);
    assert.equal((await get('/api/port')).status, 400);
  });
  await check('/api/port 只读返回白名单字段，不暴露命令行', async () => {
    const r = await get('/api/port?port=' + port);
    if (r.status === 503 && r.json?.error?.code === 'PWSH_MISSING') { console.log('  skip 端口探测（缺 pwsh 7）'); return; }
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.data.port, port);
    assert(Array.isArray(r.json.data.occupants));
    assert(r.json.data.occupants.length >= 1, '管理台自身监听应被识别');
    assert(typeof r.json.data.cliCommand === 'string' && r.json.data.cliCommand.includes(`port ${port}`));
    const forbidden = new Set(['commandLine', 'cmd', 'args', 'command']);
    const allowedOccupant = new Set(['pid', 'processName', 'executablePath', 'startedAt', 'localAddress', 'localPort', 'source', 'note', 'identity']);
    const allowedIdentity = new Set(['result', 'code', 'creationFileTime', 'image', 'comm']);
    const walk = (value, trail) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
      if (!value || typeof value !== 'object') return;
      for (const [k, v] of Object.entries(value)) {
        assert(!forbidden.has(k), `${trail}.${k} 不应暴露`);
        walk(v, `${trail}.${k}`);
      }
    };
    walk(r.json.data, 'data');
    for (const o of r.json.data.occupants) {
      for (const k of Object.keys(o)) assert(allowedOccupant.has(k), `占用进程字段不在白名单：${k}`);
      if (o.identity) for (const k of Object.keys(o.identity)) assert(allowedIdentity.has(k), `身份字段不在白名单：${k}`);
    }
  });

  // lifecycle 写操作防 CSRF：GET 必须被方法守卫挡在业务之外（405 而非业务错误码），
  // 跨站来源（Sec-Fetch-Site=cross-site 或异源 Origin）的 POST 一律 403。
  await check('GET /api/lifecycle 拒绝（405）', async () => {
    const r = await get('/api/lifecycle?app=nosuchapp&op=stop');
    assert.equal(r.status, 405);
  });
  await check('cross-site POST /api/lifecycle 拒绝（403）', async () => {
    const r = await get('/api/lifecycle?app=nosuchapp&op=stop', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
  });
  await check('异源 Origin 的 POST /api/lifecycle 拒绝（403）', async () => {
    const r = await get('/api/lifecycle?app=nosuchapp&op=stop', { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
  });
  await check('同源 POST /api/lifecycle 可进入业务（404 应用不存在）', async () => {
    const r = await get('/api/lifecycle?app=nosuchapp&op=stop', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 404);
  });

  const apps = (await get('/api/apps')).json.data.apps;
  await check('应用列表（4 个登记应用）', () => assert.equal(apps.length, 4));
  await check('应用列表含 displayName（按显示名搜索的数据基础）', () => {
    assert.equal(apps.find((a) => a.alias === 'his').displayName, 'HIS');
    assert.equal(apps.find((a) => a.alias === 'report').displayName, '报表');
  });
  await check('受管 STOPPED 状态', () => assert.equal(apps.find((a) => a.alias === 'his').status, 'STOPPED'));
  await check('非受管 managed=false', () => assert.equal(apps.find((a) => a.alias === 'report').managed, false));
  await check('缺失目录应用 ghost 仍列出', () => assert(apps.some((a) => a.alias === 'ghost')));

  const status = (await get('/api/status?app=his')).json.data;
  await check('status 详情（runId/日志路径）', () => {
    assert.equal(status.status, 'STOPPED');
    assert.equal(status.run.runId, 'rtest1');
    assert(status.run.logPaths.stdout.endsWith('rtest1.stdout.log'));
  });

  const health = (await get('/api/health')).json.data;
  await check('健康总览：非 RUNNING 应用为 UNTESTED 且不做端口/就绪探测', () => {
    assert.equal(health.apps.length, 4);
    const his = health.apps.find((a) => a.alias === 'his');
    assert.equal(his.status, 'STOPPED');
    assert.equal(his.state, 'UNTESTED');
    assert.equal(his.listening, null);
    assert.equal(his.readiness.state, 'UNTESTED');
    assert(his.readiness.note.includes('非 RUNNING'));
    assert.equal(health.summary.running, 0);
    assert.equal(health.summary.untested, 0);
    assert(health.note.includes('监听（TCP）≠ 业务就绪'));
  });
  await check('GET-only：POST /api/health 返回 405', async () => assert.equal((await get('/api/health', { method: 'POST' })).status, 405));

  const runs = (await get('/api/runs?app=his')).json.data;
  await check('批次列表（当前 + prevRuns）', () => {
    assert.equal(runs.current.runId, 'rtest1');
    assert(runs.prevRuns.some((p) => p.runId === 'rold1'));
  });

  const sources = (await get('/api/sources?app=his')).json.data.sources;
  await check('统一日志源（当前 stdout 优先 + 历史 + .tmp）', () => {
    assert.equal(sources[0].src, 'run:rtest1.stdout');
    assert(sources.some((s) => s.src === 'run:rold1.stdout'));
    assert(sources.some((s) => s.src === 'tmp:jrebel-local-20261020-100000.stdout.log'));
    assert(sources.some((s) => s.src === 'tmp:runner-local-20261021-100000.stderr.log'));
  });
  await check('统一日志源含双流合并源（标注近似顺序）', () => {
    const merged = sources.find((s) => s.src === 'merge:rtest1');
    assert(merged, '缺少当前批次合并源');
    assert.equal(merged.stream, 'both');
    assert.equal(merged.merged, true);
    assert(merged.label.includes('合并') && merged.label.includes('近似顺序'));
    assert(sources.some((s) => s.src === 'merge:rold1'), '缺少历史批次合并源');
  });
  const repSources = (await get('/api/sources?app=report')).json.data.sources;
  await check('非受管应用日志源=登记线索（hash 定位符）', () => assert.match(repSources[0].src, /^hint:[0-9a-f]{12}$/));
  const hintTail = (await get(`/api/tail?app=report&src=${encodeURIComponent(repSources[0].src)}`)).json.data;
  await check('hint 源 tail 内容', () => assert(Buffer.from(hintTail.b64, 'base64').toString('utf8').includes('hint 1')));
  const staleHint = (await get(`/api/tail?app=report&src=${encodeURIComponent('hint:0')}`));
  await check('hint 下标旧定位符明确报错（404）', () => {
    assert.equal(staleHint.status, 404);
    assert(staleHint.json.error.message.includes('失效'));
  });
  await check('hint 定位符在 logHints 变化后仍命中原文件（不错位）', async () => {
    // 在 listSources 与 tail 之间新增并调换线索顺序：旧下标会错位读到别的文件，hash 定位符必须仍命中原文件
    const hint2 = path.join(base, 'hint', 'second.out');
    w(hint2, 'hint 2\n');
    const rtNow = JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'arep.json'), 'utf8'));
    rtNow.current.logHints = [hint2, hintFile];
    fs.writeFileSync(path.join(home, 'runtime', 'arep.json'), JSON.stringify(rtNow, null, 2));
    const after = (await get('/api/sources?app=report')).json.data.sources;
    assert(after.some((s) => s.src === repSources[0].src), '原 hash 定位符在线索变化后丢失');
    const t2 = (await get(`/api/tail?app=report&src=${encodeURIComponent(repSources[0].src)}`)).json.data;
    assert(Buffer.from(t2.b64, 'base64').toString('utf8').includes('hint 1'));
  });
  await check('失效 hash 定位符明确报错（404）', async () => {
    const gone = (await get(`/api/tail?app=report&src=${encodeURIComponent('hint:deadbeefdead')}`));
    assert.equal(gone.status, 404);
    assert(gone.json.error.message.includes('失效'));
  });

  const tree = (await get('/api/tree?app=his&path=')).json.data;
  await check('文件树：列出 pom.xml，隐藏 .env/.ssh/.npmrc', () => {
    assert(tree.entries.some((e) => e.name === 'pom.xml'));
    assert(!tree.entries.some((e) => e.name === '.env'));
    assert(!tree.entries.some((e) => e.name === '.ssh'));
    assert(!tree.entries.some((e) => e.name === '.npmrc'));
  });
  const file = (await get('/api/file?app=his&path=pom.xml')).json.data;
  await check('文件预览内容', () => assert(file.text.includes('<project/>')));
  await check('.env 拒绝（403）', async () => assert.equal((await get('/api/file?app=his&path=.env')).status, 403));
  await check('.ssh/id_ecdsa 与 .npmrc 拒绝（403）', async () => {
    assert.equal((await get('/api/file?app=his&path=' + encodeURIComponent('.ssh/id_ecdsa'))).status, 403);
    assert.equal((await get('/api/file?app=his&path=' + encodeURIComponent('.npmrc'))).status, 403);
  });
  await check('路径穿越拒绝（403）', async () => assert.equal((await get('/api/file?app=his&path=..%2Fregistry.json')).status, 403));
  await check('ghost 项目目录缺失 tree 404', async () => assert.equal((await get('/api/tree?app=ghost&path=')).status, 404));

  const tail = (await get('/api/tail?app=his&run=rtest1&stream=stdout')).json.data;
  await check('tail 批次日志内容', () => assert(Buffer.from(tail.b64, 'base64').toString('utf8').includes('ERROR boom')));
  await check('非法 runId 返回 404', async () => assert.equal((await get('/api/tail?app=his&run=rnot-exist')).status, 404));

  const mergedTailRes = await get('/api/tail?app=his&src=merge:rtest1');
  const mergedTail = mergedTailRes.json.data;
  await check('合并 tail 同时返回 stdout/stderr 双流与双 offset', () => {
    assert.equal(mergedTailRes.status, 200);
    assert.equal(mergedTail.merged, true);
    assert.equal(mergedTail.stream, 'both');
    assert(mergedTail.orderNote.includes('近似'));
    assert.equal(mergedTail.streams.stdout.exists, true);
    assert.equal(mergedTail.streams.stderr.exists, true);
    assert.equal(mergedTail.streams.stdout.start, 0);
    assert.equal(mergedTail.streams.stderr.start, 0);
    assert(Buffer.from(mergedTail.streams.stdout.b64, 'base64').toString('utf8').includes('ERROR boom'));
    assert(Buffer.from(mergedTail.streams.stderr.b64, 'base64').toString('utf8').includes('stderr line'));
  });
  await check('合并 tail 以双 offset 增量读取，不重复旧内容', async () => {
    fs.appendFileSync(path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), 'later out\n');
    fs.appendFileSync(path.join(home, 'logs', 'ahis', 'rtest1.stderr.log'), 'later err\n');
    const d = (await get(`/api/tail?app=his&src=merge:rtest1&offset=${mergedTail.streams.stdout.offset},${mergedTail.streams.stderr.offset}`)).json.data;
    const out = Buffer.from(d.streams.stdout.b64, 'base64').toString('utf8');
    const err = Buffer.from(d.streams.stderr.b64, 'base64').toString('utf8');
    assert(out.includes('later out') && !out.includes('ERROR boom'));
    assert(err.includes('later err') && !err.includes('stderr line'));
    assert.equal(d.streams.stdout.offset, fs.statSync(path.join(home, 'logs', 'ahis', 'rtest1.stdout.log')).size);
    assert.equal(d.streams.stderr.offset, fs.statSync(path.join(home, 'logs', 'ahis', 'rtest1.stderr.log')).size);
  });
  await check('合并 tail 单侧截断/轮转回退到新文件起始', async () => {
    const stdoutFile = path.join(home, 'logs', 'ahis', 'rtest1.stdout.log');
    const stderrFile = path.join(home, 'logs', 'ahis', 'rtest1.stderr.log');
    const outOffset = fs.statSync(stdoutFile).size;
    const errOffset = fs.statSync(stderrFile).size;
    fs.writeFileSync(stderrFile, 'after rotate\n');
    const d = (await get(`/api/tail?app=his&src=merge:rtest1&offset=${outOffset},${errOffset}`)).json.data;
    assert.equal(d.streams.stderr.start, 0, '截断后 stderr 应从新文件起始读取');
    assert(Buffer.from(d.streams.stderr.b64, 'base64').toString('utf8').includes('after rotate'));
    assert.equal(d.streams.stdout.start, outOffset, '未轮转的 stdout 保持原 offset');
  });

  const repTail = await get('/api/tail?app=report');
  await check('非受管 tail 报错给出线索（404）', () => {
    assert.equal(repTail.status, 404);
    assert(repTail.json.error.message.includes('非受管'));
    assert(repTail.json.error.message.includes('nohup.out'));
  });

  const logsCli = await exitInfo(spawn(process.execPath, [MANAGER, '--home', home, 'logs', 'report'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await check('非受管 logs 报错并给出线索（退出码 2）', () => {
    assert.equal(logsCli.code, 2);
    assert(logsCli.text.includes('非受管'));
    assert(logsCli.text.includes('nohup.out'));
  });

  const spawnUi = (p, extra = []) => spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(p), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  await check('生命周期 PORT_IN_USE 回传白名单 detail（含端口占用证据）', async () => {
    const regFile = path.join(home, 'registry.json');
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    reg.apps.ahis.expectedPort = port;
    reg.apps.ahis.args = ['-e', 'process.exit(0)'];
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
    const r = await get('/api/lifecycle?app=his&op=start', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}` } });
    if (r.status === 503 && r.json?.error?.code === 'PWSH_MISSING') { console.log('  skip 端口冲突 detail（缺 pwsh 7）'); return; }
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.error.code, 'PORT_IN_USE');
    const detail = r.json.error.detail;
    assert(detail && detail.port === port, `缺少端口 detail：${r.body}`);
    assert(Array.isArray(detail.occupants) && detail.occupants.length >= 1, '缺少占用证据');
    for (const o of detail.occupants) {
      assert(!('commandLine' in o) && !('cmd' in o), 'detail 不应包含命令行');
    }
    assert(!/commandLine|"cmd"|"args"/i.test(JSON.stringify(detail)), 'detail 不应包含命令行字段');
  });
  const dup = await exitInfo(spawnUi(port));
  await check('重复 ui 提示已有实例（退出码 3）', () => {
    assert.equal(dup.code, 3);
    assert(dup.text.includes('已有 manager ui 实例'));
  });
  const dupOpen = await exitInfo(spawnUi(port, ['--open']));
  await check('--open 不改变端口占用处理（冲突时不开浏览器，退出码 3）', () => {
    // 监听失败发生在拉起浏览器之前：不弹窗、不阻塞，仍按端口冲突退出
    assert.equal(dupOpen.code, 3);
    assert(dupOpen.text.includes('已有 manager ui 实例'));
  });
  const foreign = http.createServer((q, s) => s.end('not ours'));
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
  try {
    const occ = await exitInfo(spawnUi(foreign.address().port));
    await check('端口被其他程序占用时提示换端口（退出码 3）', () => {
      assert.equal(occ.code, 3);
      assert(occ.text.includes('被其他程序占用'));
    });
  } finally { foreign.close(); }

  const stuck = await exitInfo(spawn(process.execPath, [MANAGER, '--home', home, 'start', 'stuck'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await check('未结记录拒绝自动重试（UNRESOLVED_RUN）', () => {
    if (stuck.code === 4 && stuck.text.includes('PWSH_MISSING')) { console.log('  skip（缺 pwsh 7，跳过生命周期检查）'); return; }
    assert.equal(stuck.code, 3);
    assert(stuck.text.includes('UNRESOLVED_RUN'));
    assert(stuck.text.includes('--ack-unresolved'));
  });
} finally {
  child.kill();
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nui smoke ok');
