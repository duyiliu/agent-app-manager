#!/usr/bin/env node
// manager ui 日志源"跟随当前批次"测试：真实 ui server + node:vm 沙箱执行页面内嵌脚本（轻量 DOM 桩）。
// 覆盖：重启产生新批次后自动切到新当前源（保留 stdout/stderr 流偏好）；
//       刻意选择的历史批次/.tmp 源不被抢切；旧会话无标志位的 run: 记忆按跟随处理。
//       403（fatal）后各轮询入口停止发请求；loadSources 成功时清除残留横幅。
// 用法：node scripts/test/ui-src-follow.mjs [index.html 路径]（无外部依赖，Node 22+）
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
const PAGE = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager-ui', 'index.html'));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ui-follow-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
for (const d of [path.join(home, 'runtime'), path.join(home, 'logs', 'ahis'), path.join(proj, '.tmp')]) fs.mkdirSync(d, { recursive: true });
const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
const rtFile = path.join(home, 'runtime', 'ahis.json');
const now = '2026-01-01T00:00:00Z';

w(path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), 'rtest1 stdout\n');
w(path.join(home, 'logs', 'ahis', 'rtest1.stderr.log'), 'rtest1 stderr\n');
w(path.join(home, 'logs', 'ahis', 'rold1.stdout.log'), 'rold1 stdout\n');
w(path.join(proj, '.tmp', 'jrebel-local-20261020-100000.stdout.log'), 'tmp line\n');
w(path.join(proj, 'pom.xml'), '<project/>\n');
const root = fs.realpathSync(proj);

w(path.join(home, 'registry.json'), JSON.stringify({
  schemaVersion: 1,
  apps: {
    ahis: { appId: 'ahis', alias: 'his', displayName: 'HIS', root, entry: 'default', cwd: root, mode: 'java', exe: process.execPath, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now },
    arep: { appId: 'arep', alias: 'report', displayName: '报表', root, entry: 'default', cwd: root, mode: 'java', exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now },
  },
}));
// current=rtest1（STOPPED 受管）+ prev rold1；restart(n) 把 current 换成新 runId 并补日志文件
rtFile && w(rtFile, JSON.stringify({
  schemaVersion: 1, appId: 'ahis',
  current: { runId: 'rtest1', phase: 'STOPPED', managed: true, mode: 'java', intentAt: now, startedAt: now, pid: 99999, creationFileTime: '0', image: 'java.exe', envResolved: [], logPaths: { stdout: path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), stderr: path.join(home, 'logs', 'ahis', 'rtest1.stderr.log') }, lastError: null, endedAt: now, exitNote: 'smoke' },
  prevRuns: [{ runId: 'rold1', phase: 'STOPPED', managed: true, startedAt: now, endedAt: now, archivedAt: now }],
}));
const restart = (rid) => {
  const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  rt.prevRuns = [{ runId: rt.current.runId, phase: rt.current.phase, managed: rt.current.managed, startedAt: now, endedAt: now, archivedAt: now }, ...(rt.prevRuns ?? [])];
  rt.current = { ...rt.current, runId: rid, phase: 'RUNNING', logPaths: { stdout: path.join(home, 'logs', 'ahis', `${rid}.stdout.log`), stderr: path.join(home, 'logs', 'ahis', `${rid}.stderr.log`) }, endedAt: null, exitNote: null };
  w(rtFile, JSON.stringify(rt));
  w(path.join(home, 'logs', 'ahis', `${rid}.stdout.log`), `${rid} stdout\n`);
  w(path.join(home, 'logs', 'ahis', `${rid}.stderr.log`), `${rid} stderr\n`);
};

