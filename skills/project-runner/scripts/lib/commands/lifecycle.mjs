// 生命周期域命令：首次/复用配置启动、停止、重启、wrapper 清理与登记移除。
// 启停均在 per-app advisory lock 内执行；未结记录必须显式 ack 且复核通过。
import path from 'node:path';
import { SCHEMA_VERSION } from '../constants.mjs';
import { registryPath, runtimePath, readRegistry, readRuntimeStrict, atomicWriteJson } from '../store.mjs';
import { usageError, notFoundError, conflictError } from '../errors.mjs';
import { loadManagedDesc, canonicalizeDesc, realpathOrConflict, resolveExe, computeAppId, upsertApp, newRunId } from '../desc.mjs';
import { psProc, verifyRun, portConflict, TERMINATE_WAIT_MS, invalidateVerifyCache } from '../probe.mjs';
import { withLock, withLockAsync, withRegistryLock } from '../locks.mjs';
import { resolveAppId, archiveCurrent, writeRuntime, computeStatus, resolveUnresolvedRun, parseAckRunId } from '../runtime.mjs';
import { launchManaged, cleanupWrapper } from '../launch.mjs';
import { parseNamed } from './options.mjs';

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

// 停止核心逻辑：返回 {result: stopped|alreadyStopped} 或抛错；调用方负责落账。
// opts.tree：连带终止目标后代进程（#39）；opts.graceMs：先发优雅信号等待，超时仍存活再强杀。
function stopCurrent(home, appId, app, rt, opts = {}) {
  const cur = rt.current;
  if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供停止`);
  if (cur.phase === 'STARTING') throw conflictError('IDENTITY_UNKNOWN', `启动阶段记录（runId=${cur.runId}），身份未采集完成，拒绝停止；证据已保留`);
  if (cur.phase === 'UNKNOWN') throw conflictError('IDENTITY_UNKNOWN', `状态 UNKNOWN（${cur.lastError ?? '原因不明'}），拒绝停止；人工核验后可重新 start`);
  if (cur.phase === 'STOPPED') return { result: 'alreadyStopped', runId: cur.runId };
  const markStopped = (note, extra = {}) => {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = note;
    invalidateVerifyCache(cur.pid); // 终止后立即作废缓存存活结论，避免 stop→start 竞态读到旧值
    cleanupWrapper(rt); // 命令模式：目标死后尽力清理残留 cmd wrapper
    writeRuntime(home, appId, rt);
    return { result: 'stopped', runId: cur.runId, pid: cur.pid, ...extra };
  };
  if (opts.graceMs != null) {
    const g = psProc('grace', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image, waitMs: opts.graceMs });
    if (g.result === 'gracefulTerminated') {
      return markStopped(`grace 窗口 ${opts.graceMs}ms 内优雅退出（SIGTERM/WM_CLOSE）`);
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
  const action = opts.tree ? 'terminate-tree' : 'terminate';
  const t = psProc(action, { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
  if (t.result === 'terminated') {
    const kids = Array.isArray(t.killedPids) && t.killedPids.length ? `；连带后代 ${t.killedPids.length} 个（pid: ${t.killedPids.join(',')}）` : '';
    const graceNote = opts.graceMs != null ? `；已先等待 grace ${opts.graceMs}ms 未退出` : '';
    return markStopped(`terminated(137) 有界强制停止${opts.tree ? `（--tree${kids}）` : ''}${graceNote}`,
      Array.isArray(t.killedPids) ? { killedPids: t.killedPids } : {});
  }
  if (t.result === 'exited' || t.result === 'notfound') {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程已自行退出';
    invalidateVerifyCache(cur.pid);
    cleanupWrapper(rt);
    writeRuntime(home, appId, rt);
    return { result: 'alreadyStopped', runId: cur.runId };
  }
  if (t.result === 'mismatch') {
    // 记录的实例已退出，该 PID 现属其他进程：不触碰，落账退出
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = '进程退出后 PID 被复用；未触碰新进程';
    invalidateVerifyCache(cur.pid);
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

export function cmdStop(ctx, ref) {
  if (!ref) throw usageError('stop 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--tree': 'flag', '--grace': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  let graceMs = null;
  if (opts.has('--grace')) {
    graceMs = Number.parseInt(opts.get('--grace'), 10);
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 600000) {
      throw usageError('--grace 需要 0-600000 的毫秒数');
    }
  }
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
  const opts = parseNamed(ctx.rest.slice(1), { '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
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
    const stopResult = stopCurrent(ctx.home, appId, app, rt); // 必须确认退出才继续；抛错则中止，绝不先起后停
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

// 移除注册表条目；运行记录与日志证据一律保留。仅允许无存活受管实例时移除：
// RUNNING 核验存活一律拒绝（CONFLICT）；STARTING/UNKNOWN 未结记录按既有 ack 流程（核验已退出才可放弃）。
export function cmdRemove(ctx, ref) {
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
      } else if (ackRunId) {
        // 已确认 STOPPED 的记录没有可 ack 的未结旧账：与 start 同一 ACK_MISMATCH 语义
        throw conflictError('ACK_MISMATCH',
          `当前没有 STARTING/UNKNOWN 未结记录，--ack-unresolved=${ackRunId} 不适用；请去掉该参数`,
          { ackRunId, current: { runId: rt.current.runId, phase: rt.current.phase, managed: rt.current.managed } });
      }
    }
    withRegistryLock(ctx.home, 'remove', () => {
      const regW = readRegistry(ctx.home);
      delete regW.apps[appId];
      atomicWriteJson(registryPath(ctx.home), regW);
    });
    return {
      appId, alias: app.alias, removed: true,
      runtimeFile: runtimePath(ctx.home, appId),
      logsDir: path.join(ctx.home, 'logs', appId),
      ...(abandonedRunId ? { abandonedRunId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '注册表条目已移除；运行记录与日志证据保留。超保留期历史批次日志可用 prune 回收',
    };
  });
}
