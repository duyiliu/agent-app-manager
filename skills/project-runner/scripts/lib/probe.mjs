// PowerShell process probes: identity capture, liveness verification, port diagnosis.
// proc.ps1 runs the actual win32 calls; each invocation is a short-lived pwsh process.
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retryProcessProbe } from './proc.mjs';
import { conflictError, dependencyError } from './errors.mjs';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PS_PROC = path.join(SCRIPTS_DIR, 'ps', 'proc.ps1');

export const TERMINATE_WAIT_MS = 10000;         // 有界强制停止等待
export const COMMAND_DISCOVER_TIMEOUT_MS = 45000; // 命令模式后代发现默认上限

let selfIdentity = null;

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
    // 标记可重试：proc.ps1 每次都在进程内用 Add-Type 编译 C#，偶发 Roslyn 栈溢出崩溃
    // （退出码 0xC00000FD / “type initializer ... threw an exception”），与进程状态无关。
    e.psTransient = true;
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
  return retryProcessProbe(action, () => psProcOnce(action, params));
}

export function portOccupants(port) {
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
    return { ...row, identity };
  });
}

export function portConflict(port, force, ignorePid = null) {
  if (!Number.isInteger(port) || port < 1) return null;
  const occupants = portOccupants(port).filter((p) => p.pid !== ignorePid);
  if (!occupants.length) return null;
  if (force) return { port, occupants, forced: true, note: '--force 已明确允许在端口监听时继续；外部进程仅诊断，不接管、不停止' };
  throw conflictError('PORT_IN_USE', `预期端口 ${port} 已监听，拒绝启动；占用证据见详情。外部进程仅诊断，不接管、不停止；如确认仍要继续请用 --force`, { port, occupants, forced: false });
}

export function selfIdentityCapture() {
  if (!selfIdentity) {
    const r = psProc('capture', { id: process.pid });
    if (r.result !== 'ok') throw dependencyError(`无法采集自身进程身份：${JSON.stringify(r)}`);
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
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}
