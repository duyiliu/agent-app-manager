const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
const fmtTime = t => t ? String(t).replace('T', ' ').replace(/\.\d+Z$/, '') : null;

let selected = null;          // 当前选中的 alias
let appsCache = [];
let paused = false, manualRefresh = false;
let previousStatuses = new Map();
let notifiedRuns;
try { notifiedRuns = new Set(JSON.parse(sessionStorage.getItem('pr-ui-notified-runs') || '[]')); } catch { notifiedRuns = new Set(); }
let wantedHistoryRun = null, selectedHistoryRun = null;
let fatal = false;            // 403（非本机访问）后停止轮询
let degrading = false;        // 数据损坏等持久性错误

async function api(path, signal, method = 'GET') {
  const u = new URL(path, location.origin);
  const r = await fetch(u, { cache: 'no-store', signal, method });
  const j = await r.json().catch(() => ({ ok: false, error: { code: 'BAD_JSON', message: '响应解析失败' } }));
  if (!r.ok) {
    const e = new Error(j?.error?.message || `请求失败（${r.status}）`);
    e.code = j?.error?.code; e.status = r.status;
    throw e;
  }
  return j.data;
}
function showBanner(text, warn = false) {
  const b = $('#fatalBanner');
  b.hidden = false;
  b.classList.toggle('warn', warn);
  b.replaceChildren(el('span', null, text));
}
function hideBanner() { $('#fatalBanner').hidden = true; }
function conn(text, bad = false) { const c = $('#connState'); c.textContent = text; c.classList.toggle('bad', bad); }
function notifyExit(runId, status, note) {
  if (!runId || notifiedRuns.has(runId)) return;
  notifiedRuns.add(runId);
  try { sessionStorage.setItem('pr-ui-notified-runs', JSON.stringify([...notifiedRuns])); } catch {}
  const banner = $('#exitBanner');
  banner.hidden = false;
  banner.textContent = `批次 ${runId} 状态变化：${status}${note ? ` · ${note}` : ''}`;
  // 浏览器通知：首次触发时申请权限，授权后 RUNNING→STOPPED/UNKNOWN 也推系统通知（标签页切走时仍可见）
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`project-runner · ${status}`, { body: `${runId}${note ? ` · ${note}` : ''}` });
    } else if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch { /* 通知不可用时仅保留页面横幅 */ }
}
function handlePollError(e) {
  conn(e.message, true);
  if (e.status === 403) {
    fatal = true;
    showBanner('访问被拒绝（403）：管理台仅接受 127.0.0.1 本机请求，请确认经本机直接访问。');
  } else if (String(e.code ?? '').startsWith('DATA_')) {
    degrading = true;
    showBanner(`数据异常[${e.code}] ${e.message} —— 按设计不静默跳过：请人工处置，不要删除运行数据重建。`, true);
  }
}

// ---------- 应用列表 ----------

