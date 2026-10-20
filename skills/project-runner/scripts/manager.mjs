#!/usr/bin/env node
// project-runner 跨项目管理器（P0）
// 设计基线：docs/design.md v2。要点：
// - 只管理本 Skill 启动并记录的应用进程（Java/Python/Node/其他真实可执行进程）；外部进程绝不接管或终止。
// - 受管启停依赖 ps/proc.ps1 的"同句柄身份核验 + 终止"，防 PID 复用误杀。
// - 启动前先持久化意图（runId/STARTING），中断保留证据并拒绝自动重试。
// - 数据目录 ~/.project-runner/（或 --home 绝对路径）；注册表/运行记录带 schemaVersion，
//   损坏或不兼容版本拒绝覆盖并保留原件；写入均为临时文件 + 原子替换。
// - stdout 只输出管理结果，不混入被启动应用的日志（--follow 是用户显式要求的例外）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const EXIT = { OK: 0, USAGE: 1, NOT_FOUND: 2, CONFLICT: 3, DEPENDENCY: 4, DATA: 5 };
const MAX_LOG_BYTES = 4 * 1024 * 1024;   // 单次读取的日志字节上限
const MAX_LOG_LINES = 5000;              // --lines 上限
const TERMINATE_WAIT_MS = 10000;         // 有界强制停止等待
const PREV_RUNS_KEEP = 20;
// 未结记录：STARTING（启动中断，pid 未采集）、UNKNOWN（身份不明，进程可能仍存活）
// 以及任何无法识别的 phase，一律禁止自动重起。只有 RUNNING/STOPPED 可在核验后继续启动。
const RESUMABLE_PHASES = new Set(['RUNNING', 'STOPPED']);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PS_PROC = path.join(SCRIPT_DIR, 'ps', 'proc.ps1');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 运行形态标签：java/jrebel 为 JVM 应用；python/node 为对应解释器进程；
// proc 为其他真实可执行进程（Go/.NET/PHP 等）。仅作登记与展示语义，生命周期机制完全相同。
const MODES = new Set(['java', 'jrebel', 'python', 'node', 'proc']);
// 受管 exe 必须是可直接 CreateProcess 的真实可执行文件；脚本包装（cmd/bat/ps1）
// 与 WindowsApps 应用执行别名 stub（0 字节 reparse point）会让真实进程变成子进程或根本无法启动。
const WRAPPER_EXT_RE = /\.(cmd|bat|ps1)$/i;
const EXEC_EXT_RE = /\.(exe|com)$/i;
// 命令模式：expectedImage 必须是映像基名（node.exe/java.exe 等），不允许路径分隔符
const IMAGE_NAME_RE = /^[^\\/]+\.(exe|com)$/i;
const COMMAND_DISCOVER_TIMEOUT_MS = 45000; // 命令模式后代发现默认上限

// ---------- 错误契约 ----------

class ManagerError extends Error {
  constructor(code, message, exitCode, detail) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}
const usageError = (m, d) => new ManagerError('USAGE', m, EXIT.USAGE, d);
const notFoundError = (m, d) => new ManagerError('NOT_FOUND', m, EXIT.NOT_FOUND, d);
const conflictError = (code, m, d) => new ManagerError(code, m, EXIT.CONFLICT, d);
const dependencyError = (m, d) => new ManagerError('PWSH_MISSING', m, EXIT.DEPENDENCY, d);
const dataError = (code, m, d) => new ManagerError(code, m, EXIT.DATA, d);

// ---------- 参数与 home ----------

function parseArgv(argv) {
  const ctx = { json: false, home: null, command: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') ctx.json = true;
    else if (a === '--home') {
      ctx.home = argv[++i];
      if (!ctx.home) throw usageError('--home 需要绝对路径参数');
    } else if (ctx.command === null) ctx.command = a;
    else ctx.rest.push(a);
  }
  if (!ctx.command || ctx.command === 'help') {
    throw usageError(usageText());
  }
  return ctx;
}

function resolveHome(argHome, readOnly = false) {
  const raw = argHome || path.join(os.homedir(), '.project-runner');
  if (!path.isAbsolute(raw)) throw usageError(`--home 需要绝对路径：${raw}`);
  if (readOnly) return fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
  fs.mkdirSync(raw, { recursive: true });
  const home = fs.realpathSync.native(raw);
  for (const d of ['runtime', 'logs', 'locks']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

// ---------- PowerShell 进程适配 ----------

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

const PS_PROBE_ATTEMPTS = 3; // 仅针对 pwsh/Add-Type 编译的瞬时崩溃，不重试语义性失败

function psProc(action, params = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return psProcOnce(action, params);
    } catch (e) {
      // terminate 不重试：避免“已终止但响应丢失”后重试带来歧义（重试只会看到 notfound/exited）
      if (!e.psTransient || action === 'terminate' || attempt >= PS_PROBE_ATTEMPTS) throw e;
    }
  }
}

function portOccupants(port) {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(SCRIPT_DIR, 'ps', 'port.ps1'), '-Port', String(port)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
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

function portConflict(port, force, ignorePid = null) {
  if (!Number.isInteger(port) || port < 1) return null;
  const occupants = portOccupants(port).filter((p) => p.pid !== ignorePid);
  if (!occupants.length) return null;
  if (force) return { port, occupants, forced: true, note: '--force 已明确允许在端口监听时继续；外部进程仅诊断，不接管、不停止' };
  throw conflictError('PORT_IN_USE', `预期端口 ${port} 已监听，拒绝启动；占用证据见详情。外部进程仅诊断，不接管、不停止；如确认仍要继续请用 --force`, { port, occupants, forced: false });
}

function selfIdentityCapture() {
  if (!selfIdentity) {
    const r = psProc('capture', { id: process.pid });
    if (r.result !== 'ok') throw dependencyError(`无法采集自身进程身份：${JSON.stringify(r)}`);
    selfIdentity = r;
  }
  return selfIdentity;
}

// 返回 {alive, reason}；reason: 'gone' | 'pidReused'。核验失败抛错（不猜）。
function verifyRun(run) {
  if (run.pid == null || !run.creationFileTime || !run.image) {
    throw conflictError('IDENTITY_UNKNOWN', '运行记录缺少身份证据（pid/创建时间/映像），无法核验');
  }
  const r = psProc('verify', { id: run.pid, creationFileTime: run.creationFileTime, image: run.image });
  if (r.result === 'ok') return { alive: true };
  if (r.result === 'exited' || r.result === 'notfound') return { alive: false, reason: 'gone' };
  if (r.result === 'mismatch') return { alive: false, reason: 'pidReused' };
  throw conflictError('IDENTITY_UNKNOWN', `身份核验失败（${r.code ?? r.result}），拒绝操作`, r);
}

// ---------- 注册表与运行记录 ----------

function registryPath(home) { return path.join(home, 'registry.json'); }
function runtimePath(home, appId) { return path.join(home, 'runtime', `${appId}.json`); }
function lockPath(home, name) { return path.join(home, 'locks', `${name}.lock`); }

function parseStructured(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw dataError('DATA_UNREADABLE', `${label} 不可读（${file}）：${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw dataError('DATA_CORRUPT', `${label} 损坏，拒绝覆盖并保留原件（${file}）：${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || obj.schemaVersion !== SCHEMA_VERSION) {
    throw dataError('DATA_UNSUPPORTED', `${label} schemaVersion=${obj && obj.schemaVersion} 不受支持（期望 ${SCHEMA_VERSION}），拒绝覆盖（${file}）`);
  }
  return obj;
}

function readRegistry(home) {
  const p = registryPath(home);
  if (!fs.existsSync(p)) return { schemaVersion: SCHEMA_VERSION, apps: {} };
  const reg = parseStructured(p, '注册表');
  if (!reg.apps || typeof reg.apps !== 'object') throw dataError('DATA_CORRUPT', `注册表结构无效（缺少 apps，${p}）`);
  return reg;
}

function readRuntimeStrict(home, appId) {
  const p = runtimePath(home, appId);
  if (!fs.existsSync(p)) return null;
  const rt = parseStructured(p, `运行记录(${appId})`);
  if (rt.appId !== appId) throw dataError('DATA_CORRUPT', `运行记录 appId 不匹配（${p}）`);
  return rt;
}

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw dataError('DATA_UNWRITABLE', `写入失败（${file}）：${e.message}`);
  }
}

function archiveCurrent(rt, opts = {}) {
  if (rt.current) {
    const cur = rt.current;
    const entry = {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, kind: cur.kind ?? 'direct',
      startedAt: cur.startedAt, endedAt: cur.endedAt ?? null,
      lastError: cur.lastError ?? null, archivedAt: new Date().toISOString(),
    };
    if (opts.reason) {
      // 显式 ack 放弃的未结记录：保留完整身份与日志证据，注明归档原因
      entry.archiveReason = opts.reason;
      entry.intentAt = cur.intentAt ?? null;
      entry.pid = cur.pid ?? null;
      entry.creationFileTime = cur.creationFileTime ?? null;
      entry.image = cur.image ?? null;
      entry.wrapperPid = cur.wrapperPid ?? null;
      entry.logPaths = cur.logPaths ?? null;
      entry.exitNote = cur.exitNote ?? null;
      entry.envResolved = cur.envResolved ?? [];
    }
    rt.prevRuns = rt.prevRuns ?? [];
    rt.prevRuns.unshift(entry);
    rt.prevRuns = rt.prevRuns.slice(0, PREV_RUNS_KEEP);
    rt.current = null;
  }
}

// ---------- 未结记录（STARTING/UNKNOWN）防护与显式 ack 恢复 ----------

function runEvidence(home, appId, cur) {
  return {
    runId: cur.runId,
    phase: cur.phase,
    managed: cur.managed,
    pid: cur.pid ?? null,
    intentAt: cur.intentAt ?? null,
    startedAt: cur.startedAt ?? null,
    lastError: cur.lastError ?? null,
    runtimeFile: runtimePath(home, appId),
    logPaths: cur.logPaths ?? null,
  };
}

function unresolvedRunError(home, appId, rt) {
  const cur = rt.current;
  const ev = runEvidence(home, appId, cur);
  const logHint = cur.logPaths?.stdout ? `，日志：${cur.logPaths.stdout}` : '';
  return conflictError('UNRESOLVED_RUN',
    `存在未结运行记录 runId=${cur.runId}（phase=${cur.phase}${cur.pid != null ? `，pid=${cur.pid}` : ''}），拒绝自动重复启动，未产生新进程；证据：${ev.runtimeFile}${logHint}。请先人工核验该进程是否仍存活（status/logs 可查），确认已退出后再用 --ack-unresolved ${cur.runId} 显式恢复`,
    ev);
}

// ack 前复核：旧进程仍存活则拒绝；已退出/无 pid 可核验才允许放弃旧账。
function verifyAbandonable(home, appId, cur) {
  const ev = runEvidence(home, appId, cur);
  if (cur.pid == null) return; // 无 pid 可核验：显式 ack 即人工核验结论
  if (cur.creationFileTime && cur.image) {
    const v = verifyRun(cur); // 核验失败抛 IDENTITY_UNKNOWN，保守拒绝
    if (v.alive) {
      throw conflictError('UNRESOLVED_RUN',
        `--ack-unresolved=${cur.runId} 被拒绝：旧进程仍存活（pid=${cur.pid}），禁止启动第二份受管实例`,
        { ...ev, verification: 'alive' });
    }
    return; // 已退出或 PID 已复用
  }
  const r = psProc('capture', { id: cur.pid });
  if (r.result === 'notfound' || r.result === 'exited') return;
  if (r.result === 'ok') {
    throw conflictError('UNRESOLVED_RUN',
      `--ack-unresolved=${cur.runId} 被拒绝：pid=${cur.pid} 仍存在但记录缺少完整身份证据（creationFileTime/image），无法确认是否为原实例；请人工核验并处理该进程后重试`,
      { ...ev, verification: 'identity-incomplete-pid-present' });
  }
  throw conflictError('IDENTITY_UNKNOWN',
    `--ack-unresolved=${cur.runId} 无法核验 pid=${cur.pid} 当前状态（${r.code ?? r.result}），拒绝`,
    { ...ev, capture: r });
}

