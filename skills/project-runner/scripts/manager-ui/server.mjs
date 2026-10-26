// project-runner 本地 Web 管理台服务（design.md §2.2 / AC08）。
// 仅 127.0.0.1 + Host 校验，无令牌（本机可信用户）；GET 全部只读，启停仅 POST /api/lifecycle
// （start|stop|restart，复用 CLI 同一实现）。数据层全部经 api 注入复用 manager.mjs，
// 本文件不实现任何业务逻辑。前台常驻直到 Ctrl+C，无守护、无自动重启。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, MANAGER_VERSION, errorStatus } from '../lib/constants.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(SCRIPT_DIR, 'index.html');
const MANAGER_SCRIPT = path.resolve(SCRIPT_DIR, '..', 'manager.mjs');
const TAIL_CHUNK = 256 * 1024;
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// ---- HTTP 出口白名单 -------------------------------------------------------
// 端口/进程诊断只回传定位所需字段，绝不透传 commandLine（可能含密码、token、
// 完整启动参数）。错误 detail 也走同一套白名单，避免 manager 内部证据把命令行
// 或任意对象带进浏览器。
const DETAIL_KEYS = new Set([
  'port', 'forced', 'note', 'runId', 'pid', 'wrapperPid', 'alias', 'appId', 'phase',
  'expectedPort', 'expectedImage', 'result', 'code', 'message', 'reason', 'cause',
  'creationFileTime', 'image', 'comm', 'startedAt', 'processName', 'executablePath',
  'localAddress', 'localPort', 'stdout', 'stderr', 'file', 'runtimeFile', 'logsDir',
  'logPaths', 'evidence', 'occupants', 'candidates', 'capture', 'detail', 'stderrTail',
  'listening', 'accepted', 'managed', 'status',
]);
const SAFE_TEXT_MAX = 4000;