function statusPill(status) { return el('span', 'pill st-' + (status ?? 'UNKNOWN'), status ?? 'UNKNOWN'); }
function renderApps() {
  const list = $('#appList');
  const q = ($('#appSearch').value || '').trim().toLowerCase();
  const rank = { RUNNING: 0, STARTING: 1, UNKNOWN: 2, STOPPED: 3 };
  const filtered = appsCache
    .filter(a => !q || [a.alias, a.displayName, a.mode, a.root, a.status, a.expectedPort].some(v => String(v ?? '').toLowerCase().includes(q)))
    .sort((x, y) => (rank[x.status] ?? 4) - (rank[y.status] ?? 4) || String(x.alias).localeCompare(String(y.alias)));
  $('#appCount').textContent = q ? `${filtered.length}/${appsCache.length}` : String(appsCache.length);
  const previousScroll = list.scrollTop;
  const existing = new Map([...list.querySelectorAll('.app-card')].map(card => [card.dataset.appId, card]));
  if (!appsCache.length) {
    if (!list.querySelector('.empty')) list.replaceChildren(el('div', 'empty', '注册表为空：尚无由本 Skill 启动并登记的应用。\n用 Skill/Agent 启动第一个项目后会自动出现在这里。'));
    return;
  }
  list.querySelector('.empty')?.remove();
  if (!filtered.length) { list.appendChild(el('div', 'empty', '无匹配应用')); return; }
  const ordered = [];
  for (const a of filtered) {
    const card = existing.get(a.appId) ?? el('button', 'app-card');
    existing.delete(a.appId);
    card.className = 'app-card' + (a.alias === selected ? ' selected' : '');
    card.dataset.appId = a.appId;
    card.replaceChildren();
    card.type = 'button';
    card.setAttribute('role', 'listitem');
    const head = el('div', 'app-head');
    head.append(el('span', 'app-alias', a.alias), statusPill(a.status));
    if (a.managed === false) head.appendChild(el('span', 'pill unmanaged', '非受管'));
    card.appendChild(head);
    const meta = el('div', 'app-meta');
    meta.append(el('span', null, a.mode ?? '?'));
    if (a.pid != null) meta.appendChild(el('span', null, 'pid ' + a.pid));
    if (a.expectedPort != null) {
      if (a.status === 'RUNNING') {
        const link = el('a', 'port-link', ':' + a.expectedPort);
        link.href = `http://127.0.0.1:${a.expectedPort}/`;
        link.target = '_blank'; link.rel = 'noopener';
        link.title = '新标签页打开该应用端口';
        link.addEventListener('click', (e) => e.stopPropagation());
        meta.appendChild(link);
      } else meta.appendChild(el('span', null, ':' + a.expectedPort));
    }
    if (a.error) meta.appendChild(el('span', 'v bad', a.error));
    card.appendChild(meta);
    card.appendChild(el('div', 'app-root', a.root ?? ''));
    card.title = a.error ? `${a.alias}：${a.error}` : `${a.alias} · ${a.appId}`;
    card.onclick = () => selectApp(a.alias);
    ordered.push(card);
  }
  for (const stale of existing.values()) stale.remove();
  ordered.forEach((card, i) => { if (list.children[i] !== card) list.insertBefore(card, list.children[i] ?? null); });
  list.scrollTop = previousScroll;
}
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 非安全上下文或拒绝授权：退回选区复制 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
function copyButton(text) {
  const btn = el('button', 'copy-btn', '复制');
  btn.type = 'button';
  btn.title = '复制命令';
  btn.addEventListener('click', async () => {
    const ok = await copyText(text);
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1600);
  });
  return btn;
}
function updateTitle() {
  const running = appsCache.filter(a => a.status === 'RUNNING').length;
  document.title = (running > 0 ? `(${running}) ` : '') + 'Project Runner · 运行管理台';
}
async function loadApps() {
  if (fatal || (paused && !manualRefresh)) return;
  try {
    const d = await api('/api/apps');
    hideBannerIfRecovered();
    appsCache = d.apps ?? [];
    for (const a of appsCache) {
      const old = previousStatuses.get(a.alias);
      const runId = a.lastRunId ?? null;
      if (old?.status === 'RUNNING' && ['STOPPED', 'UNKNOWN'].includes(a.status) && old.runId === runId) {
        try {
          const detail = await api('/api/status?app=' + encodeURIComponent(a.alias));
          notifyExit(runId, a.status, detail.run?.exitNote || detail.run?.lastError || detail.note || a.error || '退出说明不可用');
        } catch { notifyExit(runId, a.status, a.error || '退出说明不可用'); }
      }
      previousStatuses.set(a.alias, { status: a.status, runId });
    }
    updateTitle();
    $('#homePath').textContent = d.home ?? '';
    if (selected && !appsCache.some(a => a.alias === selected)) {
      selected = null;
      renderDetail(null);
      resetLog();
      $('#filesBtn').disabled = true;
      $('#fileDrawer').hidden = true;
    }
    renderApps();
    if (!selected) renderDetail(null);
    conn('已连接 · ' + new Date().toLocaleTimeString());
  } catch (e) { handlePollError(e); }
}
function hideBannerIfRecovered() { if (!degrading) hideBanner(); }

// ---------- 详情 ----------

