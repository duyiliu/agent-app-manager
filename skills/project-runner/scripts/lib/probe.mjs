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
  if (action === 'terminate' || action === 'discover') args.push('-WaitMs', String(params.waitMs ?? (action === 'discover' ? COMMAND_DISCOVER_TIMEOUT_MS : TERMINATE_WAIT_MS)));
  // discover 在单个 pwsh 进程内轮询等待目标出现，超时上限 = 发现窗口 + 启动余量
  const timeout = action === 'discover' ? (params.waitMs ?? COMMAND_DISCOVER_TIMEOUT_MS) + 15000 : 30000;
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
    if (action !== 'discover') e.psTransient = true;
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
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(SCRIPTS_DIR, 'ps', 'port.ps1'), '-Port', String(port)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw dependencyError('未找到 pwsh（PowerShell 7），端口诊断依赖它');
    throw dependencyError(`端口诊断调用失败：${r.error.message}`);
  }
  if (r.status !== 0) throw dependencyError(`端口诊断失败：${(r.stderr || '').trim()}`);
  let rows;
  try { rows = JSON.parse((r.stdout || '').trim() || '[]'); } catch { throw dependencyError('端口诊断输出无法解析'); }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  return rows.map((row) => {
    let identity = null;
    try { identity = psProc('capture', { id: row.pid }); } catch (e) { identity = { result: 'error', message: e.message }; }
    // 与 status/capture 统一口径：端口诊断的 executablePath 取解析后的 image（#55），
    // 避免 nvm/shim 场景下 port.ps1 的 Win32_Process.ExecutablePath 与 status 的 image 不一致。
    return {
      ...row,
      executablePath: identity?.result === 'ok' ? identity.image : row.executablePath,
      identity,
    };
  });
}

export function portConflict(port, force, ignorePid = null) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const occupants = portOccupants(port).filter((p) => p.pid !== ignorePid);
  if (!occupants.length) return null;
  if (force) return { port, occupants, forced: true, note: '--force 已明确允许在端口监听时继续；外部进程仅诊断，不接管、不停止' };
  throw conflictError('PORT_IN_USE', `预期端口 ${port} 已监听，拒绝启动；占用证据见详情。外部进程仅诊断，不接管、不停止；如确认仍要继续请用 --force`, { port, occupants, forced: false });
}

// 枚举目标进程当时仍在的后代（PPID 树）：stop --tree 在终止目标前留证（#39）。
// 只返回当时仍在的后代链，不向上爬、不认领外部进程。
export function listDescendants(pid) {
  ensureSupported();
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (IS_LINUX) return linuxProc.descendants(pid);
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PS_PROC, '-Action', 'descendants', '-Id', String(pid)],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw dependencyError('未找到 pwsh（PowerShell 7），受管启停依赖它');
    throw dependencyError(`pwsh 调用失败：${r.error.message}`);
  }
  if (r.status !== 0) throw dependencyError(`proc.ps1 退出码 ${r.status}：${(r.stderr || '').trim()}`);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return [];
  let parsed;
  try { parsed = JSON.parse(line); } catch { throw dependencyError(`proc.ps1 输出无法解析：${line}`); }
  return Array.isArray(parsed) ? parsed : [parsed];
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

export function verifyRun(run) {
  if (run.pid == null || !run.creationFileTime || !run.image) {
    throw conflictError('IDENTITY_UNKNOWN', '运行记录缺少身份证据（pid/创建时间/映像），无法核验');
  }
  return interpretVerifyResult(psProc('verify', { id: run.pid, creationFileTime: run.creationFileTime, image: run.image }));
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
