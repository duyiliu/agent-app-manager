// 诊断与状态命令：port/doctor/list/status 与就绪证据评估（只读，不改状态）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { registryPath, runtimePath, readRegistry, readRuntimeStrict } from '../store.mjs';
import { usageError } from '../errors.mjs';
import { verifyRun, verifyRuns, portOccupants, tcpListening, listListeningPorts, listListeningPortsBatch, cacheVerifyResult, interpretVerifyResult, probeComposite } from '../probe.mjs';
import { resolveAppId, statusWithFacts, exitSummary } from '../runtime.mjs';
import { readTailLines, MAX_LOG_LINES } from '../logs.mjs';
import { decodeText } from '../decode.mjs';
import { RUN_LOG_MAX_BYTES } from '../desc.mjs';
import { readinessTimeoutError, conflictError } from '../errors.mjs';
import { bootId } from '../proc-linux.mjs';
import { displayEnv } from '../env.mjs';
import { DEFAULT_MAX_RESTARTS, DEFAULT_BACKOFF_MS } from '../restart.mjs';
import { sampleRunResources } from '../resources.mjs';

// 实际监听端口去重排序：同一端口可能在 0.0.0.0 与 :: 各有一条监听记录。
function uniqueListeningPorts(entries) {
  return [...new Set((entries ?? []).map((e) => e?.localPort).filter((p) => Number.isInteger(p) && p > 0))]
    .sort((a, b) => a - b);
}

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

// 运行记录里需要组合探针采集的证据：身份核验项 + loggerPid 身份采集 + 监听枚举 + 资源采样。
// 各段只读且按 pid 独立；核验结果返回前不知道进程是否真 RUNNING，按记录投机采集、
// 消费端再按核验后的 status 取舍——多余采集只是几次只读调用，语义与逐路调用一致。
function pendingProbeSpec(pending) {
  const capture = [];
  for (const p of pending) {
    if (Number.isInteger(p.loggerPid) && p.loggerPid > 0 && p.loggerCreationFileTime) capture.push(p.loggerPid);
  }
  return {
    verify: pending,
    capture,
    listening: pending.map((p) => p.pid),
    resources: { items: pending.map((p) => ({ id: p.pid, tree: p.kind === 'command' })) },
  };
}

// 预取的 logger capture 结果按 pid 索引；只有确实预取过的记录才返回值（否则 undefined，
// loggerAliveNote 走原有按需探测路径）。
function loggerCapLookup(probe) {
  const byPid = new Map((probe?.capture ?? []).map((c) => [c.pid, c]));
  return (cur) => {
    if (!probe || !Number.isInteger(cur?.loggerPid) || cur.loggerPid <= 0 || !cur.loggerCreationFileTime) return undefined;
    return byPid.get(cur.loggerPid) ?? { result: 'error', code: 'missing' };
  };
}

