// 受管 scenario-test 工作台。仅操作登记项目中的固定入口。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
// 自定义目录发现：agent-app-manager 无从预知项目的 scenario-test 目录，只能靠扫描。
// 为控制性能：默认 `scenario-test` 完整时零扫描；缺失或不完整时才浅扫描项目根两层
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
  const defaultDir = path.join(root, 'scenario-test');
  const defaults = scenarioExists(defaultDir);
  if (defaults.every(Boolean)) return { dir: defaultDir, exists: defaults };
  const cache = readDirCache(home);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const hit = cache[key];
  let candidates;
  // 缓存全部候选而非选中项：每次重查完整性，且不沿用旧版静默择一的缓存。
  if (hit?.version === 2 && Array.isArray(hit.dirs)
    && hit.dirs.every(d => typeof d === 'string' && within(root, d))
    && Date.now() - hit.at < DIR_CACHE_TTL_MS) {
    candidates = hit.dirs;
  } else {
    candidates = scanScenarioDirs(root);
    cache[key] = { version: 2, dirs: candidates, at: Date.now() };
    writeDirCache(home, cache);
  }
  const complete = candidates.filter(d => scenarioExists(d).every(Boolean));
  const choices = complete.length ? complete : defaults.some(Boolean) ? [defaultDir] : candidates.filter(isScenarioCandidate);
  if (choices.length > 1) throw conflictError('WORKBENCH_AMBIGUOUS',
    `发现多个场景测试目录，无法确定应打开哪一个：${choices.map(d => path.relative(root, d)).join('、')}`);
  const dir = choices[0] ?? defaultDir;
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
// scenario-test 的用户级项目登记（~/.scenario-test/projects.json）：
// 新版项目内 CLI 支持 `projects ensure`，由它统一分配/固定端口；
// 旧版 CLI 不识别该命令时，退化为只读登记文件，避免管理台每次换端口。
function scenarioRegistryPath() {
  const explicit = process.env.SCENARIO_TEST_HOME;
  return path.join(explicit ? path.resolve(explicit) : path.join(os.homedir(), '.scenario-test'), 'projects.json');
}
function canonicalConfig(config) {
  let resolved = path.resolve(config);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* 配置缺失时保持 resolve 结果 */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function readScenarioProjectPort(config) {
  try {
    const registry = JSON.parse(fs.readFileSync(scenarioRegistryPath(), 'utf8'));
    const key = canonicalConfig(config);
    for (const [entryKey, entry] of Object.entries(registry.projects || {})) {
      const normalized = process.platform === 'win32' ? entryKey.toLowerCase() : entryKey;
      if (normalized === key && Number.isInteger(entry.port)) return entry.port;
    }
  } catch { /* 未登记或文件损坏时回退随机端口 */ }
  return null;
}
function ensureScenarioProject(info) {
  try {
    const stdout = execFileSync(process.execPath, [info.cli, 'projects', 'ensure', '--config', info.config, '--json', '--reassign'], {
      cwd: info.workRoot,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    const parsed = JSON.parse(stdout);
    if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) return null;
    return parsed;
  } catch {
    return null;
  }
}
function scenarioSlug(name, id) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return slug || `scenario-${id}`;
}
// 旧版项目内 CLI 不支持 `projects ensure` 时，由管理台按 scenario-test 的登记格式补写端口，
// 保证首次打开后端口同样固定。锁与格式和 scenario-test 保持一致；写失败不影响启动。
function rememberScenarioProjectPort(info, port) {
  try {
    const file = scenarioRegistryPath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'projects.lock');
    let handle;
    try { handle = fs.openSync(lock, 'wx'); } catch { return; }
    try {
      let registry = { schemaVersion: 1, defaultPort: 4300, projects: {} };
      try { registry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次登记 */ }
      if (!registry.projects || typeof registry.projects !== 'object') registry.projects = {};
      if (!Number.isInteger(registry.defaultPort)) registry.defaultPort = 4300;
      const key = canonicalConfig(info.config);
      const now = new Date().toISOString();
      const existing = registry.projects[key];
      const root = path.dirname(info.workRoot);
      const name = path.basename(root) || `scenario-${info.id}`;
      registry.projects[key] = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        name: existing?.name || name,
        slug: existing?.slug || scenarioSlug(name, info.id),
        root,
        dir: info.workRoot,
        config: info.config,
        port,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, file);
    } finally {
      try { fs.closeSync(handle); } catch { /* 已关闭 */ }
      fs.rmSync(lock, { force: true });
    }
  } catch { /* 登记写入失败不影响工作台启动 */ }
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
    // 端口优先复用 scenario-test 的项目登记（新版 CLI 负责分配/顺延并回写），
    // 旧版 CLI 或登记缺失时才退回随机端口。serve 启动时仍显式传 --port，
    // 保证管理台的 expectedPort 与工作台实际端口一致，并同步回登记。
    const ensured = ensureScenarioProject(info);
    let port = ensured?.port ?? readScenarioProjectPort(info.config);
    if (!Number.isInteger(port)) {
      port = await freePort();
      rememberScenarioProjectPort(info, port);
    }
    try {
      portConflict(port, false);
    } catch {
      port = await freePort();
      portConflict(port, false);
      rememberScenarioProjectPort(info, port);
    }
    const desc = {
      alias: `scenario-${info.id}`,
      displayName: ensured?.name ? `场景测试工作台 - ${ensured.name}` : '场景测试工作台',
      root: info.workRoot,
      entry: info.entry,
      cwd: info.workRoot,
      mode: 'node',
      exe: process.execPath,
      args: [info.cli, 'serve', '--config', info.config, '--port', String(port)],
      envRefs: [],
      env: {},
      expectedPort: port
    };
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