// 返回 null（无未结记录）或 {runId}（已验证可放弃，launchManaged 归档时注明 abandoned-by-ack）。
// managed=false 的登记记录不表示受管实例，不构成受管启动的未结记录。
function resolveUnresolvedRun(home, appId, rt, ackRunId) {
  const cur = rt && rt.current;
  const unresolved = !!(cur && cur.managed !== false && isUnresolvedPhase(cur.phase));
  if (!unresolved) {
    if (ackRunId) {
      throw conflictError('ACK_MISMATCH',
        `当前没有 STARTING/UNKNOWN 未结记录，--ack-unresolved=${ackRunId} 不适用；请去掉该参数`,
        { ackRunId, current: cur ? { runId: cur.runId, phase: cur.phase, managed: cur.managed } : null });
    }
    return null;
  }
  if (!ackRunId) throw unresolvedRunError(home, appId, rt);
  if (ackRunId !== cur.runId) {
    throw conflictError('ACK_MISMATCH',
      `--ack-unresolved=${ackRunId} 与未结记录 runId=${cur.runId} 不一致，拒绝`,
      { ackRunId, ...runEvidence(home, appId, cur) });
  }
  verifyAbandonable(home, appId, cur);
  return { runId: cur.runId, evidence: runEvidence(home, appId, cur) };
}

// 未结判定：STARTING/UNKNOWN 明确是未结记录；无法识别的 phase（例如记录被外部改坏）
// 同样按未结处理并保留证据，避免“先归档旧账再起”造成旧进程永久失管。
function isUnresolvedPhase(phase) {
  return !RESUMABLE_PHASES.has(phase);
}

function parseAckRunId(value) {
  if (value == null) return null;
  if (!ID_RE.test(value)) throw usageError(`--ack-unresolved 需要合法 runId：${value}`);
  return value;
}

// ---------- 跨进程互斥锁 ----------

function holderAlive(holder) {
  if (!holder || typeof holder.pid !== 'number' || typeof holder.creationFileTime !== 'string') {
    throw dataError('LOCK_CORRUPT', `锁文件信息不完整，拒绝静默处理；人工核验后删除：${lockPath(holder ? holder.name : '')}`);
  }
  const r = psProc('capture', { id: holder.pid });
  if (r.result === 'notfound' || r.result === 'exited') return false; // 明确已退出 → 持有者已死
  if (r.result !== 'ok') return true; // 权限不足等未知情形：保守视为存活，拒绝回收
  return String(r.creationFileTime) === String(holder.creationFileTime); // 复用 → 视为死锁可回收
}

function acquireLock(home, name, op) {
  const file = lockPath(home, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
      let holder;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e2) {
        throw dataError('LOCK_CORRUPT', `锁文件损坏，拒绝静默处理；人工核验后删除：${file}（${e2.message}）`);
      }
      holder.name = name;
      let alive;
      try {
        alive = holderAlive(holder);
      } catch (e3) {
        if (e3.code === 'PWSH_MISSING') throw e3;
        alive = true; // 权限等未知情形：保守视为存活，拒绝回收
      }
      if (alive) throw conflictError('LOCK_BUSY', `另一操作进行中（${holder.op ?? '?'}，pid=${holder.pid}），拒绝并发执行`);
      try {
        fs.renameSync(file, `${file}.stale-${Date.now()}`); // 回收死锁，保留现场
      } catch (e4) {
        if (e4.code !== 'ENOENT') throw conflictError('LOCK_STEAL_FAILED', `死锁回收失败：${e4.message}`);
      }
      continue;
    }
    let wrote = false;
    try {
      const me = selfIdentityCapture();
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, creationFileTime: me.creationFileTime, op, at: new Date().toISOString() }) + '\n', 'utf8');
      wrote = true;
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      if (!wrote) {
        // 持有者信息未写入（如 pwsh 不可用）时必须删掉刚创建的空锁，
        // 否则残留空文件会让后续每次调用都报 LOCK_CORRUPT 而永久卡死该应用。
        try { fs.unlinkSync(file); } catch { /* 已被删/回收则忽略 */ }
      }
    }
    return () => {
      try { fs.unlinkSync(file); } catch { /* 已被回收则忽略 */ }
    };
  }
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

function withLock(home, name, op, fn) {
  const release = acquireLock(home, name, op);
  try {
    return fn();
  } finally {
    release();
  }
}

function lockHeld(home, name) {
  return fs.existsSync(lockPath(home, name));
}

// ---------- 应用解析与启动描述 ----------

function computeAppId(root, entry) {
  return 'a' + crypto.createHash('sha256').update(`${root.toLowerCase()}\u0000${entry.toLowerCase()}`).digest('hex').slice(0, 15);
}

