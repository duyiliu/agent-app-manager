// 受管 scenario-test 工作台。仅操作登记项目中的固定入口。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { readRegistry, readRuntimeStrict, registryPath, atomicWriteJson } from '../store.mjs';
import { resolveAppId, resolveUnresolvedRun } from '../runtime.mjs';
import { computeAppId, upsertApp } from '../desc.mjs';
import { verifyRun, invalidateVerifyCache, listListeningPorts, portConflict } from '../probe.mjs';
import { withLock, withLockAsync, withRegistryLock } from '../locks.mjs';
import { launchManaged } from '../launch.mjs';
import { cmdStop } from './lifecycle.mjs';
import { conflictError, usageError } from '../errors.mjs';

const MARKER = 'scenario-workbench-v1';
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function within(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
// scenario-test 接入目录的标记文件：config + 工作台页面 + 项目内 CLI 运行时副本。
const SCENARIO_FILES = ['scenario.config.js', 'index.html', path.join('.scenario-test', 'scenario-test-cli.cjs')];
const scenarioExists = (dir) => SCENARIO_FILES.map((f) => fs.existsSync(path.join(dir, f)));
// 自定义目录发现：project-runner 无从预知项目的 scenario-test 目录，只能靠扫描。
// 为控制性能：默认 `scenario-test` 存在时零扫描；缺失时才浅扫描项目根两层
// （跳过常见非业务目录），并把结果缓存到 home 缓存文件（默认 5 分钟有效），
// 避免详情轮询反复遍历同一项目。候选须命中 scenario-test 特有标记
// （scenario.config.js 或 .scenario-test/scenario-test-cli.cjs），普通含 index.html 不算。
const SCAN_SKIP = new Set(['.git', 'node_modules', '.tmp', 'target', 'build', 'dist', 'out', 'logs', '.idea', '.vscode', '.scenario-test']);
const SCAN_MAX_DEPTH = 2;
const DIR_CACHE_TTL_MS = 5 * 60 * 1000;
function dirCachePath(home) {
  return path.join(home, 'workbench-dir-cache.json');
}
function readDirCache(home) {
  try { return JSON.parse(fs.readFileSync(dirCachePath(home), 'utf8')); } catch { return {}; }
}
function writeDirCache(home, cache) {
  try {
    const tmp = dirCachePath(home) + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, dirCachePath(home));
  } catch { /* 缓存失败不影响功能 */ }
}
function isScenarioCandidate(dir) {
  const [config, , cli] = scenarioExists(dir);
  return config || cli;
}
function scanScenarioDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isScenarioCandidate(full)) found.push(full);
      if (depth < SCAN_MAX_DEPTH) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}
