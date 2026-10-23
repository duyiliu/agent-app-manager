// PowerShell process probes: identity capture, liveness verification, port diagnosis.
// proc.ps1 runs the actual win32 calls; each invocation is a short-lived pwsh process.
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retryProcessProbe } from './proc.mjs';
import { EXIT, ManagerError, TERMINATE_WAIT_MS, COMMAND_DISCOVER_TIMEOUT_MS } from './constants.mjs';
import * as linuxProc from './proc-linux.mjs';
import { conflictError, dependencyError } from './errors.mjs';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PS_PROC = path.join(SCRIPTS_DIR, 'ps', 'proc.ps1');

export { TERMINATE_WAIT_MS, COMMAND_DISCOVER_TIMEOUT_MS };

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
let selfIdentity = null;

// 当前仅支持 Windows（pwsh/Win32）与 Linux（/proc）；其他平台明确拒绝，
// 不静默降级成不可靠的探针。
function ensureSupported() {
  if (!IS_WIN && !IS_LINUX) {
    throw new ManagerError('PLATFORM_UNSUPPORTED', `project-runner 当前仅支持 Windows 与 Linux；当前平台：${process.platform}`, EXIT.DEPENDENCY);
  }
}

function psProcOnce(action, params) {
  const args = ['-NoProfile', '-NonInteractive', '-File', PS_PROC, '-Action', action];
  if (params.id != null) args.push('-Id', String(params.id));
  if (params.creationFileTime != null) args.push('-CreationFileTime', String(params.creationFileTime));
  if (params.image != null) args.push('-Image', params.image);
  if (action === 'terminate' || action === 'terminate-tree' || action === 'grace' || action === 'discover') args.push('-WaitMs', String(params.waitMs ?? (action === 'discover' ? COMMAND_DISCOVER_TIMEOUT_MS : TERMINATE_WAIT_MS)));
  // discover 在单个 pwsh 进程内轮询等待目标出现，超时上限 = 发现窗口 + 启动余量
  // grace 内部要轮询 waitMs 才能给出 stillAlive，pwsh 超时需覆盖
  const timeout = action === 'discover' ? (params.waitMs ?? COMMAND_DISCOVER_TIMEOUT_MS) + 15000
    : action === 'grace' ? (params.waitMs ?? TERMINATE_WAIT_MS) + 15000 : 30000;
  const r = spawnSync('pwsh', args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw dependencyError('未找到 pwsh（PowerShell 7），受管启停依赖它');
    throw dependencyError(`pwsh 调用失败：${r.error.message}`);
  }
  if (r.status !== 0) {
    const e = dependencyError(`proc.ps1 退出码 ${r.status}：${(r.stderr || '').trim()}`);
    // 短时探针可重试：proc.ps1 每次都在进程内用 Add-Type 编译 C#，偶发 Roslyn 栈溢出
    // 崩溃（0xC00000FD / “type initializer ... threw an exception”），与进程状态无关。
    // discover 单次调用内部已轮询到超时，重试会把最坏等待放大到分钟级，故不重试。
    if (action !== 'discover' && action !== 'terminate' && action !== 'terminate-tree' && action !== 'grace') e.psTransient = true;
    throw e;
  }
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) {
    const e = dependencyError('proc.ps1 无输出');
    e.psTransient = true;
    throw e;
  }
  try {
    return JSON.parse(line);
  } catch {
    const e = dependencyError(`proc.ps1 输出无法解析：${line}`);
    e.psTransient = true;
    throw e;
  }
}

export function psProc(action, params = {}) {
  ensureSupported();
  if (IS_LINUX) return linuxProc.run(action, params);
  return retryProcessProbe(action, () => psProcOnce(action, params));
}

export function portOccupants(port) {
  ensureSupported();
  if (IS_LINUX) return linuxProc.portOccupants(port);
  // 单次 pwsh 调用完成端口+身份采集（proc.ps1 -Action port）：N 个监听人不再叠加
  // N 次 capture；identity.image 与 capture 同源，保持 #55 的 image 统一口径。
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PS_PROC, '-Action', 'port', '-Id', String(port)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw dependencyError('未找到 pwsh（PowerShell 7），端口诊断依赖它');
    throw dependencyError(`端口诊断调用失败：${r.error.message}`);
  }
  if (r.status !== 0) throw dependencyError(`端口诊断失败：${(r.stderr || '').trim()}`);
  let parsed;
  const text = (r.stdout || '').trim();
  try { parsed = text ? JSON.parse(text) : []; } catch { throw dependencyError('端口诊断输出无法解析'); }
  // 单元素时 ConvertTo-Json 会退化为对象而非数组
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  return rows.map((row) => ({
    pid: row.pid ?? null,
    processName: row.processName ?? null,
    executablePath: row.executablePath ?? null,
    commandLine: row.commandLine ?? null,
    startedAt: row.startedAt ?? null,
    localAddress: row.localAddress,
    localPort: row.localPort,
    identity: row.identity ?? null,
  }));
}