function kvRow(grid, k, v, cls) {
  if (v == null || v === '') return;
  grid.append(el('div', 'k', k), el('div', 'v' + (cls ? ' ' + cls : ''), String(v)));
}
let detailOpen = false, detailTouched = false;
function applyDetail(open) {
  $('#detail').hidden = !open;
  $('#detailBar').setAttribute('aria-expanded', String(open));
}
function renderDetail(d) {
  const box = $('#detail');
  const bar = $('#detailBar');
  box.replaceChildren();
  if (!d) {
    bar.hidden = true;
    $('#detailOps').hidden = true;
    $('#detailOps').replaceChildren();
    box.hidden = false;
    box.appendChild(el('div', 'empty', selected ? '该应用已不在注册表中。' : '从左侧选择应用查看状态与日志。'));
    return;
  }
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('span', 'name', d.alias), statusPill(d.status),
    el('span', 'pill mode', d.mode ?? '?'),
    el('span', 'pill' + (d.managed === false ? ' unmanaged' : ''), d.managed === false ? '非受管' : '受管'));
  const opsSlot = $('#detailOps');
  opsSlot.replaceChildren();
  const st = d.status;
  if (d.managed !== false) {
    // 受管启停按钮：与 CLI start/stop/restart 同一实现；非受管登记不提供。
    // 摘要栏（折叠态也可见）与详情卡头各渲染一组。
    const makeOps = () => {
      const ops = el('span', 'op-group');
      const mk = (label, op, enabled, title, extra = '') => {
        const needsConfirm = op !== 'start' || extra;
        const armed = armedOp === `${d.alias}:${op}:${extra}`;
        const running = lifecycleBusy && lifecycleOpKey === `${d.alias}:${op}:${extra}`;
        const b = el('button', 'op-btn' + (running ? ' busy' : armed ? ' armed' : ''), running ? `${label}中…` : armed ? `确认${label}` : label);
        b.disabled = !enabled || lifecycleBusy;
        b.title = running ? `${label}执行中，可能需要数秒，请稍候` : armed ? '再次点击确认执行' : title + (needsConfirm ? '（需再点一次确认）' : '');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (needsConfirm && !armed) armOp(d.alias, op, extra);
          else { disarmOp(); doLifecycle(d.alias, op, extra); }
        });
        ops.appendChild(b);
      };
      const cur = d.run;
      const unresolved = cur && cur.managed !== false && !['RUNNING', 'STOPPED'].includes(cur.phase);
      mk('启动', 'start', st !== 'RUNNING' && st !== 'STARTING' && !unresolved, '复用已保存配置启动（同 CLI start）');
      mk('停止', 'stop', st === 'RUNNING', '有界强制终止，不杀进程树（同 CLI stop）');
      mk('重启', 'restart', st === 'RUNNING', '确认旧实例退出后启动新实例（同 CLI restart）');
      if (unresolved) mk('ack 并启动', 'start', true, `放弃未结记录 ${cur.runId} 并重新启动（同 start --ack-unresolved）`, `&ack=${encodeURIComponent(cur.runId)}`);
      mk('移除', 'remove', st === 'STOPPED', '从注册表移除登记（须无存活实例，证据保留；同 CLI remove）');
      return ops;
    };
    head.appendChild(makeOps());
    opsSlot.appendChild(makeOps());
    opsSlot.hidden = false;
  } else {
    // 非受管登记：不提供启停，STOPPED 时仍可移除登记（同 CLI remove 约束）
    const mkUnmanagedRemove = () => {
      const ops = el('span', 'op-group');
      const armed = armedOp === `${d.alias}:remove:`;
      const running = lifecycleBusy && lifecycleOpKey === `${d.alias}:remove:`;
      const b = el('button', 'op-btn' + (running ? ' busy' : armed ? ' armed' : ''), running ? '移除中…' : armed ? '确认移除' : '移除');
      b.disabled = st !== 'STOPPED' || lifecycleBusy;
      b.title = running ? '移除执行中，请稍候' : armed ? '再次点击确认执行' : '从注册表移除登记（须无存活实例，证据保留；同 CLI remove）（需再点一次确认）';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!armed) armOp(d.alias, 'remove');
        else { disarmOp(); doLifecycle(d.alias, 'remove'); }
      });
      ops.appendChild(b);
      return ops;
    };
    head.appendChild(mkUnmanagedRemove());
    opsSlot.appendChild(mkUnmanagedRemove());
    opsSlot.hidden = false;
  }
  head.appendChild(el('span', 'spacer'));
  head.appendChild(el('span', 'appid', d.appId));
  card.appendChild(head);

  const run = d.run;
  const needsAttention = run && run.managed !== false && !['RUNNING', 'STOPPED'].includes(run.phase);
  if (needsAttention) {
    const cmd = `start ${d.alias} --ack-unresolved ${run.runId}`;
    const alert = el('div', 'alert');
    alert.append(el('span', null, `未结记录（phase=${run.phase}，runId=${run.runId}）：不会自动重试。请先人工核验该进程是否仍存活（本页与 logs 可查），确认退出后用 manager CLI 执行 `));
    alert.appendChild(el('code', null, cmd));
    alert.appendChild(copyButton(cmd));
    alert.appendChild(el('span', null, ' 显式恢复。不要删除运行数据绕过。'));
    card.appendChild(alert);
  }
  if (d.readinessUntested) {
    card.appendChild(el('div', 'hint-line', '进程存活 ≠ 业务就绪：就绪与 JRebel/热加载验证需按 Skill 规程用真实证据判定，本页不代替该结论。'));
  }
  if (d.note) card.appendChild(el('div', 'hint-line', 'note: ' + d.note));

  const body = el('div', 'card-body');
  const grid = el('div', 'kv');
  kvRow(grid, '仓库', d.root);
  kvRow(grid, '入口', d.entry);
  if (d.expectedPort != null) {
    grid.appendChild(el('div', 'k', '预期端口'));
    const pv = el('div', 'v' + (st === 'RUNNING' ? '' : ' dim'));
    if (st === 'RUNNING') {
      const a = el('a', 'port-link', String(d.expectedPort));
      a.href = `http://127.0.0.1:${d.expectedPort}/`;
      a.target = '_blank'; a.rel = 'noopener'; a.title = '新标签页打开该应用端口';
      pv.appendChild(a);
    } else pv.textContent = String(d.expectedPort);
    grid.appendChild(pv);
  }
  kvRow(grid, 'pid', run?.pid ?? d.pid ?? null, run?.pid != null || d.pid != null ? 'good' : undefined);
  kvRow(grid, 'runId', run?.runId);
  kvRow(grid, 'phase', run?.phase);
  kvRow(grid, '启动时间', fmtTime(run?.startedAt));
  kvRow(grid, '结束时间', fmtTime(run?.endedAt));
  kvRow(grid, '退出说明', run?.exitNote, run?.exitNote ? 'dim' : undefined);
  kvRow(grid, '最近错误', run?.lastError, run?.lastError ? 'bad' : undefined);
  kvRow(grid, '身份证据', run?.creationFileTime ? `${run.creationFileTime} · ${run.image ?? '?'}` : null, 'dim');
  kvRow(grid, '环境引用', run?.envResolved?.length ? run.envResolved.join(', ') : null, 'dim');
  kvRow(grid, 'stdout', run?.logPaths?.stdout);
  kvRow(grid, 'stderr', run?.logPaths?.stderr);
  kvRow(grid, '日志线索', run?.logHints?.length ? run.logHints.join('\n') : null, 'dim');
  kvRow(grid, '记录文件', d.runtimeFile, 'dim');
  if (d.managed === false) kvRow(grid, '能力', '非受管登记：仅记录启动尝试与日志线索，不提供跨会话启停', 'dim');
  body.appendChild(grid);
  card.appendChild(body);

  if (d.prevRuns?.length) {
    card.appendChild(el('div', 'prev-title', '历史批次（prevRuns）'));
    for (const p of d.prevRuns.slice(0, 10)) {
      const row = el('div', 'prev-row');
      row.classList.add('history-pick');
      row.dataset.runId = p.runId;
      row.classList.toggle('selected', selectedHistoryRun === p.runId);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.appendChild(el('span', 'rid', p.runId));
      row.appendChild(el('span', 'dim', p.phase ?? '?'));
      if (p.pid != null) row.appendChild(el('span', 'dim', 'pid ' + p.pid));
      if (p.archivedAt) row.appendChild(el('span', 'dim', '归档 ' + fmtTime(p.archivedAt)));
      if (p.archiveReason) row.appendChild(el('span', 'why', p.archiveReason));
      if (p.lastError) row.appendChild(el('span', 'dim', p.lastError));
      row.addEventListener('click', () => selectHistoryRun(p.runId));
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectHistoryRun(p.runId); } });
      card.appendChild(row);
    }
  }
  box.appendChild(card);

  const bits = [
    run?.pid != null ? 'pid ' + run.pid : null,
    d.expectedPort != null ? ':' + d.expectedPort : null,
    run?.runId,
    fmtTime(run?.startedAt),
  ].filter(Boolean).join(' · ');
  $('#detailSummary').replaceChildren(
    el('span', 'db-name', d.alias),
    statusPill(d.status),
    el('span', 'pill mode', d.mode ?? '?'),
    el('span', 'pill' + (d.managed === false ? ' unmanaged' : ''), d.managed === false ? '非受管' : '受管'),
    el('span', 'db-info', bits));
  bar.hidden = false;
  applyDetail(detailTouched ? detailOpen : needsAttention);
}
let lifecycleBusy = false, lifecycleOpKey = null;
// 二次确认不用 window.confirm（预览/嵌套 iframe 中常被拦截、表现为“点了没反应”）：
// 第一次点击把按钮变成“确认X”4 秒内有效，再点一次才执行。
let armedOp = null, armedTimer = null;
function armOp(alias, op, extra = '') {
  disarmOp();
  armedOp = `${alias}:${op}:${extra}`;
  armedTimer = setTimeout(() => { disarmOp(); if (selected) loadStatus(); }, 4000);
  loadStatus();
}
function disarmOp() { armedOp = null; if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; } }
async function doLifecycle(alias, op, extra = '') {
  if (lifecycleBusy || !alias) return;
  lifecycleBusy = true;
  lifecycleOpKey = `${alias}:${op}:${extra}`;
  conn(`${op} ${alias} 执行中…`);
  manualRefresh = true;
  loadStatus(); // 立刻重绘按钮为执行中态，不等请求返回（stop/restart 可能数秒）
  try {
    const r = await api(`/api/lifecycle?app=${encodeURIComponent(alias)}&op=${op}${extra}`, undefined, 'POST');
    const pid = r.pid ?? r.start?.pid;
    showBanner(`${op} 成功：${alias}${pid ? `（pid=${pid}）` : ''}`, false);
  } catch (e) {
    showBanner(`${op} ${alias} 失败：${e.message}`, true);
  }
  lifecycleBusy = false;
  lifecycleOpKey = null;
  await Promise.all([loadApps(), loadStatus(), loadSources()]);
  manualRefresh = false;
  pollTail();
}