function newRunId() {
  return `r${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function resolveAppId(reg, ref) {
  const s = String(ref);
  if (ID_RE.test(s) && reg.apps[s]) return s;
  const low = s.toLowerCase();
  for (const app of Object.values(reg.apps)) {
    if (app.alias.toLowerCase() === low) return app.appId;
  }
  throw notFoundError(`未找到应用：${ref}（可用 list 查看）`);
}

// 受管启动描述：完整校验（start-new）
function loadManagedDesc(file) {
  if (!file) throw usageError('start-new 需要 --desc <启动描述 JSON 文件>');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw usageError(`启动描述文件不可读：${e.message}`);
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw usageError(`启动描述 JSON 无效：${e.message}`);
  }
  if (!d || typeof d !== 'object') throw usageError('启动描述必须是 JSON 对象');
  const errs = [];
  if (!ALIAS_RE.test(d.alias ?? '')) errs.push(`alias 需匹配 ${ALIAS_RE}`);
  if (!d.root || !path.isAbsolute(d.root)) errs.push('root 必须是绝对路径');
  if (d.entry != null && !ENTRY_RE.test(d.entry)) errs.push(`entry 需匹配 ${ENTRY_RE}`);
  const hasExe = typeof d.exe === 'string' && d.exe;
  const hasCmd = typeof d.command === 'string' && d.command.trim();
  // 两种受管形态：exe+args（真实可执行进程）或 command+expectedImage（脚本/复合命令，wrapper+后代发现）
  if (!hasExe && !hasCmd) errs.push('exe 或 command 必填其一');
  if (hasExe && hasCmd) errs.push('exe 与 command 只能填一个（command 已是完整命令行）');
  if (hasCmd && d.command.length > 2000) errs.push('command 不超过 2000 字符');
  if (hasCmd && d.args != null) errs.push('command 模式不接受 args（参数写入 command 本身）');
  if (hasCmd && !IMAGE_NAME_RE.test(d.expectedImage ?? '')) errs.push('command 模式需要 expectedImage（目标进程映像基名，如 node.exe/java.exe）');
  if (hasExe && (d.expectedImage != null || d.discoverTimeoutMs != null)) errs.push('expectedImage/discoverTimeoutMs 仅 command 模式使用');
  if (d.discoverTimeoutMs != null && (!Number.isInteger(d.discoverTimeoutMs) || d.discoverTimeoutMs < 1000 || d.discoverTimeoutMs > 120000)) errs.push('discoverTimeoutMs 需为 1000-120000 整数');
  if (d.args != null && (!Array.isArray(d.args) || d.args.some((a) => typeof a !== 'string'))) errs.push('args 必须是字符串数组');
  if (d.envRefs != null && (!Array.isArray(d.envRefs) || d.envRefs.some((a) => typeof a !== 'string' || !ENV_NAME_RE.test(a)))) errs.push('envRefs 必须是合法环境变量名数组（仅名称，不含值）');
  if (d.mode != null && !MODES.has(d.mode)) errs.push(`mode 只能是 ${[...MODES].join(' 或 ')}`);
  if (d.expectedPort != null && !Number.isInteger(d.expectedPort)) errs.push('expectedPort 必须是整数');
  if (errs.length) throw usageError(`启动描述无效：${errs.join('；')}`);
  return {
    alias: d.alias,
    displayName: typeof d.displayName === 'string' && d.displayName ? d.displayName : d.alias,
    root: d.root,
    entry: d.entry ?? 'default',
    cwd: d.cwd ?? d.root,
    mode: d.mode ?? 'java',
    exe: d.exe ?? null,
    args: d.args ?? [],
    command: d.command ?? null,
    expectedImage: d.expectedImage ?? null,
    discoverTimeoutMs: d.discoverTimeoutMs ?? null,
    envRefs: d.envRefs ?? [],
    expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
    sourceFingerprint: typeof d.sourceFingerprint === 'string' ? d.sourceFingerprint : null,
  };
}

// 非受管登记描述：宽松校验（record-unmanaged）
function loadUnmanagedDesc(file) {
  if (!file) throw usageError('record-unmanaged 需要 --desc <描述 JSON 文件>');
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw usageError(`描述文件不可读或 JSON 无效：${e.message}`);
  }
  if (!d || typeof d !== 'object') throw usageError('描述必须是 JSON 对象');
  const errs = [];
  if (!ALIAS_RE.test(d.alias ?? '')) errs.push(`alias 需匹配 ${ALIAS_RE}`);
  if (!d.root || !path.isAbsolute(d.root)) errs.push('root 必须是绝对路径');
  if (errs.length) throw usageError(`描述无效：${errs.join('；')}`);
  return d;
}

function realpathOrConflict(label, p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    throw conflictError('CONFIG_INVALID', `${label} 不存在或不可解析：${p}（Skill 需重新分析该目标项目）`);
  }
}

// WindowsApps 应用执行别名：Node lstat 视为符号链接（AppX reparse point）。
// 未安装应用时是 0 字节 stub（运行即打开商店），已安装时也无法预先验证目标进程身份，
// 一律不作为受管 exe——真实解释器应来自安装目录或项目 venv。
function isAppExecAlias(file) {
  if (!/\\Microsoft\\WindowsApps\\/i.test(file)) return false;
  try {
    const st = fs.lstatSync(file);
    return st.size === 0 || st.isSymbolicLink();
  } catch {
    return false;
  }
}

// 校验解析出的候选可执行文件：返回 null 表示可用，否则为拒绝原因。
function exeRejection(resolved) {
  if (isAppExecAlias(resolved)) {
    return `WindowsApps 应用执行别名（reparse point，无法核验真实目标进程）`;
  }
  if (WRAPPER_EXT_RE.test(resolved)) {
    return `脚本包装（${path.extname(resolved)}），真实进程会变成其子进程：日志句柄不落地、终止目标错位`;
  }
  if (/javapath/i.test(resolved)) {
    return `Oracle javapath 转发 shim，其真实 JVM 为子进程：日志句柄不落地、终止会错位`;
  }
  if (!EXEC_EXT_RE.test(resolved)) {
    return `不是可直接启动的可执行文件（受管要求 .exe/.com）；请解析到底层真实进程`;
  }
  return null;
}

// where 的输出按系统 ANSI 代码页编码（中文 Windows 为 GBK）：UTF-8 解码失败回退 GBK，
// 避免非 ASCII 用户名路径乱码后把真实候选误判为不可用。
function decodeCmdOutput(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gbk').decode(buf); }
}

function resolveExe(exe, cwd) {
  if (/[\\/]/.test(exe)) {
    const abs = path.isAbsolute(exe) ? exe : path.resolve(cwd, exe);
    const rejected = [];
    for (const cand of [abs, `${abs}.exe`]) {
      if (!fs.existsSync(cand)) continue;
      const resolved = path.resolve(cand);
      const why = exeRejection(resolved);
      if (!why) return resolved;
      rejected.push(`${resolved}（${why}）`);
    }
    if (rejected.length) {
      throw conflictError('CONFIG_INVALID', `exe 不可用：${rejected.join('；')}。请改用真实可执行文件路径`);
    }
    throw conflictError('CONFIG_INVALID', `exe 不存在：${exe}（Skill 需重新分析该目标项目）`);
  }
  // 裸名 java/javac 优先用 JAVA_HOME 下真实 JDK，绕开 Oracle javapath 转发 shim：
  // shim 会把真实 JVM 拉成子进程，导致重定向句柄不落地、终止目标错位。
  if (/^java(c)?$/i.test(exe) && process.env.JAVA_HOME) {
    const jh = path.join(process.env.JAVA_HOME, 'bin', `${exe}.exe`);
    if (fs.existsSync(jh)) return path.resolve(jh);
  }
  const r = spawnSync('where', [exe], { encoding: 'buffer', windowsHide: true, timeout: 10000 });
  if (r.error) return exe; // 无法定位 where 时按原值交给 spawn
  if (r.status !== 0) throw conflictError('CONFIG_INVALID', `exe 不在 PATH 中：${exe}（Skill 需重新分析该目标项目）`);
  const candidates = decodeCmdOutput(r.stdout).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // 按 where 顺序逐个校验：跳过 stub/脚本包装/非 exe，取第一个真实可执行文件；
  // 全部不可用时报告候选清单与原因，不静默选一个包装进程冒充受管目标。
  const rejected = [];
  for (const cand of candidates) {
    const resolved = path.resolve(cand);
    const why = exeRejection(resolved);
    if (!why) return resolved;
    rejected.push(`${resolved}（${why}）`);
  }
  throw conflictError('CONFIG_INVALID',
    `exe ${exe} 的 PATH 候选均不可作为受管目标：${rejected.join('；')}。请提供真实可执行文件路径（如真实 python.exe/node.exe）后重试`);
}

function canonicalizeDesc(desc) {
  const root = realpathOrConflict('root', desc.root);
  const cwd = realpathOrConflict('cwd', desc.cwd);
  // 命令模式不解析 exe——cmd wrapper 与真实目标进程都在 launchManaged 内确认
  const exe = desc.command ? null : resolveExe(desc.exe, cwd);
  return { ...desc, root, cwd, exe };
}

function upsertApp(reg, appId, desc) {
  for (const app of Object.values(reg.apps)) {
    if (app.appId !== appId && app.alias.toLowerCase() === desc.alias.toLowerCase()) {
      throw conflictError('ALIAS_TAKEN', `别名 ${desc.alias} 已被 ${app.displayName ?? app.alias}（${app.appId}）使用`);
    }
  }
  const now = new Date().toISOString();
  const existing = reg.apps[appId];
  if (existing) {
    existing.alias = desc.alias;
    existing.displayName = desc.displayName;
    existing.root = desc.root;
    existing.entry = desc.entry;
    existing.cwd = desc.cwd;
    existing.mode = desc.mode;
    existing.exe = desc.exe;
    existing.args = desc.args;
    existing.command = desc.command ?? null;
    existing.expectedImage = desc.expectedImage ?? null;
    existing.discoverTimeoutMs = desc.discoverTimeoutMs ?? null;
    existing.envRefs = desc.envRefs;
    existing.expectedPort = desc.expectedPort ?? null;
    existing.sourceFingerprint = desc.sourceFingerprint ?? null;
    existing.configRevision = (existing.configRevision ?? 1) + 1;
    existing.updatedAt = now;
    return existing;
  }
  const app = {
    appId, alias: desc.alias, displayName: desc.displayName, root: desc.root, entry: desc.entry,
    cwd: desc.cwd, mode: desc.mode, exe: desc.exe, args: desc.args,
    command: desc.command ?? null, expectedImage: desc.expectedImage ?? null,
    discoverTimeoutMs: desc.discoverTimeoutMs ?? null, envRefs: desc.envRefs,
    expectedPort: desc.expectedPort ?? null, sourceFingerprint: desc.sourceFingerprint ?? null,
    configRevision: 1, createdAt: now, updatedAt: now,
  };
  reg.apps[appId] = app;
  return app;
}

// ---------- 受管启动（意图先行 → detached 启动 → 身份采集 → 登记） ----------

// 命令模式的顶层 wrapper：cmd.exe 是真实 exe，同样走候选校验保证不被 shim 冒充
function resolveComspec(cwd) {
  return resolveExe(process.env.ComSpec || 'cmd.exe', cwd);
}

// 目标进程终止后尽力清理仍存活的 cmd wrapper（多数会随子进程退出自然消亡）。
// wrapper 身份在启动时已采集，同句柄核验+终止，失败仅作留证不影响主结果。
function cleanupWrapper(rt) {
  const cur = rt.current;
  if (!cur?.wrapperPid || !cur.wrapperCreationFileTime || !cur.wrapperImage) return;
  try {
    psProc('terminate', { id: cur.wrapperPid, creationFileTime: cur.wrapperCreationFileTime, image: cur.wrapperImage });
  } catch { /* best-effort */ }
}

function launchManaged(home, appId, app, opts = {}) {
  const runId = newRunId();
  const logDir = path.join(home, 'logs', appId);
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, `${runId}.stdout.log`);
  const errPath = path.join(logDir, `${runId}.stderr.log`);
  const rt = readRuntimeStrict(home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
  if (opts.abandonRunId && rt.current && rt.current.runId === opts.abandonRunId
      && rt.current.managed !== false && isUnresolvedPhase(rt.current.phase)) {
    archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 显式 ack 的未结旧账：保留证据并注明原因
  } else {
    archiveCurrent(rt); // 旧运行证据归档保留，绝不删账
  }

  const isCommand = !!app.command;
  rt.current = {
    runId, phase: 'STARTING', managed: true, mode: app.mode,
    kind: isCommand ? 'command' : 'direct',
    intentAt: new Date().toISOString(), startedAt: null,
    pid: null, creationFileTime: null, image: null,
    wrapperPid: null, wrapperCreationFileTime: null, wrapperImage: null,
    envResolved: app.envRefs.filter((n) => n in process.env),
    logPaths: { stdout: outPath, stderr: errPath },
    lastError: null, endedAt: null, exitNote: null,
  };
  writeRuntime(home, appId, rt);

  const failUnresolved = (code, message, detail) => {
    writeRuntime(home, appId, rt);
    const stderrTail = readStderrTailSafe(rt.current.logPaths.stderr);
    throw conflictError(code, message, { runId, logPaths: rt.current.logPaths, ...detail, stderrTail });
  };

  let child;
  let outFd;
  let errFd;
  let spawnError = null;
  try {
    outFd = fs.openSync(outPath, 'a');
    errFd = fs.openSync(errPath, 'a');
    // 命令模式：拉起 cmd wrapper 执行完整命令行；真实目标进程稍后按后代发现确定。
    // 注意 wrapper 不能 detach——Windows 下 detached(无控制台) wrapper 的后代进程
    // stdout 句柄全部失效（实测 echo/node/ping 写入丢失），必须共享父进程控制台。
    // Windows 父退出不杀子进程，wrapper/目标仍会存活；代价是交互终端启动时
    // 共享其控制台（典型 agent 管道调用下 manager 本无控制台，不受影响）。
    const file = isCommand ? resolveComspec(app.cwd) : app.exe;
    const argv = isCommand ? ['/d', '/s', '/c', app.command] : app.args;
    child = spawn(file, argv, {
      cwd: app.cwd, detached: !isCommand, windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env },
    });
    // spawn 的异步 error（EACCES 等）必须有监听，否则会以未捕获事件终止 manager；
    // 具体失败仍由下方身份采集/发现路径统一落账并保留证据
    child.on('error', (err) => { spawnError = err.message; });
    child.unref();
  } catch (e) {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `spawn_failed: ${e.message}`;
    failUnresolved('SPAWN_FAILED', `进程启动失败；意图与证据已保留（runId=${runId}），拒绝自动重试`, { cause: e.message });
  } finally {
    try { if (outFd != null) fs.closeSync(outFd); } catch { /* 忽略 */ }
    try { if (errFd != null) fs.closeSync(errFd); } catch { /* 忽略 */ }
  }

  rt.current.startedAt = new Date().toISOString();
  if (isCommand) {
    rt.current.wrapperPid = child.pid;
  } else {
    rt.current.pid = child.pid;
  }

  let cap;
  try {
    cap = psProc('capture', { id: child.pid });
  } catch (e) {
    cap = { result: 'error', message: e.message };
  }

  if (!isCommand) {
    if (cap.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.creationFileTime = cap.creationFileTime;
      rt.current.image = cap.image;
      writeRuntime(home, appId, rt);
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed: ${JSON.stringify(cap)}${spawnError ? `; spawn_error: ${spawnError}` : ''}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已拉起（pid=${child.pid}）但身份采集失败，标记 UNKNOWN；证据保留，拒绝自动重试`, { pid: child.pid, capture: cap });
  }

  // ---- 命令模式：wrapper 身份留证，随后在后代中发现唯一真实目标 ----
  if (cap.result === 'ok') {
    rt.current.wrapperCreationFileTime = cap.creationFileTime;
    rt.current.wrapperImage = cap.image;
  }

  const waitMs = app.discoverTimeoutMs ?? COMMAND_DISCOVER_TIMEOUT_MS;
  let d;
  try {
    d = psProc('discover', { id: child.pid, image: app.expectedImage, waitMs });
  } catch (e) {
    d = { result: 'error', code: 'discover_failed', message: e.message };
  }

  if (d.result === 'found' && d.candidates.length === 1) {
    let t;
    try {
      t = psProc('capture', { id: d.candidates[0].pid });
    } catch (e) {
      t = { result: 'error', message: e.message };
    }
    if (t.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.pid = d.candidates[0].pid;
      rt.current.creationFileTime = t.creationFileTime;
      rt.current.image = t.image;
      writeRuntime(home, appId, rt);
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed(target=${d.candidates[0].pid}): ${JSON.stringify(t)}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已发现目标进程（pid=${d.candidates[0].pid}）但身份采集失败，标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { pid: d.candidates[0].pid, wrapperPid: child.pid, capture: t });
  }

  if (d.result === 'found') {
    // 歧义即拒绝：候选清单留证，wrapper 仍在运行由人工决定处置
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_ambiguous: ${JSON.stringify(d.candidates)}`;
    failUnresolved('DISCOVERY_AMBIGUOUS', `wrapper(pid=${child.pid}) 后代中匹配 ${app.expectedImage} 的进程有 ${d.candidates.length} 个，拒绝任选一个；wrapper 仍在运行，证据已保留`, { wrapperPid: child.pid, expectedImage: app.expectedImage, candidates: d.candidates });
  }

  if (d.result === 'wrapperExited') {
    // wrapper 死了且无目标：命令大概率失败——没有存活进程，落 STOPPED 可直接重试
    rt.current.phase = 'STOPPED';
    rt.current.endedAt = new Date().toISOString();
    rt.current.exitNote = `command wrapper(pid=${child.pid}) 已退出且未发现匹配 ${app.expectedImage} 的目标进程`;
    failUnresolved('SPAWN_FAILED', `命令已退出且未发现目标进程（expectedImage=${app.expectedImage}，详见 stderr 日志）`, { wrapperPid: child.pid });
  }

  if (d.result === 'timeout') {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_timeout: ${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代（wrapper pid=${child.pid}）`;
    failUnresolved('DISCOVERY_TIMEOUT', `${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代进程；wrapper(pid=${child.pid}) 可能仍在启动中，证据保留，拒绝自动重试`, { wrapperPid: child.pid, expectedImage: app.expectedImage });
  }

  rt.current.phase = 'UNKNOWN';
  rt.current.lastError = `discovery_failed: ${JSON.stringify(d)}${spawnError ? `; spawn_error: ${spawnError}` : ''}`;
  failUnresolved('DISCOVERY_FAILED', `后代发现失败（${d.code ?? d.result}），标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { wrapperPid: child.pid, detail: d });
}

function writeRuntime(home, appId, rt) {
  atomicWriteJson(runtimePath(home, appId), rt);
}

// ---------- 状态计算（只读 + 就地标记；落账由 statusWithFacts 在锁内完成） ----------

function computeStatus(home, appId, rt) {
  if (!rt || !rt.current) return { status: 'UNKNOWN', note: '无当前运行记录' };
  const cur = rt.current;
  if (!cur.managed) {
    return { status: 'UNKNOWN', managed: false, runId: cur.runId, note: '非受管记录：仅记录启动尝试与日志线索，不提供生命周期控制' };
  }
  if (cur.phase === 'STARTING') {
    if (lockHeld(home, appId)) return { status: 'STARTING', managed: true, runId: cur.runId };
    return { status: 'UNKNOWN', managed: true, runId: cur.runId, note: `启动中断（intentAt=${cur.intentAt}）；证据保留，不会自动重试` };
  }
  if (cur.phase === 'STOPPED') {
    return { status: 'STOPPED', managed: true, runId: cur.runId, note: cur.exitNote ?? null };
  }
  if (cur.phase === 'UNKNOWN') {
    return { status: 'UNKNOWN', managed: true, runId: cur.runId, note: cur.lastError ?? '状态未知' };
  }
  if (cur.phase === 'RUNNING') {
    const v = verifyRun(cur);
    if (v.alive) return { status: 'RUNNING', managed: true, runId: cur.runId, pid: cur.pid };
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = v.reason === 'pidReused' ? '进程退出后 PID 被复用（未触碰新进程）' : '进程已退出';
    return { status: 'STOPPED', managed: true, runId: cur.runId, pid: cur.pid, note: cur.exitNote, writeback: true };
  }
  return { status: 'UNKNOWN', managed: true, runId: cur.runId, note: `未知 phase=${cur.phase}` };
}

// 查询即核验，并按 OS 事实落账；落账在应用锁内二次确认同一 runId 后写入，
// 避免与并发启动/停止对运行记录的写入互相覆盖。
function statusWithFacts(home, appId) {
  const rt = readRuntimeStrict(home, appId);
  const st = computeStatus(home, appId, rt);
  if (st.writeback && rt && rt.current) {
    const marked = { endedAt: rt.current.endedAt, exitNote: rt.current.exitNote, runId: rt.current.runId };
    try {
      withLock(home, appId, 'status-refresh', () => {
        const rt2 = readRuntimeStrict(home, appId);
        if (rt2 && rt2.current && rt2.current.runId === marked.runId && rt2.current.phase === 'RUNNING') {
          rt2.current.phase = 'STOPPED';
          rt2.current.endedAt = marked.endedAt;
          rt2.current.exitNote = marked.exitNote;
          writeRuntime(home, appId, rt2);
        }
      });
    } catch {
      // 锁忙或锁损坏：跳过落账，查询结果照常返回（不阻塞只读命令）
    }
  }
  return { rt, st };
}

// ---------- 命令实现 ----------

function cmdStartNew(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const desc = canonicalizeDesc(loadManagedDesc(opts.get('--desc')));
  const appId = computeAppId(desc.root, desc.entry);
  return withLock(ctx.home, appId, 'start-new', () => {
    const reg = readRegistry(ctx.home);
    // 已有受管实例在运行则拒绝（并发/重复启动只允许一份实例）
    const rt = readRuntimeStrict(ctx.home, appId);
    if (rt && rt.current && rt.current.managed && rt.current.phase === 'RUNNING') {
      const v = verifyRun(rt.current); // 核验失败抛 IDENTITY_UNKNOWN → 拒绝继续，不会重复起
      if (v.alive) {
        throw conflictError('ALREADY_RUNNING', `${desc.alias} 已有受管实例在运行`, { runId: rt.current.runId, pid: rt.current.pid });
      }
    }
    // STARTING/UNKNOWN 未结记录默认拒绝；显式 ack 且复核通过后才归档旧账并继续
    const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
    const portEvidence = portConflict(desc.expectedPort, opts.has('--force'));
    const app = upsertApp(reg, appId, desc);
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind,
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      ...(cur.wrapperPid ? { wrapperPid: cur.wrapperPid } : {}),
      readinessUntested: true, logPaths: cur.logPaths,
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '进程存活不等于业务就绪；就绪与 JRebel/热加载验证按 SKILL 规程另行执行',
    };
  });
}

function cmdRecordUnmanaged(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--log-hints': 'multi' });
  const d = loadUnmanagedDesc(opts.get('--desc'));
  const root = realpathOrConflict('root', d.root);
  const entry = ENTRY_RE.test(d.entry ?? '') ? d.entry : 'default';
  const appId = computeAppId(root, entry);
  const logHints = (opts.getAll('--log-hints') ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  return withLock(ctx.home, appId, 'record-unmanaged', () => {
    const reg = readRegistry(ctx.home);
    for (const app of Object.values(reg.apps)) {
      if (app.appId !== appId && app.alias.toLowerCase() === String(d.alias).toLowerCase()) {
        throw conflictError('ALIAS_TAKEN', `别名 ${d.alias} 已被 ${app.displayName ?? app.alias}（${app.appId}）使用`);
      }
    }
    const now = new Date().toISOString();
    if (reg.apps[appId]) {
      const app = reg.apps[appId];
      app.alias = d.alias;
      app.displayName = d.displayName ?? d.alias;
      app.updatedAt = now;
    } else {
      reg.apps[appId] = {
        appId, alias: d.alias, displayName: d.displayName ?? d.alias, root, entry,
        cwd: d.cwd ? realpathOrConflict('cwd', d.cwd) : root, mode: MODES.has(d.mode) ? d.mode : 'java',
        exe: null, args: [], command: null, expectedImage: null, discoverTimeoutMs: null,
        envRefs: [], expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
        sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now,
      };
    }
    atomicWriteJson(registryPath(ctx.home), reg);
    const rt = readRuntimeStrict(ctx.home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
    archiveCurrent(rt);
    rt.current = {
      runId: newRunId(), phase: 'UNKNOWN', managed: false, mode: reg.apps[appId].mode,
      intentAt: now, startedAt: now, pid: null, creationFileTime: null, image: null,
      envResolved: [], logPaths: null, logHints,
      lastError: null, endedAt: null,
      note: 'Skill 在既有授权下执行的启动，未托管目标进程；仅记录尝试与日志线索',
    };
    writeRuntime(ctx.home, appId, rt);
    return {
      appId, alias: reg.apps[appId].alias, runId: rt.current.runId,
      managed: false, status: 'UNKNOWN', logHints,
      note: '非受管登记不提供 RUNNING/STOPPED 断言与跨会话启停；日志线索仅原路径关联',
    };
  });
}

function cmdPort(ctx, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError('port 需要 1-65535 的整数');
  return { port, occupants: portOccupants(port), note: '外部进程仅诊断，不接管、不停止' };
}

function cmdDoctor(ctx) {
  const home = ctx.home;
  const reg = readRegistry(home);
  const runtimes = [];
  const runtimeDir = path.join(home, 'runtime');
  if (fs.existsSync(runtimeDir)) for (const name of fs.readdirSync(runtimeDir)) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}\.json$/.test(name)) continue;
    const appId = name.slice(0, -5);
    const rt = readRuntimeStrict(home, appId);
    const logChecks = [];
    for (const run of [rt?.current, ...(rt?.prevRuns ?? [])].filter(Boolean)) {
      if (!run.runId || !run.managed) continue;
      const paths = run.logPaths ?? { stdout: path.join(home, 'logs', appId, `${run.runId}.stdout.log`), stderr: path.join(home, 'logs', appId, `${run.runId}.stderr.log`) };
      for (const stream of ['stdout', 'stderr']) logChecks.push({ runId: run.runId, stream, exists: !!paths[stream] && fs.existsSync(paths[stream]) });
    }
    runtimes.push({ appId, schemaVersion: rt.schemaVersion, prevRuns: rt.prevRuns?.length ?? 0, logs: logChecks });
  }
  const locksDir = path.join(home, 'locks');
  const locks = fs.existsSync(locksDir) ? fs.readdirSync(locksDir).filter((n) => n.endsWith('.lock')) : [];
  const tempFiles = [];
  const scanTemps = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, name.name);
      if (name.name.startsWith('.tmp-')) tempFiles.push(file);
      else if (name.isDirectory()) scanTemps(file, depth + 1);
    }
  };
  for (const dir of [home, runtimeDir, path.join(home, 'logs'), locksDir]) scanTemps(dir);
  const pw = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const homeWritable = (() => { try { fs.accessSync(home, fs.constants.W_OK); return true; } catch { return false; } })();
  const portSummary = Object.values(reg.apps).filter((a) => Number.isInteger(a.expectedPort)).map((a) => ({ alias: a.alias, port: a.expectedPort, listening: tcpListening(a.expectedPort) }));
  return Promise.all(portSummary.map(async (p) => ({ ...p, listening: await p.listening }))).then((ports) => ({
    nodeVersion: process.version, pwshVersion: !pw.error && pw.status === 0 ? pw.stdout.trim() : null,
    home, homeWritable, registrySchemaVersion: reg.schemaVersion, runtime: runtimes, locks, orphanTmpFiles: tempFiles, portSummary: ports,
    note: '只读诊断；locks 项仅列出，不回收；端口监听不代表业务就绪',
  }));
}

function cmdList(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps);
  const rows = apps.map((app) => {
    let rt;
    let st;
    try {
      ({ rt, st } = statusWithFacts(ctx.home, app.appId));
    } catch (e) {
      return { alias: app.alias, appId: app.appId, mode: app.mode, status: 'UNKNOWN', managed: null, error: `${e.code}: ${e.message}`, root: app.root };
    }
    return {
      alias: app.alias, appId: app.appId, mode: app.mode,
      status: st.status, managed: st.managed ?? (rt?.current?.managed ?? null),
      pid: st.status === 'RUNNING' ? (st.pid ?? rt?.current?.pid) : null,
      expectedPort: app.expectedPort, lastRunId: rt?.current?.runId ?? rt?.prevRuns?.[0]?.runId ?? null,
      log: rt?.current?.logPaths?.stdout ?? null, root: app.root,
    };
  });
  if (!apps.length) return { apps: [], note: '注册表为空：尚无由本 Skill 启动并记录的应用' };
  return { apps: rows };
}

function tcpListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(700);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function extractJrebelEvidence(home, appId, cur) {
  const files = ['stdout', 'stderr'].map((stream) => cur.logPaths?.[stream]).filter((file) => file && fs.existsSync(file));
  if (!files.length) return { available: false, note: '当前批次日志不存在；日志证据，不是热加载成功证明' };
  const read = files.map((file) => ({ file, ...readTailLines(file, MAX_LOG_LINES) }));
  const lines = read.flatMap((r) => r.lines).slice(-MAX_LOG_LINES);
  const matching = (re) => lines.filter((line) => re.test(line));
  return {
    available: true, files: read.map((r) => r.file), truncated: read.some((r) => r.truncated),
    banner: matching(/JRebel:/i), licenseErrors: matching(/(?:license|licence).*(?:error|invalid|expired|fail)|(?:error|invalid|expired|fail).*license/i),
    reloadingClassCount: matching(/Reloading class/i).length,
    reloadingSqlMapsCount: matching(/Reloading SQL maps/i).length,
    note: '仅引用当前批次日志原文；banner 不代表许可有效，日志证据不是热加载成功证明',
  };
}

async function cmdStatus(ctx, ref, probeRequested = false) {
  if (!ref) throw usageError('status 需要 <alias|appId>');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const { rt, st } = statusWithFacts(ctx.home, appId);
  const cur = rt && rt.current;
  const evidenceFile = runtimePath(ctx.home, appId);
  const portListening = probeRequested && Number.isInteger(app.expectedPort) ? await tcpListening(app.expectedPort) : null;
  const jrebelEvidence = cur?.mode === 'jrebel' ? extractJrebelEvidence(ctx.home, appId, cur) : null;
  return {
    alias: app.alias, appId, entry: app.entry, mode: app.mode, root: app.root,
    status: st.status, managed: st.managed ?? false,
    pid: st.pid ?? cur?.pid ?? null,
    runtimeFile: evidenceFile,
    expectedPort: app.expectedPort,
    portNote: probeRequested ? '端口监听仅为 TCP 证据；监听 ≠ 业务就绪' : '使用 --probe 执行本机 TCP 监听探测',
    ...(probeRequested ? { portListening } : {}),
    ...(jrebelEvidence ? { jrebelEvidence } : {}),
    run: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, mode: cur.mode,
      kind: cur.kind ?? 'direct', wrapperPid: cur.wrapperPid ?? null,
      intentAt: cur.intentAt ?? null, startedAt: cur.startedAt ?? cur.intentAt,
      endedAt: cur.endedAt, pid: cur.pid ?? null,
      creationFileTime: cur.creationFileTime ?? null, image: cur.image ?? null,
      envResolved: cur.envResolved ?? [],
      logPaths: cur.logPaths, logHints: cur.logHints ?? null,
      lastError: cur.lastError, exitNote: cur.exitNote ?? null,
      evidenceFile,
    } : null,
    readinessUntested: st.status === 'RUNNING',
    note: st.note ?? null,
    prevRuns: (rt?.prevRuns ?? []).slice(0, 5),
  };
}

// 公开 start：已登记应用复用保存的配置，从任意目录启动
function cmdStart(ctx, ref) {
  if (!ref) throw usageError('start 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'start', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app.exe && !app.command) {
      throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置；需 Skill 重新分析该项目并走 start-new`);
    }
    // 结构性检查：路径/产物失效只报该应用，不做全盘扫描（AC02）
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (rt && rt.current && rt.current.managed && rt.current.phase === 'RUNNING') {
      const v = verifyRun(rt.current);
      if (v.alive) throw conflictError('ALREADY_RUNNING', `${app.alias} 已有受管实例在运行`, { runId: rt.current.runId, pid: rt.current.pid });
    }
    // STARTING/UNKNOWN 未结记录默认拒绝；显式 ack 且复核通过后才归档旧账并继续
    const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'));
    app.cwd = cwd;
    app.exe = exe;
    app.updatedAt = new Date().toISOString();
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind, source: 'saved-config',
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      readinessUntested: true, logPaths: cur.logPaths,
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '复用已保存启动配置；进程存活不等于业务就绪',
    };
  });
}