function pickScenarioDir(home, root) {
  const defaults = scenarioExists(path.join(root, 'scenario-test'));
  // 默认目录存在（哪怕不完整）就沿用现有行为，不扫描，避免与自定义目录歧义。
  if (defaults.some(Boolean)) return { dir: path.join(root, 'scenario-test'), exists: defaults };
  const cache = readDirCache(home);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const hit = cache[key];
  let dir;
  if (hit && typeof hit.dir === 'string' && Date.now() - hit.at < DIR_CACHE_TTL_MS) {
    dir = hit.dir;
  } else {
    const candidates = scanScenarioDirs(root);
    const count = (d) => scenarioExists(d).filter(Boolean).length;
    candidates.sort((a, b) => count(b) - count(a) || (samePath(a, b) ? 0 : a < b ? -1 : 1));
    dir = candidates[0] ?? path.join(root, 'scenario-test');
    cache[key] = { dir, at: Date.now() };
    writeDirCache(home, cache);
  }
  return { dir, exists: scenarioExists(dir) };
}
function discover(home, ref) {
  const registry = readRegistry(home);
  const app = registry.apps[resolveAppId(registry, ref)];
  if (app.internalKind === MARKER) throw usageError('请选择业务应用');
  let root;
  try { root = fs.realpathSync.native(app.root); } catch { throw conflictError('PROJECT_INVALID', '登记项目根目录不可访问'); }
  const { dir, exists } = pickScenarioDir(home, root);
  const files = SCENARIO_FILES.map((f) => path.join(dir, f));
  let real;
  let realDir;
  try { realDir = fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir; real = files.map((f, i) => exists[i] ? fs.realpathSync.native(f) : null); } catch { throw conflictError('PROJECT_INVALID', '场景测试文件不可访问'); }
  if (!within(root, realDir) || real.some((f) => f && (!within(root, f) || !fs.statSync(f).isFile()))) throw conflictError('PROJECT_INVALID', '场景测试文件必须位于登记项目根目录内');
  const [config, index, cli] = real;
  const workRoot = config ? path.dirname(config) : realDir;
  const identity = config || path.join(realDir, 'scenario.config.js');
  const key = process.platform === 'win32' ? identity.toLowerCase() : identity;
  const entry = `scenario-workbench-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  const id = computeAppId(workRoot, entry);
  const existing = registry.apps[id];
  if (existing && (existing.internalKind !== MARKER || !samePath(existing.root, workRoot))) throw conflictError('WORKBENCH_ID_CONFLICT', '工作台登记身份冲突');
  const state = exists.every(Boolean) ? 'AVAILABLE' : (exists.some(Boolean) ? 'INCOMPLETE' : 'NOT_INSTALLED');
  return { state, message: state === 'INCOMPLETE' ? '场景测试配置、页面或项目内 CLI 缺失' : null, id, entry, workRoot, config, cli, index, existing };
}
function tail(file) {
  if (!file) return '';
  try { const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const b = Buffer.alloc(Math.min(size, 4096)); fs.readSync(fd, b, 0, b.length, Math.max(0, size - b.length)); return b.toString('utf8'); } finally { fs.closeSync(fd); } } catch { return ''; }
}
function httpReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function status(home, info) {
  if (info.state !== 'AVAILABLE') {
    const cur = info.existing && readRuntimeStrict(home, info.id)?.current;
    const running = cur?.phase === 'RUNNING' && verifyRun(cur).alive;
    return { state: info.state, message: info.message ?? null, ...(running ? { pid: cur.pid, stderr: tail(cur.logPaths?.stderr) } : {}) };
  }
  const app = readRegistry(home).apps[info.id];
  const cur = readRuntimeStrict(home, info.id)?.current;
  if (!app || !cur) return { state: 'STOPPED' };
  const logs = { runId: cur.runId, stderr: tail(cur.logPaths?.stderr) };
  if (cur.phase !== 'RUNNING') {
    if (['STARTING', 'UNKNOWN'].includes(cur.phase)) return { state: 'UNKNOWN', message: '工作台进程身份待核验', ...logs };
    if (cur.phase === 'DEAD' || (cur.phase === 'STOPPED' && !cur.stopRequested)) return { state: 'FAILED', message: '工作台意外退出，请查看 stderr', ...logs };
    return { state: 'STOPPED', ...logs };
  }
  if (!verifyRun(cur).alive) return { state: 'FAILED', message: '工作台进程已退出', ...logs };
  const port = app.expectedPort;
  const ports = listListeningPorts(cur.pid);
  if (!ports.some((p) => p.localPort === port && p.localAddress === '127.0.0.1')) return { state: 'FAILED', pid: cur.pid, message: '受管进程未监听预期的本地端口', ...logs };
  const accessible = await httpReady(port);
  invalidateVerifyCache(cur.pid);
  if (!accessible || !verifyRun(cur).alive) return { state: 'FAILED', pid: cur.pid, message: '工作台尚不可访问或进程已退出', ...logs };
  return { state: 'RUNNING', url: `http://127.0.0.1:${port}/`, pid: cur.pid, ...logs };
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close((e) => e ? reject(e) : resolve(port)); }); });
}
export async function cmdWorkbench(ctx, op, ref) {
  if (!ref || !['status', 'open', 'stop'].includes(op) || ctx.rest.length !== 2) throw usageError('workbench 需要 status|open|stop 和应用标识');
  const info = discover(ctx.home, ref);
  if (op === 'status') return status(ctx.home, info);
  if (op === 'stop') {
    if (!info.id) throw conflictError('WORKBENCH_UNAVAILABLE', '工作台目录不可访问，无法核验应停止的实例');
    if (!info.existing && info.state !== 'AVAILABLE') throw conflictError('WORKBENCH_UNAVAILABLE', '工作台文件缺失且没有可核验的登记');
    if (!info.existing) return withLock(ctx.home, info.id, 'workbench-stop', () => {
      if (readRegistry(ctx.home).apps[info.id]) throw conflictError('WORKBENCH_CHANGED', '工作台刚刚启动，请重试停止');
      return { state: 'STOPPED' };
    });
    cmdStop({ ...ctx, rest: [info.id] }, info.id);
    return status(ctx.home, info);
  }
  if (info.state !== 'AVAILABLE') throw conflictError('WORKBENCH_UNAVAILABLE', info.message || '未发现场景测试');
  return withLockAsync(ctx.home, info.id, 'workbench-open', async () => {
    const fresh = discover(ctx.home, ref);
    if (fresh.state !== 'AVAILABLE' || fresh.id !== info.id || !samePath(fresh.config, info.config) || !samePath(fresh.cli, info.cli)) throw conflictError('PROJECT_CHANGED', '场景测试路径已改变，请重新检查');
    const rt = readRuntimeStrict(ctx.home, info.id);
    if (rt?.current?.phase === 'RUNNING' && verifyRun(rt.current).alive) return status(ctx.home, fresh);
    resolveUnresolvedRun(ctx.home, info.id, rt, null);
    const port = await freePort();
    portConflict(port, false);
    const desc = { alias: `scenario-${info.id}`, displayName: '场景测试工作台', root: info.workRoot, entry: info.entry, cwd: info.workRoot, mode: 'node', exe: process.execPath, args: [info.cli, 'serve', '--config', info.config, '--port', String(port)], envRefs: [], env: {}, expectedPort: port };
    const app = withRegistryLock(ctx.home, 'workbench-register', () => {
      const reg = readRegistry(ctx.home);
      const previous = reg.apps[info.id];
      if (previous && previous.internalKind !== MARKER) throw conflictError('WORKBENCH_ID_CONFLICT', '工作台登记身份冲突');
      const result = upsertApp(reg, info.id, desc);
      result.internalKind = MARKER;
      atomicWriteJson(registryPath(ctx.home), reg);
      return result;
    });
    await launchManaged(ctx.home, info.id, app);
    const deadline = Date.now() + 20000;
    let result;
    do {
      result = await status(ctx.home, info);
      if (result.state === 'RUNNING') return result;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    return { ...result, state: 'FAILED', message: result.message || '工作台启动超时，请查看 stderr' };
  });
}