// ---------- 轻量 DOM 桩（只覆盖页面脚本用到的 API 面） ----------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {};
    this.style = {}; this.handlers = {}; this._cls = new Set(); this._text = '';
    this.hidden = false; this.disabled = false; this.value = ''; this.title = '';
    this.scrollTop = 0; this.scrollHeight = 0;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; },
      contains: (c) => s.has(c),
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new El('#text').withText(c) : c); }
  prepend(...cs) { for (const c of cs.reverse()) { const n = typeof c === 'string' ? new El('#text').withText(c) : c; n.parentNode = this; this.children.unshift(n); } }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { const p = this.parentNode; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentNode = null; }
  withText(t) { this._text = t; return this; }
  addEventListener(t, fn) { (this.handlers[t] ??= []).push(fn); }
  removeEventListener(t, fn) { const a = this.handlers[t]; const i = a?.indexOf(fn) ?? -1; if (i >= 0) a.splice(i, 1); }
  dispatch(t, ev) { for (const f of this.handlers[t] ?? []) f(ev); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (matchEl(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  closest(sel) { let n = this; while (n) { if (matchEl(n, sel)) return n; n = n.parentNode; } return null; }
  get nextElementSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] ?? null; }
  get options() { return this.children; }
  get selectedOptions() { return this.children.filter((c) => c.selected); }
  click() { this.dispatch('click', { target: this }); }
  focus() {}
  select() {}
}
// 复合选择器（tag / .cls / [data-x="v"] 组合，无后代组合器）
function matchEl(el, sel) {
  if (!(el instanceof El) || el.tagName === '#text' || el.tagName === '#fragment') return false;
  const re = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|([a-zA-Z][\w-]*)|(\*)/g;
  let m, tag = null; const cls = [], attrs = [];
  while ((m = re.exec(sel))) {
    if (m[1]) cls.push(m[1]);
    else if (m[2]) attrs.push([m[2], m[3]]);
    else if (m[4]) tag = m[4].toUpperCase();
  }
  if (tag && el.tagName !== tag) return false;
  for (const c of cls) if (!el._cls.has(c)) return false;
  for (const [k, v] of attrs) {
    const actual = k.startsWith('data-')
      ? el.dataset[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]
      : el.attrs[k];
    if (v === undefined ? actual === undefined : String(actual) !== v) return false;
  }
  return cls.length + attrs.length + (tag ? 1 : 0) > 0;
}
class Opt extends El { constructor(text, value) { super('option'); this._text = text ?? ''; this.value = value ?? this._text; this.selected = false; } get text() { return this._text; } }
class Frag extends El { constructor() { super('#fragment'); } }

