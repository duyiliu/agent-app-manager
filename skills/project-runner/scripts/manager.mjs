#!/usr/bin/env node
// project-runner 跨项目管理器（P0）
// 设计基线：docs/design.md v2。要点：
// - 只管理本 Skill 启动并记录的 Java 应用；外部进程绝不接管或终止。
// - 受管启停依赖 ps/proc.ps1 的"同句柄身份核验 + 终止"，防 PID 复用误杀。
// - 启动前先持久化意图（runId/STARTING），中断保留证据并拒绝自动重试。
// - 数据目录 ~/.project-runner/（或 --home 绝对路径）；注册表/运行记录带 schemaVersion，
//   损坏或不兼容版本拒绝覆盖并保留原件；写入均为临时文件 + 原子替换。
// - stdout 只输出管理结果，不混入被启动应用的日志（--follow 是用户显式要求的例外）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

function resolveHome(argHome) {
  const raw = argHome || path.join(os.homedir(), '.project-runner');
  if (!path.isAbsolute(raw)) throw usageError(`--home 需要绝对路径：${raw}`);
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
  if (action === 'terminate') args.push('-WaitMs', String(params.waitMs ?? TERMINATE_WAIT_MS));
  const r = spawnSync('pwsh', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
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
      runId: cur.runId, phase: cur.phase, managed: cur.managed,
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
  if (!d.exe || typeof d.exe !== 'string') errs.push('exe 必填');
  if (d.args != null && (!Array.isArray(d.args) || d.args.some((a) => typeof a !== 'string'))) errs.push('args 必须是字符串数组');
  if (d.envRefs != null && (!Array.isArray(d.envRefs) || d.envRefs.some((a) => typeof a !== 'string' || !ENV_NAME_RE.test(a)))) errs.push('envRefs 必须是合法环境变量名数组（仅名称，不含值）');
  if (d.mode != null && !['java', 'jrebel'].includes(d.mode)) errs.push('mode 只能是 java 或 jrebel');
  if (d.expectedPort != null && !Number.isInteger(d.expectedPort)) errs.push('expectedPort 必须是整数');
  if (errs.length) throw usageError(`启动描述无效：${errs.join('；')}`);
  return {
    alias: d.alias,
    displayName: typeof d.displayName === 'string' && d.displayName ? d.displayName : d.alias,
    root: d.root,
    entry: d.entry ?? 'default',
    cwd: d.cwd ?? d.root,
    mode: d.mode ?? 'java',
    exe: d.exe,
    args: d.args ?? [],
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

function resolveExe(exe, cwd) {
  if (/[\\/]/.test(exe)) {
    const abs = path.isAbsolute(exe) ? exe : path.resolve(cwd, exe);
    for (const cand of [abs, `${abs}.exe`]) {
      if (fs.existsSync(cand)) return path.resolve(cand);
    }
    throw conflictError('CONFIG_INVALID', `exe 不存在：${exe}（Skill 需重新分析该目标项目）`);
  }
  // 裸名 java/javac 优先用 JAVA_HOME 下真实 JDK，绕开 Oracle javapath 转发 shim：
  // shim 会把真实 JVM 拉成子进程，导致重定向句柄不落地、终止目标错位。
  if (process.env.JAVA_HOME) {
    const jh = path.join(process.env.JAVA_HOME, 'bin', `${exe}.exe`);
    if (fs.existsSync(jh)) return path.resolve(jh);
  }
  const r = spawnSync('where', [exe], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error) return exe; // 无法定位 where 时按原值交给 spawn
  if (r.status !== 0) throw conflictError('CONFIG_INVALID', `exe 不在 PATH 中：${exe}（Skill 需重新分析该目标项目）`);
  const first = r.stdout.trim().split(/\r?\n/)[0];
  const resolved = first ? path.resolve(first) : exe;
  if (/javapath/i.test(resolved)) {
    throw conflictError('CONFIG_INVALID', `exe 解析到 Oracle javapath 转发 shim（${resolved}），其真实 JVM 为子进程：日志句柄不落地、终止会错位。请提供真实 JDK bin 路径（如 %JAVA_HOME%\\bin\\java.exe）后重试`);
  }
  return resolved;
}

function canonicalizeDesc(desc) {
  const root = realpathOrConflict('root', desc.root);
  const cwd = realpathOrConflict('cwd', desc.cwd);
  const exe = resolveExe(desc.exe, cwd);
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
    existing.envRefs = desc.envRefs;
    existing.expectedPort = desc.expectedPort ?? null;
    existing.sourceFingerprint = desc.sourceFingerprint ?? null;
    existing.configRevision = (existing.configRevision ?? 1) + 1;
    existing.updatedAt = now;
    return existing;
  }
  const app = {
    appId, alias: desc.alias, displayName: desc.displayName, root: desc.root, entry: desc.entry,
    cwd: desc.cwd, mode: desc.mode, exe: desc.exe, args: desc.args, envRefs: desc.envRefs,
    expectedPort: desc.expectedPort ?? null, sourceFingerprint: desc.sourceFingerprint ?? null,
    configRevision: 1, createdAt: now, updatedAt: now,
  };
  reg.apps[appId] = app;
  return app;
}

// ---------- 受管启动（意图先行 → detached 启动 → 身份采集 → 登记） ----------

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

  rt.current = {
    runId, phase: 'STARTING', managed: true, mode: app.mode,
    intentAt: new Date().toISOString(), startedAt: null,
    pid: null, creationFileTime: null, image: null,
    envResolved: app.envRefs.filter((n) => n in process.env),
    logPaths: { stdout: outPath, stderr: errPath },
    lastError: null, endedAt: null, exitNote: null,
  };
  writeRuntime(home, appId, rt);

  let child;
  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(outPath, 'a');
    errFd = fs.openSync(errPath, 'a');
    child = spawn(app.exe, app.args, {
      cwd: app.cwd, detached: true, windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env },
    });
    child.unref();
  } catch (e) {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `spawn_failed: ${e.message}`;
    writeRuntime(home, appId, rt);
    throw conflictError('SPAWN_FAILED', `JVM 启动失败；意图与证据已保留（runId=${runId}），拒绝自动重试`, { runId, logPaths: rt.current.logPaths, cause: e.message });
  } finally {
    try { if (outFd != null) fs.closeSync(outFd); } catch { /* 忽略 */ }
    try { if (errFd != null) fs.closeSync(errFd); } catch { /* 忽略 */ }
  }

  rt.current.startedAt = new Date().toISOString();
  rt.current.pid = child.pid;

  let cap;
  try {
    cap = psProc('capture', { id: child.pid });
  } catch (e) {
    cap = { result: 'error', message: e.message };
  }
  if (cap.result === 'ok') {
    rt.current.phase = 'RUNNING';
    rt.current.creationFileTime = cap.creationFileTime;
    rt.current.image = cap.image;
    writeRuntime(home, appId, rt);
    return rt.current;
  }
  rt.current.phase = 'UNKNOWN';
  rt.current.lastError = `identity_capture_failed: ${JSON.stringify(cap)}`;
  writeRuntime(home, appId, rt);
  throw conflictError('IDENTITY_CAPTURE_FAILED', `已拉起（pid=${child.pid}）但身份采集失败，标记 UNKNOWN；证据保留，拒绝自动重试`, { runId, pid: child.pid, capture: cap, logPaths: rt.current.logPaths });
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
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--ack-unresolved': 'value' });
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
    const app = upsertApp(reg, appId, desc);
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode,
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      readinessUntested: true, logPaths: cur.logPaths,
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
        cwd: d.cwd ? realpathOrConflict('cwd', d.cwd) : root, mode: d.mode === 'jrebel' ? 'jrebel' : 'java',
        exe: null, args: [], envRefs: [], expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
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
      note: 'Skill 在既有授权下执行的启动，未托管目标 JVM；仅记录尝试与日志线索',
    };
    writeRuntime(ctx.home, appId, rt);
    return {
      appId, alias: reg.apps[appId].alias, runId: rt.current.runId,
      managed: false, status: 'UNKNOWN', logHints,
      note: '非受管登记不提供 RUNNING/STOPPED 断言与跨会话启停；日志线索仅原路径关联',
    };
  });
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

