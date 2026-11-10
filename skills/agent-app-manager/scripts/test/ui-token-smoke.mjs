#!/usr/bin/env node
// manager ui 令牌鉴权冒烟测试：--token / --host / --public-host 的 401 / 302 登录 /
// cookie / Bearer / Host 白名单边界。隔离 --home + 空注册表，不触碰真实数据与业务进程。
// 用法：node scripts/test/ui-token-smoke.mjs   （无外部依赖，Node 22+）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { MANAGER } from './lib.mjs';

const TOKEN = 'smoke-secret-token-2026';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ui-token-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify({ schemaVersion: 1, apps: {} }));

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const child = spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(port), '--token', TOKEN, '--public-host', 'public.example', '--public-host', 'tunnel.example:8443'], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = '';
child.stdout.on('data', (d) => { banner += d; });
child.stderr.on('data', (d) => { banner += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p, { method = 'GET', host, headers: extra = {} } = {}) => new Promise((res, rej) => {
  const headers = { ...extra };
  if (host) headers.Host = host;
  const r = http.request(`http://127.0.0.1:${port}${p}`, { method, headers }, (rs) => {
    let b = '';
    rs.on('data', (d) => { b += d; });
    rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
  });
  r.on('error', rej);
  r.end();
});

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await get('/api/apps')).status === 401; } catch { /* 未就绪 */ }
    if (!up) await wait(200);
  }
  assert(up, 'manager ui 未在 10s 内就绪（应返回 401）');

  await check('启动横幅：首次访问 URL 用公网入口 + 必带泄露警示（有意设计）', () => {
    // token 模式 banner 有意输出 ?token= 首次访问 URL；有 --public-host 时登录地址用首个
    // 公网入口（loginBase = publicUrl ?? uiUrl）。必须带"请勿转发/截图"与"令牌等同完全
    // 控制权"警示；若将来有人移除警示而保留 token 输出，此断言即失败。
    assert(banner.includes('https://public.example/?token='), '缺少公网入口首次访问 URL');
    assert(banner.includes('请勿转发/截图'), '缺少泄露警示');
    assert(banner.includes('令牌等同完全控制权'), '缺少控制权警示');
    assert(banner.includes(`运行管理台: http://127.0.0.1:${port}/`), '本机地址应始终显示');
  });

  await check('无凭证 GET / 返回 401 HTML + WWW-Authenticate', async () => {
    const r = await get('/');
    assert.equal(r.status, 401);
    assert(r.body.includes('需要访问令牌'), `页面缺少提示：${r.body.slice(0, 120)}`);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(r.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  });
  await check('无凭证 GET /api/apps 返回 401 JSON UNAUTHORIZED（路由不可探测）', async () => {
    const r = await get('/api/apps');
    assert.equal(r.status, 401);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
    assert(r.json.error.message.includes('未授权'), `message 应为未授权提示：${r.json.error.message}`);
  });
  await check('错误 ?token= 一律 401（页面与 API 同口径）', async () => {
    assert.equal((await get('/?token=wrong')).status, 401);
    const r = await get('/api/apps?token=wrong');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
  });
  await check('错误 Bearer 返回 401', async () => {
    const r = await get('/api/apps', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
  });

  const login = await get(`/?token=${encodeURIComponent(TOKEN)}`);
  await check('正确 ?token= 返回 302 登录并写 HttpOnly 会话 cookie', () => {
    assert.equal(login.status, 302);
    const sc = String(login.headers['set-cookie'] ?? '');
    assert(sc.startsWith('aam_ui='), `Set-Cookie 缺失：${sc}`);
    assert(sc.includes('HttpOnly') && sc.includes('SameSite=Lax') && sc.includes('Path=/') && sc.includes('Max-Age=43200'), `cookie 属性不符：${sc}`);
    assert(!sc.includes(TOKEN), 'cookie 值不应含令牌明文');
  });
  await check('登录重定向清理 ?token（不留在地址栏/Referer）', () => {
    assert.equal(login.headers.location, '/');
    assert(!login.headers.location.includes('token'));
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0];

  await check('带会话 cookie 访问首页与 API 均 200', async () => {
    assert.equal((await get('/', { headers: { Cookie: cookie } })).status, 200);
    const r = await get('/api/apps', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
  await check('Authorization: Bearer 访问 API 200（脚本场景）', async () => {
    const r = await get('/api/apps', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
  await check('?token= 只对 GET 生效，POST 携带也按未授权处理', async () => {
    const r = await get(`/api/lifecycle?app=nosuchapp&op=stop&token=${encodeURIComponent(TOKEN)}`, { method: 'POST' });
    assert.equal(r.status, 401, r.body);
    assert.equal(r.json.error.code, 'UNAUTHORIZED');
  });

  await check('--public-host 无端口：Host 匹配直接放行（带凭证）', async () => {
    const r = await get('/api/apps', { host: 'public.example', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200, r.body);
  });
  await check('--public-host 无端口：:443 变体放行', async () => {
    const r = await get('/api/apps', { host: 'public.example:443', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200, r.body);
  });
  await check('--public-host 带端口：Host 精确匹配放行', async () => {
    const r = await get('/api/apps', { host: 'tunnel.example:8443', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200, r.body);
  });
  await check('Host 白名单不绕过鉴权（白名单 Host 无凭证仍 401）', async () => {
    const r = await get('/api/apps', { host: 'public.example' });
    assert.equal(r.status, 401);
  });
  await check('白名单外 Host 即使带凭证也 403（Host 校验先于鉴权）', async () => {
    const r = await get('/api/apps', { host: 'evil.example', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'FORBIDDEN');
  });
} finally {
  child.kill();
  let cleaned = false;
  for (let i = 0; i < 150; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleaned = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (!cleaned) console.warn(`[warn] 临时目录清理超时，已跳过（不影响断言）：${base}`);
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }