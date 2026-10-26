// 登记命令：record-unmanaged 登记非受管记录；remove 移除注册表条目（运行证据保留）。
import path from 'node:path';
import { SCHEMA_VERSION } from '../constants.mjs';
import { registryPath, runtimePath, readRegistry, readRuntimeStrict, atomicWriteJson } from '../store.mjs';
import { usageError, notFoundError, conflictError } from '../errors.mjs';
import { loadUnmanagedDesc, realpathOrConflict, computeAppId, newRunId, ENTRY_RE, MODES } from '../desc.mjs';
import { withLock, withRegistryLock } from '../locks.mjs';
import { resolveAppId, archiveCurrent, writeRuntime, computeStatus, resolveUnresolvedRun, parseAckRunId } from '../runtime.mjs';
import { parseNamed } from './common.mjs';

export function cmdRecordUnmanaged(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--log-hints': 'multi', '--force': 'flag' });
  const d = loadUnmanagedDesc(opts.get('--desc'));
  const root = realpathOrConflict('root', d.root);
  const entry = ENTRY_RE.test(d.entry ?? '') ? d.entry : 'default';
  const appId = computeAppId(root, entry);
  const logHints = (opts.getAll('--log-hints') ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  if (logHints.some((h) => !path.isAbsolute(h))) throw usageError('--log-hints 需要绝对路径');
  return withLock(ctx.home, appId, 'record-unmanaged', () => {
    const regResult = withRegistryLock(ctx.home, 'record-unmanaged', () => {
    const reg = readRegistry(ctx.home);
    for (const app of Object.values(reg.apps)) {
      if (app.appId !== appId && app.alias.toLowerCase() === String(d.alias).toLowerCase()) {
        throw conflictError('ALIAS_TAKEN', `别名 ${d.alias} 已被 ${app.displayName ?? app.alias}（${app.appId}）使用`);
      }
    }
    const now = new Date().toISOString();
    const existing = reg.apps[appId];
    // 同 root+entry 的 appId 与 alias 无关：非受管登记覆盖已存在的受管登记会丢失
    // 受管身份与进程追踪证据，必须显式拒绝或 --force（#49）。
    const wasManaged = !!(existing && (existing.exe || existing.command));
    if (wasManaged && !opts.has('--force')) {
      throw conflictError('ALREADY_REGISTERED',
        `appId=${appId}（root=${root}，entry=${entry}）已存在受管登记「${existing.alias}」，非受管登记会覆盖其受管身份与进程追踪证据；确认后用 --force 覆盖，或先 remove 该登记`,
        { appId, alias: existing.alias, root, entry, managed: true });
    }
    if (existing) {
      existing.alias = d.alias;
      existing.displayName = d.displayName ?? d.alias;
      // 转为非受管形态：清空受管启动能力，避免残留 exe/command 继续被当作可受管
      existing.exe = null;
      existing.args = [];
      existing.command = null;
      existing.expectedImage = null;
      existing.discoverTimeoutMs = null;
      existing.restartPolicy = 'never';
      existing.maxRestarts = null;
      existing.backoffMs = null;
      existing.mode = MODES.has(d.mode) ? d.mode : existing.mode;
      existing.tags = d.tags ?? [];
      existing.updatedAt = now;
    } else {
      reg.apps[appId] = {
        appId, alias: d.alias, displayName: d.displayName ?? d.alias, root, entry,
        cwd: d.cwd ? realpathOrConflict('cwd', d.cwd) : root, mode: MODES.has(d.mode) ? d.mode : 'java',
        tags: d.tags ?? [],
        exe: null, args: [], command: null, expectedImage: null, discoverTimeoutMs: null,
        restartPolicy: 'never', maxRestarts: null, backoffMs: null,
        envRefs: [], env: {}, expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
        sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now,
      };
    }
    atomicWriteJson(registryPath(ctx.home), reg);
    return { mode: reg.apps[appId].mode, alias: reg.apps[appId].alias, replaced: !!existing, wasManaged, now };
    });
    const rt = readRuntimeStrict(ctx.home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
    archiveCurrent(rt);
    rt.current = {
      runId: newRunId(), phase: 'UNKNOWN', managed: false, mode: regResult.mode,
      intentAt: regResult.now, startedAt: regResult.now, pid: null, creationFileTime: null, image: null,
      envResolved: [], logPaths: null, logHints,
      lastError: null, endedAt: null,
      note: 'Skill 在既有授权下执行的启动，未托管目标进程；仅记录尝试与日志线索',
    };
    writeRuntime(ctx.home, appId, rt);
    return {
      appId, alias: regResult.alias, runId: rt.current.runId,
      managed: false, status: 'UNKNOWN', logHints,
      replaced: regResult.replaced,
      ...(regResult.wasManaged ? { replacedManaged: true } : {}),
      note: regResult.wasManaged
        ? '已用 --force 覆盖同 appId 的受管登记：原受管身份与进程追踪证据不再可用（运行记录与日志证据仍保留）'
        : '非受管登记不提供 RUNNING/STOPPED 断言与跨会话启停；日志线索仅原路径关联',
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
      if (st.status === 'BACKOFF') {
        // 移除登记前先取消监督重启，避免 registry 删除后 timer 又把进程拉起。
        rt.current.phase = 'STOPPED';
        rt.current.stopRequested = true;
        rt.current.endedAt = new Date().toISOString();
        rt.current.exitNote = '人为 remove：已取消 BACKOFF 中的自动重启';
        rt.current.restartState = null;
        rt.current.nextRestartAt = null;
        writeRuntime(ctx.home, appId, rt);
      } else if (st.status === 'STOPPED' || st.status === 'DEAD') {
        // 即使是 status 刚写回的 STOPPED，也显式压制可能尚未处理的监督重启。
        if (!rt.current.stopRequested) {
          rt.current.stopRequested = true;
          writeRuntime(ctx.home, appId, rt);
        }
      }
      if (st.status === 'RUNNING') {
        throw conflictError('INSTANCE_RUNNING',
          `${app.alias} 有受管实例在运行（pid=${st.pid ?? rt.current.pid}），拒绝移除；先 stop 确认退出后再 remove`,
          { runId: rt.current.runId, pid: st.pid ?? rt.current.pid });
      }
      if (st.status !== 'STOPPED' && st.status !== 'DEAD' && st.status !== 'BACKOFF') {
        // STARTING/UNKNOWN/无法识别的 phase：未结记录，默认拒绝；显式 ack 且复核通过才归档旧账
        const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
        if (abandon) {
          archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 完整身份与日志证据保留在 prevRuns 并注明原因
          writeRuntime(ctx.home, appId, rt);
          abandonedRunId = abandon.runId;
        }
      } else if (ackRunId) {
        // 已确认 STOPPED/DEAD（或刚取消 BACKOFF）的记录没有可 ack 的未结旧账
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