async function loadStatus() {
  if (fatal || (paused && !manualRefresh) || !selected) return;
  try {
    const detail = await api('/api/status?app=' + encodeURIComponent(selected));
    const old = previousStatuses.get(selected);
    const runId = detail.run?.runId;
    if (old?.status === 'RUNNING' && old.runId === runId && ['STOPPED', 'UNKNOWN'].includes(detail.status)) {
      notifyExit(runId, detail.status, detail.run?.exitNote || detail.run?.lastError || detail.note || '退出说明不可用');
    }
    previousStatuses.set(selected, { status: detail.status, runId });
    renderDetail(detail);
  } catch (e) {
    if (e.status === 404) { renderDetail(null); return; }
    handlePollError(e);
  }
}
function selectApp(alias) {
  if (selected === alias) return;
  selected = alias;
  selectedHistoryRun = null; wantedHistoryRun = null;
  logSrcWasCurrent = false;
  detailOpen = false; detailTouched = false;
  try {
    const u = new URL(location.href);
    u.searchParams.set('app', alias);
    history.replaceState(null, '', u); // 回写 ?app=<alias>：刷新后保持选中（初始定位已支持）
  } catch { /* 地址不可写时仅影响刷新定位，不阻塞选择 */ }
  renderApps();
  renderDetail(null);
  resetLog();
  $('#filesBtn').disabled = false;
  if (!$('#fileDrawer').hidden) loadTree('', $('#fdTree'), ++treeVersion);
  loadSources();
  loadStatus();
}

// ---------- 日志 ----------

const MAX_LINES = 8000;
const errorPattern = /\bERROR\b|Exception|(?:\w+Error)(?::|\b)|Caused by:|Suppressed:/;
const classify = t => errorPattern.test(t) ? 'err' : t.includes('JRebel:') ? 'jr' : /\bWARN\b/.test(t) ? 'warn'
  : /Preparing:|Parameters:|<== *Total|==>|SqlSession|JDBC Connection/.test(t) ? 'sql' : '';