// 停止核心逻辑：返回 {result: stopped|alreadyStopped} 或抛错；调用方负责落账
function stopCurrent(home, appId, app, rt) {
  const cur = rt.current;
  if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供停止`);
  if (cur.phase === 'STARTING') throw conflictError('IDENTITY_UNKNOWN', `启动阶段记录（runId=${cur.runId}），身份未采集完成，拒绝停止；证据已保留`);
  if (cur.phase === 'UNKNOWN') throw conflictError('IDENTITY_UNKNOWN', `状态 UNKNOWN（${cur.lastError ?? '原因不明'}），拒绝停止；人工核验后可重新 start`);
  if (cur.phase === 'STOPPED') return { result: 'alreadyStopped', runId: cur.runId };
  const t = psProc('terminate', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
  if (t.result === 'terminated') {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = 'terminated(137) 有界强制停止；不保证优雅关机';
    cleanupWrapper(rt); // 命令模式：目标死后尽力清理残留 cmd wrapper
    writeRuntime(home, appId, rt);
    return { result: 'stopped', runId: cur.runId, pid: cur.pid };
  }
  if (t.result === 'exited' || t.result === 'notfound') {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程已自行退出';
    cleanupWrapper(rt);
    writeRuntime(home, appId, rt);
    return { result: 'alreadyStopped', runId: cur.runId };
  }
  if (t.result === 'mismatch') {
    // 记录的实例已退出，该 PID 现属其他进程：不触碰，落账退出
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程退出后 PID 被复用；未触碰新进程';
    cleanupWrapper(rt);
    writeRuntime(home, appId, rt);
    return { result: 'alreadyStopped', runId: cur.runId, note: '原实例已退出，PID 已被其他进程复用，未触碰新进程' };
  }
  if (t.result === 'terminateTimeout') {
    cur.phase = 'UNKNOWN';
    cur.lastError = 'terminate_timeout';
    writeRuntime(home, appId, rt);
    throw conflictError('TERMINATE_TIMEOUT', `终止已发出但等待 ${TERMINATE_WAIT_MS}ms 未确认退出，标记 UNKNOWN，不自动重试`, { runId: cur.runId, pid: cur.pid });
  }
  cur.phase = 'UNKNOWN';
  cur.lastError = `terminate_failed: ${JSON.stringify(t)}`;
  writeRuntime(home, appId, rt);
  throw conflictError('IDENTITY_UNKNOWN', `终止失败（${t.code ?? t.result}），标记 UNKNOWN，拒绝进一步操作`, { runId: cur.runId, detail: t });
}

function cmdStop(ctx, ref) {
  if (!ref) throw usageError('stop 需要 <alias|appId>');
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'stop', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    return { appId, alias: app.alias, ...stopCurrent(ctx.home, appId, app, rt) };
  });
}

function cmdRestart(ctx, ref) {
  if (!ref) throw usageError('restart 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'restart', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app.exe && !app.command) throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置`);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'), rt.current.pid);
    const stopResult = stopCurrent(ctx.home, appId, app, rt); // 必须确认退出才继续；抛错则中止，绝不先起后停
    app.cwd = cwd;
    app.exe = exe;
    app.updatedAt = new Date().toISOString();
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app);
    return {
      appId, alias: app.alias, stop: stopResult,
      start: { runId: cur.runId, pid: cur.pid, status: 'RUNNING', readinessUntested: true, logPaths: cur.logPaths, ...(portEvidence ? { portEvidence } : {}) },
      note: '已确认旧实例退出后启动新实例；进程存活不等于业务就绪',
    };
  });
}