export function cmdList(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps).filter((app) => app.internalKind !== 'scenario-workbench-v1');
  // 批量核验所有 RUNNING 记录（#15/#51）：N 个受管应用只产生 1 次 pwsh 调用；
  // 现已并入组合探针（核验+logger 采集+监听枚举+资源采样同一 pwsh）；
  // 组合失败时回退原逐路调用，语义与结果不变。
  const prefetched = new Map();
  const pending = [];
  const runtimes = new Map();
  for (const app of apps) {
    try {
      const rt = readRuntimeStrict(ctx.home, app.appId);
      runtimes.set(app.appId, rt);
      const cur = rt?.current;
      if (cur && cur.managed && cur.phase === 'RUNNING' && cur.pid != null && cur.creationFileTime && cur.image) {
        pending.push({ appId: app.appId, pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image, kind: cur.kind, loggerPid: cur.loggerPid, loggerCreationFileTime: cur.loggerCreationFileTime });
      }
    } catch (e) {
      // 损坏/不兼容记录：保留错误供下方按 DATA_* 呈现
      runtimes.set(app.appId, e);
    }
  }
  let probe = null;
  if (pending.length) {
    try {
      probe = probeComposite(pendingProbeSpec(pending));
    } catch { probe = null; /* 组合探针失败：回退下方逐路调用 */ }
  }
  const verifyResults = probe?.verify ?? null;
  if (verifyResults) {
    pending.forEach((p, i) => {
      const result = verifyResults[i];
      if (!result) return;
      prefetched.set(p.appId, result);
      // 填充单条核验缓存：同一轮询周期内 /api/status 的 verifyRun 直接命中，不再多起 pwsh
      try { cacheVerifyResult(p, interpretVerifyResult(result)); } catch { /* error 结果不缓存 */ }
    });
  } else if (pending.length) {
    try {
      const results = verifyRuns(pending);
      pending.forEach((p, i) => {
        if (!results[i]) return;
        prefetched.set(p.appId, results[i]);
        try { cacheVerifyResult(p, interpretVerifyResult(results[i])); } catch { /* error 结果不缓存 */ }
      });
    } catch { /* 回退逐条 */ }
  }
  const loggerCapOf = loggerCapLookup(probe);
  const rows = apps.map((app) => {
    let rt;
    let st;
    try {
      const cached = runtimes.get(app.appId);
      if (cached instanceof Error) throw cached;
      ({ rt, st } = statusWithFacts(ctx.home, app.appId, prefetched.get(app.appId) ?? null, cached, loggerCapOf(cached?.current)));
    } catch (e) {
      return { alias: app.alias, displayName: app.displayName ?? app.alias, appId: app.appId, mode: app.mode, status: 'UNKNOWN', managed: null, error: `${e.code}: ${e.message}`, root: app.root, tags: app.tags ?? [], memoryBytes: null };
    }
    const current = rt?.current ?? null;
    const runExit = current?.exit ?? null;
    return {
      alias: app.alias, displayName: app.displayName ?? app.alias, appId: app.appId, mode: app.mode,
      status: st.status, managed: st.managed ?? (current?.managed ?? null),
      pid: st.status === 'RUNNING' ? (st.pid ?? current?.pid) : null,
      expectedPort: app.expectedPort, lastRunId: current?.runId ?? rt?.prevRuns?.[0]?.runId ?? null,
      tags: app.tags ?? [],
      restartPolicy: app.restartPolicy ?? 'never',
      restartState: current?.restartState ?? st.restartState ?? null,
      restartCount: current?.restartCount ?? 0,
      exit: runExit, exitSummary: exitSummary(current),
      exitWatchError: current?.exitWatchError ?? null,
      exitNote: st.note ?? current?.exitNote ?? null,
      log: current?.logPaths?.stdout ?? null, root: app.root,
      // 单点采样（无趋势）：RUNNING 受管应用带 RSS；采样失败/未运行时保持 null。
      memoryBytes: null,
    };
  });
  // list 的内存列（#111）：所有 RUNNING 受管应用共用一次平台采样（Windows 1 次 pwsh，Linux 直读 /proc）。
  // 命令模式按目标 + 后代聚合（tree=true）；失败只降级为 memoryBytes=null，不影响 list 结果。
  const candidates = [];
  rows.forEach((row, index) => {
    if (row.status !== 'RUNNING' || !Number.isInteger(row.pid) || row.managed === false) return;
    const cached = runtimes.get(row.appId);
    const cur = cached instanceof Error ? null : cached?.current;
    if (!cur || !cur.managed) return;
    candidates.push({ index, pid: row.pid, kind: cur.kind ?? 'direct', verified: true, creationFileTime: cur.creationFileTime, image: cur.image });
  });
  if (candidates.length) {
    const runs = candidates.map(({ pid, kind }) => ({ pid, kind, verified: true }));
    const samples = probe?.resources ? sampleRunResources(runs, { sampled: probe.resources }) : sampleRunResources(runs);
    candidates.forEach((c, i) => {
      const s = samples[i];
      if (s?.available) {
        rows[c.index].memoryBytes = s.rssBytes ?? null;
        rows[c.index].cpuPercent = s.cpuPercent ?? null;
        rows[c.index].resourcesScope = s.scope;
      } else {
        rows[c.index].resourcesNote = s?.reason ?? '资源采样不可用';
      }
    });
  }
  // 列表也附实际监听端口（#107）：一次批量枚举所有 RUNNING pid，避免每个应用各起一次 pwsh。
  // 枚举失败不回退到 expectedPort 冒充实际端口；UI 会按无 actualPorts 处理。
  const runningPids = [...new Set(rows.filter((r) => r.status === 'RUNNING' && Number.isInteger(r.pid)).map((r) => r.pid))];
  if (runningPids.length) {
    if (probe) {
      // 组合探针已枚举全部 pending pid（RUNNING 记录的投机采集），按核验后的 RUNNING 行取用。
      if (probe.listening?.result === 'ok') {
        const byPid = new Map();
        for (const row of probe.listening.rows ?? []) {
          if (!byPid.has(row.pid)) byPid.set(row.pid, []);
          byPid.get(row.pid).push(row);
        }
        for (const row of rows) {
          if (row.status !== 'RUNNING' || !Number.isInteger(row.pid)) continue;
          row.actualPorts = uniqueListeningPorts(byPid.get(row.pid) ?? []);
        }
      }
    } else {
      try {
        const byPid = listListeningPortsBatch(runningPids);
        for (const row of rows) {
          if (row.status !== 'RUNNING' || !Number.isInteger(row.pid)) continue;
          row.actualPorts = uniqueListeningPorts(byPid.get(row.pid) ?? []);
        }
      } catch { /* 端口枚举失败不阻断 list；UI 回退 expectedPort */ }
    }
  }
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