let logSrc = null, logSrcLabel = '', logSrcWasCurrent = false, offset = -1, pending = '', decoder = new TextDecoder('utf-8'), logEncoding = 'utf-8';
let renderedId = 0, sourcesVersion = 0, sourcesController = null, sourcesBySrc = new Map();
let lines = [], nextId = 1, boundary = '', removed = 0, following = true, tailBusy = false;
// 过滤在渲染层做：lines 数组始终保留全量，清空条件即恢复全视图；
// errorsOnly 等价内置 errorPattern；自定义正则无效时给出提示而非静默失效（不过滤 + 输入框标红 + meta 提示）。
let errorsOnly = false, filterRe = null, filterError = null;
let logSize = 0, logFallbackLabel = '日志', renderedDomCount = 0;

function compileFilter() {
  const input = $('#logFilter');
  const raw = input.value.trim();
  filterRe = null;
  filterError = null;
  input.classList.remove('invalid');
  input.title = '';
  if (!raw) return;
  try { filterRe = new RegExp(raw); }
  catch (e) {
    filterError = e.message;
    input.classList.add('invalid');
    input.title = `正则无效：${e.message}`;
  }
}
function lineVisible(text) {
  if (errorsOnly && !errorPattern.test(text)) return false;
  return !filterRe || filterRe.test(text);
}
function visibleLines() { return lines.filter(l => lineVisible(l.text)); }
function renderMeta() {
  let text = `${logSrcLabel || logFallbackLabel} · ${fmtSize(logSize)} · 缓存 ${lines.length} 行`;
  if (removed) text += ` · 已移除较早 ${removed} 行`;
  if (filterError) text += ` · 正则无效（${filterError}），已按未过滤显示`;
  else if (filterRe || errorsOnly) text += ` · 命中 ${visibleLines().length} 行`;
  $('#logMeta').textContent = text;
}

