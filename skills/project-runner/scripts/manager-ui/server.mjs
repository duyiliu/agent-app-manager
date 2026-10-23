// project-runner 本地 Web 管理台服务（design.md §2.2 / AC08）。
// 仅 127.0.0.1 + 一次性令牌 + Host 校验；GET 全部只读，启停仅 POST /api/lifecycle
// （start|stop|restart，复用 CLI 同一实现）。数据层全部经 api 注入复用 manager.mjs，
// 本文件不实现任何业务逻辑。前台常驻直到 Ctrl+C，无守护、无自动重启。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, errorStatus } from '../lib/constants.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(SCRIPT_DIR, 'index.html');
const TAIL_CHUNK = 256 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

// 常数时间比较：对两侧各做一次哈希拉平长度后 timingSafeEqual
function tokenOk(expectedHash, presented) {
  if (!presented) return false;
  const got = crypto.createHash('sha256').update(presented).digest();
  return got.length === expectedHash.length && crypto.timingSafeEqual(got, expectedHash);
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
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  let boundPort = port;

  async function route(res, u) {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (u.pathname === '/api/lifecycle') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: await api.lifecycle(u.searchParams.get('app') || '', u.searchParams.get('op') || '') });
    }
    if (u.pathname === '/api/apps') {
      return sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ok: true, data: { ...api.list(), home } });
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
      if (!fs.existsSync(t.file)) throw fail(404, `日志不存在（${t.runId ? `runId=${t.runId}, ` : ''}stream=${t.stream ?? '?'}）`);
      const size = fs.statSync(t.file).size;
      let offset = Number(u.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) offset = Math.max(0, size - TAIL_CHUNK);
      const len = Math.min(size - offset, TAIL_CHUNK);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(t.file, 'r');
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
      return sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION, ok: true,
        data: { appId: t.appId, alias: t.alias, runId: t.runId ?? null, stream: t.stream ?? null, start: offset, offset: offset + read, size, encoding, b64: bytes.toString('base64') },
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
      if (req.method !== 'GET' && !(req.method === 'POST' && u.pathname === '/api/lifecycle')) {
        return sendJson(res, 405, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'METHOD', message: '仅支持 GET 与 POST /api/lifecycle' } });
      }
      if (!tokenOk(tokenHash, u.searchParams.get('token'))) {
        return sendJson(res, 403, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: 'FORBIDDEN', message: '缺少或错误的访问令牌；请使用启动时打印的完整地址' } });
      }
    } catch (e) {
      return sendJson(res, errorStatus(e), { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } });
    }
    route(res, u).catch((e) => {
      const status = errorStatus(e);
      if (status >= 500) console.error(e?.stack ?? e);
      // ManagerError 业务原因（包括依赖/冲突）原样透出；未知内部错误仍使用通用文案。
      const known = Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 5;
      sendJson(res, status, { schemaVersion: SCHEMA_VERSION, ok: false, error: { code: e.code ?? 'INTERNAL', message: known || status < 500 ? e.message : '读取失败，请刷新重试' } });
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
  const uiUrl = `http://127.0.0.1:${boundPort}/?token=${token}`;
  process.stdout.write([
    '',
    `[project-runner] 运行管理台: ${uiUrl}`,
    `  数据目录: ${home}`,
    '  该地址包含访问令牌，请勿转发给他人；页面展示的日志可能含敏感信息。',
    '  Ctrl+C 退出（无常驻服务，退出即停止）。',
    '',
  ].join('\n') + '\n');
  if (open) openInBrowser(uiUrl);
  await new Promise(() => { /* 常驻直到进程被终止 */ });
}