// 移除注册表条目；运行记录与日志证据一律保留。仅允许无存活受管实例时移除：
// RUNNING 核验存活一律拒绝（CONFLICT）；STARTING/UNKNOWN 未结记录按既有 ack 流程（核验已退出才可放弃）。
function cmdRemove(ctx, ref) {
  if (!ref) throw usageError('remove 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'remove', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app) throw notFoundError(`未找到应用：${ref}（可用 list 查看）`);
    const rt = readRuntimeStrict(ctx.home, appId);
    let abandonedRunId = null;
    if (rt && rt.current && rt.current.managed) {
      const st = computeStatus(ctx.home, appId, rt);
      if (st.writeback && rt.current) writeRuntime(ctx.home, appId, rt); // RUNNING→STOPPED 按 OS 事实落账（已在应用锁内）
      if (st.status === 'RUNNING') {
        throw conflictError('INSTANCE_RUNNING',
          `${app.alias} 有受管实例在运行（pid=${st.pid ?? rt.current.pid}），拒绝移除；先 stop 确认退出后再 remove`,
          { runId: rt.current.runId, pid: st.pid ?? rt.current.pid });
      }
      if (st.status !== 'STOPPED') {
        // STARTING/UNKNOWN/无法识别的 phase：未结记录，默认拒绝；显式 ack 且复核通过才归档旧账
        const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
        if (abandon) {
          archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 完整身份与日志证据保留在 prevRuns 并注明原因
          writeRuntime(ctx.home, appId, rt);
          abandonedRunId = abandon.runId;
        }
      }
    }
    delete reg.apps[appId];
    atomicWriteJson(registryPath(ctx.home), reg);
    return {
      appId, alias: app.alias, removed: true,
      runtimeFile: runtimePath(ctx.home, appId),
      logsDir: path.join(ctx.home, 'logs', appId),
      ...(abandonedRunId ? { abandonedRunId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '注册表条目已移除；运行记录与日志证据保留。超保留期历史批次日志可用 prune 回收',
    };
  });
}

// ---------- prune：回收三类残留（默认 dry-run，--apply 才真正删除） ----------
// 1) logs/<appId>/ 超保留期历史批次日志：保留 current + prevRuns（≤PREV_RUNS_KEEP）引用的 runId，其余回收；
//    逐应用在应用锁内判定，避免与并发启动/停止竞争（锁忙/损坏/缺 pwsh 时跳过该应用并注明）。
// 2) locks/*.lock.stale-* 死锁回收残留。
// 3) 数据目录内 .tmp-<pid>-<hex> 原子写孤儿临时文件（近期修改的可能是进行中的原子写，跳过）。
// 边界：绝不删 current 运行日志与 runtime/registry 证据；不跟随符号链接、不触碰 home 之外的文件；
// 运行记录损坏按 DATA_* 契约整体拒绝（无法判定保留范围时绝不删任何文件）。

const STALE_LOCK_RE = /^[A-Za-z0-9._-]+\.lock\.stale-\d+$/;
const TMP_ORPHAN_RE = /^\.tmp-\d+-[0-9a-f]+$/;
const RUN_LOG_FILE_RE = /^([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)\.log$/;
const TMP_ORPHAN_RECENT_MS = 60 * 1000;

const fileSizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// 只收集 home 内的普通文件；不跟随任何符号链接，绝不触碰 home 之外的文件
function walkHomeFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) out.push(p);
    }
  };
  visit(root);
  return out;
}

function planPrune(home) {
  const plan = { logs: [], staleLocks: [], tmpOrphans: [], skipped: [] };
  const logsDir = path.join(home, 'logs');
  for (const appId of fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []) {
    const dir = path.join(logsDir, appId);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!ID_RE.test(appId)) {
      plan.skipped.push({ kind: 'logs', target: dir, reason: '目录名不是合法 appId，跳过' });
      continue;
    }
    if (!fs.existsSync(runtimePath(home, appId))) {
      plan.skipped.push({ kind: 'logs', target: dir, reason: '无运行记录可判定保留范围，跳过' });
      continue;
    }
    try {
      withLock(home, appId, 'prune', () => {
        const rt = readRuntimeStrict(home, appId); // 损坏/不兼容 → DATA_* 向上抛，prune 整体拒绝
        const retain = new Set((rt?.prevRuns ?? []).map((p) => p.runId));
        if (rt?.current?.runId) retain.add(rt.current.runId);
        const files = [];
        for (const name of fs.readdirSync(dir)) {
          const m = RUN_LOG_FILE_RE.exec(name);
          if (!m || retain.has(m[1])) continue;
          const file = path.join(dir, name);
          files.push({ runId: m[1], stream: m[2], file, size: fileSizeOf(file) });
        }
        if (files.length) plan.logs.push({ appId, files });
      });
    } catch (e) {
      // 锁忙/锁损坏/缺 pwsh：只跳过该应用的日志回收，不阻塞其余残留清理
      if (e instanceof ManagerError && ['LOCK_BUSY', 'LOCK_CORRUPT', 'PWSH_MISSING'].includes(e.code)) {
        plan.skipped.push({ kind: 'logs', target: dir, reason: `${e.code}: ${e.message}` });
        continue;
      }
      throw e;
    }
  }
  const locksDir = path.join(home, 'locks');
  for (const name of fs.existsSync(locksDir) ? fs.readdirSync(locksDir) : []) {
    if (!STALE_LOCK_RE.test(name)) continue;
    const file = path.join(locksDir, name);
    plan.staleLocks.push({ file, size: fileSizeOf(file) });
  }
  const recentCutoff = Date.now() - TMP_ORPHAN_RECENT_MS;
  for (const file of walkHomeFiles(home)) {
    if (!TMP_ORPHAN_RE.test(path.basename(file))) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= recentCutoff) {
      plan.skipped.push({ kind: 'tmp', target: file, reason: '近期修改，可能是进行中的原子写，跳过' });
      continue;
    }
    plan.tmpOrphans.push({ file, size: fileSizeOf(file) });
  }
  return plan;
}