function logHint(text, error = false) {
  const box = $('#log');
  box.replaceChildren(el('div', 'empty' + (error ? ' error' : ''), text));
  renderedDomCount = 0; // 内容已被提示节点替换，行计数同步清零，避免后续修剪误判
}
function resetLog() {
  offset = -1; pending = ''; logEncoding = 'utf-8'; decoder = new TextDecoder('utf-8'); renderedId = 0;
  lines = []; nextId = 1; boundary = ''; removed = 0; following = true;
  logSize = 0; logFallbackLabel = '日志'; renderedDomCount = 0;
  updateFollow();
  renderMeta();
  if (selected) logHint('等待日志输出…'); else logHint('选择左侧应用后查看日志。');
}
function updateFollow() {
  $('#followBtn').textContent = following ? '跟随中' : '恢复跟随';
  $('#followBtn').setAttribute('aria-pressed', String(following));
}
function renderLines(force = false) {
  const box = $('#log');
  if (!force && renderedId && lines[0]?.id <= renderedId) {
    const frag = document.createDocumentFragment();
    let appended = 0;
    for (const l of lines) if (l.id > renderedId) {
      if (!lineVisible(l.text)) continue; // 增量新行同样按当前过滤条件入视图
      const row = el('div', 'line ' + classify(l.text)); row.dataset.id = l.id;
      row.appendChild(document.createTextNode(l.text || ' ')); frag.appendChild(row); appended++;
    }
    box.appendChild(frag);
    renderedDomCount += appended;
    // DOM 窗口有界：不再全量 querySelectorAll。过滤激活时可见行数 < 缓存行数，
    // 旧逻辑按「DOM 行数 - 缓存行数」修剪永远不会触发，长会话下 DOM 无界增长。
    // 顶部可能有边界提示节点，用 querySelector 定位最靠前的 .line，不图断在提示节点上。
    while (renderedDomCount > MAX_LINES) {
      const victim = box.querySelector('.line');
      if (!victim) break;
      victim.remove();
      renderedDomCount--;
    }
    renderedId = lines.at(-1)?.id ?? renderedId;
    if (following) box.scrollTop = box.scrollHeight;
    return;
  }
  const wasEmpty = box.querySelector('.empty') !== null;
  if (!force && wasEmpty && !lines.length) return;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    if (!lineVisible(l.text)) continue; // 增量新行也按当前条件入视图
    const row = el('div', 'line ' + classify(l.text));
    row.dataset.id = l.id;
    row.appendChild(document.createTextNode(l.text || ' '));
    frag.appendChild(row);
  }
  box.replaceChildren(frag);
  if (boundary) box.prepend(el('div', 'empty', boundary));
  renderedDomCount = frag.childElementCount;
  renderedId = lines.at(-1)?.id ?? 0;
  if (following) box.scrollTop = box.scrollHeight;
  renderMeta();
}
async function pollTail() {
  if (fatal || (paused && !manualRefresh) || degrading || !selected || !logSrc || tailBusy) return;
  tailBusy = true;
  try {
    const d = await api(`/api/tail?app=${encodeURIComponent(selected)}&src=${encodeURIComponent(logSrc)}&offset=${offset}`);
    if (offset >= 0 && d.start !== offset) {
      pending = ''; logEncoding = 'utf-8'; decoder = new TextDecoder('utf-8'); renderedId = 0;
      lines = []; removed = 0; boundary = '日志已截断，读取位置已重置';
    } else if (offset < 0) {
      boundary = d.start > 0 ? `已加载尾部 ${fmtSize(d.size - d.start)}，更早内容未加载` : '从文件起始读取';
    }
    if (d.b64) {
      const bytes = Uint8Array.from(atob(d.b64), c => c.charCodeAt(0));
      if (d.encoding !== logEncoding) { logEncoding = d.encoding; decoder = new TextDecoder(logEncoding); pending = ''; }
      const parts = (pending + decoder.decode(bytes, { stream: true })).split('\n');
      pending = parts.pop();
      for (const text of parts) lines.push({ id: nextId++, text: text.replace(/\r$/, '') });
      if (lines.length > MAX_LINES) {
        const count = lines.length - MAX_LINES;
        lines.splice(0, count);
        removed += count;
      }
      renderLines();
    }
    offset = d.offset;
    logSize = d.size;
    logFallbackLabel = d.runId ? `${d.runId}.${d.stream}` : '日志';
    renderMeta();
    conn('已连接 · ' + new Date().toLocaleTimeString());
  } catch (e) {
    if (e.status === 404) { logHint('日志文件不存在（可能已被清理，或该批次未产生该流输出）。'); return; }
    handlePollError(e);
  } finally { tailBusy = false; }
}
async function loadSources() {
  if (paused && !manualRefresh) return;
  const version = ++sourcesVersion;
  sourcesController?.abort();
  sourcesController = new AbortController();
  const runSel = $('#runSel');
  if (!selected) { runSel.replaceChildren(); runSel.disabled = true; return; }
  try {
    const d = await api('/api/sources?app=' + encodeURIComponent(selected), sourcesController.signal);
    if (version !== sourcesVersion) return;
    runSel.replaceChildren();
    for (const s of d.sources ?? []) {
      runSel.appendChild(new Option(`${s.current ? '● ' : ''}${s.label} · ${fmtSize(s.size)}`, s.src));
    }
    const has = runSel.options.length > 0;
    runSel.disabled = !has;
    $('#followBtn').disabled = !has;
    $('#clearBtn').disabled = !has;
    $('#logFilter').disabled = !has;
    $('#errorsBtn').disabled = !has;
    $('#dlBtn').disabled = !has;
    if (!has) {
      const missingRunId = wantedHistoryRun;
      wantedHistoryRun = null;
      selectedHistoryRun = null;
      logSrc = null;
      logSrcLabel = '';
      logSrcWasCurrent = false;
      sourcesBySrc = new Map();
      logHint(missingRunId ? `历史批次 ${missingRunId} 没有 stdout 日志流。` : '该应用暂无可读日志源（受管批次、登记线索与项目 .tmp 日志都未找到）。');
      $('#logMeta').textContent = '';
      return;
    }
    const historicalSource = wantedHistoryRun ? `run:${wantedHistoryRun}.stdout` : null;
    if (historicalSource && ![...runSel.options].some(o => o.value === historicalSource)) {
      const missingRunId = wantedHistoryRun;
      wantedHistoryRun = null;
      selectedHistoryRun = null;
      $('#detail').querySelectorAll('.history-pick.selected').forEach(n => n.classList.remove('selected'));
      logSrc = null;
      logSrcLabel = '';
      logSrcWasCurrent = false;
      runSel.value = '';
      logHint(`历史批次 ${missingRunId} 没有 stdout 日志流。`);
      $('#logMeta').textContent = '';
      return;
    }
    let remembered = null, rememberedWasCurrent = false;
    try {
      remembered = selected ? sessionStorage.getItem('pr-ui-src:' + selected) : null;
      const flag = selected ? sessionStorage.getItem('pr-ui-src-cur:' + selected) : null;
      // 旧会话没有标志位：run:/hint: 源按"当时在跟随当前批次"处理（重启后回到最新）；tmp: 从来不是当前源
      rememberedWasCurrent = flag != null ? flag === '1' : /^(run|hint):/.test(remembered ?? '');
    } catch {}
    sourcesBySrc = new Map((d.sources ?? []).map((s) => [s.src, s]));
    // 跟随语义：所选源当时是"当前批次"，如今失去 current 标记（重启产生了新批次）或文件已清理——
    // 说明它在跟随旧批次，自动切到新当前源（优先保留 stdout/stderr 流）；刻意选的非当前源保持不动
    const staleFollow = (src, wasCurrent) => !!src && wasCurrent && !sourcesBySrc.get(src)?.current;
    const logSrcStale = staleFollow(logSrc, logSrcWasCurrent);
    const remStale = staleFollow(remembered, rememberedWasCurrent);
    const streamOf = (src) => sourcesBySrc.get(src)?.stream ?? 'stdout';
    const followSrc = (src) => (d.sources ?? []).find((s) => s.current && s.stream === streamOf(src))?.src
      ?? (d.sources ?? []).find((s) => s.current)?.src;
    const want = historicalSource
      || (!logSrcStale && logSrc && sourcesBySrc.has(logSrc) ? logSrc : null)
      || (!remStale && remembered && sourcesBySrc.has(remembered) ? remembered : null)
      || ((logSrcStale || remStale) ? followSrc(logSrcStale ? logSrc : remembered) : null)
      || runSel.options[0].value;
    runSel.value = want;
    const picked = (d.sources ?? []).find(s => s.src === want);
    logSrcLabel = picked ? picked.label : '';
    logSrcWasCurrent = !!picked?.current;
    if (want !== logSrc) { logSrc = want; resetLog(); }
    if (wantedHistoryRun && want === historicalSource) {
      const pickedRun = wantedHistoryRun;
      wantedHistoryRun = null;
      selectedHistoryRun = pickedRun;
      $('#detail').querySelectorAll('.history-pick').forEach(row => row.classList.toggle('selected', row.dataset.runId === pickedRun));
    }
  } catch (e) { if (e.name !== 'AbortError' && version === sourcesVersion) handlePollError(e); }
}

