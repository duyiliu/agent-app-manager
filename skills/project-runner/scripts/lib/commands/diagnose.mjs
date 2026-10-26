// 诊断与状态命令：port/doctor/list/status 与就绪证据评估（只读，不改状态）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { registryPath, runtimePath, readRegistry, readRuntimeStrict } from '../store.mjs';
import { usageError } from '../errors.mjs';
import { verifyRun, verifyRuns, portOccupants, tcpListening, cacheVerifyResult, interpretVerifyResult } from '../probe.mjs';
import { resolveAppId, statusWithFacts } from '../runtime.mjs';
import { readTailLines, MAX_LOG_LINES } from '../logs.mjs';
import { bootId } from '../proc-linux.mjs';

export function portDiagnosis(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError('port 需要 1-65535 的整数');
  return { port, occupants: portOccupants(port), note: '外部进程仅诊断，不接管、不停止' };
}

export function cmdPort(ctx, value) {
  if (ctx.rest.length > 1) throw usageError(`无法识别的参数：${ctx.rest[1]}`);
  return portDiagnosis(Number(value));
}

export function cmdDoctor(ctx) {
  const home = ctx.home;
  const problems = [];
  const addProblem = (file, e) => {
    const code = e.code ?? 'UNKNOWN';
    if (problems.some((p) => p.file === file && p.code === code)) return;
    problems.push({ file, code, message: e.message });
  };

  // 注册表损坏不阻断其余独立诊断项；错误显式列入 problems，绝不静默当空注册表。
  let reg = { schemaVersion: null, apps: {} };
  try {
    reg = readRegistry(home);
  } catch (e) {
    addProblem(registryPath(home), e);
  }

  const runtimes = [];
  const runtimeDir = path.join(home, 'runtime');
  let runtimeNames = [];
  try {
    if (fs.existsSync(runtimeDir)) runtimeNames = fs.readdirSync(runtimeDir);
  } catch (e) {
    addProblem(runtimeDir, e);
  }
  for (const name of runtimeNames) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}\.json$/.test(name)) continue;
    const appId = name.slice(0, -5);
    let rt;
    try {
      rt = readRuntimeStrict(home, appId);
    } catch (e) {
      addProblem(runtimePath(home, appId), e);
      runtimes.push({ appId, schemaVersion: null, prevRuns: 0, logs: [], error: e.code ?? 'UNKNOWN' });
      continue;
    }
    const logChecks = [];
    for (const run of [rt?.current, ...(rt?.prevRuns ?? [])].filter(Boolean)) {
      if (!run.runId || !run.managed) continue;
      const paths = run.logPaths ?? { stdout: path.join(home, 'logs', appId, `${run.runId}.stdout.log`), stderr: path.join(home, 'logs', appId, `${run.runId}.stderr.log`) };
      for (const stream of ['stdout', 'stderr']) logChecks.push({ runId: run.runId, stream, exists: !!paths[stream] && fs.existsSync(paths[stream]) });
    }
    runtimes.push({ appId, schemaVersion: rt.schemaVersion, prevRuns: rt.prevRuns?.length ?? 0, logs: logChecks });
  }

  const locksDir = path.join(home, 'locks');
  let locks = [];
  try {
    locks = fs.existsSync(locksDir) ? fs.readdirSync(locksDir).filter((n) => n.endsWith('.lock')) : [];
  } catch (e) {
    addProblem(locksDir, e);
  }

  const tempFiles = [];
  const scanTemps = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, name.name);
      if (name.name.startsWith('.tmp-')) tempFiles.push(file);
      else if (name.isDirectory()) scanTemps(file, depth + 1);
    }
  };
  for (const dir of [home, runtimeDir, path.join(home, 'logs'), locksDir]) {
    try { scanTemps(dir); } catch (e) { addProblem(dir, e); }
  }

  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  let pw = { error: true, status: null, stdout: '' };
  if (isWin) {
    pw = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  }
  const procReadable = isLinux
    ? (() => { try { fs.accessSync('/proc/self/stat', fs.constants.R_OK); return true; } catch { return false; } })()
    : null;
  const homeWritable = (() => { try { fs.accessSync(home, fs.constants.W_OK); return true; } catch { return false; } })();
  const portSummary = Object.values(reg.apps).filter((a) => Number.isInteger(a.expectedPort)).map((a) => ({ alias: a.alias, port: a.expectedPort, listening: tcpListening(a.expectedPort) }));
  return Promise.all(portSummary.map(async (p) => ({ ...p, listening: await p.listening }))).then((ports) => ({
    nodeVersion: process.version, platform: process.platform,
    procBackend: isLinux ? 'linux-proc' : (isWin ? 'pwsh-win32' : null),
    pwshVersion: isWin && !pw.error && pw.status === 0 ? pw.stdout.trim() : null,
    bootId: isLinux ? bootId() : null,
    procReadable,
    home, homeWritable, registrySchemaVersion: reg.schemaVersion, runtime: runtimes, locks, orphanTmpFiles: tempFiles, portSummary: ports, problems,
    note: '只读诊断；locks 项仅列出，不回收；problems 为诊断发现，不自动修复；orphanTmpFiles 可由 prune 按保留集回收；端口监听不代表业务就绪',
  }));
}