function cmdStatus(ctx, ref) {
  if (!ref) throw usageError('status 需要 <alias|appId>');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const { rt, st } = statusWithFacts(ctx.home, appId);
  const cur = rt && rt.current;
  const evidenceFile = runtimePath(ctx.home, appId);
  return {
    alias: app.alias, appId, entry: app.entry, mode: app.mode, root: app.root,
    status: st.status, managed: st.managed ?? false,
    pid: st.pid ?? cur?.pid ?? null,
    runtimeFile: evidenceFile,
    expectedPort: app.expectedPort,
    portNote: 'expectedPort 为配置预期值，P0 不做实际监听探测',
    run: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, mode: cur.mode,
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
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'start', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app.exe) {
      throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置；需 Skill 重新分析该项目并走 start-new`);
    }
    // 结构性检查：路径/产物失效只报该应用，不做全盘扫描（AC02）
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = resolveExe(app.exe, cwd);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (rt && rt.current && rt.current.managed && rt.current.phase === 'RUNNING') {
      const v = verifyRun(rt.current);
      if (v.alive) throw conflictError('ALREADY_RUNNING', `${app.alias} 已有受管实例在运行`, { runId: rt.current.runId, pid: rt.current.pid });
    }
    // STARTING/UNKNOWN 未结记录默认拒绝；显式 ack 且复核通过后才归档旧账并继续
    const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
    app.cwd = cwd;
    app.exe = exe;
    app.updatedAt = new Date().toISOString();
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, source: 'saved-config',
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      readinessUntested: true, logPaths: cur.logPaths,
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
    writeRuntime(home, appId, rt);
    return { result: 'stopped', runId: cur.runId, pid: cur.pid };
  }
  if (t.result === 'exited' || t.result === 'notfound') {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程已自行退出';
    writeRuntime(home, appId, rt);
    return { result: 'alreadyStopped', runId: cur.runId };
  }
  if (t.result === 'mismatch') {
    // 记录的实例已退出，该 PID 现属其他进程：不触碰，落账退出
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程退出后 PID 被复用；未触碰新进程';
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
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'restart', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app.exe) throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置`);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const stopResult = stopCurrent(ctx.home, appId, app, rt); // 必须确认退出才继续；抛错则中止，绝不先起后停
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = resolveExe(app.exe, cwd);
    app.cwd = cwd;
    app.exe = exe;
    app.updatedAt = new Date().toISOString();
    atomicWriteJson(registryPath(ctx.home), reg);
    const cur = launchManaged(ctx.home, appId, app);
    return {
      appId, alias: app.alias, stop: stopResult,
      start: { runId: cur.runId, pid: cur.pid, status: 'RUNNING', readinessUntested: true, logPaths: cur.logPaths },
      note: '已确认旧实例退出后启动新实例；进程存活不等于业务就绪',
    };
  });
}

