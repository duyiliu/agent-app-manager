const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
const fmtTime = t => t ? String(t).replace('T', ' ').replace(/\.\d+Z$/, '') : null;

let selected = null;          // 当前选中的 alias
let appsCache = [];
let healthByAlias = new Map(); // GET /api/health 结果：appId -> 健康总览行
let currentDetail = null;     // 最近一次 /api/status 结果，供健康刷新/诊断结果异步返回后原地重绘
let detailMissing = false;    // /api/status 返回 404：选中项确实不在注册表；否则详情区显示「正在加载」而非误报
let portDiag = null;          // { alias, port, loading, auto, data?, error? }
let lastLifecycleError = null; // { alias, op, code, message, detail? }：启停失败的可见详情（仅当前选择展示）
let paused = false, manualRefresh = false;
let previousStatuses = new Map();
let notifiedRuns;
try { notifiedRuns = new Set(JSON.parse(sessionStorage.getItem('pr-ui-notified-runs') || '[]')); } catch { notifiedRuns = new Set(); }
let wantedHistoryRun = null, selectedHistoryRun = null;
let fatal = false;            // 403（非本机访问）后停止轮询
let degrading = false;        // 数据损坏等持久性错误
let appsBusy = false, statusBusy = false, healthBusy = false; // loadApps/loadStatus/loadHealth 在飞守卫：响应慢于轮询周期时不堆叠请求
let statusSampleBusy = false; // 展开详情的按需资源采样：独立守卫，不能被轮询挡住

// 资源告警：只看当前值，不记峰值。内存取 /api/apps 的单点采样；
// CPU 需要连续高位才判定，避免 Java 启动/GC 的瞬时 100% 误报。
const RES_RSS_WARN = 2 * 1024 ** 3;
const RES_CPU_WARN = 80;
const RES_CPU_STREAK_WARN = 3;
const cpuStreaks = new Map(); // `${appId}:${runId}` → 连续 ≥ RES_CPU_WARN 的采样次数
const resKey = (row) => `${row.appId}:${row.lastRunId ?? '-'}`;
function trackCpuStreak(row) {
  if (row.cpuPercent == null) return;
  const key = resKey(row);
  const n = Number(row.cpuPercent) >= RES_CPU_WARN ? (cpuStreaks.get(key) ?? 0) + 1 : 0;
  if (n) cpuStreaks.set(key, n); else cpuStreaks.delete(key);
}
function resWarnOf(row) {
  if (row?.memoryBytes != null && row.memoryBytes >= RES_RSS_WARN) return `当前内存 ${fmtSize(row.memoryBytes)}，超过 ${fmtSize(RES_RSS_WARN)}`;
  const n = cpuStreaks.get(resKey(row)) ?? 0;
  if (n >= RES_CPU_STREAK_WARN) return `CPU 连续 ${n} 次采样 ≥ ${RES_CPU_WARN}%`;
  return null;
}
// 资源时间序列：只在详情展开时按 2s 采样，收起即停。60 点 = 2 分钟窗口。
// 采样走 /api/sample（CLI sample 子进程），单次约 1.3s；in-flight 去重避免叠加。
const RES_SERIES_MAX = 60;
const RES_SAMPLE_INTERVAL_MS = 2000;
let resSeries = [];          // [{ t, cpu, rss }]
let resSeriesAlias = null;   // 曲线归属的应用：换应用必须清空
let resTimer = null, resSampling = false;