function safeScalar(value) {
  if (typeof value === 'string') return value.length > SAFE_TEXT_MAX ? `${value.slice(0, SAFE_TEXT_MAX)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function sanitizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['result', 'code', 'creationFileTime', 'image', 'comm']) {
    const v = safeScalar(value[key]);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeProcessInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['pid', 'processName', 'executablePath', 'startedAt', 'localAddress', 'localPort', 'source', 'note', 'creationFileTime', 'image', 'comm', 'result', 'code']) {
    const v = safeScalar(value[key]);
    if (v !== undefined) out[key] = v;
  }
  const identity = sanitizeIdentity(value.identity);
  if (identity) out.identity = identity;
  return Object.keys(out).length ? out : null;
}

function sanitizeDetailValue(value, depth = 0) {
  if (depth > 4) return undefined;
  const scalar = safeScalar(value);
  if (scalar !== undefined || value === null) return scalar;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDetailValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (!DETAIL_KEYS.has(key)) continue;
      const v = key === 'occupants' || key === 'candidates'
        ? (Array.isArray(value[key]) ? value[key].slice(0, 50).map(sanitizeProcessInfo).filter(Boolean) : undefined)
        : sanitizeDetailValue(value[key], depth + 1);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function sanitizeErrorDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  return sanitizeDetailValue(detail);
}

function quoteShellPath(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function sanitizePortData(data, home) {
  const port = Number.isInteger(data?.port) ? data.port : null;
  const out = {
    port,
    occupants: Array.isArray(data?.occupants) ? data.occupants.slice(0, 100).map(sanitizeProcessInfo).filter(Boolean) : [],
  };
  if (typeof data?.note === 'string') out.note = data.note;
  if (port != null) out.cliCommand = `node ${quoteShellPath(MANAGER_SCRIPT)} --home ${quoteShellPath(home)} port ${port}`;
  return out;
}

function errorPayload(error, message) {
  const payload = { code: error?.code ?? 'INTERNAL', message };
  const detail = sanitizeErrorDetail(error?.detail);
  if (detail !== undefined) payload.detail = detail;
  return { schemaVersion: SCHEMA_VERSION, ok: false, error: payload };
}

// 单流 tail 读取：offset 缺失/非法/超前时回退到文件尾部窗口。
// exists=false 表示该流文件尚未产生（合并源允许单侧缺失），其他读盘错误原样抛出。
function readTailChunk(file, rawOffset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, start: 0, offset: 0, size: 0, encoding: 'utf-8', b64: '', fileId: null };
    throw e;
  }
  const size = stat.size;
  let offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) offset = Math.max(0, size - TAIL_CHUNK);
  const len = Math.min(size - offset, TAIL_CHUNK);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  let read;
  try {
    read = fs.readSync(fd, buf, 0, len, offset);
  } finally {
    fs.closeSync(fd);
  }
  const bytes = buf.subarray(0, read);
  let encoding = 'utf-8';
  let validUtf8 = false;
  // Tail offsets/chunk boundaries may split a UTF-8 code point. Ignore only
  // up to three boundary bytes while still strictly validating the payload.
  for (let prefix = 0; prefix <= 3 && !validUtf8; prefix++) {
    for (let suffix = 0; suffix <= 3 && prefix + suffix <= bytes.length; suffix++) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(prefix, bytes.length - suffix));
        validUtf8 = true;
        break;
      } catch { /* retry after excluding a possible partial boundary code point */ }
    }
  }
  if (!validUtf8) encoding = 'gbk';
  // fileId 用于前端识别 rename+重建式轮转（新文件可能很快长得比旧 offset 更大，仅靠 size < offset 会漏判）。
  const fileId = `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs ?? 0)}`;
  return { exists: true, start: offset, offset: offset + read, size, encoding, b64: bytes.toString('base64'), fileId };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

// ManagerError 退出码契约 → HTTP 状态的 errorStatus 经 lib/constants.mjs 与 CLI 共用，避免接口契约分叉；数据损坏必须原样透出，不静默当空数据
// --open 拉起默认浏览器：任何失败都只降级为“已打印 URL”，绝不阻塞/中断 ui 常驻。
// Windows 用 cmd /d /s /c start：首个引号参数是窗口标题，URL 加引号防查询串里的特殊字符被 cmd 截断。
function openInBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/d', '/s', '/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {
      process.stdout.write(`[project-runner] 自动打开浏览器失败，请手动访问上方地址\n`);
    });
    child.unref();
  } catch {
    process.stdout.write(`[project-runner] 自动打开浏览器失败，请手动访问上方地址\n`);
  }
}

export async function startUiServer({ home, port = 0, open = false, api }) {
  let boundPort = port;
  // 首页静态内容缓存为 Buffer：每个轮询会话都会反复 GET /，读盘一次即可（#82-B4）；
  // 进程内缓存，更新 index.html 后重启 ui 生效。
  let indexHtmlCache = null;
  const indexHtml = () => (indexHtmlCache ??= fs.readFileSync(INDEX_FILE));

  async function route(res, u, method) {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      // 管理台无令牌，安全边界依赖「只允许本机用户直接访问」：禁止任何站点 iframe 嵌入，
      // 防止点击劫持把用户在诱导弹层中的点击转成同源 POST /api/lifecycle。
      // 只加 frame-ancestors，避免 default-src 破坏页面内联脚本。
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      });
      res.end(indexHtml());
      return;
    }
    if (u.pathname === '/api/lifecycle') {
      // 外层方法守卫只挡「非 GET 且非 lifecycle-POST」，这里必须再查一次：
      // 否则 GET /api/lifecycle?op=stop 会被 <img>/导航等跨站请求触达（CSRF）。
      if (method !== 'POST') throw fail(405, '启停/移除仅接受 POST');
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: await api.lifecycle(u.searchParams.get('app') || '', u.searchParams.get('op') || '', u.searchParams.get('ack') || null, u.searchParams.get('tree'), u.searchParams.get('grace')) });
    }
    if (u.pathname === '/api/port') {
      // 只读端口诊断：与 CLI `port <N>` 同一实现；输出在 HTTP 层按白名单裁剪。
      const raw = u.searchParams.get('port');
      const port = Number(raw);
      if (raw == null || !/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw fail(400, 'port 需要 1-65535 的整数', 'USAGE');
      }
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: sanitizePortData(await api.port(port), home) });
    }
    if (u.pathname === '/api/doctor') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: await api.doctor() });
    }
    if (u.pathname === '/api/meta') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: { version: MANAGER_VERSION } });
    }
    if (u.pathname === '/api/apps') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: { ...api.list(), home } });
    }
    if (u.pathname === '/api/health') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: await api.health() });
    }
    if (u.pathname === '/api/status') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: await api.status(u.searchParams.get('app') || '') });
    }
    if (u.pathname === '/api/runs') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: api.listRuns(u.searchParams.get('app') || '') });
    }
    if (u.pathname === '/api/sources') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: api.listSources(u.searchParams.get('app') || '') });
    }
    if (u.pathname === '/api/tree') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: api.listTree(u.searchParams.get('app') || '', u.searchParams.get('path') || '') });
    }
    if (u.pathname === '/api/file') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: api.readFile(u.searchParams.get('app') || '', u.searchParams.get('path') || '', u.searchParams.get('offset') || '0') });
    }
    if (u.pathname === '/api/tail') {
      const src = u.searchParams.get('src');
      const t = src
        ? api.resolveSource(u.searchParams.get('app') || '', src)
        : api.resolveLogFile(
          u.searchParams.get('app') || '',
          u.searchParams.get('run') || null,
          u.searchParams.get('stream') === 'stderr' ? 'stderr' : 'stdout');
      if (t.merged) {
        // 合并源：offset 参数为 stdout,stderr 双 offset，各自独立读取（前端同时维护双 decoder）。
        // 单侧文件暂不存在时返回 exists=false，不使整个合并源 404；两侧都缺失才报日志不存在。
        const raw = u.searchParams.get('offset');
        const parts = raw == null ? [] : raw.split(',', 2);
        const streams = {
          stdout: readTailChunk(t.files.stdout, parts[0]),
          stderr: readTailChunk(t.files.stderr, parts[1]),
        };
        if (!streams.stdout.exists && !streams.stderr.exists) throw fail(404, `日志不存在（runId=${t.runId}, stream=stdout/stderr）`);
        return sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION, ok: true,
          data: {
            appId: t.appId, alias: t.alias, runId: t.runId, stream: 'both', merged: true,
            orderNote: 'stdout/stderr 无统一时间戳；合并顺序按各流尾部相对位置近似交错，不保证精确时间序',
            streams,
          },
        });
      }
      const chunk = readTailChunk(t.file, u.searchParams.get('offset'));
      if (!chunk.exists) throw fail(404, `日志不存在（${t.runId ? `runId=${t.runId}, ` : ''}stream=${t.stream ?? '?'}）`);
      const { exists, ...data } = chunk;
      return sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION, ok: true,
        data: { appId: t.appId, alias: t.alias, runId: t.runId ?? null, stream: t.stream ?? null, ...data },
      });
    }
    throw fail(404, '接口不存在');
  }

  function handle(req, res) {
    let u;
    try {
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        return sendJson(res, 403, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'FORBIDDEN', message: 'Host 不允许访问' } });
      }
      u = new URL(req.url, `http://127.0.0.1:${boundPort}`);
      // 纵深防御：正常页面导航不会以 iframe/frame 为目标；一旦声明为内嵌框架直接拒绝，
      // 即使浏览器忽略 X-Frame-Options/CSP，也无法完成点击劫持。
      const dest = String(req.headers['sec-fetch-dest'] ?? '').toLowerCase();
      if (dest === 'iframe' || dest === 'frame') {
        return sendJson(res, 403, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'FORBIDDEN', message: '不允许在 iframe 中访问管理台' } });
      }
      if (req.method !== 'GET' && !(req.method === 'POST' && u.pathname === '/api/lifecycle')) {
        return sendJson(res, 405, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'METHOD', message: '仅支持 GET 与 POST /api/lifecycle' } });
      }
      if (u.pathname === '/api/lifecycle') {
        // 跨站写操作拦截：POST 属 simple request 无 CORS 预检，仅靠 Host 校验挡不住
        // 浏览器里恶意页面直接 fetch 本服务。Sec-Fetch-Site=cross-site 一律拒；
        // Origin 存在时必须同源（curl/脚本不带这两个头，不受影响）。
        const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
        const origin = String(req.headers.origin ?? '');
        const allowedOrigins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
        if (site === 'cross-site' || (origin && !allowedOrigins.includes(origin))) {
          return sendJson(res, 403, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'FORBIDDEN', message: '跨站写操作被拒绝' } });
        }
      }
    } catch (e) {
      return sendJson(res, errorStatus(e), errorPayload(e, e.message));
    }
    route(res, u, req.method).catch((e) => {
      const status = errorStatus(e);
      if (status >= 500) console.error(e?.stack ?? e);
      // ManagerError 业务原因（包括依赖/冲突）原样透出；未知内部错误仍使用通用文案。
      const known = Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 5;
      sendJson(res, status, errorPayload(e, known || status < 500 ? e.message : '读取失败，请刷新重试'));
    });
  }

  const server = http.createServer(handle);
  // 端口占用由 manager.mjs 统一给出可操作提示，这里只记录其他运行期错误
  server.on('error', (e) => { if (e.code !== 'EADDRINUSE') console.error(`[project-runner ui] ${e.message}`); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      boundPort = server.address().port;
      resolve();
    });
  });
  const uiUrl = `http://127.0.0.1:${boundPort}/`;
  process.stdout.write([
    '',
    `[project-runner] 运行管理台: ${uiUrl}`,
    `  数据目录: ${home}`,
    '  仅监听 127.0.0.1，供本机可信用户使用；页面可启停受管应用且日志可能含敏感信息，勿对外转发。',
    '  Ctrl+C 退出（无常驻服务，退出即停止）。',
    '',
  ].join('\n') + '\n');
  if (open) openInBrowser(uiUrl);
  await new Promise(() => { /* 常驻直到进程被终止 */ });
}