const byId = new Map();
const elFor = (id) => { if (!byId.has(id)) byId.set(id, new El(id === 'runSel' ? 'select' : 'div')); return byId.get(id); };
const allEls = [];
const documentStub = {
  visibilityState: 'visible',
  documentElement: new El('html'),
  body: new El('body'),
  createElement: (t) => { const e = new El(t); allEls.push(e); return e; },
  createElementNS: (_ns, t) => { const e = new El(t); allEls.push(e); return e; },
  createDocumentFragment: () => new Frag(),
  querySelector: (sel) => sel.startsWith('#') ? elFor(sel.slice(1)) : (allEls.find((e) => matchEl(e, sel)) ?? null),
  querySelectorAll: (sel) => {
    if (sel.startsWith('#')) { const e = byId.get(sel.slice(1)); return e ? [e] : []; }
    return allEls.filter((e) => matchEl(e, sel));
  },
  addEventListener: () => {},
  execCommand: () => false,
};
// 页面通过 $('#id') 取元素：预挂到 body 下，保证 querySelectorAll 子树搜索与 closest 可用
const roots = ['appList', 'detail', 'detailBar', 'detailSummary', 'detailOps', 'runSel', 'log', 'fdTree', 'logMeta'];
for (const id of roots) documentStub.body.appendChild(elFor(id));
elFor('fileDrawer').hidden = true; // 文件抽屉默认关闭，跳过 loadTree 分支

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _map: m }; };
const sessionStorageStub = memStore();

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = '';
child.stdout.on('data', (d) => { banner += d; });
child.stderr.on('data', (d) => { banner += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => {
  http.get(`${origin}${p}`, (rs) => { let b = ''; rs.on('data', (d) => { b += d; }); rs.on('end', () => res({ status: rs.statusCode, body: b })); }).on('error', rej);
});

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

const html = fs.readFileSync(PAGE, 'utf8');
// 页面脚本自 #56 起外置为 app.js；仍校验 index.html 以 <script src="app.js"> 引用之。
const scriptRef = /<script\s+src="([^"]+)"><\/script>/.exec(html);
assert(scriptRef, '页面缺少 <script src> 引用');
const scriptSrc = fs.readFileSync(path.join(path.dirname(PAGE), scriptRef[1]), 'utf8');
const ctx = vm.createContext({
  document: documentStub,
  sessionStorage: sessionStorageStub,
  localStorage: memStore(),
  location: { origin, href: origin + '/', search: '' },
  history: { replaceState: () => {} },
  navigator: {},
  window: {},
  CSS: { escape: (s) => String(s) },
  Option: Opt,
  fetch, URL, URLSearchParams, TextDecoder, AbortController, AbortSignal, Blob, crypto, atob,
  setInterval, setTimeout, clearInterval, clearTimeout,
  // 本测试不检查 canvas 绘制；浏览器会在下一帧调用此回调。
  requestAnimationFrame: () => 0,
  console, alert: () => {},
});
new vm.Script(scriptSrc, { filename: 'index.html<script>' }).runInContext(ctx);
const run = (expr) => vm.runInContext(expr, ctx);
const poll = async (expr, pred, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    let v;
    try { v = run(expr); } catch { v = undefined; }
    if (pred(v)) return v;
    if (Date.now() - t > ms) throw new Error(`等待超时: ${expr}（当前 ${JSON.stringify(v)}）`);
    await wait(120);
  }
};
const pickSrc = (src) => {
  const sel = elFor('runSel');
  sel.dispatch('change', { target: { value: src, selectedOptions: sel.options.filter((o) => o.value === src) } });
};
const restartAndSync = async (rid) => { restart(rid); await run('loadSources()'); };

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await get('/api/apps')).status === 200; } catch { /* 未就绪 */ }
    if (!up) await wait(200);
  }
  assert(up, 'manager ui 未在 10s 内就绪');

  await poll('appsCache.length', (v) => v >= 2);
  const cardAppIds = () => [...elFor('appList').querySelectorAll('.app-card')].map((c) => c.dataset.appId).sort();
  const searchApps = (q) => { elFor('appSearch').value = q; run('renderApps()'); return cardAppIds(); };
  await check('应用搜索命中显示名（HIS/报表）与应用 ID（arep）', () => {
    assert.deepEqual(searchApps('HIS'), ['ahis']);
    assert.deepEqual(searchApps('报表'), ['arep']);
    assert.deepEqual(searchApps('arep'), ['arep']);
    elFor('appSearch').value = '';
    run('renderApps()');
  });

  run(`selectApp('his')`);
  await poll('logSrc', (v) => v !== null);

  await check('初始选中=当前批次 stdout', () => assert.equal(run('logSrc'), 'run:rtest1.stdout'));
  await check('内部浮层取消不执行，确认才执行操作', () => {
    run(`globalThis.__confirmed = 0; actionDialog('测试', '进程信息', () => __confirmed++)`);
    assert.equal(elFor('actionOverlay').hidden, false);
    assert.equal(elFor('actionMessage').textContent, '进程信息');
    elFor('actionCancel').onclick();
    assert.equal(run('__confirmed'), 0);
    assert.equal(elFor('actionOverlay').hidden, true);
    run(`actionDialog('测试', '进程信息', () => __confirmed++)`);
    elFor('actionConfirm').onclick();
    assert.equal(run('__confirmed'), 1);
    assert.equal(elFor('actionOverlay').hidden, true);
  });
  await check('端口冲突浮层提供强制启动并要求再次确认', async () => {
    run(`globalThis.__origApiForConflict = api; api = async (url, ...args) => {
      if (String(url).includes('/api/lifecycle')) throw Object.assign(new Error('端口已占用'), { code:'PORT_IN_USE', detail:{ port:8188, occupants:[{ pid:123, executablePath:'node', identity:{ result:'ok', creationFileTime:'1234', image:'node' } }] } });
      return __origApiForConflict(url, ...args);
    };`);
    try {
      await run(`doLifecycle('his','start')`);
      assert.equal(elFor('actionOverlay').hidden, false);
      assert.equal(elFor('actionConfirm').textContent, '强制启动');
      assert.match(elFor('actionMessage').textContent, /PID 123/);
      elFor('actionConfirm').onclick();
      assert.equal(elFor('actionTitle').textContent, '确认结束占用进程');
      assert.equal(elFor('actionConfirm').textContent, '确认结束并启动');
      elFor('actionCancel').onclick();
    } finally { run('api = __origApiForConflict'); }
  });

  await restartAndSync('rtest2');
  await check('重启后切到新当前批次 stdout', () => assert.equal(run('logSrc'), 'run:rtest2.stdout'));

  pickSrc('run:rtest2.stderr');
  await check('手动选当前批次 stderr 生效', () => assert.equal(run('logSrc'), 'run:rtest2.stderr'));
  await restartAndSync('rtest3');
  await check('跟随保留流偏好：新当前批次 stderr', () => assert.equal(run('logSrc'), 'run:rtest3.stderr'));

  pickSrc('run:rold1.stdout');
  await restartAndSync('rtest4');
  await check('刻意选历史批次：重启后不抢切', () => assert.equal(run('logSrc'), 'run:rold1.stdout'));
  await check('历史选择记忆标志=非当前', () => assert.equal(sessionStorageStub.getItem('pr-ui-src-cur:his'), '0'));
  await check('页面启动成功后优先切换当前批次', async () => {
    await run('loadSources({ preferCurrent: true })');
    assert.equal(run('logSrc'), 'run:rtest4.stdout');
  });

  pickSrc('run:rtest4.stdout');
  await restartAndSync('rtest5');
  await check('手动选当前批次后仍跟随新批次', () => assert.equal(run('logSrc'), 'run:rtest5.stdout'));

  pickSrc('tmp:jrebel-local-20261020-100000.stdout.log');
  await restartAndSync('rtest6');
  await check('.tmp 源选择重启后保持', () => assert.equal(run('logSrc'), 'tmp:jrebel-local-20261020-100000.stdout.log'));

  // 旧会话：有 pr-ui-src 无 -cur 标志位，run: 源按"当时在跟随"处理 → 回到新当前
  sessionStorageStub.setItem('pr-ui-src:his', 'run:rtest6.stdout');
  sessionStorageStub.removeItem('pr-ui-src-cur:his');
  run('logSrc = null; logSrcWasCurrent = false;');
  await restartAndSync('rtest7');
  await check('旧会话记忆（无标志位 run:）重启后跟随新当前', () => assert.equal(run('logSrc'), 'run:rtest7.stdout'));

  // 带标志位的非当前记忆：重启后仍保持原选择
  sessionStorageStub.setItem('pr-ui-src:his', 'run:rold1.stdout');
  sessionStorageStub.setItem('pr-ui-src-cur:his', '0');
  run('logSrc = null; logSrcWasCurrent = false;');
  await restartAndSync('rtest8');
  await check('非当前记忆（标志=0）重启后保持', () => assert.equal(run('logSrc'), 'run:rold1.stdout'));

  await check('所有生命周期操作首次点击只进入确认态，二次点击才提交', async () => {
    run(`globalThis.__lifecycleCalls = []; globalThis.__origDoLifecycle = doLifecycle; doLifecycle = (alias, op, extra = '') => { __lifecycleCalls.push({ alias, op, extra }); }; globalThis.__savedSelected = selected; selected = null;`);
    const clickBtn = (btn) => btn.dispatch('click', { target: btn, stopPropagation() {} });
    const cases = [
      { name: '普通启动', label: '启动', op: 'start', extra: '', d: { status: 'STOPPED', managed: true, run: { runId: 'rtest8', phase: 'STOPPED', managed: true } } },
      { name: '停止', label: '停止', op: 'stop', extra: '', d: { status: 'RUNNING', managed: true, run: { runId: 'rtest8', phase: 'RUNNING', managed: true } } },
      { name: '重启', label: '重启', op: 'restart', extra: '', d: { status: 'RUNNING', managed: true, run: { runId: 'rtest8', phase: 'RUNNING', managed: true } } },
      { name: 'ack 并启动', label: 'ack 并启动', op: 'start', extra: '&ack=ru1', d: { status: 'UNKNOWN', managed: true, run: { runId: 'ru1', phase: 'UNKNOWN', managed: true } } },
      { name: '受管移除', label: '移除', op: 'remove', extra: '', d: { status: 'STOPPED', managed: true, run: { runId: 'rtest8', phase: 'STOPPED', managed: true } } },
      { name: '非受管移除', label: '移除', op: 'remove', extra: '', d: { status: 'STOPPED', managed: false, run: { runId: 'rtest8', phase: 'STOPPED', managed: false } } },
    ];
    for (const c of cases) {
      const detail = { alias: 'his', appId: 'ahis', mode: 'java', expectedPort: null, ...c.d };
      run(`disarmOp(); __lifecycleCalls.length = 0; renderDetail(${JSON.stringify(detail)})`);
      const findBtn = () => [...elFor('detailOps').querySelectorAll('.op-btn')].find((b) => b.textContent === c.label || b.textContent === `确认${c.label}`);
      assert.equal(findBtn()?.textContent, c.label, `${c.name} 初始应为未确认态`);
      clickBtn(findBtn());
      assert.equal(run('__lifecycleCalls.length'), 0, `${c.name} 首次点击不应提交生命周期请求`);
      assert.equal(run('armedOp'), `his:${c.op}:${c.extra}`, `${c.name} 首次点击应进入确认态`);
      // 实际界面由轮询后的 renderDetail 重绘为确认态；这里显式重绘，避免依赖网络时序。
      run(`renderDetail(${JSON.stringify(detail)})`);
      assert.equal(findBtn()?.textContent, `确认${c.label}`, `${c.name} 重绘后应显示确认态`);
      clickBtn(findBtn());
      assert.equal(run('__lifecycleCalls.length'), 1, `${c.name} 二次点击应提交一次生命周期请求`);
      assert.equal(run('__lifecycleCalls[0].alias'), 'his');
      assert.equal(run('__lifecycleCalls[0].op'), c.op);
      assert.equal(run('__lifecycleCalls[0].extra'), c.extra);
      run('disarmOp()');
    }
    run('selected = __savedSelected; doLifecycle = __origDoLifecycle;');
  });
  // 合并源：同一批次 stdout/stderr 双流、双 offset/decoder；stderr 行加 [err] 前缀，
  // 过滤/只看错误/下载共用同一 lines 缓存；顺序明确标注为近似。
  run('pollTimers.forEach(clearInterval)');
  pickSrc('merge:rtest8');
  await run('pollTail()');
  await check('合并源同时显示 stdout 与带 [err] 前缀的 stderr', () => {
    assert.equal(run('logMerged'), true);
    const texts = run('lines.map(l => l.text)');
    assert(texts.includes('rtest8 stdout'));
    assert(texts.includes('[err] rtest8 stderr'));
    assert(elFor('logMeta').textContent.includes('近似顺序'));
  });
  fs.appendFileSync(path.join(home, 'logs', 'ahis', 'rtest8.stdout.log'), 'rtest8 later out\n');
  fs.appendFileSync(path.join(home, 'logs', 'ahis', 'rtest8.stderr.log'), 'rtest8 later err\n');
  await run('pollTail()');
  await check('合并源双 offset 增量跟随（不重复旧内容）', () => {
    const texts = run('lines.map(l => l.text)');
    assert(texts.includes('rtest8 later out'));
    assert(texts.includes('[err] rtest8 later err'));
    assert.equal(texts.filter((t) => t === 'rtest8 stdout').length, 1);
  });
  await check('合并源行参与只看错误与过滤（[err] 前缀可见）', () => {
    run('errorsOnly = true');
    assert.equal(run("lineVisible('[err] plain stderr')"), true);
    assert.equal(run("lineVisible('plain stdout')"), false);
    run('errorsOnly = false; filterRe = /later/');
    assert.equal(run("lineVisible('[err] rtest8 later err')"), true);
    assert.equal(run("lineVisible('rtest8 stdout')"), false);
    run('filterRe = null');
  });

  await restartAndSync('rtest9');
  await check('合并源跟随新当前批次（保留 both 流偏好）', () => assert.equal(run('logSrc'), 'merge:rtest9'));
  await run('pollTail()');
  fs.writeFileSync(path.join(home, 'logs', 'ahis', 'rtest9.stderr.log'), 'after rotate\n');
  await run('pollTail()');
  await check('合并源单侧轮转/截断后清空缓存并从新文件继续', () => {
    const boundary = run('boundary');
    assert(boundary.includes('stderr'));
    assert(boundary.includes('轮转') || boundary.includes('截断'));
    const texts = run('lines.map(l => l.text)');
    assert(texts.includes('[err] after rotate'));
  });
  const stderr9 = path.join(home, 'logs', 'ahis', 'rtest9.stderr.log');
  fs.renameSync(stderr9, `${stderr9}.1`);
  fs.writeFileSync(stderr9, 'after rename rotation with more bytes\n');
  await run('pollTail()');
  await check('合并源识别 rename+重建轮转（新文件更大也不漏读开头）', () => {
    assert(run('boundary').includes('stderr'));
    const texts = run('lines.map(l => l.text)');
    assert(texts.includes('[err] after rename rotation with more bytes'));
  });

  await check('详情卡展示退出码与信号并区分异常退出', () => {
    run(`renderDetail({ alias:'his', appId:'ahis', status:'STOPPED', managed:true, mode:'java', expectedPort:null, note:'异常退出（code=7）', run:{ runId:'rexit', phase:'STOPPED', managed:true, exit:{code:7,signal:null,at:'2026-01-01T00:00:00.000Z'}, exitSummary:'异常退出（code=7）', exitNote:'异常退出（code=7）' } })`);
    const text = elFor('detail').textContent;
    assert(text.includes('退出结果') && text.includes('code=7') && text.includes('异常退出'), text);
    run(`renderDetail({ alias:'his', appId:'ahis', status:'STOPPED', managed:true, mode:'java', expectedPort:null, note:'被信号终止（signal=SIGKILL）', run:{ runId:'rsig', phase:'STOPPED', managed:true, exit:{code:null,signal:'SIGKILL',at:'2026-01-01T00:00:01.000Z'}, exitSummary:'被信号终止（signal=SIGKILL）' } })`);
    const sigText = elFor('detail').textContent;
    assert(sigText.includes('signal=SIGKILL') && sigText.includes('被信号终止'), sigText);
  });
  await check('工作台入口展示运行状态、安全链接和停止按钮', () => {
    run(`workbench = {state:'RUNNING', url:'http://127.0.0.1:43123/', pid:123}; renderDetail({alias:'his',appId:'ahis',status:'STOPPED',managed:true,mode:'node'});`);
    const root = elFor('detail');
    const link = root.querySelectorAll('a').find((a) => a.href === 'http://127.0.0.1:43123/');
    assert(link && link.target === '_blank' && link.rel.includes('noopener'));
    assert(root.querySelector('.workbench-row') && root.textContent.includes('打开工作台') && root.textContent.includes('停止工作台'));
    assert.equal(link.title, 'http://127.0.0.1:43123/');
    assert(!root.textContent.includes('进入工作台'));
    assert(elFor('detailOps').textContent.includes('场景测试：已运行') && elFor('detailOps').textContent.includes('打开') && elFor('detailOps').textContent.includes('停止工作台'));
  });
  await check('工作台打开操作异步 POST 并打开独立地址', async () => {
    run(`selected='his'; workbenchBusy=false; globalThis.__workbenchFetch=fetch; globalThis.__opened=null; window.open=(...args)=>{globalThis.__opened=args}; fetch=async(u,options)=>{ globalThis.__request={url:String(u),method:options.method}; return {ok:true,json:async()=>({data:{state:'RUNNING',url:'http://127.0.0.1:43123/'}})}; };`);
    try {
      await run(`workbenchAction('his','open')`);
      assert.equal(run('__opened[0]'), 'http://127.0.0.1:43123/');
      assert.match(run('__opened[2]'), /noopener/);
      assert.equal(run('__request.method'), 'POST');
      assert.match(run('__request.url'), /\/api\/workbench\?app=his&op=open/);
    } finally { run(`fetch=__workbenchFetch; workbench=null;`); }
  });
  // #107：UI 必须优先展示/链接实际监听端口，expectedPort 只保留为启动前冲突检查与回退展示。
  await check('端口链接优先使用实际端口（列表与详情）', () => {
    const anchorHrefs = (root) => [...root.querySelectorAll('a.port-link')].map((a) => a.href);
    run(`renderDetail({ alias:'his', appId:'ahis', status:'RUNNING', managed:true, mode:'java', expectedPort:5173, actualPorts:[5174], portMismatch:true, run:{ runId:'rtest8', phase:'RUNNING', managed:true, pid:4242, startedAt:null } })`);
    const detailHrefs = anchorHrefs(elFor('detail'));
    assert(detailHrefs.includes('http://127.0.0.1:5174/'), `详情缺少实际端口链接：${detailHrefs.join(',')}`);
    assert(!detailHrefs.includes('http://127.0.0.1:5173/'), `详情不应链接 expectedPort：${detailHrefs.join(',')}`);
    assert(elFor('detail').textContent.includes('5173'), '详情应保留 expectedPort 展示');
    run(`appsCache = [{ alias:'portapp', appId:'aport', mode:'node', status:'RUNNING', pid:4242, expectedPort:5173, actualPorts:[5174], root:'/tmp/x' }]; renderApps();`);
    const listHrefs = anchorHrefs(elFor('appList'));
    assert(listHrefs.includes('http://127.0.0.1:5174/'), `列表缺少实际端口链接：${listHrefs.join(',')}`);
    assert(!listHrefs.includes('http://127.0.0.1:5173/'), `列表不应链接 expectedPort：${listHrefs.join(',')}`);
  });

  await check('详情卡生命周期控件：tree 复选框 + grace 毫秒输入，值跨重绘保留', () => {
    run(`lifecycleTree = false; lifecycleGrace = ''; renderDetail({ alias:'his', appId:'ahis', status:'RUNNING', managed:true, mode:'java', expectedPort:null, run:{ runId:'rtest8', phase:'RUNNING', managed:true, pid:1 } })`);
    const box = elFor('detail').querySelector('.lifecycle-tree');
    const grace = elFor('detail').querySelector('.lifecycle-grace');
    assert(box && grace, '详情卡缺少 tree 复选框或 grace 输入');
    assert.equal(box.type, 'checkbox');
    assert.equal(grace.type, 'number');
    box.checked = true; box.dispatch('change', { target: box });
    grace.value = '3000'; grace.dispatch('input', { target: grace });
    assert.equal(run('lifecycleTree'), true);
    assert.equal(run('lifecycleGrace'), '3000');
    run(`renderDetail({ alias:'his', appId:'ahis', status:'RUNNING', managed:true, mode:'java', expectedPort:null, run:{ runId:'rtest8', phase:'RUNNING', managed:true, pid:1 } })`);
    assert.equal(elFor('detail').querySelector('.lifecycle-tree').checked, true);
    assert.equal(elFor('detail').querySelector('.lifecycle-grace').value, '3000');
    run(`lifecycleTree = false; lifecycleGrace = '';`);
  });

  await check('stop 请求透传 tree/grace，横幅展示 treeKilled/killedPids', async () => {
    run(`lifecycleTree = true; lifecycleGrace = '3000'; lifecycleBusy = false; lifecycleOpKey = null;`);
    try {
      run(`globalThis.__uiUrls = []; globalThis.__origFetch = fetch; fetch = async (u, opt) => { const s = String(u); if (s.includes('/api/lifecycle')) { globalThis.__uiUrls.push(s); return { ok:true, status:200, json:async()=>({ ok:true, data:{ result:'stopped', treeKilled:[{ pid:4321, image:'node' }], killedPids:[4321] } }) }; } return globalThis.__origFetch(u, opt); };`);
      await run(`doLifecycle('his','stop')`);
      const urls = run('__uiUrls');
      assert.equal(urls.length, 1, JSON.stringify(urls));
      const u = new URL(urls[0]);
      assert.equal(u.searchParams.get('tree'), '1');
      assert.equal(u.searchParams.get('grace'), '3000');
      const banner = elFor('fatalBanner').textContent;
      assert(banner.includes('treeKilled=1'), banner);
      assert(banner.includes('killedPids=[4321]'), banner);
    } finally {
      run(`fetch = __origFetch;`);
      run(`lifecycleTree = false; lifecycleGrace = '';`);
    }
  });

  await check('启停执行中呈 loading（busy 类 + 禁用 + “中…”标签）', async () => {
    run(`lifecycleBusy = true; lifecycleOpKey = 'his:start:';`);
    run(`renderDetail({ alias:'his', appId:'ahis', status:'STOPPED', managed:true, mode:'java', expectedPort:null, run:{ runId:'rtest8', phase:'STOPPED', managed:true } })`);
    const buttons = [...elFor('detailOps').querySelectorAll('.op-btn'), ...elFor('detail').querySelectorAll('.op-btn')];
    const busy = buttons.filter((b) => b.classList.contains('busy'));
    assert.equal(busy.length, 1, '固定操作栏应只有一个 busy 按钮');
    assert(busy.every((b) => b.disabled && b.textContent.includes('启动中')), '执行中按钮应禁用并显示“启动中…”');
    assert(buttons.every((b) => b.disabled), '执行期间其余按钮应全部禁用');
    run(`lifecycleBusy = false; lifecycleOpKey = null;`);
    await run('loadStatus()');
  });

  await check('loadSources 成功加载时清除残留横幅', async () => {
    run(`showBanner('残留横幅')`);
    assert.equal(run(`$('#fatalBanner').hidden`), false, '前置横幅应可见');
    await run('loadSources()');
    assert.equal(run(`$('#fatalBanner').hidden`), true, '成功加载后横幅应隐藏');
  });

  await check('403 后各轮询入口均不再发请求', async () => {
    const realFetch = ctx.fetch;
    let calls = 0;
    ctx.fetch = () => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: { code: 'HOST_FORBIDDEN', message: '访问被拒绝（403）' } }),
      });
    };
    try {
      await run('loadSources()'); // 由真实轮询入口触发 403，使 fatal 生效
      assert.equal(run('fatal'), true, 'loadSources 收到 403 后应置 fatal');
      await wait(100); // 等待替换 fetch 前已发出的请求落地
      calls = 0;
      await run('Promise.all([loadApps(), loadStatus(), loadSources(), pollTail(), manualReload()])');
      await wait(1200); // 覆盖 pollTail 的 1s 定时器
      assert.equal(calls, 0, `fatal 后仍发出了 ${calls} 次轮询请求`);
    } finally {
      ctx.fetch = realFetch;
      run('fatal = false');
    }
  });

  await check('健康总览：列表与详情展示 READY 及监听/HTTP 证据', async () => {
    await run('loadApps()'); // 前序用例覆盖了 appsCache，先从服务端恢复真实应用列表
    run(`healthByAlias = new Map([['ahis', { appId:'ahis', status:'RUNNING', state:'READY', expectedPort:8080, listening:true, readiness:{ state:'READY', configured:true, evidence:[{ kind:'http', url:'http://127.0.0.1:8080/ready', status:200 }] } }]])`);
    run(`renderApps()`);
    const healthDot = elFor('appList').querySelector('.hl-dot');
    assert(healthDot, '应用列表缺少就绪圆点');
    assert(healthDot.title.includes('HTTP 200'), '就绪圆点缺少 HTTP 证据');
    run(`renderDetail({ alias:'his', appId:'ahis', status:'RUNNING', managed:true, mode:'java', expectedPort:8080, run:{ runId:'rtest8', phase:'RUNNING', managed:true, pid:123, logPaths:{} } })`);
    const text = elFor('detail').textContent;
    for (const marker of ['健康', 'READY', '监听 127.0.0.1:8080 → 是', 'HTTP 200']) {
      assert(text.includes(marker), `详情健康区块缺少 ${marker}：${text}`);
    }
    assert(elFor('detail').querySelector('.health-head')?.title.includes('监听（TCP）≠ 业务就绪'), '健康说明提示缺失');
    assert(elFor('detailSummary').querySelectorAll('.hl-READY').length >= 1, '摘要栏缺少健康状态 pill');
  });

  await check('健康总览：listening=null（未探测）不误渲染为“否”', async () => {
    run(`healthByAlias = new Map([['ahis', { appId:'ahis', status:'RUNNING', state:'UNTESTED', expectedPort:8080, listening:null, readiness:{ state:'UNTESTED', configured:false, evidence:[] } }]])`);
    run(`renderDetail({ alias:'his', appId:'ahis', status:'RUNNING', managed:true, mode:'java', expectedPort:8080, run:{ runId:'rtest8', phase:'RUNNING', managed:true, pid:123, logPaths:{} } })`);
    const text = elFor('detail').textContent;
    assert(text.includes('监听 127.0.0.1:8080 → 未探测'), `listening=null 应显示未探测：${text}`);
    assert(!text.includes('监听 127.0.0.1:8080 → 否'), `listening=null 不应显示为否：${text}`);
  });
} finally {
  child.kill();
  // Windows 上被杀进程的句柄释放有延迟，rmSync 可能 EBUSY。清理失败只告警，不让已完成的断言判负。
  let cleaned = false;
  for (let i = 0; i < 150; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleaned = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (!cleaned) console.warn(`[warn] 临时目录清理超时，已跳过（不影响断言）：${base}`);
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nui source-follow ok');
process.exit(0); // 页面脚本的轮询定时器仍挂在事件循环，显式退出