function stopResSampling() {
  if (resTimer) clearInterval(resTimer);
  resTimer = null;
}
function resetResSeries(alias) {
  stopResSampling();
  resSeries = [];
  resSeriesAlias = alias ?? null;
}
function startResSampling(alias) {
  // 幂等：renderDetail 每 4s 重绘都会走 applyDetail，重复启动会把定时器不断重置、永远采不到点。
  if (resTimer && resSeriesAlias === alias) return;
  stopResSampling();
  if (!alias) return;
  if (resSeriesAlias !== alias) { resSeries = []; resSeriesAlias = alias; }
  const tick = async () => {
    if (resSampling || !selected || selected !== alias) return;
    resSampling = true;
    try {
      const d = await api('/api/sample?app=' + encodeURIComponent(alias));
      if (selected !== alias) return;
      if (!d?.available) return;
      resSeries.push({ t: Date.now(), cpu: Number(d.cpuPercent ?? 0), rss: Number(d.rssBytes ?? 0) });
      if (resSeries.length > RES_SERIES_MAX) resSeries.splice(0, resSeries.length - RES_SERIES_MAX);
      drawResChart();
    } catch { /* 单次采样失败不断曲线 */ }
    finally { resSampling = false; }
  };
  tick();
  resTimer = setInterval(tick, RES_SAMPLE_INTERVAL_MS);
}
function resChartLegend(label, color) {
  const span = el('span', 'res-chart-legend');
  const swatch = el('span', 'res-chart-swatch');
  swatch.style.background = color;
  span.append(swatch, el('span', null, label));
  return span;
}
function buildResChart() {
  const wrap = el('div', 'res-chart-wrap');
  const head = el('div', 'res-chart-head');
  const now = el('span', 'res-chart-now');
  now.id = 'resChartNow';
  head.append(
    el('span', 'res-chart-title', '资源曲线'),
    resChartLegend('CPU %', '#f59e0b'),
    resChartLegend('内存 MB', '#38bdf8'),
    now,
    el('span', 'res-chart-hint', `${RES_SAMPLE_INTERVAL_MS / 1000}s 采样 · 近 ${Math.round(RES_SERIES_MAX * RES_SAMPLE_INTERVAL_MS / 60000)} 分钟`),
  );
  const canvas = document.createElement('canvas');
  canvas.className = 'res-chart';
  canvas.id = 'resChart';
  wrap.append(head, canvas);
  return wrap;
}
function drawResChart() {
  const canvas = $('#resChart');
  if (!canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const gridColor = css.getPropertyValue('--line-soft').trim() || 'rgba(148,163,184,.15)';
  const dimColor = css.getPropertyValue('--text-faint').trim() || '#71829a';
  const padR = 44, padB = 12, padT = 6;
  const plotW = Math.max(1, w - padR), plotH = Math.max(1, h - padT - padB);
  // CPU 轴自适应：命令模式聚合后代后 CPU% 可超过 100，固定 0-100 会把峰值裁掉。
  const maxCpu = Math.max(100, ...resSeries.map(p => p.cpu));
  // 网格 + 右侧刻度（CPU 0 / 中值 / 上限）
  ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
  ctx.font = '9px "Cascadia Code", Consolas, monospace'; ctx.fillStyle = dimColor; ctx.textAlign = 'left';
  for (const pct of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - pct);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(String(Math.round(pct * maxCpu)), plotW + 6, y + 3);
  }
  if (resSeries.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText('采样中…', plotW / 2, padT + plotH / 2);
    return;
  }
  // 留 15% 余量，否则窗口内最大值总贴顶、小波动被放大成满屏起伏。
  const maxRss = Math.max(...resSeries.map(p => p.rss), 1) * 1.15;
  // 最新点贴右边缘、旧点向左滚出（任务管理器同款），窗口未满时左侧留空而不是从左往右爬。
  const offset = RES_SERIES_MAX - resSeries.length;
  const xOf = (i) => ((i + offset) / (RES_SERIES_MAX - 1)) * plotW;
  const yOfCpu = (v) => padT + plotH * (1 - Math.min(v, maxCpu) / maxCpu);
  const yOfRss = (v) => padT + plotH * (1 - v / maxRss);
  const drawLine = (pick, yOf, color) => {
    ctx.beginPath();
    resSeries.forEach((p, i) => { const x = xOf(i), y = yOf(pick(p)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  };
  drawLine(p => p.cpu, yOfCpu, '#f59e0b');
  drawLine(p => p.rss, yOfRss, '#38bdf8');
  // 当前值放到头部图例旁：画在线上会随曲线移动，两条线接近时文字互相压住。
  const last = resSeries[resSeries.length - 1];
  const now = $('#resChartNow');
  if (now) {
    now.replaceChildren(
      el('span', 'res-chart-value cpu', `CPU ${last.cpu.toFixed(0)}%`),
      el('span', 'res-chart-value rss', `内存 ${fmtSize(last.rss)}`),
    );
  }
}

// 展开详情时那次实时采样的缓存：轮询重绘（不带 resources）时继续显示它，避免数字来回跳。
// 按 runId 绑定而不是按时间过期——页面时钟在后台标签页会跳，TTL 判定不可靠；
// runId 变了（重启）或切换应用时自动失效。
let liveResources = null; // { alias, runId, rssBytes, cpuPercent, scope, reason?, at }

async function api(path, signal, method = 'GET') {
  const u = new URL(path, location.origin);
  const r = await fetch(u, { cache: 'no-store', signal, method });
  const j = await r.json().catch(() => ({ ok: false, error: { code: 'BAD_JSON', message: '响应解析失败' } }));
  if (!r.ok) {
    const e = new Error(j?.error?.message || `请求失败（${r.status}）`);
    e.code = j?.error?.code; e.status = r.status;
    // 服务端已按白名单裁剪 detail；页面只展示该副本，不自行猜测/回捞敏感字段。
    if (j?.error?.detail !== undefined) e.detail = j.error.detail;
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
  // 浏览器通知：授权后 RUNNING→STOPPED/UNKNOWN 也推系统通知（标签页切走时仍可见）。
  // 权限只能在用户手势中申请（浏览器会静默拒绝轮询回调里的 requestPermission），
  // 已挪到首次点击页面时询问（见事件区）。
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`project-runner · ${status}`, { body: `${runId}${note ? ` · ${note}` : ''}` });
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
function healthPill(state) { return el('span', 'pill hl-' + (state ?? 'UNTESTED'), state ?? 'UNTESTED'); }
function healthEvidenceLines(h) {
  const out = [];
  if (!h || h.status !== 'RUNNING') return ['非 RUNNING：未做端口监听/就绪探测'];
  out.push(h.expectedPort == null
    ? '监听：未登记 expectedPort，无法 TCP 探测'
    : `监听 127.0.0.1:${h.expectedPort} → ${h.listening == null ? '未探测' : h.listening ? '是' : '否'}`);
  const ev = h.readiness?.evidence ?? [];
  for (const e of ev) {
    if (e.kind === 'http') out.push(`HTTP ${e.status ?? '—'} ${e.url}${e.error ? ' · ' + e.error : ''}`);
    else if (e.kind === 'logPattern') out.push(`日志 ${e.stream}: ${e.matched}`);
  }
  if (!ev.length) out.push(h.readiness?.configured ? '就绪条件已配置但暂无证据' : '未配置 readyUrl / readyLogPattern：UNTESTED');
  return out;
}
function healthTitle(h) { return healthEvidenceLines(h).join('\n'); }
function healthBlock(h) {
  const box = el('div', 'health');
  const head = el('div', 'health-head');
  head.append(el('span', 'health-title', '健康'), healthPill(h.state),
    el('span', null, h.state === 'READY' ? '就绪证据命中' : h.state === 'NOT_READY' ? '就绪证据未命中' : '未做就绪探测'));
  box.appendChild(head);
  const ev = el('div', 'health-ev');
  for (const line of healthEvidenceLines(h)) ev.appendChild(el('div', null, line));
  box.appendChild(ev);
  box.appendChild(el('div', 'health-note', '监听（TCP）≠ 业务就绪：READY 仅代表配置的 readyUrl/readyLogPattern 证据命中。'));
  return box;
}
function exitLabel(exit) {
  if (!exit) return null;
  if (exit.signal) return 'signal=' + exit.signal;
  if (exit.code != null) return 'code=' + exit.code;
  return '退出码/信号不可用';
}
function exitOk(exit) { return !!exit && !exit.signal && exit.code === 0; }
function exitClass(exit) { return exit ? (exitOk(exit) ? 'good' : 'bad') : undefined; }
// 实际监听端口（#107）：优先用于展示与链接；expectedPort 仅作为启动前冲突检查与回退展示。
function actualPortsOf(d) {
  return Array.isArray(d?.actualPorts) ? d.actualPorts.filter((p) => Number.isInteger(p) && p > 0) : [];
}
function portAnchor(port, title) {
  const a = el('a', 'port-link', ':' + port);
  a.href = `http://127.0.0.1:${port}/`;
  a.target = '_blank'; a.rel = 'noopener';
  a.title = title ?? '新标签页打开该应用端口';
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}
function renderApps() {
  // 未选中应用时收起整块日志区（含工具栏），避免右侧同时出现两个空状态
  document.body.classList.toggle('no-selection', !selected);
  const list = $('#appList');
  const q = ($('#appSearch').value || '').trim().toLowerCase();
  const rank = { RUNNING: 0, STARTING: 1, BACKOFF: 2, UNKNOWN: 3, DEAD: 4, STOPPED: 5 };
  const filtered = appsCache
    .filter(a => !q || [a.alias, a.displayName, a.appId, a.mode, a.root, a.status, a.expectedPort, healthByAlias.get(a.appId)?.state, ...(a.tags ?? [])].some(v => String(v ?? '').toLowerCase().includes(q)))
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
    const health = healthByAlias.get(a.appId);
    head.append(el('span', 'app-alias', a.alias), statusPill(a.status));
    if (health) {
      // 卡片只保留「异常」与「正常」两态：UNTESTED 多为未配置就绪条件，属未知而非故障，
      // 常驻会与进程状态胶囊并列成噪音（Portainer 同理：没有 healthcheck 就不显示健康标）。
      // 完整三态与证据在详情卡 healthBlock 里展示。
      if (health.state === 'READY') {
        const dot = el('span', 'hl-dot');
        dot.title = healthTitle(health);
        head.appendChild(dot);
      } else if (health.state !== 'UNTESTED') {
        const hp = healthPill(health.state);
        hp.title = healthTitle(health);
        head.appendChild(hp);
      }
    }
    if (a.managed === false) head.appendChild(el('span', 'pill unmanaged', '非受管'));
    // 资源告警只在异常时出现（正常态无噪音）：当前内存超阈值，或 CPU 连续高位。
    trackCpuStreak(a);
    const resWarn = resWarnOf(a);
    if (resWarn) {
      const dot = el('span', 'res-warn');
      dot.title = resWarn;
      head.appendChild(dot);
    }
    card.appendChild(head);
    const meta = el('div', 'app-meta');
    meta.append(el('span', null, a.mode ?? '?'));
    if (a.tags?.length) meta.appendChild(el('span', null, a.tags.map(t => '#' + t).join(' ')));
    if (a.pid != null) meta.appendChild(el('span', null, 'pid ' + a.pid));
    const actualPorts = actualPortsOf(a);
    const shownPorts = actualPorts.length ? actualPorts : (a.expectedPort != null ? [a.expectedPort] : []);
    if (shownPorts.length) {
      if (a.status === 'RUNNING') {
        for (const port of shownPorts) {
          const title = actualPorts.length && a.expectedPort != null && a.expectedPort !== port
            ? `实际监听端口 ${port}（配置 expectedPort=${a.expectedPort}）`
            : '新标签页打开该应用端口';
          meta.appendChild(portAnchor(port, title));
        }
      } else meta.appendChild(el('span', null, ':' + (a.expectedPort ?? shownPorts[0])));
    }
    if (a.exit) meta.appendChild(el('span', 'v ' + exitClass(a.exit), exitLabel(a.exit)));
    // 内存列：list 的单点采样（命令模式已聚合后代）；采样不可用时不显示，避免伪造 0。
    if (a.memoryBytes != null) {
      const mem = el('span', 'app-mem', '内存 ' + fmtSize(a.memoryBytes));
      mem.title = a.resourcesScope === 'tree' ? 'RSS 单点采样（含受管目标后代聚合）' : 'RSS 单点采样';
      meta.appendChild(mem);
    }
    if (a.error) meta.appendChild(el('span', 'v bad', a.error));
    card.appendChild(meta);
    card.appendChild(el('div', 'app-root', a.root ?? ''));
    card.title = a.error ? `${a.alias}：${a.error}` : [a.alias, a.displayName !== a.alias ? a.displayName : null, a.appId, health ? health.state : null].filter(Boolean).join(' · ');
    card.onclick = () => selectApp(a.alias);
    ordered.push(card);
  }
  for (const stale of existing.values()) stale.remove();
  ordered.forEach((card, i) => { if (list.children[i] !== card) list.insertBefore(card, list.children[i] ?? null); });
  list.scrollTop = previousScroll;
  // 清理已消失或已换 run 的 CPU 计数，避免 Map 随重启次数无限增长。
  const liveKeys = new Set(appsCache.map(resKey));
  for (const k of [...cpuStreaks.keys()]) if (!liveKeys.has(k)) cpuStreaks.delete(k);
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
  if (fatal || (paused && !manualRefresh) || appsBusy) return;
  appsBusy = true;
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
          notifyExit(runId, a.status, detail.run?.exitNote || detail.run?.exitSummary || detail.run?.lastError || detail.note || a.error || '退出说明不可用');
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
  finally { appsBusy = false; }
}
// 任一轮询成功即视为数据层恢复可读：清掉 degrading 让日志跟随恢复轮询并隐藏横幅。
// DATA_UNREADABLE 可能是瞬时的（杀软扫描/原子写窗口）；若损坏持续，下一轮轮询会重新上报。
function hideBannerIfRecovered() { degrading = false; hideBanner(); }

// ---------- 详情 ----------

function kvRow(grid, k, v, cls) {
  if (v == null || v === '') return;
  grid.append(el('div', 'k', k), el('div', 'v' + (cls ? ' ' + cls : ''), String(v)));
}
let detailOpen = false, detailTouched = false;
let detailInitialized = false; // 该应用的详情是否已按「首次」规则决定过展开状态
// 停止/重启的附加参数：控件在详情卡内，值跨轮询重绘保留；启动/移除不使用。
let lifecycleTree = false, lifecycleGrace = '';
function applyDetail(open) {
  $('#detail').hidden = !open;
  $('#detailBar').setAttribute('aria-expanded', String(open));
  // 曲线只在详情展开时采样：收起即停，避免后台常驻 pwsh。
  if (open && selected) { startResSampling(selected); requestAnimationFrame(drawResChart); }
  else stopResSampling();
}
function rerenderDetail() {
  if (currentDetail && selected && currentDetail.alias === selected) renderDetail(currentDetail);
}
function detailJson(detail) {
  try { return JSON.stringify(detail, null, 2); }
  catch { return String(detail); }
}
function appendLifecycleError(card, d) {
  const err = lastLifecycleError;
  if (!err || err.alias !== d.alias) return;
  const panel = el('div', 'diag-panel diag-error');
  const head = el('div', 'diag-head');
  head.append(el('strong', null, `最近一次 ${err.op} 失败`), el('span', 'diag-code', err.code ?? 'ERROR'));
  const close = el('button', 'diag-close', '✕');
  close.type = 'button';
  close.title = '关闭失败详情';
  close.addEventListener('click', () => { lastLifecycleError = null; rerenderDetail(); });
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(el('div', 'diag-msg', err.message));
  if (err.detail !== undefined) {
    panel.appendChild(el('div', 'diag-note', '详情（服务端白名单字段）：'));
    panel.appendChild(el('pre', 'diag-json', detailJson(err.detail)));
  }
  card.appendChild(panel);
}
function appendPortDiagnosis(card, d) {
  const st = portDiag;
  if (!st || st.alias !== d.alias) return;
  const panel = el('div', 'diag-panel');
  const head = el('div', 'diag-head');
  head.append(el('strong', null, `端口 ${st.port} 诊断`));
  if (st.auto) head.appendChild(el('span', 'diag-code', '自动'));
  const refresh = el('button', 'diag-btn', st.loading ? '诊断中…' : '重新诊断');
  refresh.type = 'button';
  refresh.disabled = st.loading;
  refresh.addEventListener('click', () => diagnosePort(st.alias, st.port));
  const close = el('button', 'diag-close', '✕');
  close.type = 'button';
  close.title = '关闭端口诊断';
  close.addEventListener('click', () => { portDiag = null; rerenderDetail(); });
  head.append(refresh, close);
  panel.appendChild(head);
  if (st.loading) {
    panel.appendChild(el('div', 'diag-loading', '正在只读探测端口占用（约 1 秒）…'));
  } else if (st.error) {
    panel.appendChild(el('div', 'diag-msg', st.error.message));
    if (st.error.detail !== undefined) panel.appendChild(el('pre', 'diag-json', detailJson(st.error.detail)));
  } else {
    const data = st.data ?? {};
    const occupants = data.occupants ?? [];
    if (data.note) panel.appendChild(el('div', 'diag-note', data.note));
    if (!occupants.length) {
      panel.appendChild(el('div', 'diag-note', '未发现监听该端口的进程。'));
    } else {
      for (const o of occupants) {
        const row = el('div', 'diag-occ');
        row.appendChild(el('div', null, `PID ${o.pid ?? '?'} · ${o.processName ?? '未知进程'}${o.localAddress != null ? ` · ${o.localAddress}:${o.localPort ?? st.port}` : ''}`));
        if (o.startedAt) row.appendChild(el('div', 'dim', '启动时间 ' + o.startedAt));
        if (o.executablePath) row.appendChild(el('div', 'diag-path', o.executablePath));
        const id = o.identity;
        row.appendChild(el('div', 'dim', id ? `身份 ${id.result ?? 'unknown'}${id.image ? ` · ${id.image}` : ''}${id.creationFileTime ? ` · ${id.creationFileTime}` : ''}` : '身份不可用（仅报告端口监听）'));
        if (o.note) row.appendChild(el('div', 'dim', o.note));
        panel.appendChild(row);
      }
    }
    const cmd = data.cliCommand || `manager port ${st.port}`;
    const cmdRow = el('div', 'diag-cmd');
    cmdRow.append(el('span', null, '等效 CLI：'), el('code', null, cmd), copyButton(cmd));
    panel.appendChild(cmdRow);
  }
  card.appendChild(panel);
}
function lifecycleOptions() {
  const row = el('div', 'lifecycle-opts');
  const treeLabel = el('label', 'lifecycle-opt');
  const tree = el('input', 'lifecycle-tree');
  tree.type = 'checkbox';
  tree.checked = lifecycleTree;
  tree.title = '停止/重启时连带终止该实例的全部后代进程（同 CLI --tree）；启动/移除不使用';
  tree.addEventListener('change', e => { lifecycleTree = !!e.target.checked; });
  treeLabel.append(tree, el('span', null, '同时终止子进程（--tree）'));
  const graceLabel = el('label', 'lifecycle-opt');
  const grace = el('input', 'lifecycle-grace');
  grace.type = 'number';
  grace.min = '0';
  grace.max = '600000';
  grace.step = '100';
  grace.placeholder = '例如 3000';
  grace.value = lifecycleGrace;
  grace.title = '停止/重启前先等待优雅退出的毫秒数（0-600000，同 CLI --grace）；留空=现有强制终止';
  grace.addEventListener('input', e => { lifecycleGrace = e.target.value; });
  graceLabel.append(el('span', null, '优雅退出'), grace, el('span', 'lifecycle-unit', 'ms'));
  row.append(treeLabel, graceLabel, el('span', 'lifecycle-note', '仅停止/重启生效；留空=不等待'));
  return row;
}
function renderDetail(d) {
  currentDetail = d;
  const box = $('#detail');
  const bar = $('#detailBar');
  box.replaceChildren();
  if (!d) {
    bar.hidden = true;
    $('#detailOps').hidden = true;
    $('#detailOps').replaceChildren();
    box.hidden = false;
    box.appendChild(el('div', 'empty', selected
      ? (detailMissing ? '该应用已不在注册表中。' : '正在加载应用详情…')
      : '从左侧选择应用查看状态与日志。'));
    return;
  }
  const card = el('div', 'card');
  const actualPorts = actualPortsOf(d);
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
        const needsConfirm = true; // 所有生命周期操作（含普通启动）都需二次点击确认
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
      const unresolved = cur && cur.managed !== false && !['RUNNING', 'STOPPED', 'BACKOFF', 'DEAD'].includes(cur.phase);
      mk('启动', 'start', st !== 'RUNNING' && st !== 'STARTING' && !unresolved, '复用已保存配置启动（同 CLI start）');
      mk('停止', 'stop', st === 'RUNNING' || st === 'BACKOFF', '有界强制终止（默认不杀进程树；勾选「同时终止子进程」等同 --tree）；BACKOFF 时取消排程的重启（同 CLI stop）');
      mk('重启', 'restart', ['RUNNING', 'BACKOFF', 'DEAD'].includes(st), '确认旧实例退出后启动新实例（同 CLI restart）');
      if (unresolved) mk('ack 并启动', 'start', true, `放弃未结记录 ${cur.runId} 并重新启动（同 start --ack-unresolved）`, `&ack=${encodeURIComponent(cur.runId)}`);
      mk('移除', 'remove', st === 'STOPPED' || st === 'DEAD', '从注册表移除登记（须无存活实例，证据保留；同 CLI remove）');
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
  if (d.managed !== false) card.appendChild(lifecycleOptions());

  const run = d.run;
  const needsAttention = run && run.managed !== false && !['RUNNING', 'STOPPED', 'BACKOFF', 'DEAD'].includes(run.phase);
  if (needsAttention) {
    const cmd = `start ${d.alias} --ack-unresolved ${run.runId}`;
    const alert = el('div', 'alert');
    alert.append(el('span', null, `未结记录（phase=${run.phase}，runId=${run.runId}）：不会自动重试。请先人工核验该进程是否仍存活（本页与 logs 可查），确认退出后可点击本页“ack 并启动”（需再次点击确认），或用 manager CLI 执行 `));
    alert.appendChild(el('code', null, cmd));
    alert.appendChild(copyButton(cmd));
    alert.appendChild(el('span', null, ' 显式恢复。不要删除运行数据绕过。'));
    card.appendChild(alert);
  }
  const health = healthByAlias.get(d.appId);
  if (health) card.appendChild(healthBlock(health));
  else if (d.readinessUntested) {
    card.appendChild(el('div', 'hint-line', '进程存活 ≠ 业务就绪：等待健康总览返回；就绪与 JRebel/热加载验证仍需按 Skill 规程用真实证据判定。'));
  }
  if (d.note) card.appendChild(el('div', 'hint-line', 'note: ' + d.note));
  if (d.portMismatch) {
    card.appendChild(el('div', 'hint-line', `端口漂移：配置 expectedPort=${d.expectedPort}，实际监听 ${actualPorts.join(', ')}；端口链接已指向实际端口。`));
  }
  if (d.actualPortsError) card.appendChild(el('div', 'alert', `实际端口探测失败：${d.actualPortsError}`));
  if (d.loggerNote) card.appendChild(el('div', 'alert', d.loggerNote));
  if (run?.logRotateFailedStreams?.length) {
    card.appendChild(el('div', 'alert', `日志轮转重开失败（${run.logRotateFailedStreams.join('/')}）：期间输出可能未落盘，管道后续自动恢复重试；请人工核验日志完整性。`));
  }

  const body = el('div', 'card-body');
  const grid = el('div', 'kv');
  kvRow(grid, '仓库', d.root);
  kvRow(grid, '入口', d.entry);
  kvRow(grid, 'tags', d.tags?.length ? d.tags.join(', ') : null, 'dim');
  const actualLinked = st === 'RUNNING' && actualPorts.length > 0;
  if (d.expectedPort != null) {
    grid.appendChild(el('div', 'k', '预期端口'));
    const pv = el('div', 'v' + (st === 'RUNNING' ? '' : ' dim'));
    if (st === 'RUNNING' && !actualLinked) pv.appendChild(portAnchor(d.expectedPort));
    else pv.textContent = String(d.expectedPort);
    const diag = el('button', 'diag-btn', portDiag?.alias === d.alias && portDiag?.loading ? '诊断中…' : '诊断');
    diag.type = 'button';
    diag.title = '只读诊断该端口占用（同 CLI port），不接管、不停止外部进程';
    diag.disabled = !!portDiag?.loading && portDiag?.alias === d.alias;
    diag.addEventListener('click', (e) => { e.stopPropagation(); diagnosePort(d.alias, d.expectedPort); });
    pv.appendChild(diag);
    grid.appendChild(pv);
  }
  if (actualPorts.length) {
    grid.appendChild(el('div', 'k', '实际端口'));
    const pv = el('div', 'v' + (d.portMismatch ? ' bad' : ' good'));
    if (st === 'RUNNING') {
      actualPorts.forEach((port, i) => {
        if (i) pv.appendChild(el('span', null, ' '));
        pv.appendChild(portAnchor(port, d.expectedPort != null && d.expectedPort !== port
          ? `实际监听端口 ${port}（配置 expectedPort=${d.expectedPort}）`
          : '新标签页打开该应用端口'));
      });
    } else pv.textContent = actualPorts.join(', ');
    grid.appendChild(pv);
  }
  kvRow(grid, 'pid', run?.pid ?? d.pid ?? null, run?.pid != null || d.pid != null ? 'good' : undefined);
  // 优先用展开时那次实时采样；轮询重绘时该字段不返回，回退到缓存值，再回退到 /api/apps 的单点值。
  const listRow = appsCache.find(a => a.alias === d.alias);
  const cached = liveResources && liveResources.alias === d.alias && (liveResources.runId ?? null) === (d.run?.runId ?? null) ? liveResources : null;
  const live = d.resources?.available ? d.resources : (cached?.available ? cached : null);
  const rss = live?.rssBytes ?? listRow?.memoryBytes ?? null;
  const cpuPct = live?.cpuPercent ?? listRow?.cpuPercent ?? null;
  if (rss != null) {
    const cpu = cpuPct != null ? ` · CPU ${Number(cpuPct).toFixed(1)}%` : '';
    const scope = (live?.scope ?? listRow?.resourcesScope) === 'tree' ? '含后代聚合' : '';
    // 标明来源：展开时的精确采样，还是列表轮询的单点值。两者采样窗口相同，但时刻不同。
    const src = live ? '展开时采样' : '轮询采样';
    kvRow(grid, '内存（RSS）', `${fmtSize(rss)}${cpu}（${[scope, src].filter(Boolean).join(' · ')}）`, 'dim');
  } else if (live === null && listRow?.resourcesNote) {
    kvRow(grid, '内存（RSS）', '不可用：' + listRow.resourcesNote, 'dim');
  } else if (live && live.rssBytes == null) {
    kvRow(grid, '内存（RSS）', '不可用：' + (live.reason ?? '采样失败'), 'dim');
  }
  kvRow(grid, 'runId', run?.runId);
  kvRow(grid, 'phase', run?.phase);
  if (run?.restartPolicy && run.restartPolicy !== 'never') {
    kvRow(grid, '重启策略', `${run.restartPolicy} · 已重启 ${run.restartCount ?? 0}/${run.maxRestarts ?? '?'} 次 · backoff ${run.backoffMs ?? '?'}ms`, run.restartState === 'DEAD' ? 'bad' : 'dim');
    kvRow(grid, '下次重启', fmtTime(run?.nextRestartAt), 'dim');
    kvRow(grid, '最近退出', run?.lastExit ? `${run.lastExit.code != null ? `code=${run.lastExit.code}` : ''}${run.lastExit.signal ? ` signal=${run.lastExit.signal}` : ''} · ${fmtTime(run.lastExit.at)}` : null, 'dim');
  }
  kvRow(grid, '启动时间', fmtTime(run?.startedAt));
  kvRow(grid, '结束时间', fmtTime(run?.endedAt));
  const runExit = run?.exit;
  const runExitText = runExit
    ? `${exitLabel(runExit)}${runExit.at ? ' · ' + fmtTime(runExit.at) : ''}`
    : null;
  kvRow(grid, '退出结果', run?.exitSummary, run?.exitSummary ? exitClass(runExit) : undefined);
  kvRow(grid, '退出码/信号', runExitText, exitClass(runExit));
  if (run?.wrapperExit) {
    const wrapperExitText = `${exitLabel(run.wrapperExit)}${run.wrapperExit.at ? ' · ' + fmtTime(run.wrapperExit.at) : ''}`;
    kvRow(grid, 'wrapper 退出（非目标）', wrapperExitText, 'dim');
  }
  kvRow(grid, '退出说明', run?.exitNote, run?.exitNote ? 'dim' : undefined);
  kvRow(grid, '退出证据', run?.exitWatchError?.reason ? `不可用：${run.exitWatchError.reason}` : null, 'bad');
  kvRow(grid, '最近错误', run?.lastError, run?.lastError ? 'bad' : undefined);
  kvRow(grid, '身份证据', run?.creationFileTime ? `${run.creationFileTime} · ${run.image ?? '?'}` : null, 'dim');
  kvRow(grid, '环境引用', run?.envResolved?.length ? run.envResolved.join(', ') : null, 'dim');
  const envRows = Object.entries(d.env ?? {});
  kvRow(grid, '环境变量', envRows.length ? envRows.map(([k, v]) => `${k}=${v}`).join('\n') : null, 'dim');
  kvRow(grid, 'stdout', run?.logPaths?.stdout);
  kvRow(grid, 'stderr', run?.logPaths?.stderr);
  kvRow(grid, '日志线索', run?.logHints?.length ? run.logHints.join('\n') : null, 'dim');
  kvRow(grid, '日志轮转', run?.logRotated ? `已轮转（${(run.logRotatedStreams ?? []).join('/') || '未知流'}）· 源列表可选「轮转前」版本` : null, 'dim');
  kvRow(grid, '记录文件', d.runtimeFile, 'dim');
  if (d.managed === false) kvRow(grid, '能力', '非受管登记：仅记录启动尝试与日志线索，不提供跨会话启停', 'dim');
  // 曲线放在字段表之前：详情卡有 max-height + 滚动，放底部会被裁到可视区外。
  // 只有运行中的受管实例才有曲线；非 RUNNING 不建 canvas，避免空图占位。
  if (d.status === 'RUNNING' && d.managed !== false) {
    body.appendChild(buildResChart());
    requestAnimationFrame(drawResChart);
  }
  body.appendChild(grid);
  card.appendChild(body);
  appendLifecycleError(card, d);
  appendPortDiagnosis(card, d);

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
      if (p.exit) row.appendChild(el('span', 'v ' + exitClass(p.exit), exitLabel(p.exit)));
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
    actualPorts.length ? actualPorts.map((p) => ':' + p).join(' ') : (d.expectedPort != null ? ':' + d.expectedPort : null),
    run?.runId,
    fmtTime(run?.startedAt),
  ].filter(Boolean).join(' · ');
  $('#detailSummary').replaceChildren(
    el('span', 'db-name', d.alias),
    statusPill(d.status),
    ...(health ? [healthPill(health.state)] : []),
    el('span', 'pill mode', d.mode ?? '?'),
    el('span', 'pill' + (d.managed === false ? ' unmanaged' : ''), d.managed === false ? '非受管' : '受管'),
    el('span', 'db-info', bits));
  bar.hidden = false;
  const hasDiagnostics = lastLifecycleError?.alias === d.alias || portDiag?.alias === d.alias;
  // 只在首次渲染该应用时自动决定展开/收起；之后保持现状。
  // 否则每 4s 轮询重绘都会按「当前无异常」重新收起，用户正看着详情却被折叠。
  if (detailTouched) applyDetail(detailOpen);
  else if (!detailInitialized) { detailInitialized = true; applyDetail(needsAttention || hasDiagnostics); }
}
let lifecycleBusy = false, lifecycleOpKey = null;
// 二次确认不用 window.confirm（预览/嵌套 iframe 中常被拦截、表现为“点了没反应”）：
// 第一次点击把按钮变成“确认X”，10 秒内再点一次才执行。
// 不能太短：armOp 会触发 loadStatus() 重绘（Windows 上单次采集 3s 左右），
// 若窗口只有 4s，确认态实际只可见约 1s，用户来不及点第二次。
const ARM_WINDOW_MS = 10000;
let armedOp = null, armedTimer = null;
function armOp(alias, op, extra = '') {
  disarmOp();
  armedOp = `${alias}:${op}:${extra}`;
  armedTimer = setTimeout(() => { disarmOp(); if (selected) loadStatus(); }, ARM_WINDOW_MS);
  // 先用当前详情本地重绘出"确认X"，不要等 loadStatus（Windows 上采集 3s 起）：
  // 否则点击后数秒内按钮毫无变化，用户会以为没响应而重复点击。
  rerenderDetail();
  loadStatus();
}
function disarmOp() { armedOp = null; if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; } }
async function diagnosePort(alias, port, auto = false) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    portDiag = { alias, port: n, loading: false, auto, error: { message: '端口无效：需要 1-65535 的整数' } };
    rerenderDetail();
    return;
  }
  const token = { alias, port: n, loading: true, auto };
  portDiag = token;
  rerenderDetail();
  try {
    const data = await api('/api/port?port=' + encodeURIComponent(n));
    if (portDiag !== token) return; // 新一轮诊断已开始：丢弃过期响应
    portDiag = { alias, port: n, loading: false, auto, data };
  } catch (e) {
    if (portDiag !== token) return;
    portDiag = { alias, port: n, loading: false, auto, error: { code: e.code, status: e.status, message: e.message, detail: e.detail } };
  }
  if (selected === alias) rerenderDetail();
}
function lifecycleEnvWarning(r) {
  const msg = r?.envWarning ?? r?.start?.envWarning;
  if (msg) return msg;
  const names = r?.envWarnings ?? r?.start?.envWarnings ?? [];
  return names.length
    ? `env 中疑似机密字面值：${names.join(', ')}（非阻断）；请改用 envRefs/envFile 提供`
    : null;
}
function lifecycleRequestPath(alias, op, extra = '') {
  const q = new URLSearchParams({ app: alias, op });
  if (extra) {
    const extraParams = new URLSearchParams(extra.replace(/^&/, ''));
    for (const [k, v] of extraParams) q.set(k, v);
  }
  if (op === 'stop' || op === 'restart') {
    if (lifecycleTree) q.set('tree', '1');
    const grace = String(lifecycleGrace ?? '').trim();
    if (grace !== '') q.set('grace', grace);
  }
  return `/api/lifecycle?${q.toString()}`;
}
async function doLifecycle(alias, op, extra = '') {
  if (lifecycleBusy || !alias) return;
  lifecycleBusy = true;
  lifecycleOpKey = `${alias}:${op}:${extra}`;
  conn(`${op} ${alias} 执行中…`);
  manualRefresh = true;
  loadStatus(); // 立刻重绘按钮为执行中态，不等请求返回（stop/restart 可能数秒）
  try {
    // 启停可能耗时数十秒（命令模式 discover 上限 ~60s），加 150s 超时防永久挂起
    const r = await api(lifecycleRequestPath(alias, op, extra), AbortSignal.timeout(150_000), 'POST');
    const pid = r.pid ?? r.start?.pid;
    if (lastLifecycleError?.alias === alias) lastLifecycleError = null;
    if (portDiag?.alias === alias && portDiag.auto) portDiag = null;
    const envWarning = lifecycleEnvWarning(r);
    // restart 的 treeKilled 在停旧实例结果里；stop 在顶层。未请求 tree 时保持原横幅。
    const stopResult = op === 'restart' ? r.stop : r;
    const treeNote = Array.isArray(stopResult?.treeKilled)
      ? `；treeKilled=${stopResult.treeKilled.length} killedPids=${JSON.stringify(stopResult.killedPids ?? [])}`
      : '';
    showBanner(`${op} 成功：${alias}${pid ? `（pid=${pid}）` : ''}${treeNote}${envWarning ? ` · 警告：${envWarning}` : ''}`, Boolean(envWarning));
  } catch (e) {
    lastLifecycleError = { alias, op, code: e.code, message: e.message, detail: e.detail };
    showBanner(`${op} ${alias} 失败：${e.message}${e.detail !== undefined ? '（详情见详情卡）' : ''}`, true);
    if (e.code === 'PORT_IN_USE') {
      const app = appsCache.find((a) => a.alias === alias);
      const target = Number(e.detail?.port ?? app?.expectedPort);
      if (Number.isInteger(target)) diagnosePort(alias, target, true);
    }
  }
  lifecycleBusy = false;
  lifecycleOpKey = null;
  await Promise.all([loadApps(), loadStatus(), loadSources(), loadHealth()]);
  manualRefresh = false;
  pollTail();
}

