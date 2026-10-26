// 生命周期命令：start-new/start/stop/restart/cleanup-wrapper。除 start-new 的登记写外，
// 生命周期命令均在 manager.mjs 的 per-app advisory lock 内执行。
import { registryPath, readRegistry, readRuntimeStrict, atomicWriteJson } from '../store.mjs';
import { usageError, notFoundError, conflictError } from '../errors.mjs';
import { loadManagedDesc, canonicalizeDesc, realpathOrConflict, resolveExe, computeAppId, upsertApp } from '../desc.mjs';
import { psProc, verifyRun, listDescendants, portConflict, TERMINATE_WAIT_MS, invalidateVerifyCache } from '../probe.mjs';
import { withLock, withLockAsync, withRegistryLock } from '../locks.mjs';
import { resolveAppId, writeRuntime, resolveUnresolvedRun, parseAckRunId } from '../runtime.mjs';
import { launchManaged, cleanupWrapper } from '../launch.mjs';
import { prepareLaunchEnv } from '../env.mjs';
import { parseNamed } from './common.mjs';
import { parseReadyOptions, requireReadyEvidence, waitForReady, startReadyFields, cmdStatus } from './diagnose.mjs';

export async function cmdStartNew(ctx) {
  const opts = parseNamed(ctx.rest, {
    '--desc': 'value', '--ack-unresolved': 'value', '--force': 'flag',
    '--wait-ready': 'flag', '--ready-timeout': 'value',
  });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const readyOpts = parseReadyOptions(opts);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const desc = canonicalizeDesc(loadManagedDesc(opts.get('--desc')));
  requireReadyEvidence(desc, readyOpts.waitReady); // 启动前拒绝，不产生任何进程或登记副作用
  const appId = computeAppId(desc.root, desc.entry);
  return withLockAsync(ctx.home, appId, 'start-new', async () => {
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
    const preparedEnv = prepareLaunchEnv(desc);
    const portEvidence = portConflict(desc.expectedPort, opts.has('--force'));
    const app = withRegistryLock(ctx.home, 'start-new', () => {
      const reg = readRegistry(ctx.home);
      const a = upsertApp(reg, appId, desc);
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null, preparedEnv });
    const readiness = readyOpts.waitReady
      ? await waitForReady(ctx.home, app, cur, readyOpts.timeoutMs)
      : null;
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind,
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      ...(cur.wrapperPid ? { wrapperPid: cur.wrapperPid } : {}),
      ...startReadyFields(readiness), logPaths: cur.logPaths,
      ...(cur.envWarnings?.length ? { envWarnings: cur.envWarnings, ...(cur.envWarning ? { envWarning: cur.envWarning } : {}) } : {}),
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: readiness
        ? '已同步等待就绪：进程 RUNNING 且已有 READY 证据；证据不是业务功能验收'
        : '进程存活不等于业务就绪；就绪与 JRebel/热加载验证按 SKILL 规程另行执行',
    };
  });
}