async function readinessCheck(home, app, cur, opts = {}) {
  const evidence = [...(opts.logEvidence ?? [])];
  // opts.logEvidence 由等待器提供时表示已从批次日志起点增量扫描，避免 status 的
  // 5000 行尾部窗口漏掉早期标记；undefined 表示 status --ready 的既有尾读语义。
  if (opts.logEvidence === undefined && app.readyLogPattern && cur?.runId) {
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

const READY_WAIT_DEFAULT_MS = 60000;
const READY_WAIT_MAX_MS = 600000;
const READY_POLL_MS = 250;

// UTF-8 尾部可能被写入切分：只解码完整前缀，残余字节留到下次与新增内容一起解码。
// 非法 UTF-8（如 GBK）返回整个缓冲区，交给 decodeText 的既有回退策略。
function completeUtf8Prefix(buf) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try { decoder.decode(buf); return buf.length; } catch { /* 可能只是尾部不完整 */ }
  for (let cut = 1; cut <= 3 && cut <= buf.length; cut++) {
    try {
      decoder.decode(buf.subarray(0, buf.length - cut));
      return buf.length - cut;
    } catch { /* 继续尝试更短的尾部 */ }
  }
  return buf.length;
}

// 等待期日志扫描器：从本批次日志起点按字节增量读取（上限 logMaxBytes），
// 跨 chunk 保留未完成行/未完成 UTF-8 字节，避免早期就绪标记落在 status 的
// 5000 行窗口之外。
function createReadyLogScanner(home, app, cur) {
  const streams = ['stdout', 'stderr'];
  const maxBytes = app.logMaxBytes ?? RUN_LOG_MAX_BYTES;
  const re = app.readyLogPattern ? readyRe(app.readyLogPattern) : null;
  const dir = path.join(home, 'logs', app.appId);
  const state = new Map(streams.map((stream) => [stream, {
    offset: 0, pending: '', carry: Buffer.alloc(0), matched: null,
  }]));
  return () => {
    if (!re || !cur?.runId) return [];
    const evidence = [];
    for (const stream of streams) {
      const st = state.get(stream);
      if (st.matched) { evidence.push(st.matched); continue; }
      const file = path.join(dir, `${cur.runId}.${stream}.log`);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      // 轮转/截断后文件变小：从头重扫新文件，不留下跨轮转的偏移。
      if (size < st.offset) { st.offset = 0; st.pending = ''; st.carry = Buffer.alloc(0); }
      const end = Math.min(size, maxBytes);
      let text = '';
      if (end > st.offset) {
        try {
          const len = end - st.offset;
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(file, 'r');
          try { fs.readSync(fd, buf, 0, len, st.offset); } finally { fs.closeSync(fd); }
          st.offset = end;
          const combined = st.carry.length ? Buffer.concat([st.carry, buf]) : buf;
          const cut = completeUtf8Prefix(combined);
          text = decodeText(combined.subarray(0, cut));
          st.carry = combined.subarray(cut);
        } catch { continue; }
      }
      if (!text && !st.pending) continue;
      const parts = `${st.pending}${text}`.split(/\r?\n/);
      st.pending = parts.pop() ?? '';
      const hit = parts.find((l) => re.test(l)) ?? (st.pending && re.test(st.pending) ? st.pending : null);
      if (hit != null) {
        st.matched = { kind: 'logPattern', stream, matched: hit.slice(0, 200) };
        evidence.push(st.matched);
      }
    }
    return evidence;
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --wait-ready 参数：默认 60s；--ready-timeout 只在等待模式下有意义。
export function parseReadyOptions(opts) {
  const waitReady = opts.has('--wait-ready');
  if (!waitReady && opts.has('--ready-timeout')) {
    throw usageError('--ready-timeout 需要与 --wait-ready 一起使用');
  }
  let timeoutMs = READY_WAIT_DEFAULT_MS;
  if (opts.has('--ready-timeout')) {
    const n = Number(opts.get('--ready-timeout'));
    if (!Number.isInteger(n) || n < 0 || n > READY_WAIT_MAX_MS) {
      throw usageError(`--ready-timeout 需要 0-${READY_WAIT_MAX_MS} 的毫秒数`);
    }
    timeoutMs = n;
  }
  return { waitReady, timeoutMs };
}

export function requireReadyEvidence(app, waitReady) {
  if (waitReady && !app.readyLogPattern && !app.readyUrl) {
    throw usageError('--wait-ready 需要先为应用配置 readyLogPattern 或 readyUrl（否则无法判定业务就绪）');
  }
}

// 同步等待就绪：进程提前退出立即失败；超时抛出 READY_TIMEOUT（退出码 6）并保持
// runtime 的 RUNNING 记录不变，调用方可继续用 status --ready 核验。
export async function waitForReady(home, app, cur, timeoutMs) {
  const startedAt = Date.now();
  const scanLog = createReadyLogScanner(home, app, cur);
  let last = null;
  for (;;) {
    const v = verifyRun(cur);
    if (!v.alive) {
      throw conflictError('PROCESS_EXITED', `${app.alias} 在就绪前已退出（runId=${cur.runId}），停止等待`, {
        runId: cur.runId, pid: cur.pid, status: 'STOPPED', timeoutMs, readiness: last,
      });
    }
    last = await readinessCheck(home, app, cur, { logEvidence: scanLog() });
    const waitedMs = Date.now() - startedAt;
    if (last.state === 'READY') return { ...last, waitedMs };
    if (waitedMs >= timeoutMs) {
      throw readinessTimeoutError(`${app.alias} 在 ${timeoutMs}ms 内未就绪（runId=${cur.runId}）；进程仍 RUNNING，可用 status --ready 继续核验`, {
        runId: cur.runId, pid: cur.pid, status: 'RUNNING', timeoutMs, waitedMs, readiness: last,
      });
    }
    await delay(Math.max(1, Math.min(READY_POLL_MS, timeoutMs - waitedMs)));
  }
}

export function startReadyFields(readiness) {
  return readiness
    ? { readinessUntested: false, readiness }
    : { readinessUntested: true };
}

// 管理台健康总览（GET /api/health）：对全部登记应用做一次只读评估。
// RUNNING 应用并发执行 TCP 监听探测与 readyUrl/readyLogPattern 就绪评估；
// 非 RUNNING、无就绪配置或缺少就绪证据一律明确标 UNTESTED，绝不把监听当成就绪。
// 批量核验 RUNNING 身份，避免 N 个应用产生 N 次 pwsh 冷启动；单应用损坏只降级该行。
export async function cmdHealth(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps).filter((app) => app.internalKind !== 'scenario-workbench-v1');
  const prefetched = new Map();
  const runtimes = new Map();
  const pending = [];
  for (const app of apps) {
    try {
      const rt = readRuntimeStrict(ctx.home, app.appId);
      runtimes.set(app.appId, rt);
      const cur = rt?.current;
      if (cur && cur.managed && cur.phase === 'RUNNING' && cur.pid != null && cur.creationFileTime && cur.image) {
        pending.push({ appId: app.appId, pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image, kind: cur.kind, loggerPid: cur.loggerPid, loggerCreationFileTime: cur.loggerCreationFileTime });
      }
    } catch (e) {
      runtimes.set(app.appId, e);
    }
  }
  // 组合探针一次完成核验 + logger 采集（health 不需要监听/资源段）；
  // 失败回退批量核验 + logger 按需探测，语义不变。
  let probe = null;
  if (pending.length) {
    try {
      probe = probeComposite({ verify: pending, capture: pendingProbeSpec(pending).capture });
    } catch { probe = null; }
  }
  const verifyResults = probe?.verify ?? null;
  if (verifyResults) {
    pending.forEach((p, i) => {
      const result = verifyResults[i];
      if (!result) return;
      prefetched.set(p.appId, result);
      try { cacheVerifyResult(p, interpretVerifyResult(result)); } catch { /* error 结果不缓存 */ }
    });
  } else if (pending.length) {
    try {
      const results = verifyRuns(pending);
      pending.forEach((p, i) => {
        if (!results[i]) return;
        prefetched.set(p.appId, results[i]);
        try { cacheVerifyResult(p, interpretVerifyResult(results[i])); } catch { /* error 结果不缓存 */ }
      });
    } catch { /* 批量失败回退逐条核验 */ }
  }
  const loggerCapOf = loggerCapLookup(probe);

  const rows = await Promise.all(apps.map(async (app) => {
    const base = {
      alias: app.alias, appId: app.appId, expectedPort: Number.isInteger(app.expectedPort) ? app.expectedPort : null,
    };
    let rt;
    let st;
    try {
      const cached = runtimes.get(app.appId);
      if (cached instanceof Error) throw cached;
      ({ rt, st } = statusWithFacts(ctx.home, app.appId, prefetched.get(app.appId) ?? null, cached, loggerCapOf(cached?.current)));
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

// status --resources（#111）：只对 RUNNING 受管实例做一次有界采样；非 RUNNING 明确说明不采样，
// 绝不因采样失败改变状态或退出码。sampled 为组合探针预取的平台采样（undefined = 未预取，
// 走原有单独采样路径）。
function statusResources(st, cur, sampled) {
  const pid = st.status === 'RUNNING' ? (st.pid ?? cur?.pid) : null;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { available: false, reason: `非 RUNNING（${st.status}），不采样资源用量` };
  }
  const [result] = sampleRunResources(
    [{ pid, kind: cur?.kind ?? 'direct', verified: true, creationFileTime: cur?.creationFileTime, image: cur?.image }],
    sampled !== undefined && sampled !== null ? { sampled } : {},
  );
  return result ?? { available: false, reason: '资源采样不可用' };
}

// 管理台时间序列采样：只读 runtime 记录 + 一次采样，跳过 registry 全量解析与身份核验。
// 用于详情展开时 2s 一次的高频采样；pid 取自刚读到的运行记录，复用窗口极小。
// 控制类操作仍走 status/verify 全链路，这里只服务于只读曲线。
export function sampleAppUsage(home, ref) {
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const alias = app?.alias ?? ref;
  const rt = readRuntimeStrict(home, appId);
  const cur = rt?.current ?? null;
  if (!cur || !cur.managed) return { alias, available: false, reason: '当前无受管运行实例' };
  if (!Number.isInteger(cur.pid) || cur.pid <= 0) return { alias, available: false, reason: '运行记录无可用 pid' };
  const [r] = sampleRunResources([{ pid: cur.pid, kind: cur.kind ?? 'direct', verified: true, creationFileTime: cur.creationFileTime, image: cur.image }]);
  return { alias, runId: cur.runId ?? null, ...(r ?? { available: false, reason: '采样不可用' }) };
}

export async function cmdStatus(ctx, ref, probeRequested = false, readyRequested = false, portsRequested = false, resourcesRequested = false) {
  if (!ref) throw usageError('status 需要 <alias|appId>');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const collectPorts = probeRequested || portsRequested;
  // 组合探针：RUNNING 记录需要的 核验 + logger 采集 + 监听枚举 + 资源采样 合并为一次
  // pwsh（Windows）。核验完成前不知道进程是否真 RUNNING——按记录投机采集（全部只读），
  // 消费端仍按核验后的 st.status 取舍；已退出/复用 pid 的多余结果直接丢弃，输出语义不变。
  const rt0 = readRuntimeStrict(ctx.home, appId);
  const cur0 = rt0?.current;
  const spec = {};
  // 全部投机段限定在记录 phase=RUNNING：只有 RUNNING 记录才可能核验为 RUNNING、
  // 才可能消费 logger/端口/资源段；STOPPED 记录投机采集只会白白多起一次 pwsh。
  const runningRecord = cur0?.managed && cur0.phase === 'RUNNING' && Number.isInteger(cur0.pid);
  if (runningRecord && cur0.creationFileTime && cur0.image) {
    spec.verify = [{ pid: cur0.pid, creationFileTime: cur0.creationFileTime, image: cur0.image }];
  }
  if (runningRecord && Number.isInteger(cur0?.loggerPid) && cur0.loggerPid > 0 && cur0.loggerCreationFileTime) {
    spec.capture = [cur0.loggerPid];
  }
  if (runningRecord && collectPorts) {
    spec.listening = [cur0.pid];
  }
  if (runningRecord && resourcesRequested) {
    spec.resources = { items: [{ id: cur0.pid, tree: (cur0.kind ?? 'direct') === 'command' }] };
  }
  const probe = Object.keys(spec).length ? probeComposite(spec) : null;
  // 只有确实预取过 logger 身份（有 loggerCreationFileTime 才进 spec.capture）才传预取结果；
  // 否则保持 undefined，loggerAliveNote 走原 kill(0)+按需 capture 路径，语义不回退。
  const loggerCapture = probe && spec.capture
    ? ((probe.capture ?? []).find((c) => c.pid === cur0.loggerPid) ?? { result: 'error', code: 'missing' })
    : undefined;
  const { rt, st } = statusWithFacts(ctx.home, appId, probe?.verify?.[0] ?? null, rt0, loggerCapture);
  const cur = rt && rt.current;
  const evidenceFile = runtimePath(ctx.home, appId);
  const portListening = probeRequested && Number.isInteger(app.expectedPort) ? await tcpListening(app.expectedPort) : null;
  // 实际端口是 pid→监听端口枚举（#107），只在进程被核验为 RUNNING 时查询：
  // 已停止的旧记录不会因 PID 复用而误报新进程的端口。
  let actualPorts = null;
  let actualPortsError = null;
  if (collectPorts) {
    actualPorts = [];
    const probePid = st.status === 'RUNNING' ? (st.pid ?? cur?.pid ?? null) : null;
    if (Number.isInteger(probePid)) {
      const section = probe?.listening;
      if (section?.result === 'ok') {
        actualPorts = uniqueListeningPorts((section.rows ?? []).filter((r) => r.pid === probePid));
      } else if (section != null) {
        actualPortsError = `${section.code ?? 'PORT_PROBE_FAILED'}: ${section.message ?? '端口探测失败'}`;
      } else {
        try { actualPorts = uniqueListeningPorts(listListeningPorts(probePid)); }
        catch (e) { actualPortsError = `${e.code ?? 'PORT_PROBE_FAILED'}: ${e.message}`; }
      }
    }
  }
  const portMismatch = collectPorts && Number.isInteger(app.expectedPort)
    ? actualPorts.length > 0 && !actualPorts.includes(app.expectedPort)
    : false;
  const readiness = readyRequested && st.status === 'RUNNING' ? await readinessCheck(ctx.home, app, cur)
    : readyRequested ? { state: 'UNTESTED', configured: Boolean(app.readyLogPattern || app.readyUrl), evidence: [], note: '非 RUNNING，不就绪评估' } : null;
  const jrebelEvidence = cur?.mode === 'jrebel' ? extractJrebelEvidence(ctx.home, appId, cur) : null;
  const resources = resourcesRequested ? statusResources(st, cur, probe?.resources ?? undefined) : null;
  const runExit = cur?.exit ?? null;
  const runExitSummary = exitSummary(cur);
  return {
    alias: app.alias, appId, entry: app.entry, mode: app.mode, root: app.root,
    status: st.status, managed: st.managed ?? false,
    tags: app.tags ?? [],
    env: displayEnv(app.env ?? {}),
    pid: st.pid ?? cur?.pid ?? null,
    runtimeFile: evidenceFile,
    expectedPort: app.expectedPort,
    exit: runExit,
    exitSummary: runExitSummary,
    portNote: probeRequested ? '端口监听仅为 TCP 证据；监听 ≠ 业务就绪；actualPorts 为受管进程实际监听端口' : '使用 --probe 执行本机 TCP 监听探测与 pid→实际端口枚举',
    ...(probeRequested ? { portListening } : {}),
    ...(collectPorts ? { actualPorts, portMismatch, ...(actualPortsError ? { actualPortsError } : {}) } : {}),
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
      exit: runExit, exitSummary: runExitSummary, wrapperExit: cur.wrapperExit ?? null,
      exitWatchError: cur.exitWatchError ?? null,
      restartPolicy: cur.restartPolicy ?? app.restartPolicy ?? 'never',
      maxRestarts: cur.maxRestarts ?? app.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      backoffMs: cur.backoffMs ?? app.backoffMs ?? DEFAULT_BACKOFF_MS,
      restartCount: cur.restartCount ?? 0,
      restartState: cur.restartState ?? null,
      nextRestartAt: cur.nextRestartAt ?? null,
      lastExit: cur.lastExit ?? null,
      restartEvents: cur.restartEvents ?? [],
      notifiedAt: cur.notifiedAt ?? null, notifyResult: cur.notifyResult ?? null,
      evidenceFile,
    } : null,
    ...(readiness ? { readiness } : {}),
    ...(resources ? { resources } : {}),
    readinessUntested: st.status === 'RUNNING' && readiness?.state !== 'READY',
    note: st.note ?? null,
    loggerNote: st.loggerNote ?? null,
    prevRuns: (rt?.prevRuns ?? []).slice(0, 5),
  };
}