// ---------- 事件与轮询 ----------

async function manualReload() {
  if (fatal) return;
  manualRefresh = true;
  try {
    await loadApps();
    if (selected) { await Promise.all([loadStatus(), loadSources()]); pollTail(); }
  } finally { manualRefresh = false; }
}
$('#refreshBtn').addEventListener('click', manualReload);
$('#appSearch').addEventListener('input', renderApps);
$('#pauseBtn').addEventListener('click', () => {
  paused = !paused;
  $('#pauseBtn').textContent = paused ? '恢复刷新' : '暂停';
  $('#pauseBtn').setAttribute('aria-pressed', String(paused));
  $('#pauseBtn').classList.toggle('on', paused);
  if (!paused) manualReload();
});
async function selectHistoryRun(runId) {
  wantedHistoryRun = runId;
  selectedHistoryRun = runId;
  const source = `run:${runId}.stdout`;
  const row = $('#detail').querySelector(`.history-pick[data-run-id="${CSS.escape(runId)}"]`);
  $('#detail').querySelectorAll('.history-pick').forEach(n => n.classList.toggle('selected', n === row));
  logSrc = source;
  logSrcWasCurrent = false; // 历史批次必然非当前源；loadSources 会按 picked 重新落地
  resetLog();
  await loadSources();
  if (logSrc === source) pollTail();
}