function applyPrune(plan) {
  const apply = (items, kind) => {
    const removed = [];
    for (const item of items) {
      try {
        fs.unlinkSync(item.file);
        removed.push(item);
      } catch (e) {
        if (e.code === 'ENOENT') plan.skipped.push({ kind, target: item.file, reason: '删除时已不存在（可能已被并发操作清理）' });
        else throw dataError('DATA_UNWRITABLE', `回收失败（${item.file}）：${e.message}`);
      }
    }
    return removed;
  };
  for (const app of plan.logs) app.files = apply(app.files, 'logs');
  plan.logs = plan.logs.filter((a) => a.files.length);
  plan.staleLocks = apply(plan.staleLocks, 'locks');
  plan.tmpOrphans = apply(plan.tmpOrphans, 'tmp');
}

function cmdPrune(ctx) {
  const opts = parseNamed(ctx.rest, { '--dry-run': 'flag', '--apply': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  if (opts.has('--dry-run') && opts.has('--apply')) throw usageError('--dry-run 与 --apply 不能同时使用');
  const dryRun = !opts.has('--apply'); // 默认 dry-run：只打印将删内容，--apply 才真正删除
  const plan = planPrune(ctx.home);
  if (!dryRun) applyPrune(plan);
  const all = [...plan.logs.flatMap((a) => a.files), ...plan.staleLocks, ...plan.tmpOrphans];
  return {
    dryRun,
    logs: plan.logs,
    staleLocks: plan.staleLocks,
    tmpOrphans: plan.tmpOrphans,
    skipped: plan.skipped,
    summary: { files: all.length, bytes: all.reduce((n, f) => n + (f.size ?? 0), 0) },
    note: dryRun ? '默认 dry-run：未删除任何文件；确认后加 --apply 执行删除' : '已删除以上文件；current 运行日志与 runtime/registry 证据一律保留',
  };
}

function readTailLines(file, n, maxBytes = MAX_LOG_BYTES) {
  const want = Math.min(Math.max(1, n), MAX_LOG_LINES);
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('gbk').decode(buf); }
  let all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  const lines = all.slice(-want);
  return { lines, truncated: start > 0 || all.length > want, skippedBytes: start };
}

function readStderrTailSafe(file) {
  try {
    return readTailLines(file, 20, 4 * 1024).lines.join('\n');
  } catch {
    return '';
  }
}

// 解析 logs 与 ui 共用的日志目标：校验应用、runId 归属与流名，返回绝对路径（不读内容）
function resolveLogFile(home, ref, run, stream = 'stdout') {
  if (!ref) throw usageError('需要 <alias|appId>');
  if (!['stdout', 'stderr'].includes(stream)) throw usageError('--stream 只能是 stdout 或 stderr');
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const rt = readRuntimeStrict(home, appId);
  const cur = rt && rt.current;
  const prev = rt && rt.prevRuns ? rt.prevRuns.find((p) => p.runId === run) : null;
  const runId = run ?? cur?.runId ?? null;
  // 非受管记录没有批次日志（设计边界：只记录日志线索，不接管日志）；报错要说清去哪找，不伪装成日志丢失
  if (!run && cur && !cur.managed) {
    const hints = (cur.logHints ?? []).filter((h) => typeof h === 'string' && h);
    throw notFoundError(`${app.alias} 为非受管记录，不提供批次日志${hints.length ? `；日志线索：${hints.join(', ')}` : ''}（可用 logs ${ref} --src hint:N 读取线索，或在 manager ui 的日志源中选择）`);
  }
  if (prev && !prev.managed) {
    throw notFoundError(`runId=${runId} 为非受管记录，无批次日志；请按项目脚本输出路径或在 manager ui 的日志源中选择`);
  }
  if (!runId) throw notFoundError(`${app.alias} 无运行批次`);
  if (!ID_RE.test(runId)) throw usageError(`runId 非法：${runId}`);
  if (run && runId !== cur?.runId && !prev) {
    throw notFoundError(`runId=${runId} 不在 ${app.alias} 的运行记录中`);
  }
  return { appId, alias: app.alias, runId, stream, file: path.join(home, 'logs', appId, `${runId}.${stream}.log`) };
}

// 运行批次列表（ui 日志选择器用）：当前批次 + prevRuns 全量
function listRuns(home, ref) {
  if (!ref) throw usageError('需要 <alias|appId>');
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const rt = readRuntimeStrict(home, appId);
  const cur = rt && rt.current;
  return {
    appId, alias: reg.apps[appId].alias,
    current: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed,
      logPaths: cur.logPaths ?? null, logHints: cur.logHints ?? null,
    } : null,
    prevRuns: (rt?.prevRuns ?? []).map((p) => ({
      runId: p.runId, phase: p.phase, managed: p.managed ?? null,
      endedAt: p.endedAt ?? null, archivedAt: p.archivedAt ?? null, archiveReason: p.archiveReason ?? null,
    })),
  };
}

// ---------- ui 统一日志源与项目文件浏览（只读，替代原单项 viewer） ----------
// 日志源三类：受管批次 logs/<appId>/<runId>.<stream>.log、非受管登记的 logHints、
// 应用 root/.tmp 下 jrebel-local-*/runner-local-* 兼容扫描。文件树/预览限定在应用 root 内。

// 兼容两类约定名：jrebel-local-*（Java/JRebel 时代沿用）与 runner-local-*（非 Java 项目脚本日志）
const TMP_NAME_RE = /^(?:jrebel|runner)-local-[^/\\]+\.(stdout|stderr)\.log$/;
const UI_FILE_CHUNK = 256 * 1024;
const uiBlocked = (name) => /^(\.git|node_modules|\.env.*|jrebel\.properties)$/i.test(name)
  || /\.(pem|key|p12|pfx|lic|keystore|jks)$/i.test(name)
  || /^(id_rsa|id_ed25519|credentials)(\..*)?$/i.test(name);
const uiFail = (status, message) => Object.assign(new Error(message), { status });
const uiInside = (base, file) => {
  const rel = path.relative(base, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};

// 相对路径、无穿越、逐段非符号链接、realpath 仍在 base 内
function uiResolveFile(base, rel = '') {
  if (rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel)
    || rel.split('/').some((p) => p === '..' || uiBlocked(p))) throw uiFail(403, '此路径不允许访问');
  const candidate = path.resolve(base, rel);
  if (!uiInside(base, candidate)) throw uiFail(403, '此路径不允许访问');
  let walk = base;
  for (const part of rel.split('/').filter(Boolean)) {
    walk = path.join(walk, part);
    if (fs.lstatSync(walk).isSymbolicLink()) throw uiFail(403, '不支持浏览符号链接');
  }
  const real = fs.realpathSync(candidate);
  if (!uiInside(base, real)) throw uiFail(403, '此路径不允许访问');
  return real;
}

function appRootOf(home, ref) {
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  try {
    return { appId, app, root: fs.realpathSync.native(app.root) };
  } catch {
    throw notFoundError(`${app.alias} 的项目目录不存在或不可访问：${app.root}`);
  }
}