// sample=true 时服务端追加 --resources，做一次有界 RSS/CPU 采样。
// 只在展开详情/首次选中时用；4s 轮询不带，避免变成常驻采样。
async function loadStatus(opts = {}) {
  // 采样请求不能被轮询的在飞守卫挡掉：展开是用户主动动作，此刻轮询大概率正在飞。
  const busy = opts.sample ? statusSampleBusy : statusBusy;
  if (fatal || (paused && !manualRefresh) || !selected || busy) return;
  if (opts.sample) statusSampleBusy = true; else statusBusy = true;
  try {
    const detail = await api('/api/status?app=' + encodeURIComponent(selected) + (opts.sample ? '&sample=1' : ''));
    // 实时采样结果留在本地：后续 4s 轮询不带 resources，靠它继续显示同一份"当前值"。
    if (opts.sample && detail.alias === selected && detail.resources) {
      liveResources = { alias: selected, runId: detail.run?.runId ?? null, at: Date.now(), ...detail.resources };
    }
    const old = previousStatuses.get(selected);
    const runId = detail.run?.runId;
    if (old?.status === 'RUNNING' && old.runId === runId && ['STOPPED', 'UNKNOWN'].includes(detail.status)) {
      notifyExit(runId, detail.status, detail.run?.exitNote || detail.run?.exitSummary || detail.run?.lastError || detail.note || '退出说明不可用');
    }
    previousStatuses.set(selected, { status: detail.status, runId });
    renderDetail(detail);
  } catch (e) {
    if (e.status === 404) { detailMissing = true; renderDetail(null); return; }
    handlePollError(e);
  } finally { if (opts.sample) statusSampleBusy = false; else statusBusy = false; }
}
async function loadHealth() {
  if (fatal || (paused && !manualRefresh) || healthBusy) return;
  healthBusy = true;
  try {
    const d = await api('/api/health');
    healthByAlias = new Map((d.apps ?? []).map(h => [h.appId, h]));
    if (appsCache.length) renderApps();
    if (selected && currentDetail?.alias === selected) renderDetail(currentDetail);
  } catch (e) {
    if (e.status !== 404) handlePollError(e); // 旧服务无此接口时仅保留通用提示
  } finally { healthBusy = false; }
}
function selectApp(alias) {
  if (selected === alias) return;
  selected = alias;
  currentDetail = null;
  detailMissing = false; // 详情加载中用「正在加载」，只有真正 404 才提示不在注册表
  portDiag = null;
  lastLifecycleError = null;
  selectedHistoryRun = null; wantedHistoryRun = null;
  logSrcWasCurrent = false;
  detailOpen = false; detailTouched = false; detailInitialized = false;
  liveResources = null; // 换应用后旧的采样值不再适用
  resetResSeries(alias); // 曲线属于单个应用，换应用必须清空
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
  loadStatus({ sample: true }); // 首次选中可能自动展开详情，顺带做一次资源采样
}