function readTailLines(file, n) {
  const want = Math.min(Math.max(1, n), MAX_LOG_LINES);
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - MAX_LOG_BYTES);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  let all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  const lines = all.slice(-want);
  return { lines, truncated: start > 0 || all.length > want, skippedBytes: start };
}

function cmdLogs(ctx, ref) {
  if (!ref) throw usageError('logs 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag' });
  const lines = opts.has('--lines') ? Number.parseInt(opts.get('--lines'), 10) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');
  const stream = opts.get('--stream') ?? 'stdout';
  if (!['stdout', 'stderr'].includes(stream)) throw usageError('--stream 只能是 stdout 或 stderr');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const rt = readRuntimeStrict(ctx.home, appId);
  const cur = rt && rt.current;
  const prev = rt && rt.prevRuns ? rt.prevRuns.find((p) => p.runId === opts.get('--run')) : null;
  const runId = opts.get('--run') ?? cur?.runId ?? null;
  if (!runId) throw notFoundError(`${app.alias} 无运行批次`);
  if (!ID_RE.test(runId)) throw usageError(`runId 非法：${runId}`);
  if (opts.get('--run') && runId !== cur?.runId && !prev) {
    throw notFoundError(`runId=${runId} 不在 ${app.alias} 的运行记录中`);
  }
  const file = path.join(ctx.home, 'logs', appId, `${runId}.${stream}.log`);
  if (!fs.existsSync(file)) throw notFoundError(`日志不存在（runId=${runId}, stream=${stream}）`);
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    followLogs(ctx, appId, app, rt, runId, stream, file, lines);
    return { following: true };
  }
  const r = readTailLines(file, lines);
  return { appId, alias: app.alias, runId, stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file };
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
        process.stdout.write(buf.toString('utf8'));
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
            process.stdout.write(buf.toString('utf8'));
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
    if (e.detail) text += `\n详情: ${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}`;
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
    case 'status':
      return [
        `${data.alias} (${data.appId}) mode=${data.mode} status=${data.status} managed=${data.managed}${data.pid ? ` pid=${data.pid}` : ''}`,
        data.run ? `run=${data.run.runId} phase=${data.run.phase} managed=${data.run.managed} started=${data.run.startedAt ?? '-'}` : 'run=无',
        data.run?.pid != null ? `pid=${data.run.pid}${data.run.creationFileTime ? ` creationFileTime=${data.run.creationFileTime}` : ''}${data.run.image ? ` image=${data.run.image}` : ''}` : null,
        data.run?.lastError ? `lastError: ${data.run.lastError}` : null,
        data.run?.logPaths?.stdout ? `stdout=${data.run.logPaths.stdout}` : null,
        data.run?.logPaths?.stderr ? `stderr=${data.run.logPaths.stderr}` : null,
        data.run?.logHints?.length ? `logHints=${data.run.logHints.join(', ')}` : null,
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
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `stdout=${data.logPaths.stdout}`,
        `stderr=${data.logPaths.stderr}`,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'record-unmanaged':
      return [
        `已记录非受管启动 ${data.alias} (${data.appId}) run=${data.runId}`,
        data.logHints?.length ? `日志线索: ${data.logHints.join(', ')}` : null,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'stop':
      return `stop ${data.alias}: ${data.result}${data.runId ? ` (run=${data.runId})` : ''}${data.note ? `；${data.note}` : ''}`;
    case 'restart':
      return [
        `restart ${data.alias}: stop=${data.stop.result} → start run=${data.start.runId} pid=${data.start.pid} status=${data.start.status}`,
        `stdout=${data.start.logPaths.stdout}`,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'logs':
      return data.lines.join('\n');
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
    '  status <alias|appId>              单应用详情（含运行证据）',
    '  start <alias|appId> [--ack-unresolved <runId>]   用已保存配置启动（任意目录可用）',
    '  stop <alias|appId>                有界强制停止（仅受管实例）',
    '  restart <alias|appId>             确认退出后重启（仅受管实例）',
    '  logs <alias|appId> [--lines N] [--stream stdout|stderr] [--run <runId>] [--follow]',
    '',
    '内部入口（Skill 调用，不对用户暴露注册 CRUD）：',
    '  start-new --desc <file> [--ack-unresolved <runId>]   首次受管启动：意图→启动→身份采集→登记',
    '  record-unmanaged --desc <file> [--log-hints p1,p2]   记录非受管启动尝试',
    '',
    'STARTING/UNKNOWN 未结记录默认拒绝启动（UNRESOLVED_RUN）；人工核验进程已退出后，',
    '用 --ack-unresolved <runId> 显式放弃旧账并重启：start <ref> --ack-unresolved <runId>',
    '',
    '退出码：0 成功 | 1 用法 | 2 未找到 | 3 状态冲突 | 4 环境依赖 | 5 数据损坏',
  ].join('\n');
}

// ---------- 入口 ----------

function main() {
  let ctx;
  let command;
  try {
    ctx = parseArgv(process.argv.slice(2));
    command = ctx.command;
    ctx.home = resolveHome(ctx.home);
  } catch (e) {
    const c = command ?? 'cli';
    if (e instanceof ManagerError) emitErr({ json: false }, c, e);
    throw e;
  }
  try {
    let data;
    const refCommands = new Set(['status', 'stop', 'restart']);
    if (command === 'start') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError('start 需要 <alias|appId>');
    } else if (refCommands.has(command)) {
      const bad = ctx.rest.find((a, i) => i > 0 || a.startsWith('--'));
      if (bad !== undefined && bad !== null) throw usageError(`无法识别的参数：${bad}`);
      if (!ctx.rest[0]) throw usageError(`${command} 需要 <alias|appId>`);
    }
    switch (command) {
      case 'list': data = cmdList(ctx); break;
      case 'status': data = cmdStatus(ctx, ctx.rest[0]); break;
      case 'start': data = cmdStart(ctx, ctx.rest[0]); break;
      case 'stop': data = cmdStop(ctx, ctx.rest[0]); break;
      case 'restart': data = cmdRestart(ctx, ctx.rest[0]); break;
      case 'logs': data = cmdLogs(ctx, ctx.rest[0]); break;
      case 'start-new': data = cmdStartNew(ctx); break;
      case 'record-unmanaged': data = cmdRecordUnmanaged(ctx); break;
      default: throw usageError(`未知命令：${command}\n${usageText()}`);
    }
    emitOk(ctx, command, data);
  } catch (e) {
    if (e instanceof ManagerError) emitErr(ctx, command, e);
    process.stderr.write(`内部错误：${e.stack}\n`);
    process.exit(5);
  }
}

main();
