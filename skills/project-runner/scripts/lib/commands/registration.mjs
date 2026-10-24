// 登记域命令：记录非受管启动尝试（仅证据与日志线索，不提供跨会话启停）。
import path from 'node:path';
import { SCHEMA_VERSION } from '../constants.mjs';
import { registryPath, readRegistry, readRuntimeStrict, atomicWriteJson } from '../store.mjs';
import { usageError, conflictError } from '../errors.mjs';
import { loadUnmanagedDesc, realpathOrConflict, computeAppId, newRunId, ENTRY_RE, MODES } from '../desc.mjs';
import { withLock, withRegistryLock } from '../locks.mjs';
import { archiveCurrent, writeRuntime } from '../runtime.mjs';
import { parseNamed } from './options.mjs';

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
      existing.mode = MODES.has(d.mode) ? d.mode : existing.mode;
      existing.updatedAt = now;
    } else {
      reg.apps[appId] = {
        appId, alias: d.alias, displayName: d.displayName ?? d.alias, root, entry,
        cwd: d.cwd ? realpathOrConflict('cwd', d.cwd) : root, mode: MODES.has(d.mode) ? d.mode : 'java',
        exe: null, args: [], command: null, expectedImage: null, discoverTimeoutMs: null,
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