export function cmdList(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps);
  // 一次批量核验所有 RUNNING 记录（#15/#51）：N 个受管应用只产生 1 次 pwsh 调用；
  // 批量失败时回退逐条核验，语义与结果不变。
  const prefetched = new Map();
  const pending = [];
  const runtimes = new Map();
  for (const app of apps) {
    try {
      const rt = readRuntimeStrict(ctx.home, app.appId);
      runtimes.set(app.appId, rt);
      const cur = rt?.current;
      if (cur && cur.managed && cur.phase === 'RUNNING' && cur.pid != null && cur.creationFileTime && cur.image) {
        pending.push({ appId: app.appId, pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
      }
    } catch (e) {
      // 损坏/不兼容记录：保留错误供下方按 DATA_* 呈现
      runtimes.set(app.appId, e);
    }
  }
  if (pending.length) {
    try {
      const results = verifyRuns(pending);
      pending.forEach((p, i) => {
        if (!results[i]) return;
        prefetched.set(p.appId, results[i]);
        // 填充单条核验缓存：同一轮询周期内 /api/status 的 verifyRun 直接命中，不再多起 pwsh
        try { cacheVerifyResult(p, interpretVerifyResult(results[i])); } catch { /* error 结果不缓存 */ }
      });
    } catch { /* 回退逐条 */ }
  }
  const rows = apps.map((app) => {
    let rt;
    let st;
    try {
      const cached = runtimes.get(app.appId);
      if (cached instanceof Error) throw cached;
      ({ rt, st } = statusWithFacts(ctx.home, app.appId, prefetched.get(app.appId) ?? null, cached));
    } catch (e) {
      return { alias: app.alias, displayName: app.displayName ?? app.alias, appId: app.appId, mode: app.mode, status: 'UNKNOWN', managed: null, error: `${e.code}: ${e.message}`, root: app.root };
    }
    return {
      alias: app.alias, displayName: app.displayName ?? app.alias, appId: app.appId, mode: app.mode,
      status: st.status, managed: st.managed ?? (rt?.current?.managed ?? null),
      pid: st.status === 'RUNNING' ? (st.pid ?? rt?.current?.pid) : null,
      expectedPort: app.expectedPort, lastRunId: rt?.current?.runId ?? rt?.prevRuns?.[0]?.runId ?? null,
      log: rt?.current?.logPaths?.stdout ?? null, root: app.root,
    };
  });
  if (!apps.length) return { apps: [], note: '注册表为空：尚无由本 Skill 启动并记录的应用' };
  return { apps: rows };
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

function displayEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [
    name, value.length > 120 ? `${value.slice(0, 120)}… (截断)` : value,
  ]));
}