// 公开 start：已登记应用复用保存的配置，从任意目录启动
export async function cmdStart(ctx, ref) {
  if (!ref) throw usageError('start 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), {
    '--ack-unresolved': 'value', '--force': 'flag',
    '--wait-ready': 'flag', '--ready-timeout': 'value',
  });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const readyOpts = parseReadyOptions(opts);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'start', async () => {
    const app = readRegistry(ctx.home).apps[appId];
    if (!app.exe && !app.command) {
      throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置；需 Skill 重新分析该项目并走 start-new`);
    }
    requireReadyEvidence(app, readyOpts.waitReady); // 先于任何写操作/启动
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
    const preparedEnv = prepareLaunchEnv({ ...app, cwd });
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'));
    const appForLaunch = withRegistryLock(ctx.home, 'start', () => {
      const reg = readRegistry(ctx.home);
      const a = reg.apps[appId];
      a.cwd = cwd;
      a.exe = exe;
      a.updatedAt = new Date().toISOString();
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, appForLaunch, { abandonRunId: abandon?.runId ?? null, preparedEnv });
    const readiness = readyOpts.waitReady
      ? await waitForReady(ctx.home, appForLaunch, cur, readyOpts.timeoutMs)
      : null;
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind, source: 'saved-config',
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      ...startReadyFields(readiness), logPaths: cur.logPaths,
      ...(cur.envWarnings?.length ? { envWarnings: cur.envWarnings, ...(cur.envWarning ? { envWarning: cur.envWarning } : {}) } : {}),
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: readiness
        ? '复用已保存启动配置并同步等待就绪；READY 证据不是业务功能验收'
        : '复用已保存启动配置；进程存活不等于业务就绪',
    };
  });
}

// --tree 快照：目标身份核验通过后按 PPID 向下枚举当时仍在的后代（含多级），
// 各自用 capture 采集 pid+创建时间+映像。只向下、不向上，不认领外部进程。
function snapshotTree(cur) {
  const rows = listDescendants(cur.pid);
  const snapshot = [];
  for (const row of rows) {
    const pid = Number.isInteger(row) ? row : row?.pid;
    if (!Number.isInteger(pid) || pid <= 0 || pid === cur.pid) continue;
    try {
      const id = psProc('capture', { id: pid });
      if (id.result === 'ok') snapshot.push({ pid, creationFileTime: id.creationFileTime, image: id.image });
    } catch { /* 后代可能已自行退出；跳过不报错 */ }
  }
  return snapshot;
}

// 目标已确认退出后，按快照逐个同句柄核验+终止；已退出或 PID 已复用的后代会返回
// exited/notfound/mismatch。已退出/不存在不报错并记入 treeKilled 证据（快照中的后代已不在），
// mismatch 表示 PID 已复用为其他进程，绝不触碰也不记入。逆 BFS 顺序先杀深层后代，减少中间层退出后的 reparent。
function terminateTreeSnapshot(snapshot) {
  const killed = [];
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const item = snapshot[i];
    let t;
    try {
      t = psProc('terminate', { id: item.pid, creationFileTime: item.creationFileTime, image: item.image });
    } catch { continue; }
    if (t.result === 'terminated' || t.result === 'exited' || t.result === 'notfound') killed.push({ pid: item.pid, image: item.image });
  }
  return killed;
}

// 停止核心逻辑：返回 {result: stopped|alreadyStopped} 或抛错；调用方负责落账。
// opts.tree：连带终止目标后代进程（#39）；opts.graceMs：先发优雅信号等待，超时仍存活再强杀。
function stopCurrent(home, appId, app, rt, opts = {}) {
  const cur = rt.current;
  if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供停止`);
  if (cur.phase === 'STARTING') throw conflictError('IDENTITY_UNKNOWN', `启动阶段记录（runId=${cur.runId}），身份未采集完成，拒绝停止；证据已保留`);
  if (cur.phase === 'UNKNOWN') throw conflictError('IDENTITY_UNKNOWN', `状态 UNKNOWN（${cur.lastError ?? '原因不明'}），拒绝停止；人工核验后可重新 start`);
  if (cur.phase === 'BACKOFF') {
    // 自动重启等待中：没有存活目标。落 STOPPED 即取消监督重启（timer/attempt 会复核 phase）。
    cur.phase = 'STOPPED';
    cur.stopRequested = true;
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '人为 stop：已取消 BACKOFF 中的自动重启';
    cur.restartState = null;
    cur.nextRestartAt = null;
    writeRuntime(home, appId, rt);
    return { result: 'stopped', runId: cur.runId, pid: cur.pid ?? null, restartCancelled: true };
  }
  if (cur.phase === 'DEAD') {
    return { result: 'alreadyStopped', runId: cur.runId, pid: cur.pid ?? null, note: '重启策略已耗尽（DEAD），无自动重启进程' };
  }
  if (cur.phase === 'STOPPED') {
    // status 查询可能先把崩溃落成 STOPPED；人为 stop 仍要显式压制待处理的自动重启。
    if (!cur.stopRequested) {
      cur.stopRequested = true;
      writeRuntime(home, appId, rt);
    }
    return { result: 'alreadyStopped', runId: cur.runId };
  }
  // --tree 必须在终止目标前快照后代（Linux 目标退出后会 reparent）。先核验目标身份再枚举，
  // 避免 PID 复用后把无关进程的后代当成目标后代；目标后续核验失败时不会触碰快照。
  let treeSnapshot = null;
  if (opts.tree) {
    treeSnapshot = [];
    const v = psProc('verify', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
    if (v.result === 'ok') treeSnapshot = snapshotTree(cur);
  }
  const markStopped = (note, extra = {}, killTree = false, exitEvidence = null) => {
    cur.phase = 'STOPPED';
    cur.stopRequested = true;
    cur.endedAt = new Date().toISOString();
    cur.exitNote = note;
    if (exitEvidence) cur.exit = { ...exitEvidence, at: cur.endedAt };
    invalidateVerifyCache(cur.pid); // 终止后立即作废缓存存活结论，避免 stop→start 竞态读到旧值
    cleanupWrapper(rt); // 命令模式：先清理残留 wrapper，再处理目标后代
    const treeKilled = opts.tree ? (killTree && treeSnapshot ? terminateTreeSnapshot(treeSnapshot) : []) : null;
    writeRuntime(home, appId, rt);
    return {
      result: 'stopped', runId: cur.runId, pid: cur.pid,
      ...(opts.tree ? { treeKilled, killedPids: treeKilled.map((k) => k.pid) } : {}),
      ...extra,
    };
  };
  if (opts.graceMs != null) {
    const g = psProc('grace', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image, waitMs: opts.graceMs });
    if (g.result === 'gracefulTerminated') {
      // 只证明“发出 SIGTERM 后目标在窗口内退出”，不能据此断言目标被信号终止：
      // 目标可能捕获 SIGTERM 后以 code=0 正常退出。真实退出结果由 log-writer（直连）
      // 或 exit-watcher（command 模式目标）在观察到实际退出事件后写入。
      return markStopped(`grace 窗口 ${opts.graceMs}ms 内优雅退出（SIGTERM/WM_CLOSE）`, {}, true);
    }
    if (g.result !== 'stillAlive') {
      // gracefulTerminated/stillAlive 之外的结果视同普通 terminate 结果走下面分支
      if (g.result === 'exited' || g.result === 'notfound') {
        return { ...markStopped('进程已自行退出'), result: 'alreadyStopped' };
      }
      if (g.result === 'mismatch') {
        return { ...markStopped('进程退出后 PID 被复用；未触碰新进程'), result: 'alreadyStopped',
          note: '原实例已退出，PID 已被其他进程复用，未触碰新进程' };
      }
      cur.phase = 'UNKNOWN';
      cur.lastError = `grace_failed: ${JSON.stringify(g)}`;
      writeRuntime(home, appId, rt);
      throw conflictError('IDENTITY_UNKNOWN', `优雅停止探测失败（${g.code ?? g.result}），标记 UNKNOWN，拒绝进一步操作`, { runId: cur.runId, detail: g });
    }
    // stillAlive：grace 超时，继续走下面的强制终止路径
  }
  const t = psProc('terminate', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
  if (t.result === 'terminated') {
    const graceNote = opts.graceMs != null ? `；已先等待 grace ${opts.graceMs}ms 未退出` : '';
    // stop 自己发出的有界强杀也是目标退出事实：command 模式下 wrapper 的 exit 不能
    // 代表目标，这里先在锁内落下受管目标的信号/137 语义证据，后续 logger 仅能补写同类。
    const forcedExit = process.platform === 'linux'
      ? { code: null, signal: 'SIGKILL', source: 'manager-stop' }
      : { code: 137, signal: null, source: 'manager-stop' };
    return markStopped(`terminated(137) 有界强制停止${opts.tree ? '（--tree）' : ''}${graceNote}`, {}, true, forcedExit);
  }
  if (t.result === 'exited' || t.result === 'notfound') {
    return { ...markStopped('进程已自行退出'), result: 'alreadyStopped' };
  }
  if (t.result === 'mismatch') {
    // 记录的实例已退出，该 PID 现属其他进程：不触碰，落账退出
    return { ...markStopped('进程退出后 PID 被复用；未触碰新进程'), result: 'alreadyStopped',
      note: '原实例已退出，PID 已被其他进程复用，未触碰新进程' };
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

// 命令模式失败（UNKNOWN）后清理残留 wrapper：只终止已记录身份的同进程，
// 不改变 UNKNOWN 证据；目标候选与后代由人工处置（后代清理见 #39）。
export function cmdCleanupWrapper(ctx, ref) {
  if (!ref) throw usageError('cleanup-wrapper 需要 <alias|appId>');
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'cleanup-wrapper', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cur = rt.current;
    if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供 wrapper 清理`);
    if (cur.phase !== 'UNKNOWN') {
      throw conflictError('CONFLICT', `仅 UNKNOWN 记录可清理 wrapper（当前 phase=${cur.phase}）`);
    }
    if (!Number.isInteger(cur.wrapperPid) || !cur.wrapperCreationFileTime || !cur.wrapperImage) {
      throw conflictError('IDENTITY_UNKNOWN', `runId=${cur.runId} 缺少完整 wrapper 身份证据，拒绝清理`, { runId: cur.runId, wrapperPid: cur.wrapperPid ?? null });
    }
    // Linux 的 sh 可能 exec 成目标（image 改变但 starttime 不变）：此时该 PID 已经是
    // 目标候选而非 wrapper。必须同时核验创建时间与记录的 wrapper 映像，映像变化
    // （含 exec）一律拒绝并留给人工核验，避免 cleanup-wrapper 误杀目标进程。
    let now;
    try { now = psProc('capture', { id: cur.wrapperPid }); }
    catch (e) { now = { result: 'error', message: e.message }; }
    if (now.result === 'exited' || now.result === 'notfound') {
      cur.wrapperCleaned = true;
      cur.wrapperCleanupAt = new Date().toISOString();
      cur.wrapperCleanupResult = now.result;
      writeRuntime(ctx.home, appId, rt);
      return { appId, alias: app.alias, runId: cur.runId, wrapperPid: cur.wrapperPid, result: now.result, note: 'wrapper 已退出；UNKNOWN 证据保留' };
    }
    if (now.result !== 'ok'
      || String(now.creationFileTime) !== String(cur.wrapperCreationFileTime)
      || String(now.image) !== String(cur.wrapperImage)) {
      throw conflictError('IDENTITY_UNKNOWN', `wrapper(pid=${cur.wrapperPid}) 身份与记录不一致（创建时间或映像已变，可能已 exec 成目标），拒绝清理；未触碰任何进程`, { runId: cur.runId, wrapperPid: cur.wrapperPid, recordedImage: cur.wrapperImage, capture: now });
    }
    let t;
    try { t = psProc('terminate', { id: cur.wrapperPid, creationFileTime: now.creationFileTime, image: now.image, freeze: true }); }
    catch (e) { t = { result: 'error', message: e.message }; }
    if (t.result === 'mismatch') {
      throw conflictError('IDENTITY_UNKNOWN', `wrapper(pid=${cur.wrapperPid}) 在终止前身份发生变化（${t.field ?? 'unknown'}），拒绝清理且未标记完成；UNKNOWN 证据保留`, { runId: cur.runId, wrapperPid: cur.wrapperPid, detail: t });
    }
    if (t.result === 'terminated' || t.result === 'exited' || t.result === 'notfound') {
      cur.wrapperCleaned = true;
      cur.wrapperCleanupAt = new Date().toISOString();
      cur.wrapperCleanupResult = t.result;
      writeRuntime(ctx.home, appId, rt);
      return {
        appId, alias: app.alias, runId: cur.runId, wrapperPid: cur.wrapperPid, result: t.result,
        note: 'wrapper 已清理；UNKNOWN 证据与 prevRuns 保留，确认目标已退出后可用 --ack-unresolved 恢复',
      };
    }
    if (t.result === 'terminateTimeout') {
      throw conflictError('TERMINATE_TIMEOUT', `wrapper(pid=${cur.wrapperPid}) 终止超时，未确认退出`, { runId: cur.runId, wrapperPid: cur.wrapperPid });
    }
    throw conflictError('IDENTITY_UNKNOWN', `wrapper 清理失败（${t.code ?? t.result}）`, { runId: cur.runId, detail: t });
  });
}
// --grace 参数校验：stop/restart 共用（Number() 严格解析，3000abc 不豁免为 3000）。
// ui /api/lifecycle 也复用同一校验，避免命令行与 UI 的参数契约分叉。
export function parseGraceMsValue(raw) {
  if (raw == null) return null;
  const graceMs = Number(raw);
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 600000) {
    throw usageError('--grace 需要 0-600000 的毫秒数');
  }
  return graceMs;
}

function parseGraceMs(opts) {
  if (!opts.has('--grace')) return null;
  return parseGraceMsValue(opts.get('--grace'));
}

export function cmdStop(ctx, ref) {
  if (!ref) throw usageError('stop 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--tree': 'flag', '--grace': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const graceMs = parseGraceMs(opts);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'stop', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    return { appId, alias: app.alias, ...stopCurrent(ctx.home, appId, app, rt, { tree: opts.has('--tree'), graceMs }) };
  });
}

export async function cmdRestart(ctx, ref) {
  if (!ref) throw usageError('restart 需要 <alias|appId>');
  // --tree/--grace 透传给停旧实例那一步：等价于 stop --tree/--grace + start 的组合。
  const opts = parseNamed(ctx.rest.slice(1), {
    '--force': 'flag', '--tree': 'flag', '--grace': 'value',
    '--wait-ready': 'flag', '--ready-timeout': 'value',
  });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const graceMs = parseGraceMs(opts);
  const readyOpts = parseReadyOptions(opts);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'restart', async () => {
    const app = readRegistry(ctx.home).apps[appId];
    if (!app.exe && !app.command) throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置`);
    requireReadyEvidence(app, readyOpts.waitReady); // 必须先校验：否则会先停旧实例再报用法错误
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
    // 环境校验必须在停止旧实例之前：缺失 envRefs/envFile 不可读时不得先停后败。
    const preparedEnv = prepareLaunchEnv({ ...app, cwd });
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'), rt.current.pid);
    const stopResult = stopCurrent(ctx.home, appId, app, rt, { tree: opts.has('--tree'), graceMs }); // 必须确认退出才继续；抛错则中止，绝不先起后停
    const appForLaunch = withRegistryLock(ctx.home, 'restart', () => {
      const reg = readRegistry(ctx.home);
      const a = reg.apps[appId];
      a.cwd = cwd;
      a.exe = exe;
      a.updatedAt = new Date().toISOString();
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, appForLaunch, { preparedEnv });
    const readiness = readyOpts.waitReady
      ? await waitForReady(ctx.home, appForLaunch, cur, readyOpts.timeoutMs)
      : null;
    return {
      appId, alias: app.alias, stop: stopResult,
      start: { runId: cur.runId, pid: cur.pid, status: 'RUNNING', ...startReadyFields(readiness), logPaths: cur.logPaths, ...(cur.envWarnings?.length ? { envWarnings: cur.envWarnings, ...(cur.envWarning ? { envWarning: cur.envWarning } : {}) } : {}), ...(portEvidence ? { portEvidence } : {}) },
      note: readiness
        ? '已确认旧实例退出后启动新实例并同步等待就绪；READY 证据不是业务功能验收'
        : '已确认旧实例退出后启动新实例；进程存活不等于业务就绪',
    };
  });
}

// ---------- tags 分组批量启停 ----------

// 标签匹配大小写不敏感；一个应用可属于多个标签，--tag 多值按并集去重。
// 返回顺序沿用注册表插入顺序，便于多次批量操作结果稳定。
function selectAppsByTags(home, tags) {
  const wanted = new Set(tags.map((t) => String(t).toLowerCase()));
  const reg = readRegistry(home);
  return Object.values(reg.apps).filter((app) => Array.isArray(app.tags)
    && app.tags.some((t) => wanted.has(String(t).toLowerCase())));
}

// 批量语义固定为「逐条执行、失败继续、不回滚」：stop 场景尽量清理其余应用，
// start/restart 场景保留已成功部分并回报，绝不静默中断。
async function runBatch(command, tags, apps, op) {
  const results = [];
  for (const app of apps) {
    try {
      const data = await op(app);
      results.push({ ok: true, ...(data ?? {}) });
    } catch (e) {
      results.push({
        ok: false, alias: app.alias, appId: app.appId,
        error: { code: e.code ?? 'INTERNAL', message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) },
      });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return {
    batch: true, command, tags, matched: apps.length, succeeded, failed, partialFailure: failed > 0, results,
    note: '按标签逐条执行：单条失败不中断后续、不回滚已完成的应用；每条结果以 results[].ok 为准',
  };
}

function batchAppsOrNotFound(home, tags) {
  const apps = selectAppsByTags(home, tags);
  if (!apps.length) throw notFoundError(`没有应用带有标签：${tags.join(', ')}（可用 list 查看 tags）`);
  return apps;
}

export async function cmdStartByTags(ctx, tags, cleanArgs = []) {
  const apps = batchAppsOrNotFound(ctx.home, tags);
  return runBatch('start', tags, apps, (app) => cmdStart({ ...ctx, rest: [app.alias, ...cleanArgs] }, app.alias));
}

export function cmdStopByTags(ctx, tags, cleanArgs = []) {
  const parsed = parseNamed(cleanArgs, { '--tree': 'flag', '--grace': 'value' });
  parseGraceMs(parsed); // 批量前先校验一次，避免逐条重复失败
  const apps = batchAppsOrNotFound(ctx.home, tags);
  return runBatch('stop', tags, apps, (app) => cmdStop({ ...ctx, rest: [app.alias, ...cleanArgs] }, app.alias));
}

export async function cmdRestartByTags(ctx, tags, cleanArgs = []) {
  const parsed = parseNamed(cleanArgs, { '--force': 'flag', '--tree': 'flag', '--grace': 'value' });
  parseGraceMs(parsed);
  const apps = batchAppsOrNotFound(ctx.home, tags);
  return runBatch('restart', tags, apps, (app) => cmdRestart({ ...ctx, rest: [app.alias, ...cleanArgs] }, app.alias));
}

export async function cmdStatusByTags(ctx, tags, probeRequested = false, readyRequested = false) {
  const apps = batchAppsOrNotFound(ctx.home, tags);
  return runBatch('status', tags, apps, (app) => cmdStatus(ctx, app.alias, probeRequested, readyRequested));
}