// 统一日志源列表：src 为不透明定位符（run:/hint:/tmp:），tail 时回传并重新校验
function listSources(home, ref) {
  if (!ref) throw usageError('需要 <alias|appId>');
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const rt = readRuntimeStrict(home, appId);
  const curRunId = rt?.current?.runId ?? null;
  const sources = [];
  const seen = new Set();
  const push = (s, file) => {
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return;
      const stat = fs.statSync(real);
      if (!stat.isFile()) return;
      seen.add(real);
      sources.push({ ...s, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    } catch { /* 文件可能刚被清理或不可读，跳过 */ }
  };
  const runDir = path.join(home, 'logs', appId);
  if (fs.existsSync(runDir)) {
    for (const name of fs.readdirSync(runDir)) {
      const m = /^([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)\.log$/.exec(name);
      if (!m) continue;
      push({ src: `run:${m[1]}.${m[2]}`, kind: 'run', label: `${m[1]} · ${m[2]}`, current: m[1] === curRunId, stream: m[2] }, path.join(runDir, name));
    }
  }
  (rt?.current?.logHints ?? []).forEach((hint, i) => {
    if (typeof hint !== 'string' || !path.isAbsolute(hint)) return;
    push({ src: `hint:${i}`, kind: 'hint', label: `线索 · ${path.basename(hint)}`, current: true, stream: null }, hint);
  });
  try {
    const tmpDir = uiResolveFile(app.root, '.tmp');
    if (fs.statSync(tmpDir).isDirectory()) {
      for (const name of fs.readdirSync(tmpDir)) {
        if (!TMP_NAME_RE.test(name)) continue;
        push({ src: `tmp:${name}`, kind: 'tmp', label: name.replace(/^(?:jrebel|runner)-local-/, '').replace(/\.log$/, ''), current: false, stream: name.endsWith('.stdout.log') ? 'stdout' : 'stderr' }, path.join(tmpDir, name));
      }
    }
  } catch { /* .tmp 缺失或为符号链接：无兼容日志 */ }
  // 默认排序：当前运行 stdout > 当前运行其余 > 历史源按 mtime
  const rank = (s) => (s.current ? (s.stream === 'stderr' ? 1 : 0) : 2);
  sources.sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs || Number(b.stream === 'stdout') - Number(a.stream === 'stdout'));
  return { appId, alias: app.alias, sources };
}

function resolveSource(home, ref, src) {
  if (!ref) throw usageError('需要 <alias|appId>');
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const rt = readRuntimeStrict(home, appId);
  if (typeof src !== 'string' || src.length > 200) throw usageError('日志源标识无效');
  let m;
  if ((m = /^run:([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)$/.exec(src))) {
    return { appId, alias: app.alias, runId: m[1], stream: m[2], file: uiResolveFile(path.join(home, 'logs', appId), `${m[1]}.${m[2]}.log`) };
  }
  if ((m = /^hint:(\d{1,3})$/.exec(src))) {
    const hint = (rt?.current?.logHints ?? [])[Number(m[1])];
    if (typeof hint !== 'string' || !path.isAbsolute(hint)) throw notFoundError('日志线索不存在');
    const real = fs.realpathSync(hint);
    if (!fs.statSync(real).isFile()) throw notFoundError('日志线索不存在');
    return { appId, alias: app.alias, runId: null, stream: null, file: real };
  }
  if ((m = /^tmp:(.+)$/.exec(src)) && TMP_NAME_RE.test(m[1])) {
    return { appId, alias: app.alias, runId: null, stream: m[1].endsWith('.stdout.log') ? 'stdout' : 'stderr', file: uiResolveFile(app.root, `.tmp/${m[1]}`) };
  }
  throw usageError('日志源标识无效');
}

function listTree(home, ref, rel = '') {
  const { app, root } = appRootOf(home, ref);
  const dir = uiResolveFile(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw uiFail(400, '不是目录');
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (uiBlocked(item.name) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
    entries.push({ name: item.name, path: path.posix.join(rel, item.name), directory: item.isDirectory() });
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { alias: app.alias, root, path: rel, entries };
}

function readProjectFile(home, ref, rel = '', offset = 0) {
  const { root } = appRootOf(home, ref);
  const file = uiResolveFile(root, rel);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw uiFail(400, '不是普通文件');
  offset = Number(offset);
  if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  offset = Math.min(offset, Math.max(0, stat.size - 1));
  const chunk = Math.min(Math.max(0, stat.size - offset), UI_FILE_CHUNK);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(chunk);
    const read = fs.readSync(fd, buf, 0, chunk, offset);
    buf = buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
  let text = null;
  try {
    if (buf.includes(0)) throw new Error('binary');
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: stat.size > buf.length });
    if (/[\x01-\x08\x0e-\x1f]/.test(text)) text = null;
  } catch { text = null; }
  return { path: rel, size: stat.size, offset, nextOffset: offset + buf.length, hasMore: offset + buf.length < stat.size, binary: text === null, text };
}

function cmdLogs(ctx, ref) {
  if (!ref) throw usageError('logs 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag', '--src': 'value', '--list-sources': 'flag' });
  const lines = opts.has('--lines') ? Number.parseInt(opts.get('--lines'), 10) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');

  // 统一日志源列表：与 ui 的日志源选择器同一数据（run:批次 / hint:非受管线索 / tmp:.tmp 兼容日志）
  if (opts.has('--list-sources')) {
    if (opts.has('--src') || opts.has('--run') || opts.has('--stream') || opts.has('--follow')) {
      throw usageError('--list-sources 只列出日志源，不能与 --src/--run/--stream/--follow 同时使用');
    }
    return { ...listSources(ctx.home, ref), note: '用 logs <alias|appId> --src <src> 读取对应日志源（可配合 --lines/--follow）' };
  }

  // 统一日志源读取：复用 ui 的 resolveSource，--src 已完整定位文件，与 --run/--stream 互斥
  const src = opts.get('--src');
  if (src != null) {
    if (opts.has('--run') || opts.has('--stream')) throw usageError('--src 已指定日志源，不能与 --run/--stream 同时使用');
    const t = resolveSource(ctx.home, ref, src);
    if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（src=${src}）`);
    if (opts.has('--follow')) {
      if (ctx.json) throw usageError('--follow 与 --json 不兼容');
      const reg = readRegistry(ctx.home);
      const rt = readRuntimeStrict(ctx.home, t.appId);
      // hint/tmp 源没有受管身份，followLogs 会提示无法自动结束，直到 Ctrl+C
      followLogs(ctx, t.appId, reg.apps[t.appId], rt, t.runId, t.stream, t.file, lines);
      return { following: true };
    }
    const r = readTailLines(t.file, lines);
    return { appId: t.appId, alias: t.alias, src, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
  }

  const stream = opts.get('--stream') ?? 'stdout';
  if (!['stdout', 'stderr', 'both'].includes(stream)) throw usageError('--stream 只能是 stdout、stderr 或 both');
  // 双流合并：复用 stdout 路径的校验（应用/runId 归属/非受管拒绝），stderr 按同批次路径派生
  if (stream === 'both') {
    if (opts.has('--follow')) throw usageError('--stream both 不支持 --follow；请选择单一数据流跟随');
    const t = resolveLogFile(ctx.home, ref, opts.get('--run'), 'stdout');
    const files = { stdout: t.file, stderr: path.join(path.dirname(t.file), `${t.runId}.stderr.log`) };
    const has = { stdout: fs.existsSync(files.stdout), stderr: fs.existsSync(files.stderr) };
    if (!has.stdout && !has.stderr) throw notFoundError(`日志不存在（runId=${t.runId}, stream=stdout/stderr）`);
    const parts = {};
    for (const s of ['stdout', 'stderr']) if (has[s]) parts[s] = readTailLines(files[s], lines);
    return {
      appId: t.appId, alias: t.alias, runId: t.runId, stream: 'both',
      lines: mergeStreamTails(parts.stdout?.lines ?? [], parts.stderr?.lines ?? []),
      truncated: { stdout: parts.stdout?.truncated ?? false, stderr: parts.stderr?.truncated ?? false },
      skippedBytes: { stdout: parts.stdout?.skippedBytes ?? 0, stderr: parts.stderr?.skippedBytes ?? 0 },
      files,
      missingStreams: Object.keys(has).filter((s) => !has[s]),
    };
  }
  const t = resolveLogFile(ctx.home, ref, opts.get('--run'), stream);
  if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（runId=${t.runId}, stream=${t.stream}）`);
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    const reg = readRegistry(ctx.home);
    const rt = readRuntimeStrict(ctx.home, t.appId);
    followLogs(ctx, t.appId, reg.apps[t.appId], rt, t.runId, t.stream, t.file, lines);
    return { following: true };
  }
  const r = readTailLines(t.file, lines);
  return { appId: t.appId, alias: t.alias, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
}

// 双流合并：批次日志没有统一时间戳，按各自行在尾部中的相对位置比例交替归并；
// 只保证各流内顺序稳定、整体确定性（相同输入必得相同输出），不冒充精确时间序
function mergeStreamTails(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && (i + 1) / a.length <= (j + 1) / b.length)) out.push({ stream: 'stdout', line: a[i++] });
    else out.push({ stream: 'stderr', line: b[j++] });
  }
  return out;
}

function followLogs(ctx, appId, app, rt, runId, stream, file, initialLines) {
  const cur = rt && rt.current;
  process.on('SIGINT', () => {
    process.stderr.write('\n[已中止 follow]\n');
    process.exit(0);
  });
  const managedWithIdentity = !!(cur && cur.managed && cur.pid != null && cur.creationFileTime && cur.image && cur.runId === runId);
  if (!managedWithIdentity) {
    process.stderr.write(`[非受管或身份未知批次，无法自动结束；Ctrl+C 中止]\n`);
  }
  const first = readTailLines(file, initialLines);
  for (const l of first.lines) process.stdout.write(`${l}\n`);
  let pos = fs.statSync(file).size;
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let encoding = 'utf-8';
  let lastIdentityCheck = 0;
  const tick = setInterval(() => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 文件暂时不可读，下一轮再试
    }
    if (size > pos) {
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size - pos, MAX_LOG_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        try { process.stdout.write(decoder.decode(buf, { stream: true })); }
        catch { encoding = 'gbk'; decoder = new TextDecoder('gbk'); process.stdout.write(decoder.decode(buf)); }
      } finally {
        fs.closeSync(fd);
      }
      pos += Math.min(size - pos, MAX_LOG_BYTES);
    }
    if (!managedWithIdentity || Date.now() - lastIdentityCheck < 2000) return;
    lastIdentityCheck = Date.now();
    // 核验异常时保守继续 follow（Ctrl+C 可中止）
    try {
      const v = verifyRun(cur);
      if (!v.alive) {
        try {
          const s2 = fs.statSync(file).size;
          if (s2 > pos) {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(s2 - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            fs.closeSync(fd);
            try { process.stdout.write(decoder.decode(buf, { stream: true })); }
            catch { encoding = 'gbk'; decoder = new TextDecoder('gbk'); process.stdout.write(decoder.decode(buf)); }
            pos = s2;
          }
        } catch { /* 忽略 */ }
        clearInterval(tick);
        process.stderr.write(`\n[进程已退出，follow 结束]\n`);
        process.exit(0);
      }
    } catch { /* 核验失败：继续跟随 */ }
  }, 500);
}

// ---------- 本地只读 Web 管理台（ui，design.md §2.2 / AC08） ----------

// 固定端口 8199 的占用探测：ui 对所有请求（含 /）都要求令牌，未带令牌时返回
// 本工具固定形状的 403 JSON，可据此区分"已有 ui 实例"与"被其他程序占用"
function probeManagerUi(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(!!(j && j.schemaVersion === SCHEMA_VERSION && j.ok === false && j.error?.code === 'FORBIDDEN'));
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function cmdUi(ctx) {
  const opts = parseNamed(ctx.rest, { '--port': 'value', '--open': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  let port = 8199; // 固定端口契约；--port 0 使用随机端口
  if (opts.has('--port')) {
    port = Number.parseInt(opts.get('--port'), 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw usageError('--port 需要 0-65535 的整数（0 为随机端口）');
  }
  const { startUiServer } = await import('./manager-ui/server.mjs');
  try {
    await startUiServer({
      home: ctx.home,
      port,
      open: opts.has('--open'), // 默认不开浏览器：Agent 前台拉起场景不期望弹窗
      api: {
        list: () => cmdList(ctx),
        status: (ref) => cmdStatus(ctx, ref).then((data) => { delete data.portListening; delete data.portNote; return data; }),
        listRuns: (ref) => listRuns(ctx.home, ref),
        resolveLogFile: (ref, run, stream) => resolveLogFile(ctx.home, ref, run, stream),
        listSources: (ref) => listSources(ctx.home, ref),
        resolveSource: (ref, src) => resolveSource(ctx.home, ref, src),
        listTree: (ref, p) => listTree(ctx.home, ref, p),
        readFile: (ref, p, offset) => readProjectFile(ctx.home, ref, p, offset),
      },
    });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const ours = await probeManagerUi(port);
    throw conflictError('PORT_IN_USE', ours
      ? `端口 ${port} 已有 manager ui 实例在运行：请使用该实例启动终端打印的带令牌 URL（令牌每次启动不同），或 --port <N> 换端口`
      : `端口 ${port} 被其他程序占用：用 --port <N> 换端口（--port 0 为随机端口）`);
  }
}

// ---------- 简单选项解析 ----------

function parseNamed(args, spec) {
  const single = new Map();
  const multi = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const kind = spec[a];
    if (kind === 'flag') {
      flags.add(a);
    } else if (kind === 'value') {
      const v = args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      single.set(a, v);
    } else if (kind === 'multi') {
      const v = args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      multi.set(a, [...(multi.get(a) ?? []), v]);
    } else if (a.startsWith('--')) {
      throw usageError(`未知选项：${a}`);
    } else {
      positional.push(a);
    }
  }
  return {
    get: (k) => single.get(k) ?? multi.get(k)?.[0],
    getAll: (k) => multi.get(k) ?? (single.has(k) ? [single.get(k)] : []),
    has: (k) => single.has(k) || multi.has(k) || flags.has(k),
    positional,
  };
}

// ---------- 输出 ----------

function emitOk(ctx, command, data) {
  if (data && data.following) return; // follow 模式由自身控制生命周期
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, command, data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(command, data)}\n`);
  }
  process.exit(EXIT.OK);
}

function emitErr(ctx, command, e) {
  if (ctx.json) {
    const err = { code: e.code ?? 'UNKNOWN', message: e.message };
    if (e.detail !== undefined) err.detail = e.detail;
    process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, command, error: err }, null, 2)}\n`);
  } else {
    let text = `错误[${e.code ?? 'UNKNOWN'}] ${e.message}`;
    if (e.detail) {
      text += `\n详情: ${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}`;
      if (typeof e.detail.stderrTail === 'string' && e.detail.stderrTail) text += `\nstderr 尾部:\n${e.detail.stderrTail}`;
    }
    process.stderr.write(`${text}\n`);
  }
  process.exit(e.exitCode ?? 1);
}