// ---------- 日志 ----------

const MAX_LINES = 8000;
const errorPattern = /\bERROR\b|Exception|(?:\w+Error)(?::|\b)|Caused by:|Suppressed:/;
const isErrLine = (t) => t.startsWith('[err] ');
// 合并源行序：两流无统一时间戳，按本批新行在各自流中的相对位置交错。
// 只保证流内顺序稳定、结果确定，不冒充精确时间序（源标签与 meta 同步标注）。
function mergeApprox(stdoutLines, stderrLines) {
  const out = [];
  let i = 0, j = 0;
  while (i < stdoutLines.length || j < stderrLines.length) {
    if (j >= stderrLines.length || (i < stdoutLines.length && (i + 1) / stdoutLines.length <= (j + 1) / stderrLines.length)) out.push(stdoutLines[i++]);
    else out.push(stderrLines[j++]);
  }
  return out;
}
const isMergedSrc = (src) => typeof src === 'string' && src.startsWith('merge:');
const newMergedTails = () => ({
  offsets: { stdout: -1, stderr: -1 },
  fileIds: { stdout: null, stderr: null },
  pending: { stdout: '', stderr: '' },
  decoders: { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') },
  encodings: { stdout: 'utf-8', stderr: 'utf-8' },
});
const classify = t => isErrLine(t) ? 'err' : errorPattern.test(t) ? 'err' : t.includes('JRebel:') ? 'jr' : /\bWARN\b/.test(t) ? 'warn'
  : /Preparing:|Parameters:|<== *Total|==>|SqlSession|JDBC Connection/.test(t) ? 'sql' : '';
let logSrc = null, logSrcLabel = '', logSrcWasCurrent = false, offset = -1, pending = '', decoder = new TextDecoder('utf-8'), logEncoding = 'utf-8';
let logMerged = false, mergedTails = newMergedTails();
let srcDead = false; // 当前源 404 已失效：停止每秒轮询风暴，手动刷新或换源可恢复
let renderedId = 0, sourcesVersion = 0, sourcesController = null, sourcesBySrc = new Map();
let lines = [], nextId = 1, boundary = '', removed = 0, following = true, tailBusy = false;
// 过滤在渲染层做：lines 数组始终保留全量，清空条件即恢复全视图；
// errorsOnly 等价内置 errorPattern；自定义正则无效时给出提示而非静默失效（不过滤 + 输入框标红 + meta 提示）。
let errorsOnly = false, filterRe = null, filterError = null;
let logFallbackLabel = '日志', renderedDomCount = 0;

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
  if (errorsOnly && !isErrLine(text) && !errorPattern.test(text)) return false;
  return !filterRe || filterRe.test(text);
}
function visibleLines() { return lines.filter(l => lineVisible(l.text)); }
function renderMeta() {
  // 源名与大小已由左侧下拉展示，这里只保留下拉无法表达的运行时信息。
  let text = `缓存 ${lines.length} 行`;
  if (logMerged) text += ' · 合并 stdout/stderr，顺序为近似顺序（无统一时间戳）';
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
  logMerged = isMergedSrc(logSrc); mergedTails = newMergedTails();
  lines = []; nextId = 1; boundary = ''; removed = 0; following = true; srcDead = false;
  logFallbackLabel = '日志'; renderedDomCount = 0;
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
  if (fatal || (paused && !manualRefresh) || degrading || !selected || !logSrc || tailBusy || (srcDead && !manualRefresh)) return;
  if (logMerged) return pollMergedTail();
  tailBusy = true;
  try {
    const d = await api(`/api/tail?app=${encodeURIComponent(selected)}&src=${encodeURIComponent(logSrc)}&offset=${offset}`);
    srcDead = false;
    if (offset >= 0 && d.start !== offset) {
      pending = ''; logEncoding = 'utf-8'; decoder = new TextDecoder('utf-8'); renderedId = 0;
      lines = []; removed = 0; boundary = '日志已截断，读取位置已重置';
      // 立即全量重绘：清掉 DOM 中陈旧行并显示截断提示，不等下一批数据到达
      //（否则日志停写时旧内容会一直挂着，renderedDomCount 也失准）。
      renderLines(true);
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
    logFallbackLabel = d.runId ? `${d.runId}.${d.stream}` : '日志';
    renderMeta();
    conn('已连接 · ' + new Date().toLocaleTimeString());
  } catch (e) {
    if (e.status === 404) {
      // 源已失效：不再每秒重试（轮询风暴），提示并刷新源列表；手动刷新或换源可恢复。
      srcDead = true;
      logHint('日志文件不存在（可能已被清理，或该批次未产生该流输出）；已暂停此源的轮询，可另选源或点刷新重试。');
      loadSources();
      return;
    }
    handlePollError(e);
  } finally { tailBusy = false; }
}

async function pollMergedTail() {
  tailBusy = true;
  try {
    const st = mergedTails;
    const initial = st.offsets.stdout < 0 || st.offsets.stderr < 0;
    let d, streams, resetStreams;
    // 文件被 rename+重建且新文件已长得比旧 offset 大时，首次响应会从旧 offset 读到新文件中段；
    // 发现文件身份变化后把该流 offset 归零再取一次，确保从新文件起始继续（最多重试一次）。
    for (let attempt = 0; ; attempt++) {
      d = await api(`/api/tail?app=${encodeURIComponent(selected)}&src=${encodeURIComponent(logSrc)}&offset=${st.offsets.stdout},${st.offsets.stderr}`);
      streams = d.streams ?? {};
      resetStreams = ['stdout', 'stderr'].filter((s) => {
        const cur = streams[s];
        if (!cur) return false;
        if (st.offsets[s] >= 0 && cur.start !== st.offsets[s]) return true;
        // rename+重建式轮转：旧 offset 可能仍小于新文件大小，用文件身份补充识别
        return !!(cur.exists && st.fileIds[s] && cur.fileId && cur.fileId !== st.fileIds[s]);
      });
      const reread = resetStreams.filter((s) => streams[s].exists && streams[s].fileId && st.fileIds[s]
        && streams[s].fileId !== st.fileIds[s] && streams[s].start !== 0);
      if (!reread.length || attempt >= 1) break;
      for (const s of reread) st.offsets[s] = 0;
    }
    srcDead = false;
    if (resetStreams.length) {
      pending = ''; logEncoding = 'utf-8'; decoder = new TextDecoder('utf-8'); renderedId = 0;
      lines = []; removed = 0;
      for (const s of resetStreams) {
        st.pending[s] = ''; st.encodings[s] = 'utf-8'; st.decoders[s] = new TextDecoder('utf-8');
      }
      boundary = `合并源中 ${resetStreams.join('/')} 已轮转或被截断，日志缓存已清空并从新文件位置继续；轮转前尾部可用 --src run:${d.runId}.${resetStreams[0]}.1 查看`;
      renderLines(true);
    } else if (initial) {
      const loaded = ['stdout', 'stderr'].filter((s) => streams[s]?.exists && streams[s].start > 0);
      const missing = ['stdout', 'stderr'].filter((s) => streams[s] && !streams[s].exists);
      boundary = loaded.length
        ? `已加载尾部 ${loaded.map((s) => `${s} ${fmtSize(streams[s].size - streams[s].start)}`).join(' / ')}，更早内容未加载`
        : '从文件起始读取';
      if (missing.length) boundary += `；${missing.join('/')} 暂无日志`;
    }
    const fresh = { stdout: [], stderr: [] };
    for (const s of ['stdout', 'stderr']) {
      const cur = streams[s];
      if (!cur) continue;
      if (!cur.exists) { st.offsets[s] = 0; st.fileIds[s] = null; continue; }
      if (cur.encoding && cur.encoding !== st.encodings[s]) {
        st.encodings[s] = cur.encoding;
        st.decoders[s] = new TextDecoder(cur.encoding);
        st.pending[s] = '';
      }
      if (cur.b64) {
        const bytes = Uint8Array.from(atob(cur.b64), c => c.charCodeAt(0));
        const text = st.pending[s] + st.decoders[s].decode(bytes, { stream: true });
        const parts = text.split('\n');
        st.pending[s] = parts.pop();
        for (const raw of parts) {
          const line = raw.replace(/\r$/, '');
          fresh[s].push(s === 'stderr' ? `[err] ${line}` : line);
        }
      }
      st.offsets[s] = cur.offset;
      st.fileIds[s] = cur.fileId ?? null;
    }
    const added = mergeApprox(fresh.stdout, fresh.stderr);
    if (added.length) {
      for (const text of added) lines.push({ id: nextId++, text });
      if (lines.length > MAX_LINES) {
        const count = lines.length - MAX_LINES;
        lines.splice(0, count);
        removed += count;
      }
      renderLines();
    }
    logFallbackLabel = d.runId ? `${d.runId}.both` : '合并日志';
    renderMeta();
    conn('已连接 · ' + new Date().toLocaleTimeString());
  } catch (e) {
    if (e.status === 404) {
      srcDead = true;
      logHint('日志文件不存在（该批次 stdout/stderr 均不可读，可能已被清理）；已暂停此源的轮询，可另选源或点刷新重试。');
      loadSources();
      return;
    }
    handlePollError(e);
  } finally { tailBusy = false; }
}
async function loadSources() {
  if (fatal || (paused && !manualRefresh)) return;
  const version = ++sourcesVersion;
  sourcesController?.abort();
  sourcesController = new AbortController();
  const runSel = $('#runSel');
  if (!selected) { runSel.replaceChildren(); runSel.disabled = true; return; }
  try {
    const d = await api('/api/sources?app=' + encodeURIComponent(selected), sourcesController.signal);
    if (version !== sourcesVersion) return;
    hideBannerIfRecovered(); // 成功读取即视为恢复：清横幅并让日志跟随解除 degrading（与 loadApps 一致）
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
    await loadHealth();
    if (selected) { await Promise.all([loadStatus(), loadSources()]); pollTail(); }
  } finally { manualRefresh = false; }
}
$('#refreshBtn').addEventListener('click', manualReload);
// 通知权限只能在用户手势中申请：首次点击页面任意处时询问一次（轮询回调里申请会被静默拒绝）。
document.addEventListener('click', () => {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch {}
}, { once: true });
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
$('#detailBar').addEventListener('click', () => {
  detailTouched = true;
  const open = $('#detail').hidden;
  applyDetail(detailOpen = open);
  // 展开时实时采样一次资源：用户此刻要看的是"现在占多少"，不是 4s 前轮询的快照。
  if (open) loadStatus({ sample: true });
});
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
  // 过滤/只看错误激活时下载命中行（与所见一致）；否则下载缓存全量。
  const out = (filterRe || errorsOnly) ? lines.filter((l) => lineVisible(l.text)) : lines;
  const text = out.map((l) => l.text).join('\n');
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
loadHealth();
let pollTimers = [];
function schedulePolling() {
  pollTimers.forEach(clearInterval);
  const slow = document.visibilityState === 'hidden';
  pollTimers = [
    setInterval(loadApps, slow ? 30000 : 4000),
    setInterval(loadStatus, slow ? 30000 : 4000),
    setInterval(loadHealth, slow ? 60000 : 15000), // 健康探测较重：低频轮询，启停/手动刷新时额外立即刷新
    setInterval(loadSources, slow ? 30000 : 8000),
    setInterval(pollTail, slow ? 30000 : 1000),
  ];
}
document.addEventListener('visibilitychange', schedulePolling);
schedulePolling();