// 就绪证据评估：desc 可选 readyLogPattern（当前批次 stdout/stderr 正则）与 readyUrl
// （http GET <400 即就绪）。两者都未配置 → UNTESTED；任一证据命中 → READY；配置了但
// 无命中 → NOT_READY。只读评估，不改状态。
// readyLogPattern 编译缓存：status --ready 每次调用都编译同一正则（#82-B3）。
const readyReCache = new Map();
const readyRe = (pattern) => {
  let r = readyReCache.get(pattern);
  if (!r) { r = new RegExp(pattern); readyReCache.set(pattern, r); }
  return r;
};

async function readinessCheck(home, app, cur) {
  const evidence = [];
  if (app.readyLogPattern && cur?.runId) {
    const re = readyRe(app.readyLogPattern);
    const dir = path.join(home, 'logs', app.appId);
    for (const stream of ['stdout', 'stderr']) {
      let line = null;
      try {
        // 复用 readTailLines：UTF-8 边界探测/GBK 回退与 logs 命令同口径（#82-B3），
        // 窗口上限沿用原 512KB 语义。
        line = readTailLines(path.join(dir, `${cur.runId}.${stream}.log`), MAX_LOG_LINES, 512 * 1024)
          .lines.find((l) => re.test(l));
      } catch { /* 批次日志尚不存在 */ }
      if (line != null) evidence.push({ kind: 'logPattern', stream, matched: line.slice(0, 200) });
    }
  }
  if (app.readyUrl) {
    try {
      const r = await fetch(app.readyUrl, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      evidence.push(r.status < 400
        ? { kind: 'http', url: app.readyUrl, status: r.status }
        : { kind: 'http', url: app.readyUrl, status: r.status, failed: true });
    } catch (e) {
      evidence.push({ kind: 'http', url: app.readyUrl, error: String(e?.message ?? e).slice(0, 160), failed: true });
    }
  }
  const configured = Boolean(app.readyLogPattern || app.readyUrl);
  const state = !configured ? 'UNTESTED' : evidence.some((e) => !e.failed) ? 'READY' : 'NOT_READY';
  return { state, configured, evidence };
}

// 管理台健康总览（GET /api/health）：对全部登记应用做一次只读评估。
// RUNNING 应用并发执行 TCP 监听探测与 readyUrl/readyLogPattern 就绪评估；
// 非 RUNNING、无就绪配置或缺少就绪证据一律明确标 UNTESTED，绝不把监听当成就绪。
// 批量核验 RUNNING 身份，避免 N 个应用产生 N 次 pwsh 冷启动；单应用损坏只降级该行。
export async function cmdHealth(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps);
  const prefetched = new Map();
  const runtimes = new Map();
  const pending = [];
  for (const app of apps) {
    try {
      const rt = readRuntimeStrict(ctx.home, app.appId);
      runtimes.set(app.appId, rt);
      const cur = rt?.current;
      if (cur && cur.managed && cur.phase === 'RUNNING' && cur.pid != null && cur.creationFileTime && cur.image) {
        pending.push({ appId: app.appId, pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
      }
    } catch (e) {
      runtimes.set(app.appId, e);
    }
  }
  if (pending.length) {
    try {
      const results = verifyRuns(pending);
      pending.forEach((p, i) => {
        if (!results[i]) return;
        prefetched.set(p.appId, results[i]);
        try { cacheVerifyResult(p, interpretVerifyResult(results[i])); } catch { /* error 结果不缓存 */ }
      });
    } catch { /* 批量失败回退逐条核验 */ }
  }

  const rows = await Promise.all(apps.map(async (app) => {
    const base = {
      alias: app.alias, appId: app.appId, expectedPort: Number.isInteger(app.expectedPort) ? app.expectedPort : null,
    };
    let rt;
    let st;
    try {
      const cached = runtimes.get(app.appId);
      if (cached instanceof Error) throw cached;
      ({ rt, st } = statusWithFacts(ctx.home, app.appId, prefetched.get(app.appId) ?? null, cached));
    } catch (e) {
      return {
        ...base, status: 'UNKNOWN', managed: null, listening: null, state: 'UNTESTED',
        readiness: { state: 'UNTESTED', configured: Boolean(app.readyLogPattern || app.readyUrl), evidence: [] },
        error: `${e.code ?? 'UNKNOWN'}: ${e.message}`,
      };
    }
    const running = st.status === 'RUNNING';
    const listening = running && base.expectedPort != null ? await tcpListening(base.expectedPort) : null;
    const readiness = running
      ? await readinessCheck(ctx.home, app, rt?.current)
      : { state: 'UNTESTED', configured: Boolean(app.readyLogPattern || app.readyUrl), evidence: [], note: '非 RUNNING，未做端口/就绪探测' };
    return {
      ...base, status: st.status, managed: st.managed ?? (rt?.current?.managed ?? null),
      pid: running ? (st.pid ?? rt?.current?.pid ?? null) : null,
      listening, state: readiness.state, readiness,
      note: st.note ?? null,
      ...(st.loggerNote ? { loggerNote: st.loggerNote } : {}),
    };
  }));

  const runningApps = rows.filter((r) => r.status === 'RUNNING');
  return {
    checkedAt: new Date().toISOString(),
    apps: rows,
    summary: {
      total: rows.length,
      running: runningApps.length,
      ready: runningApps.filter((r) => r.state === 'READY').length,
      notReady: runningApps.filter((r) => r.state === 'NOT_READY').length,
      untested: runningApps.filter((r) => r.state === 'UNTESTED').length,
    },
    note: '监听（TCP）≠ 业务就绪：READY 仅代表配置的 readyUrl/readyLogPattern 证据命中，未配置或非 RUNNING 为 UNTESTED',
  };
}

export async function cmdStatus(ctx, ref, probeRequested = false, readyRequested = false) {
  if (!ref) throw usageError('status 需要 <alias|appId>');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const { rt, st } = statusWithFacts(ctx.home, appId);
  const cur = rt && rt.current;
  const evidenceFile = runtimePath(ctx.home, appId);
  const portListening = probeRequested && Number.isInteger(app.expectedPort) ? await tcpListening(app.expectedPort) : null;
  const readiness = readyRequested && st.status === 'RUNNING' ? await readinessCheck(ctx.home, app, cur)
    : readyRequested ? { state: 'UNTESTED', configured: Boolean(app.readyLogPattern || app.readyUrl), evidence: [], note: '非 RUNNING，不就绪评估' } : null;
  const jrebelEvidence = cur?.mode === 'jrebel' ? extractJrebelEvidence(ctx.home, appId, cur) : null;
  return {
    alias: app.alias, appId, entry: app.entry, mode: app.mode, root: app.root,
    status: st.status, managed: st.managed ?? false,
    env: displayEnv(app.env ?? {}),
    pid: st.pid ?? cur?.pid ?? null,
    runtimeFile: evidenceFile,
    expectedPort: app.expectedPort,
    portNote: probeRequested ? '端口监听仅为 TCP 证据；监听 ≠ 业务就绪' : '使用 --probe 执行本机 TCP 监听探测',
    ...(probeRequested ? { portListening } : {}),
    ...(jrebelEvidence ? { jrebelEvidence } : {}),
    run: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, mode: cur.mode,
      kind: cur.kind ?? 'direct', wrapperPid: cur.wrapperPid ?? null, loggerPid: cur.loggerPid ?? null,
      wrapperCleaned: cur.wrapperCleaned ?? false,
      intentAt: cur.intentAt ?? null, startedAt: cur.startedAt ?? cur.intentAt,
      endedAt: cur.endedAt, pid: cur.pid ?? null,
      creationFileTime: cur.creationFileTime ?? null, image: cur.image ?? null,
      envResolved: cur.envResolved ?? [],
      logPaths: cur.logPaths, logHints: cur.logHints ?? null,
      logRotated: cur.logRotated ?? false, logRotatedStreams: cur.logRotatedStreams ?? [],
      logRotateFailedStreams: cur.logRotateFailedStreams ?? [],
      lastError: cur.lastError, exitNote: cur.exitNote ?? null,
      evidenceFile,
    } : null,
    ...(readiness ? { readiness } : {}),
    readinessUntested: st.status === 'RUNNING' && readiness?.state !== 'READY',
    note: st.note ?? null,
    loggerNote: st.loggerNote ?? null,
    prevRuns: (rt?.prevRuns ?? []).slice(0, 5),
  };
}
