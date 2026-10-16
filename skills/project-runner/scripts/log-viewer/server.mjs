import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.LOG_VIEWER_PORT || 8199);
const ROOT = fs.realpathSync(process.cwd());
const LOG_DIR = path.join(ROOT, '.tmp');
const PROJECT = path.basename(ROOT);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const NAME_RE = /^jrebel-local-[^/\\]+\.stdout\.log$/;
const CHUNK = 256 * 1024;
const blocked = (name) => /^(\.git|node_modules|\.env.*|jrebel\.properties)$/i.test(name)
  || /\.(pem|key|p12|pfx|lic|keystore|jks)$/i.test(name)
  || /^(id_rsa|id_ed25519|credentials)(\..*)?$/i.test(name);
const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (base, file) => {
  const rel = path.relative(base, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};

function resolveFile(rel = '') {
  if (rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel)
    || rel.split('/').some(p => p === '..' || blocked(p))) throw fail(403, '此路径不允许访问');
  const candidate = path.resolve(ROOT, rel);
  if (!inside(ROOT, candidate)) throw fail(403, '此路径不允许访问');
  let walk = ROOT;
  for (const part of rel.split('/').filter(Boolean)) {
    walk = path.join(walk, part);
    if (fs.lstatSync(walk).isSymbolicLink()) throw fail(403, '不支持浏览符号链接');
  }
  const real = fs.realpathSync(candidate);
  if (!inside(ROOT, real)) throw fail(403, '此路径不允许访问');
  return real;
}

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: '仅支持只读 GET 请求' });
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/tree') {
      const rel = u.searchParams.get('path') || '';
      const dir = resolveFile(rel);
      if (!fs.statSync(dir).isDirectory()) throw fail(400, '不是目录');
      const entries = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (blocked(item.name) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
        entries.push({ name: item.name, path: path.posix.join(rel, item.name), directory: item.isDirectory() });
      }
      entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return json(res, 200, { project: PROJECT, path: rel, entries });
    }
    if (u.pathname === '/api/file') {
      const rel = u.searchParams.get('path') || '';
      const file = resolveFile(rel);
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw fail(400, '不是普通文件');
      const buf = readChunk(file, 0, Math.min(stat.size, CHUNK));
      let text = null;
      try {
        if (buf.includes(0)) throw new Error('binary');
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: stat.size > buf.length });
        if (/[\x01-\x08\x0e-\x1f]/.test(text)) text = null;
      } catch { text = null; }
      return json(res, 200, { path: rel, size: stat.size, truncated: stat.size > buf.length, binary: text === null, text });
    }
    if (u.pathname === '/api/logs') {
      const logs = [];
      if (fs.existsSync(LOG_DIR)) {
        for (const name of fs.readdirSync(resolveFile('.tmp'))) {
          if (!NAME_RE.test(name)) continue;
          try {
            const stat = fs.statSync(resolveFile('.tmp/' + name));
            if (stat.isFile()) logs.push({ name, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
          } catch { /* 文件可能在列举后被清理。 */ }
        }
      }
      logs.sort((a, b) => b.name.localeCompare(a.name));
      return json(res, 200, { logs, project: PROJECT });
    }
    if (u.pathname === '/api/tail') {
      const name = u.searchParams.get('name') || '';
      if (!NAME_RE.test(name)) throw fail(400, '日志文件名无效');
      const file = resolveFile('.tmp/' + name);
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw fail(400, '不是日志文件');
      const size = stat.size;
      let offset = Number(u.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) offset = Math.max(0, size - CHUNK);
      const buf = readChunk(file, offset, Math.min(size - offset, CHUNK));
      return json(res, 200, { start: offset, offset: offset + buf.length, size, b64: buf.toString('base64') });
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(SCRIPT_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
    json(res, status, { error: e.status ? e.message : status === 404 ? '文件已不存在，请刷新' : status === 403 ? '没有读取权限' : '读取失败，请刷新重试' });
  }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is occupied; verify the existing viewer before reusing it.` : e.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', () => console.log(`[${PROJECT}] JRebel log viewer: http://127.0.0.1:${PORT}`));