function renderHuman(command, data) {
  switch (command) {
    case 'list': {
      if (!data.apps?.length) return data.note ?? '（空）';
      const head = 'alias'.padEnd(14) + 'mode'.padEnd(8) + 'status'.padEnd(10) + 'managed'.padEnd(9) + 'pid'.padEnd(8) + 'lastRunId';
      const rows = data.apps.map((a) =>
        String(a.alias).padEnd(14) + String(a.mode ?? '').padEnd(8) + String(a.status).padEnd(10)
        + String(a.managed ?? '?').padEnd(9) + String(a.pid ?? '-').padEnd(8) + String(a.lastRunId ?? '-')
        + (a.error ? `\n  ! ${a.error}` : ''));
      return [head, ...rows].join('\n');
    }
    case 'port':
      return [`端口 ${data.port}`, ...data.occupants.map((p) => `PID=${p.pid} process=${p.processName ?? '-'} path=${p.executablePath ?? '-'} started=${p.startedAt ?? '-'} identity=${p.identity?.result ?? 'unknown'}`), data.note].join('\n');
    case 'doctor':
      return JSON.stringify(data, null, 2);
    case 'status':
      return [
        `${data.alias} (${data.appId}) mode=${data.mode} status=${data.status} managed=${data.managed}${data.pid ? ` pid=${data.pid}` : ''}`,
        data.run ? `run=${data.run.runId} phase=${data.run.phase} managed=${data.run.managed} started=${data.run.startedAt ?? '-'}` : 'run=无',
        data.run?.pid != null ? `pid=${data.run.pid}${data.run.creationFileTime ? ` creationFileTime=${data.run.creationFileTime}` : ''}${data.run.image ? ` image=${data.run.image}` : ''}` : null,
        data.run?.lastError ? `lastError: ${data.run.lastError}` : null,
        data.run?.logPaths?.stdout ? `stdout=${data.run.logPaths.stdout}` : null,
        data.run?.logPaths?.stderr ? `stderr=${data.run.logPaths.stderr}` : null,
        data.run?.logHints?.length ? `logHints=${data.run.logHints.join(', ')}` : null,
        data.portListening !== undefined ? `portListening=${data.portListening}（监听 ≠ 业务就绪）` : null,
        data.jrebelEvidence ? `jrebelEvidence=${JSON.stringify(data.jrebelEvidence)}` : null,
        data.runtimeFile ? `证据: ${data.runtimeFile}` : null,
        ...(data.prevRuns ?? []).map((p) => `prev=${p.runId} phase=${p.phase}${p.archiveReason ? ` archiveReason=${p.archiveReason}` : ''}${p.pid != null ? ` pid=${p.pid}` : ''} archivedAt=${p.archivedAt}`),
        data.readinessUntested ? '就绪未检测：进程存活不等于业务就绪' : null,
        data.note ? `note: ${data.note}` : null,
      ].filter(Boolean).join('\n');
    case 'start-new':
    case 'start':
      return [
        `已启动（受管）${data.alias} (${data.appId})`,
        `run=${data.runId} pid=${data.pid} status=${data.status}`,
        data.portEvidence?.forced ? data.portEvidence.note : null,
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `stdout=${data.logPaths.stdout}`,
        `stderr=${data.logPaths.stderr}`,
        data.portEvidence?.forced ? data.portEvidence.note : null,
        data.note ?? '',
        '观察：manager ui 可在浏览器只读查看全部受管应用与日志（Ctrl+C 退出）',
      ].filter(Boolean).join('\n');
    case 'record-unmanaged':
      return [
        `已记录非受管启动 ${data.alias} (${data.appId}) run=${data.runId}`,
        data.logHints?.length ? `日志线索: ${data.logHints.join(', ')}` : null,
        '观察：非受管日志在项目 .tmp 下，可在 manager ui 的日志源中选择查看',
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'stop':
      return `stop ${data.alias}: ${data.result}${data.runId ? ` (run=${data.runId})` : ''}${data.note ? `；${data.note}` : ''}`;
    case 'remove':
      return [
        `已移除登记 ${data.alias} (${data.appId})`,
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `运行记录保留: ${data.runtimeFile}`,
        `日志目录保留: ${data.logsDir}`,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'prune': {
      const lines = [data.dryRun
        ? 'prune 预览（默认 dry-run，未删除任何文件；确认后加 --apply 执行）'
        : 'prune 完成，已删除以下文件'];
      let any = false;
      for (const a of data.logs) for (const f of a.files) { any = true; lines.push(`- [超保留期批次日志] ${f.file}（${f.size} 字节，run=${f.runId}.${f.stream}，appId=${a.appId}）`); }
      for (const f of data.staleLocks) { any = true; lines.push(`- [死锁残留] ${f.file}（${f.size} 字节）`); }
      for (const f of data.tmpOrphans) { any = true; lines.push(`- [孤儿临时文件] ${f.file}（${f.size} 字节）`); }
      for (const s of data.skipped) lines.push(`  跳过 ${s.target}：${s.reason}`);
      if (!any) lines.push(data.dryRun ? '无可回收残留' : '无文件被删除');
      lines.push(`共 ${data.summary.files} 个文件 / ${data.summary.bytes} 字节${data.dryRun ? '可回收' : '已删除'}`);
      return lines.join('\n');
    }
    case 'restart':
      return [
        `restart ${data.alias}: stop=${data.stop.result} → start run=${data.start.runId} pid=${data.start.pid} status=${data.start.status}`,
        `stdout=${data.start.logPaths.stdout}`,
        data.start.portEvidence?.forced ? data.start.portEvidence.note : null,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'logs': {
      if (data.sources) {
        return [
          `${data.alias} (${data.appId}) 的日志源（* 为当前运行）：`,
          ...data.sources.map((s) => `${s.current ? '*' : ' '} ${s.src}  ${s.kind}${s.stream ? `/${s.stream}` : ''}  ${s.size} 字节  ${s.label}`),
          data.note ?? null,
        ].filter(Boolean).join('\n');
      }
      if (data.stream === 'both') {
        const body = data.lines.map((l) => `[${l.stream}] ${l.line}`).join('\n');
        return data.missingStreams?.length ? `${body}${body ? '\n' : ''}（无 ${data.missingStreams.join('/')} 日志文件）` : body;
      }
      return data.lines.join('\n');
    }
    default:
      return JSON.stringify(data, null, 2);
  }
}

function usageText() {
  return [
    '用法：node manager.mjs [--home <绝对路径>] [--json] <命令> [参数]',
    '',
    '命令：',
    '  list                              列出已登记应用与实时状态',
    '  status <alias|appId> [--probe]    单应用详情；--probe 检测本机 TCP 监听',
    '  port <N>                           只读端口占用诊断（外部进程不接管、不停止）',
    '  doctor [--json]                    只读自检（不修复）',
    '  start <alias|appId> [--force] [--ack-unresolved <runId>] 用已保存配置启动（任意目录可用）',
    '  stop <alias|appId>                有界强制停止（仅受管实例）',
    '  restart <alias|appId> [--force]   确认退出后重启（仅受管实例）',
    '  logs <alias|appId> [--lines N] [--stream stdout|stderr|both] [--run <runId>] [--follow]',
    '       [--src <run:…|hint:N|tmp:…>] [--list-sources]    统一日志源（--src 与 --run/--stream 互斥；both 合并双流）',
    '  remove <alias|appId> [--ack-unresolved <runId>]   移除登记：须无存活受管实例；运行记录与日志证据保留',
    '  prune [--dry-run] [--apply]                       回收超保留期批次日志/死锁残留/孤儿临时文件（默认 dry-run）',
    '  ui [--port N] [--open]              本地只读 Web 管理台（默认固定 127.0.0.1:8199 + 一次性令牌；--open 监听成功后用默认浏览器打开带令牌 URL，失败仅打印地址；Ctrl+C 退出）',
    '',
    '内部入口（Skill 调用，不对用户暴露注册 CRUD）：',
    '  start-new --desc <file> [--ack-unresolved <runId>]   首次受管启动：意图→启动→身份采集→登记',
    '  record-unmanaged --desc <file> [--log-hints p1,p2]   记录非受管启动尝试',
    '',
    '启动描述 mode 取值：java | jrebel | python | node | proc（其他真实可执行进程）。',
    '受管目标两种形态（desc 二选一）：',
    '  exe+args                 真实可执行文件（.exe/.com）；.cmd/.bat/.ps1 包装与',
    '                           WindowsApps 应用执行别名会被拒绝',
    '  command+expectedImage    脚本/复合命令（npm run dev、mvn spring-boot:run 等）；',
    '                           manager 拉起 cmd wrapper 后在后代中按映像基名发现',
    '                           唯一真实目标并托管；多个匹配拒绝任选（discoverTimeoutMs 可调）',
    '',
    'STARTING/UNKNOWN 未结记录默认拒绝启动或移除（UNRESOLVED_RUN）；人工核验进程已退出后，',
    '用 --ack-unresolved <runId> 显式放弃旧账：start <ref> --ack-unresolved <runId> 重启，或 remove <ref> --ack-unresolved <runId> 移除登记',
    '',
    '退出码：0 成功 | 1 用法 | 2 未找到 | 3 状态冲突 | 4 环境依赖 | 5 数据损坏',
  ].join('\n');
}

// ---------- 供 manager-ui 复用的只读数据层 ----------

export { resolveHome, cmdList, cmdStatus, listRuns, resolveLogFile, listSources, resolveSource };

// ---------- 入口 ----------

async function main() {
  let ctx;
  let command;
  try {
    ctx = parseArgv(process.argv.slice(2));
    command = ctx.command;
    ctx.home = resolveHome(ctx.home, ['doctor', 'port', 'status'].includes(command));
  } catch (e) {
    const c = command ?? 'cli';
    if (e instanceof ManagerError) emitErr({ json: false }, c, e);
    throw e;
  }
  try {
    let data;
    const refCommands = new Set(['status', 'stop', 'restart']);
    if (command === 'start' || command === 'remove') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError(`${command} 需要 <alias|appId>`);
    } else if (refCommands.has(command)) {
      const bad = command === 'status' ? ctx.rest.slice(1).find((a) => a !== '--probe') : ctx.rest.find((a, i) => i > 0 || a.startsWith('--'));
      if (bad !== undefined && bad !== null) throw usageError(`无法识别的参数：${bad}`);
      if (!ctx.rest[0]) throw usageError(`${command} 需要 <alias|appId>`);
    }
    switch (command) {
      case 'list': data = cmdList(ctx); break;
      case 'status': data = await cmdStatus(ctx, ctx.rest[0], ctx.rest.includes('--probe')); break;
      case 'port': data = cmdPort(ctx, ctx.rest[0]); break;
      case 'doctor': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = await cmdDoctor(ctx); break;
      case 'start': data = cmdStart(ctx, ctx.rest[0]); break;
      case 'stop': data = cmdStop(ctx, ctx.rest[0]); break;
      case 'restart': data = cmdRestart(ctx, ctx.rest[0]); break;
      case 'remove': data = cmdRemove(ctx, ctx.rest[0]); break;
      case 'prune': data = cmdPrune(ctx); break;
      case 'logs': data = cmdLogs(ctx, ctx.rest[0]); break;
      case 'start-new': data = cmdStartNew(ctx); break;
      case 'record-unmanaged': data = cmdRecordUnmanaged(ctx); break;
      case 'ui': await cmdUi(ctx); return; // 前台常驻直到 Ctrl+C，不走 emitOk
      default: throw usageError(`未知命令：${command}\n${usageText()}`);
    }
    emitOk(ctx, command, data);
  } catch (e) {
    if (e instanceof ManagerError) emitErr(ctx, command, e);
    process.stderr.write(`内部错误：${e.stack}\n`);
    process.exit(5);
  }
}

// 仅在直接执行时进入 CLI；被其他模块 import（如 ui 服务或测试）时不运行 main
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