export function portConflict(port, force, ignorePid = null) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const occupants = portOccupants(port).filter((p) => p.pid !== ignorePid);
  if (!occupants.length) return null;
  if (force) return { port, occupants, forced: true, note: '--force 已明确允许在端口监听时继续；外部进程仅诊断，不接管、不停止' };
  throw conflictError('PORT_IN_USE', `预期端口 ${port} 已监听，拒绝启动；占用证据见详情。外部进程仅诊断，不接管、不停止；如确认仍要继续请用 --force`, { port, occupants, forced: false });
}

// 批量核验受管运行记录：一次 pwsh 调用处理 N 项（Linux 走 /proc，无 spawn 开销）。
// 结果顺序与入参一致；失败时抛环境依赖错误，调用方应回退逐条核验。
export function verifyRuns(runs) {
  ensureSupported();
  const items = (runs ?? []).filter((r) => r && Number.isInteger(r.pid) && r.creationFileTime && r.image);
  if (!items.length) return [];
  // 统一字段名：对外用 pid，内部/proc.ps1 用 id
  const norm = items.map((r) => ({ id: r.pid, creationFileTime: r.creationFileTime, image: r.image }));
  if (IS_LINUX) return linuxProc.verifyBatch(norm);
  const payload = Buffer.from(JSON.stringify(norm), 'utf8').toString('base64');
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PS_PROC, '-Action', 'verify-batch', '-Json', payload],
    { encoding: 'utf8', timeout: 30000 + items.length * 500, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw dependencyError('未找到 pwsh（PowerShell 7），受管启停依赖它');
    throw dependencyError(`pwsh 调用失败：${r.error.message}`);
  }
  if (r.status !== 0) throw dependencyError(`proc.ps1 退出码 ${r.status}：${(r.stderr || '').trim()}`);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw dependencyError('proc.ps1 无输出');
  let parsed;
  try { parsed = JSON.parse(line); } catch { throw dependencyError(`proc.ps1 输出无法解析：${line}`); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function selfIdentityCapture() {
  if (!selfIdentity) {
    const r = psProc('capture', { id: process.pid });
    if (r.result !== 'ok') {
      if (IS_LINUX) {
        throw new ManagerError('IDENTITY_UNAVAILABLE', `无法采集自身进程身份（/proc 不可读）：${JSON.stringify(r)}`, EXIT.DEPENDENCY);
      }
      throw dependencyError(`无法采集自身进程身份：${JSON.stringify(r)}`);
    }
    selfIdentity = r;
  }
  return selfIdentity;
}

// 核验结果的统一解释（单条 verify 与批量逐项共用，保证语义一致）。
// 返回 {alive, reason}；reason: 'gone' | 'pidReused'。核验失败抛错（不猜）。
export function interpretVerifyResult(r) {
  if (r.result === 'ok') return { alive: true };
  if (r.result === 'exited' || r.result === 'notfound') return { alive: false, reason: 'gone' };
  if (r.result === 'mismatch') return { alive: false, reason: 'pidReused' };
  throw conflictError('IDENTITY_UNKNOWN', `身份核验失败（${r.code ?? r.result}），拒绝操作`, r);
}

// 短 TTL 核验缓存：ui 的 /api/apps（批量）与 /api/status（单条）在同一轮询周期内
// 会对同一运行重复核验，Windows 上每次都是一次 pwsh 冷启动。缓存仅存活结论
// （alive/gone/pidReused），键含完整身份（pid+creationFileTime+image），PID 复用不会
// 命中旧值；terminate 类操作后主动失效，避免 stop→start 竞态读到旧存活结论。
const VERIFY_CACHE_TTL_MS = 1500;
const verifyCache = new Map(); // key -> { at, interpreted }

function verifyCacheKey(run) {
  return `${run.pid}\u0000${run.creationFileTime}\u0000${run.image}`;
}

export function cacheVerifyResult(run, interpreted) {
  verifyCache.set(verifyCacheKey(run), { at: Date.now(), interpreted });
  if (verifyCache.size > 128) {
    const cutoff = Date.now() - VERIFY_CACHE_TTL_MS;
    for (const [k, v] of verifyCache) if (v.at < cutoff) verifyCache.delete(k);
  }
}

// 终止/停止路径调用：该 pid 相关的缓存存活结论立即作废。
export function invalidateVerifyCache(pid) {
  if (!Number.isInteger(pid)) return;
  for (const k of verifyCache.keys()) if (k.startsWith(`${pid}\u0000`)) verifyCache.delete(k);
}

export function verifyRun(run) {
  if (run.pid == null || !run.creationFileTime || !run.image) {
    throw conflictError('IDENTITY_UNKNOWN', '运行记录缺少身份证据（pid/创建时间/映像），无法核验');
  }
  const key = verifyCacheKey(run);
  const hit = verifyCache.get(key);
  if (hit && Date.now() - hit.at < VERIFY_CACHE_TTL_MS) return hit.interpreted;
  const interpreted = interpretVerifyResult(psProc('verify', { id: run.pid, creationFileTime: run.creationFileTime, image: run.image }));
  cacheVerifyResult(run, interpreted);
  return interpreted;
}

export function tcpListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(700);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}