$('#runSel').addEventListener('change', e => {
  wantedHistoryRun = null;
  $('#detail').querySelectorAll('.history-pick.selected').forEach(n => n.classList.remove('selected'));
  logSrc = e.target.value || null;
  logSrcWasCurrent = !!sourcesBySrc.get(logSrc)?.current;
  try {
    if (selected) {
      sessionStorage.setItem('pr-ui-src:' + selected, e.target.value);
      sessionStorage.setItem('pr-ui-src-cur:' + selected, logSrcWasCurrent ? '1' : '0');
    }
  } catch {}
  const opt = e.target.selectedOptions[0];
  logSrcLabel = opt ? opt.textContent.replace(/^● /, '').replace(/ · [\d.]+ (KB|MB)$/, '') : '';
  resetLog();
});
$('#detailBar').addEventListener('click', () => { detailTouched = true; applyDetail(detailOpen = $('#detail').hidden); });
$('#followBtn').addEventListener('click', () => { following = !following; updateFollow(); if (following) pollTail(); });
$('#clearBtn').addEventListener('click', () => { lines = []; renderedId = 0; removed = 0; boundary = '显示已清空，后续读取继续'; renderLines(true); });
$('#logFilter').addEventListener('input', () => { compileFilter(); renderLines(true); });
$('#logFilter').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; compileFilter(); renderLines(true); }
});
$('#errorsBtn').addEventListener('click', () => {
  errorsOnly = !errorsOnly;
  $('#errorsBtn').classList.toggle('on', errorsOnly);
  $('#errorsBtn').setAttribute('aria-pressed', String(errorsOnly));
  renderLines(true);
});
$('#log').addEventListener('click', (e) => {
  const row = e.target.closest('.line');
  if (!row) return;
  copyText(row.textContent).then((ok) => { if (ok) { row.classList.add('copied'); setTimeout(() => row.classList.remove('copied'), 800); } });
});
$('#dlBtn').addEventListener('click', () => {
  const text = lines.map((l) => l.text).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${selected || 'app'}-${(logSrcLabel || logFallbackLabel || 'log').replace(/[^\w.-]+/g, '_')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
try { if (localStorage.getItem('pr-ui-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch {}
$('#themeBtn').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme === 'light';
  if (light) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = 'light';
  try { localStorage.setItem('pr-ui-theme', light ? 'dark' : 'light'); } catch {}
});
$('#docBtn').addEventListener('click', async () => {
  $('#docOverlay').hidden = false;
  $('#docBody').textContent = '诊断中…';
  try { $('#docBody').textContent = JSON.stringify(await api('/api/doctor'), null, 2); }
  catch (e) { $('#docBody').textContent = `诊断失败：${e.message}`; }
});
$('#docClose').addEventListener('click', () => { $('#docOverlay').hidden = true; });
$('#docOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
$('#log').addEventListener('wheel', e => { if (e.deltaY < 0 && following) { following = false; updateFollow(); } }, { passive: true });
$('#log').addEventListener('scroll', () => {
  const box = $('#log');
  if (box.scrollTop + box.clientHeight < box.scrollHeight - 40 && following) { following = false; updateFollow(); }
}, { passive: true });

// ---------- 项目文件（只读，替代原单项 viewer 的文件树/预览） ----------

let treeVersion = 0, previewVersion = 0, previewOffset = 0, previewSize = 0, previewPath = '';
function fdHint(target, text, error = false) {
  target.replaceChildren(el('div', 'empty' + (error ? ' error' : ''), text));
}
async function loadTree(rel, target, version) {
  if (!selected) return;
  fdHint(target, '加载中…');
  try {
    const d = await api(`/api/tree?app=${encodeURIComponent(selected)}&path=${encodeURIComponent(rel)}`);
    if (version !== treeVersion) return;
    if (rel === '') {
      $('#fdRoot').textContent = d.root || '';
      $('#fdRoot').title = d.root || '';
    }
    target.replaceChildren();
    if (!d.entries.length) { fdHint(target, '空目录'); return; }
    for (const item of d.entries) {
      const row = el('button', 'fd-item', (item.directory ? '▸ ' : '· ') + item.name);
      row.type = 'button';
      row.title = item.path;
      target.appendChild(row);
      if (item.directory) {
        const children = el('div', 'fd-group');
        children.hidden = true;
        target.appendChild(children);
        let loaded = false, loading = false;
        row.addEventListener('click', async () => {
          children.hidden = !children.hidden;
          children.dataset.expanded = String(!children.hidden);
          row.textContent = (children.hidden ? '▸ ' : '▾ ') + item.name;
          if (!children.hidden && !loaded && !loading) {
            loading = true;
            await loadTree(item.path, children, version);
            loading = false;
            loaded = !children.querySelector('.empty');
          }
        });
      } else {
        row.addEventListener('click', () => {
          $('#fdTree').querySelectorAll('.fd-item.selected').forEach(n => n.classList.remove('selected'));
          row.classList.add('selected');
          previewFile(item.path);
        });
      }
    }
    applyTreeFilter();
  } catch (e) {
    if (version === treeVersion) fdHint(target, e.message, true);
  }
}
async function previewFile(rel, offset = 0) {
  previewPath = rel; previewOffset = offset;
  const version = ++previewVersion;
  $('#fdPath').textContent = rel;
  fdHint($('#fdBody'), '加载中…');
  try {
    const d = await api(`/api/file?app=${encodeURIComponent(selected)}&path=${encodeURIComponent(rel)}&offset=${offset}`);
    if (version !== previewVersion) return;
    const box = $('#fdBody');
    box.replaceChildren();
    if (d.binary) { fdHint(box, '不支持文本预览：二进制或非 UTF-8 文件'); return; }
    if (!d.text) { fdHint(box, '空文件'); return; }
    const frag = document.createDocumentFragment();
    d.text.split('\n').forEach((text, i) => {
      const line = el('div', 'fd-line');
      line.append(el('span', 'no', String(d.offset + i + 1)), el('span', 'tx', text || ' '));
      frag.appendChild(line);
    });
    box.appendChild(frag);
    previewOffset = d.offset; previewSize = d.size;
    $('#fdPath').textContent = `${rel} · ${fmtSize(d.size)} · ${fmtSize(d.offset)} - ${fmtSize(d.nextOffset)}`;
    $('#fdPrev').disabled = d.offset === 0;
    $('#fdNext').disabled = !d.hasMore;
    $('#fdTail').disabled = d.size <= 256 * 1024;
  } catch (e) {
    if (version === previewVersion) fdHint($('#fdBody'), e.message, true);
  }
}
function openFiles() {
  const drawer = $('#fileDrawer');
  if (!selected) return;
  drawer.hidden = false;
  $('#fdPath').textContent = '选择文件查看内容（只读，UTF-8 前 256 KB）';
  fdHint($('#fdBody'), '');
  loadTree('', $('#fdTree'), ++treeVersion);
}
$('#fdTail').addEventListener('click', () => previewFile(previewPath, Math.max(0, previewSize - 256 * 1024)));
$('#fdPrev').addEventListener('click', () => previewFile(previewPath, Math.max(0, previewOffset - 256 * 1024)));
$('#fdNext').addEventListener('click', () => previewFile(previewPath, previewOffset + 256 * 1024));
$('#filesBtn').addEventListener('click', openFiles);
$('#fdClose').addEventListener('click', () => { $('#fileDrawer').hidden = true; });
$('#fdRefresh').addEventListener('click', () => { if (selected) loadTree('', $('#fdTree'), ++treeVersion); });
function applyTreeFilter() {
  const query = $('#fdFilter').value.trim().toLocaleLowerCase();
  const root = $('#fdTree');
  for (const level of [root, ...root.querySelectorAll('.fd-group')]) {
    for (const row of [...level.children].filter(n => n.classList.contains('fd-item'))) {
      const child = row.nextElementSibling?.classList.contains('fd-group') ? row.nextElementSibling : null;
      const visible = !query || row.textContent.slice(2).toLocaleLowerCase().includes(query);
      row.hidden = !visible;
      if (child) child.hidden = !visible || child.dataset.expanded !== 'true';
    }
  }
}
$('#fdFilter').addEventListener('input', applyTreeFilter);
$('#fdFilterClear').addEventListener('click', () => { $('#fdFilter').value = ''; applyTreeFilter(); $('#fdFilter').focus(); });

// ---------- 启动 ----------
api('/api/meta').then((m) => { if (m?.version) $('#verBadge').textContent = `本地 · v${m.version}`; }).catch(() => {});
loadApps().then(() => {
  const wanted = new URLSearchParams(location.search).get('app');
  const pick = wanted && appsCache.find(a => a.alias === wanted || a.appId === wanted);
  if (pick) selectApp(pick.alias);
  else if (appsCache.length === 1) selectApp(appsCache[0].alias);
});
let pollTimers = [];
function schedulePolling() {
  pollTimers.forEach(clearInterval);
  const slow = document.visibilityState === 'hidden';
  pollTimers = [
    setInterval(loadApps, slow ? 30000 : 4000),
    setInterval(loadStatus, slow ? 30000 : 4000),
    setInterval(loadSources, slow ? 30000 : 8000),
    setInterval(pollTail, slow ? 30000 : 1000),
  ];
}
document.addEventListener('visibilitychange', schedulePolling);
schedulePolling();
