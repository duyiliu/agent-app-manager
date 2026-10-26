// 生命周期命令：start-new/start/stop/restart/cleanup-wrapper。除 start-new 的登记写外，
// 生命周期命令均在 manager.mjs 的 per-app advisory lock 内执行。
import { registryPath, readRegistry, readRuntimeStrict, atomicWriteJson } from '../store.mjs';
import { usageError, notFoundError, conflictError } from '../errors.mjs';
import { loadManagedDesc, canonicalizeDesc, realpathOrConflict, resolveExe, computeAppId, upsertApp } from '../desc.mjs';
import { psProc, verifyRun, listDescendants, portConflict, TERMINATE_WAIT_MS, invalidateVerifyCache } from '../probe.mjs';
import { withLock, withLockAsync, withRegistryLock } from '../locks.mjs';
import { resolveAppId, writeRuntime, resolveUnresolvedRun, parseAckRunId } from '../runtime.mjs';
import { launchManaged, cleanupWrapper } from '../launch.mjs';
import { parseNamed } from './common.mjs';

export async function cmdStartNew(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const desc = canonicalizeDesc(loadManagedDesc(opts.get('--desc')));
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
    const portEvidence = portConflict(desc.expectedPort, opts.has('--force'));
    const app = withRegistryLock(ctx.home, 'start-new', () => {
      const reg = readRegistry(ctx.home);
      const a = upsertApp(reg, appId, desc);
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
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

// 公开 start：已登记应用复用保存的配置，从任意目录启动
export async function cmdStart(ctx, ref) {
  if (!ref) throw usageError('start 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'start', async () => {
    const app = readRegistry(ctx.home).apps[appId];
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
    const appForLaunch = withRegistryLock(ctx.home, 'start', () => {
      const reg = readRegistry(ctx.home);
      const a = reg.apps[appId];
      a.cwd = cwd;
      a.exe = exe;
      a.updatedAt = new Date().toISOString();
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, appForLaunch, { abandonRunId: abandon?.runId ?? null });
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
  if (cur.phase === 'STOPPED') return { result: 'alreadyStopped', runId: cur.runId };
  // --tree 必须在终止目标前快照后代（Linux 目标退出后会 reparent）。先核验目标身份再枚举，
  // 避免 PID 复用后把无关进程的后代当成目标后代；目标后续核验失败时不会触碰快照。
  let treeSnapshot = null;
  if (opts.tree) {
    treeSnapshot = [];
    const v = psProc('verify', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
    if (v.result === 'ok') treeSnapshot = snapshotTree(cur);
  }
  const markStopped = (note, extra = {}, killTree = false) => {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = note;
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
    return markStopped(`terminated(137) 有界强制停止${opts.tree ? '（--tree）' : ''}${graceNote}`, {}, true);
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
    // Linux 的 sh 可能 exec 成目标（image 改变但 starttime 不变）：先按记录核验
    // starttime，再用当前 image 调 terminate，避免把 exec 误判为身份不符。
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
    if (now.result !== 'ok' || String(now.creationFileTime) !== String(cur.wrapperCreationFileTime)) {
      throw conflictError('IDENTITY_UNKNOWN', `wrapper(pid=${cur.wrapperPid}) 身份与记录不一致，拒绝清理；未触碰任何进程`, { runId: cur.runId, wrapperPid: cur.wrapperPid, capture: now });
    }
    let t;
    try { t = psProc('terminate', { id: cur.wrapperPid, creationFileTime: now.creationFileTime, image: now.image }); }
    catch (e) { t = { result: 'error', message: e.message }; }
    if (t.result === 'terminated' || t.result === 'exited' || t.result === 'notfound' || t.result === 'mismatch') {
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
function parseGraceMs(opts) {
  if (!opts.has('--grace')) return null;
  const graceMs = Number(opts.get('--grace'));
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 600000) {
    throw usageError('--grace 需要 0-600000 的毫秒数');
  }
  return graceMs;
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
  const opts = parseNamed(ctx.rest.slice(1), { '--force': 'flag', '--tree': 'flag', '--grace': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const graceMs = parseGraceMs(opts);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'restart', async () => {
    const app = readRegistry(ctx.home).apps[appId];
    if (!app.exe && !app.command) throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置`);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
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
    const cur = await launchManaged(ctx.home, appId, appForLaunch);
    return {
      appId, alias: app.alias, stop: stopResult,
      start: { runId: cur.runId, pid: cur.pid, status: 'RUNNING', readinessUntested: true, logPaths: cur.logPaths, ...(portEvidence ? { portEvidence } : {}) },
      note: '已确认旧实例退出后启动新实例；进程存活不等于业务就绪',
    };
  });
}
