#!/usr/bin/env node
// agent-app-manager 跨项目管理器（P0）
// 设计基线：docs/design.md v2。要点：
// - 只管理本 Skill 启动并记录的应用进程（Java/Python/Node/其他真实可执行进程）；外部进程绝不接管或终止。
// - 受管启停依赖 ps/proc.ps1 的"同句柄身份核验 + 终止"，防 PID 复用误杀。
// - 启动前先持久化意图（runId/STARTING），中断保留证据并拒绝自动重试。
// - 数据目录 ~/.agent-app-manager/（自动复制旧目录，或 --home 绝对路径）；注册表/运行记录带 schemaVersion，
//   损坏或不兼容版本拒绝覆盖并保留原件；写入均为临时文件 + 原子替换。
// - stdout 只输出管理结果，不混入被启动应用的日志（--follow 是用户显式要求的例外）。
//
// 本文件为 CLI 入口：参数解析、数据目录解析、输出渲染与命令分发。
// 命令实现见 lib/commands.mjs；领域逻辑见 lib/{errors,probe,locks,desc,runtime,launch,log-sources,prune,detect}.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, SCHEMA_VERSION, MANAGER_VERSION, ManagerError } from './lib/constants.mjs';
import { usageError } from './lib/errors.mjs';
import { resolveHome, migrateHome } from './lib/home.mjs';
import { legacySkillNotice } from './lib/legacy-skill.mjs';
import { detectProjects } from './lib/detect.mjs';
import {
  parseNamed, cmdList, cmdStatus, cmdPort, cmdDoctor, cmdHealth, sampleAppUsage, cmdStart, cmdStop, cmdRestart,
  cmdRemove, cmdPrune, cmdLogs, cmdStartNew, cmdRecordUnmanaged, cmdUi, cmdCleanupWrapper,
  cmdStartByTags, cmdStopByTags, cmdRestartByTags, cmdStatusByTags, cmdExport, cmdImport,
} from './lib/commands.mjs';
import { parseTagFilters } from './lib/desc.mjs';
import { resolveLogFile, listRuns, listSources, resolveSource } from './lib/log-sources.mjs';
import { cmdWorkbench } from './lib/commands/workbench.mjs';

export { SCHEMA_VERSION, MANAGER_VERSION };

// ---------- 参数与 home ----------

function parseArgv(argv) {
  const ctx = { json: false, home: null, command: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') ctx.json = true;
    else if (a === '--home') {
      ctx.home = argv[++i];
      if (!ctx.home) throw usageError('--home 需要绝对路径参数');
    } else if (ctx.command === null) ctx.command = (a === '--version' || a === '-v') ? 'version' : a;
    else ctx.rest.push(a);
  }
  if (!ctx.command || ctx.command === 'help') {
    throw usageError(usageText());
  }
  return ctx;
}

// 批量命令把 --tag 及其值从原始参数里移除，再逐条复用单应用命令的解析与校验。
function stripTagArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tag') { i++; continue; }
    if (a.startsWith('--tag=')) continue;
    out.push(a);
  }
  return out;
}

// 只读命令不创建空 home/子目录；默认 home 首次升级可复制已有旧目录。
// status 的 RUNNING→STOPPED 落账仅在 home 已存在且有记录时发生，不受影响。
const READ_ONLY_COMMANDS = new Set(['doctor', 'port', 'status', 'detect', 'list', 'logs', 'prune', 'version', 'export']);

// ---------- 输出 ----------

function emitOk(ctx, command, data) {
  if (data && data.following) return; // follow 模式由自身控制生命周期
  const out = ctx.json
    ? `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, command, data }, null, 2)}\n`
    : `${renderHuman(command, data)}\n`;
  // 输出 flush 后再退出：Windows 管道下 stdout 是异步写，立即 exit 会截断大 JSON（#22）
  process.stdout.write(out, () => process.exit(EXIT.OK));
}

function emitErr(ctx, command, e) {
  if (ctx.json) {
    const err = { code: e.code ?? 'UNKNOWN', message: e.message };
    if (e.detail !== undefined) err.detail = e.detail;
    // 同 emitOk：flush 后再退出，避免 Windows 管道截断（#22）
    process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, command, error: err }, null, 2)}\n`, () => process.exit(e.exitCode ?? 1));
    return;
  } else {
    let text = `错误[${e.code ?? 'UNKNOWN'}] ${e.message}`;
    if (e.detail) {
      // detail.stderrTail 单独按原样附在末尾，不进 JSON 转义
      const { stderrTail, ...rest } = typeof e.detail === 'object' ? e.detail : {};
      const body = typeof e.detail === 'string' ? e.detail : JSON.stringify(rest);
      text += `\n详情: ${body}`;
      if (typeof stderrTail === 'string' && stderrTail) text += `\nstderr 尾部:\n${stderrTail}`;
    }
    process.stderr.write(`${text}\n`, () => process.exit(e.exitCode ?? 1));
  }
}

function envWarnLine(names) {
  return names?.length
    ? `警告：env 中疑似机密字面值 ${names.join(', ')}（非阻断）；请改用 envRefs 或 envFile，status/ui 已对本类名称脱敏`
    : null;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}


// ---------- watch：周期采样 status/list，JSON 模式输出 NDJSON 帧流 ----------

const WATCH_DEFAULT_INTERVAL_MS = 2000;
const WATCH_MIN_INTERVAL_MS = 500;
const WATCH_MAX_INTERVAL_MS = 60000;

// --watch [--interval <ms>]：仅 watch 模式允许 --interval；间隔限制在 500-60000ms，
// 避免每帧 pwsh/proc 探测过密。未带 --watch 返回 null，保持原有单次输出现状。
function parseWatchInterval(opts) {
  if (!opts.has('--watch')) {
    if (opts.has('--interval')) throw usageError('--interval 需要与 --watch 一起使用');
    return null;
  }
  if (!opts.has('--interval')) return WATCH_DEFAULT_INTERVAL_MS;
  const raw = opts.get('--interval');
  const interval = Number(raw);
  if (!Number.isInteger(interval) || interval < WATCH_MIN_INTERVAL_MS || interval > WATCH_MAX_INTERVAL_MS) {
    throw usageError(`--interval 需要 ${WATCH_MIN_INTERVAL_MS}-${WATCH_MAX_INTERVAL_MS} 的整数（毫秒），当前：${raw}`);
  }
  return interval;
}

// 常驻循环由本进程持有：收到 SIGINT 或 stdout 管道断开时只清理定时器与监听器后正常退出。
// status/list 本身不持有应用锁；status 的退出落账在锁内同步完成，不会遗留半把锁。
async function runWatch(ctx, command, interval, firstData, produce) {
  const json = ctx.json;
  const tty = Boolean(process.stdout.isTTY);
  const renderFrame = (data) => {
    if (json) {
      // NDJSON：一行一帧，不 pretty-print，便于 jq -c / while read 逐行消费
      process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, command, data })}\n`);
      return;
    }
    if (tty) process.stdout.write('\u001b[2J\u001b[H'); // 清屏并把光标移到左上角重绘
    process.stdout.write(`${renderHuman(command, data)}\n`);
  };

  let stopped = false;
  let timer = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    process.removeListener('SIGINT', onSigint);
    resolveDone(code);
  };
  // Ctrl+C / 下游断管都立即结束本进程；watch 未持有应用锁，无需额外释放。
  // stdout 的 error 监听保留到进程退出，避免同一管道再次报错时成为未处理事件。
  const onSigint = () => { stop(EXIT.OK); process.exit(EXIT.OK); };
  const onStdoutError = (err) => {
    // 下游关闭（如 | head）时 Node 写 stdout 报 EPIPE；视作消费方主动结束，干净退出。
    const code = err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED' ? EXIT.OK : EXIT.DATA;
    stop(code);
    process.exit(code);
  };
  process.on('SIGINT', onSigint);
  process.stdout.on('error', onStdoutError);

  if (!json && !tty) process.stdout.write(`[watch] 非 TTY：逐帧输出（interval=${interval}ms，Ctrl+C 退出）\n`);

  const tick = async () => {
    if (stopped) return;
    let data;
    try {
      data = await produce();
    } catch (e) {
      if (stopped) return;
      // 中途数据损坏/目标消失：JSON 模式仍保持一行一帧的错误信封，避免污染 NDJSON；
      // 错误是终止性的，输出后退出，下一帧不再继续。
      if (json) {
        const error = { code: e.code ?? 'UNKNOWN', message: e.message };
        if (e.detail !== undefined) error.detail = e.detail;
        process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, command, error })}\n`);
      } else {
        process.stderr.write(`[watch] 帧失败[${e.code ?? 'UNKNOWN'}] ${e.message}\n`);
      }
      stop(e.exitCode ?? EXIT.DATA);
      return;
    }
    if (stopped) return;
    renderFrame(data);
    if (!stopped) timer = setTimeout(tick, interval);
  };

  renderFrame(firstData); // 立即给出首帧，不等待一个 interval
  if (!stopped) timer = setTimeout(tick, interval);
  process.exitCode = await done;
}

function renderHuman(command, data) {
  if (data?.batch) return renderBatch(command, data);
  switch (command) {
    case 'migrate': {
      const legacy = legacySkillNotice(data.legacySkills);
      return `旧目录：${data.source}\n新目录：${data.target}\n操作：${data.action}（${data.reason}）${data.evidence.length ? `\n阻塞证据：${JSON.stringify(data.evidence)}` : ''}${legacy ? `\n${legacy}` : ''}`;
    }
    case 'version':
      return `agent-app-manager manager v${data.version}`;
    case 'list': {
      if (!data.apps?.length) return data.note ?? '（空）';
      const exitText = (a) => a.exit
        ? (a.exit.signal ? `signal=${a.exit.signal}` : `code=${a.exit.code ?? '?'}`)
        : '-';
      const head = 'alias'.padEnd(14) + 'mode'.padEnd(8) + 'status'.padEnd(10) + 'managed'.padEnd(9) + 'pid'.padEnd(8) + 'port'.padEnd(7) + 'rss'.padEnd(9) + 'exit'.padEnd(14) + 'tags'.padEnd(18) + 'lastRunId';
      const rows = data.apps.map((a) =>
        String(a.alias).padEnd(14) + String(a.mode ?? '').padEnd(8) + String(a.status).padEnd(10)
        + String(a.managed ?? '?').padEnd(9) + String(a.pid ?? '-').padEnd(8) + String(a.expectedPort ?? '-').padEnd(7)
        + String(a.memoryBytes != null ? fmtBytes(a.memoryBytes) : '-').padEnd(9)
        + exitText(a).padEnd(14) + String((a.tags ?? []).join(',') || '-').padEnd(18) + String(a.lastRunId ?? '-')
        + (a.error ? `\n  ! ${a.error}` : '')
        + (a.exitSummary ? `\n  exit: ${a.exitSummary}` : ''));
      return [head, ...rows].join('\n');
    }
    case 'port':
      return [`端口 ${data.port}`, ...data.occupants.map((p) => `PID=${p.pid} process=${p.processName ?? '-'} path=${p.executablePath ?? '-'} started=${p.startedAt ?? '-'} identity=${p.identity?.result ?? 'unknown'}`), data.note].join('\n');
    case 'doctor':
      return JSON.stringify(data, null, 2);
    case 'health':
      return [
        `health checkedAt=${data.checkedAt ?? '-'} total=${data.summary?.total ?? data.apps?.length ?? 0} running=${data.summary?.running ?? '-'}`,
        ...(data.apps ?? []).map((a) => `  ${String(a.alias).padEnd(24)} status=${String(a.status).padEnd(8)} listening=${a.listening == null ? '-' : a.listening} ready=${a.state}`),
      ].join('\n');
    case 'status':
      return [
        `${data.alias} (${data.appId}) mode=${data.mode} status=${data.status} managed=${data.managed}${data.pid ? ` pid=${data.pid}` : ''}`,
        (data.tags ?? []).length ? `tags=${data.tags.join(',')}` : null,
        data.run ? `run=${data.run.runId} phase=${data.run.phase} managed=${data.run.managed} started=${data.run.startedAt ?? '-'}` : 'run=无',
        data.run?.pid != null ? `pid=${data.run.pid}${data.run.creationFileTime ? ` creationFileTime=${data.run.creationFileTime}` : ''}${data.run.image ? ` image=${data.run.image}` : ''}` : null,
        data.run?.exit ? `exit: ${data.run.exit.signal ? `signal=${data.run.exit.signal}` : `code=${data.run.exit.code ?? '?'}`}${data.run.exit.at ? ` at=${data.run.exit.at}` : ''}${data.run.exitSummary ? `（${data.run.exitSummary}）` : ''}` : null,
        Object.keys(data.env ?? {}).length ? `env=${JSON.stringify(data.env)}` : null,
        data.run?.lastError ? `lastError: ${data.run.lastError}` : null,
        data.run?.restartPolicy && data.run.restartPolicy !== 'never'
          ? `restart=${data.run.restartPolicy} ${data.run.restartCount ?? 0}/${data.run.maxRestarts ?? '?'} state=${data.run.restartState ?? '-'} backoff=${data.run.backoffMs ?? '?'}ms${data.run.nextRestartAt ? ` next=${data.run.nextRestartAt}` : ''}`
          : null,
        data.run?.logPaths?.stdout ? `stdout=${data.run.logPaths.stdout}` : null,
        data.run?.logPaths?.stderr ? `stderr=${data.run.logPaths.stderr}` : null,
        data.run?.logHints?.length ? `logHints=${data.run.logHints.join(', ')}` : null,
        data.portListening !== undefined ? `portListening=${data.portListening}（监听 ≠ 业务就绪）` : null,
        data.actualPorts !== undefined ? `actualPorts=${data.actualPorts.length ? data.actualPorts.join(',') : '[]'}${data.portMismatch ? `（与 expectedPort=${data.expectedPort} 不一致）` : ''}` : null,
        data.resources
          ? data.resources.available
            ? `resources=${fmtBytes(data.resources.rssBytes)} rss（${data.resources.scope === 'tree' ? '含后代聚合' : '仅目标进程'}，${data.resources.processCount} 个进程，CPU ${Number(data.resources.cpuPercent ?? 0).toFixed(1)}%，采样窗口 ${data.resources.intervalMs}ms）`
            : `resources 不可用：${data.resources.reason ?? '原因不明'}`
          : null,
        (data.dependsOn ?? []).length ? `dependsOn=${data.dependsOn.join(',')}` : null,
        (data.dependedBy ?? []).length ? `dependedBy=${data.dependedBy.join(',')}（stop 默认不停依赖方；连带停止用 stop --with-dependents）` : null,
        data.jrebelEvidence ? `jrebelEvidence=${JSON.stringify(data.jrebelEvidence)}` : null,
        data.runtimeFile ? `证据: ${data.runtimeFile}` : null,
        ...(data.prevRuns ?? []).map((p) => `prev=${p.runId} phase=${p.phase}${p.archiveReason ? ` archiveReason=${p.archiveReason}` : ''}${p.pid != null ? ` pid=${p.pid}` : ''} archivedAt=${p.archivedAt}`),
        data.readinessUntested ? '就绪未检测：进程存活不等于业务就绪' : null,
        ...(data.history ?? []).map((h) => `history: ${h.runId} phase=${h.phase ?? '-'} outcome=${h.outcome} started=${h.startedAt ?? '-'} ended=${h.endedAt ?? '-'}${h.durationMs != null ? ` 时长=${Math.round(h.durationMs / 1000)}s` : ''}${h.exit ? ` exit=${h.exit.signal ? `signal=${h.exit.signal}` : `code=${h.exit.code ?? '?'}`}` : ''}${h.archiveReason ? ` archiveReason=${h.archiveReason}` : ''}`),
        data.stats ? `stats: 已结束 ${data.stats.runs} 批次（正常 ${data.stats.normalStops ?? 0} / 人工停 ${data.stats.stoppedByUser ?? 0} / 崩溃 ${data.stats.crashes ?? 0}${data.stats.dead ? ` 含DEAD ${data.stats.dead}` : ''} / 未知 ${data.stats.unknown ?? 0} / 证据缺失 ${data.stats.evidenceMissing ?? 0}）${data.stats.avgDurationMs != null ? ` 平均时长 ${Math.round(data.stats.avgDurationMs / 1000)}s` : ''}${data.stats.lastCrash ? ` 最近崩溃 ${data.stats.lastCrash.at} run=${data.stats.lastCrash.runId}` : ''}` : null,
        data.note ? `note: ${data.note}` : null,
      ].filter(Boolean).join('\n');
    case 'start-new':
    case 'start':
      if (data.dryRun) return renderLaunchPlan(data);
      return [
        `已启动（受管）${data.alias} (${data.appId})`,
        `run=${data.runId} pid=${data.pid} status=${data.status}`,
        data.dependsOn ? `依赖先行：已启动 ${data.dependsOn.started.join(',') || '无'}${data.dependsOn.skipped.length ? `；已在运行 ${data.dependsOn.skipped.join(',')}` : ''}` : null,
        envWarnLine(data.envWarnings),
        data.readiness ? `readiness=${data.readiness.state} waited=${data.readiness.waitedMs}ms evidence=${JSON.stringify(data.readiness.evidence)}` : null,
        data.portEvidence?.forced ? data.portEvidence.note : null,
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `stdout=${data.logPaths.stdout}`,
        `stderr=${data.logPaths.stderr}`,
        data.note ?? '',
        '观察：manager ui 可在浏览器查看全部受管应用与日志，并可对本机受管应用执行启动/停止/重启/移除（页面二次确认；Ctrl+C 退出）',
      ].filter(Boolean).join('\n');
    case 'export':
      return [
        `已导出 ${data.appCount} 条登记 → ${data.file}${data.tags ? `（tags=${data.tags.join(',')}）` : ''}`,
        ...(data.redactedEnv ?? []).map((r) => `  ${r.appId}: 未导出敏感 env 键 ${r.keys.join(',')}`),
        data.note ?? null,
      ].filter(Boolean).join('\n');
    case 'import':
      return [
        data.dryRun ? `import 预览：将导入 ${data.wouldImport.length} 条，跳过 ${data.skipped.length} 条` : `已导入 ${data.imported.length} 条登记，跳过 ${data.skipped.length} 条`,
        ...(data.dryRun ? data.wouldImport : data.imported).map((i) => `  + ${i.alias} (${i.appId})${i.replaces ? ' 覆盖同appId' : ''}${i.evictsAliasOwner ? ` 取代 ${i.evictsAliasOwner}` : ''}`),
        ...(data.skipped ?? []).map((s) => `  - 跳过 ${s.alias} (${s.appId})：${s.reason}`),
        ...(data.warnings ?? []).map((w) => `  ! ${w}`),
        data.note ?? null,
      ].filter(Boolean).join('\n');
    case 'record-unmanaged':
      return [
        `已记录非受管启动 ${data.alias} (${data.appId}) run=${data.runId}`,
        data.logHints?.length ? `日志线索: ${data.logHints.join(', ')}` : null,
        '观察：非受管日志在项目 .tmp 下，可在 manager ui 的日志源中选择查看',
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'stop':
      return `${(data.dependentsStopped ?? []).map((s) => `stop 依赖方 ${s.alias}: ${s.result}`).join('\n')}${data.dependentsStopped?.length ? '\n' : ''}stop ${data.alias}: ${data.result}${data.runId ? ` (run=${data.runId})` : ''}${data.treeKilled?.length ? `；后代已终止 ${data.treeKilled.length} 个` : ''}${data.note ? `；${data.note}` : ''}`;
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
      for (const a of data.logs) for (const f of a.files) { any = true; const kind = /^(stdout|stderr)$/.test(f.stream) ? '超保留期批次日志' : '超保留期运行元文件'; lines.push(`- [${kind}] ${f.file}（${f.size} 字节，run=${f.runId}.${f.stream}，appId=${a.appId}）`); }
      for (const f of data.staleLocks) { any = true; lines.push(`- [死锁残留] ${f.file}（${f.size} 字节）`); }
      for (const f of data.tmpOrphans) { any = true; lines.push(`- [孤儿临时文件] ${f.file}（${f.size} 字节）`); }
      for (const s of data.skipped) lines.push(`  跳过 ${s.target}：${s.reason}`);
      if (!any) lines.push(data.dryRun ? '无可回收残留' : '无文件被删除');
      lines.push(`共 ${data.summary.files} 个文件 / ${data.summary.bytes} 字节${data.dryRun ? '可回收' : '已删除'}`);
      return lines.join('\n');
    }
    case 'restart':
      if (data.dryRun) return renderLaunchPlan(data);
      return [
        `restart ${data.alias}: stop=${data.stop.result} → start run=${data.start.runId} pid=${data.start.pid} status=${data.start.status}`,
        envWarnLine(data.start.envWarnings),
        data.start.readiness ? `readiness=${data.start.readiness.state} waited=${data.start.readiness.waitedMs}ms evidence=${JSON.stringify(data.start.readiness.evidence)}` : null,
        `stdout=${data.start.logPaths.stdout}`,
        data.start.portEvidence?.forced ? data.start.portEvidence.note : null,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'logs': {
      if (data.tagMode) {
        const body = data.lines.map((l) => (l?.alias ? `[${l.alias}]${l.stream === 'stderr' ? '[err]' : ''} ${l.line}` : (l?.line ?? String(l)))).join('\n');
        return data.note ? `${body}${body ? '\n' : ''}${data.note}` : body;
      }
      if (data.sources) {
        return [
          `${data.alias} (${data.appId}) 的日志源（* 为当前运行）：`,
          ...data.sources.map((s) => `${s.current ? '*' : ' '} ${s.src}  ${s.kind}${s.stream ? `/${s.stream}` : ''}  ${s.size} 字节  ${s.label}`),
          data.note ?? null,
        ].filter(Boolean).join('\n');
      }
      if (data.stream === 'both') {
        const body = data.lines.map((l) => (l?.stream ? `[${l.stream}] ${l.line}` : (typeof l === 'string' ? l : l.line))).join('\n');
        const missing = data.missingStreams?.length ? `${body}${body ? '\n' : ''}（无 ${data.missingStreams.join('/')} 日志文件）` : body;
        return data.note ? `${missing}${missing ? '\n' : ''}${data.note}` : missing;
      }
      const body = data.lines.join('\n');
      return data.note ? `${body}${body ? '\n' : ''}${data.note}` : body;
    }
    default:
      return JSON.stringify(data, null, 2);
  }
}

function renderBatch(command, data) {
  const lines = [`批量 ${command} tags=${data.tags.join(',')}：匹配 ${data.matched}，成功 ${data.succeeded}，失败 ${data.failed}`];
  for (const r of data.results) {
    if (!r.ok) {
      lines.push(`- ${r.alias} (${r.appId}) 失败[${r.error.code}] ${r.error.message}`);
      continue;
    }
    if (command === 'status') {
      lines.push(...renderHuman('status', r).split('\n').map((line) => `- ${line}`));
    } else if (command === 'start' || command === 'start-new') {
      lines.push(`- ${r.alias} (${r.appId}) RUNNING run=${r.runId} pid=${r.pid}`);
    } else if (command === 'stop') {
      lines.push(`- ${r.alias} (${r.appId}) ${r.result}${r.runId ? ` run=${r.runId}` : ''}${r.treeKilled?.length ? ` 后代已终止 ${r.treeKilled.length} 个` : ''}`);
    } else if (command === 'restart') {
      lines.push(`- ${r.alias} (${r.appId}) stop=${r.stop?.result} → run=${r.start?.runId} pid=${r.start?.pid} status=${r.start?.status}`);
    } else {
      lines.push(`- ${r.alias} (${r.appId}) ok`);
    }
  }
  lines.push(data.note);
  return lines.join('\n');
}

function renderLaunchPlan(data) {
  const plan = data.start ?? data;
  const lines = [
    `dry-run ${data.start ? '重启' : '启动'}计划（未取锁/未写 registry/runtime/未 spawn）：${data.alias} (${data.appId})`,
  ];
  if (data.currentRun) {
    lines.push(`当前实例: run=${data.currentRun.runId} phase=${data.currentRun.phase} pid=${data.currentRun.pid ?? '-'}`);
  }
  if (data.stop) {
    lines.push(`停止计划: ${data.stop.expected}（run=${data.stop.runId}）${data.stop.tree ? '；--tree 连带后代' : ''}${data.stop.graceMs != null ? `；--grace ${data.stop.graceMs}ms` : ''}`);
  }
  lines.push(`kind=${plan.kind} mode=${plan.mode} source=${plan.source}`);
  lines.push(`cwd=${plan.cwd}`);
  if (plan.exe) lines.push(`exe=${plan.exe}`);
  if (plan.command) {
    lines.push(`command=${plan.command}`);
    lines.push(`expectedImage=${plan.expectedImage ?? '-'}${plan.discoverTimeoutMs != null ? ` discoverTimeoutMs=${plan.discoverTimeoutMs}` : ''}`);
  }
  if (plan.args?.length) lines.push(`args=${JSON.stringify(plan.args)}`);
  lines.push(`envRefs=${plan.envRefs.length ? plan.envRefs.map((e) => `${e.name}:${e.present ? '命中' : '缺失'}`).join(', ') : '（无）'}`);
  if (plan.envNames.length) lines.push(`env=${plan.envNames.join(', ')}（仅名称，值不回显）`);
  lines.push(`expectedPort=${plan.expectedPort ?? '-'}${plan.port.conflict ? `（冲突：${plan.port.occupants?.length ?? 0} 个占用者${plan.port.forced ? '，--force 已允许继续' : ''}）` : ''}`);
  if (plan.abandonRunId) lines.push(`将显式放弃未结记录 run=${plan.abandonRunId}（dry-run 不归档）`);
  lines.push(data.note ?? plan.note ?? '');
  return lines.filter(Boolean).join('\n');
}

function usageText() {
  return [
    '用法：node manager.mjs [--home <绝对路径>] [--json] <命令> [参数]',
    '',
    '命令：',
    '  migrate [--dry-run]               检查或复制旧数据目录，并列出旧 Skill 安装位置；不覆盖、不合并、不卸载',
    '  version                           显示 manager 版本号（--version/-v 同效）',
    '  list [--watch [--interval <ms>]]       列出已登记应用与实时状态（含 tags 与内存列）；--watch 周期输出全应用快照',
    '  status <alias|appId> [--probe] [--ready] [--resources] [--history] [--stats] [--watch [--interval <ms>]]   单应用详情；',
    '       --probe 检测本机 TCP 监听与 pid→实际监听端口（actualPorts/portMismatch），',
    '       --ready 按 desc 的 readyLogPattern/readyUrl 评估业务就绪证据；',
    '       --resources 对当前 RUNNING 受管实例做一次 RSS/CPU 有界采样（命令模式聚合目标后代）；',
    '       --watch 周期采样，--json 时为 NDJSON（每行一帧），人类模式 TTY 清屏重绘、非 TTY 逐帧输出',
    '  status --tag <t> [--probe] [--ready]       按 tags 批量查询（逐条返回，单条失败不中断）',
    '  port <N>                           只读端口占用诊断（外部进程不接管、不停止）',
    '  doctor [--json]                    只读自检（不修复）',
    '  health                             各应用进程状态/端口监听/就绪证据总览（只读；管理台同源接口）',
    '  detect --root <dir>                 只读扫描仓库并输出启动描述候选',
    '  start <alias|appId> [--force] [--ack-unresolved <runId>] [--wait-ready [--ready-timeout <ms>]] [--dry-run]',
    '       用已保存配置启动（任意目录可用；--dry-run 只解析并打印启动计划，不取锁/不写 registry/runtime/不 spawn）',
    '  start --tag <t> [--force]                  按 tags 批量启动：逐条执行，失败继续、不回滚',
    '  stop <alias|appId> [--tree] [--grace <ms>] [--with-dependents]   停止受管实例：默认有界强制终止；--with-dependents 先按反向依赖序停依赖方；',
    '  stop --tag <t> [--tree] [--grace <ms>]       按 tags 批量停止：逐条执行，失败继续、不回滚；',
    '       --tree 连带终止全部后代进程（#39）；--grace 先发优雅信号（Linux SIGTERM /',
    '       Windows taskkill 无 /F），等待 <ms> 仍存活再走强制终止；restart 的 --tree/--grace',
    '       作用于停旧实例这一步',
    '  cleanup-wrapper <alias|appId>     清理命令模式失败后残留的 wrapper（仅 UNKNOWN 且身份完整）',
    '  restart <alias|appId> [--force] [--tree] [--grace <ms>] [--wait-ready [--ready-timeout <ms>]] [--dry-run]   确认退出后重启',
    '       （仅受管实例；--tree/--grace 作用于停旧实例这一步；--dry-run 只打印停止+启动计划，不执行）',
    '  restart --tag <t> [--force] [--tree] [--grace <ms>]       按 tags 批量重启：--tree/--grace 逐条透传给停旧实例',
    '  logs <alias|appId> [--lines N] [--stream stdout|stderr|both] [--run <runId>] [--follow]',
    '       [--src <run:…|hint:<hash>|tmp:…>] [--list-sources] [--grep <regex>] [--ignore-case]',
    '       [--context N] [--since <30m|2026-10-25T10:00>]    统一日志源（--src 与 --run/--stream 互斥；both 合并双流；',
    '       grep/context/since 可叠加，--since 按行首时间戳过滤，无时间戳行跳过并提示）',
    '  logs --tag <t> [--lines N] [--stream stdout|stderr|both] [--follow] [--grep/--context/--since 同上]',
    '       多应用 current 批次交错合并（[alias] 前缀；无批次应用跳过并注明；JSON 行内附 src 定位符）',
    '  remove <alias|appId> [--ack-unresolved <runId>]   移除登记：须无存活受管实例；运行记录与日志证据保留',
    '  prune [--dry-run] [--apply]                       回收超保留期批次日志/死锁残留/孤儿临时文件（默认 dry-run）',
    '  ui [--port N] [--open]              本地 Web 管理台（默认固定 127.0.0.1:8199，无令牌仅本机；--open 监听成功后用默认浏览器打开 URL，失败仅打印地址；Ctrl+C 退出）',
    '  workbench <status|open|stop> <alias|appId>  查询、打开或停止项目的场景测试工作台',
    '',
    '内部入口（Skill 调用，不对用户暴露注册 CRUD）：',
    '  start-new --desc <file> [--ack-unresolved <runId>] [--wait-ready [--ready-timeout <ms>]]   首次受管启动：意图→启动→身份采集→登记',
    '  record-unmanaged --desc <file> [--log-hints p1,p2] [--force]   记录非受管启动尝试（同 appId 已有受管登记时须 --force）',
    '  export --out <file> [--tag <t>]           导出登记清单（含校验和；envRefs 按引用、敏感 env 键不落明文）',
    '  import --from <file> [--dry-run] [--force] 校验清单后重建登记（只登记不启动；冲突默认跳过，--force 覆盖）',
    '',
    '启动描述 mode 取值：java | jrebel | python | node | proc（其他真实可执行进程）。',
    'desc 可选 tags（字符串数组，最多 16 个）：--tag 按标签大小写不敏感匹配；可重复 --tag 或逗号分隔取并集。',
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
    '退出码：0 成功 | 1 用法 | 2 未找到 | 3 状态冲突 | 4 环境依赖 | 5 数据损坏/内部错误（DATA_* | INTERNAL）| 6 就绪超时（READY_TIMEOUT）',
  ].join('\n');
}

// ---------- 供 manager-ui 复用的只读数据层 ----------

export { resolveHome, cmdList, cmdStatus, listRuns, resolveLogFile, listSources, resolveSource };

// ---------- 入口 ----------

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    process.stderr.write(`agent-app-manager manager 需要 Node.js 20 或更高版本；当前版本：${process.versions.node}\n`);
    process.exit(1);
  }
  let ctx;
  let command;
  try {
    ctx = parseArgv(process.argv.slice(2));
    command = ctx.command;
    // start/restart --dry-run 必须连 home 目录都不创建：命令本身不是只读命令，
    // 但该分支不取锁/不写 registry/runtime，因此按只读方式解析 home。
    const dryRunReadOnly = (command === 'start' || command === 'restart') && ctx.rest.includes('--dry-run');
    const workbenchReadOnly = command === 'workbench' && ctx.rest[0] === 'status';
    if (command !== 'migrate') ctx.home = resolveHome(ctx.home, READ_ONLY_COMMANDS.has(command) || dryRunReadOnly || workbenchReadOnly,
      { migrate: !dryRunReadOnly });
  } catch (e) {
    const c = command ?? 'cli';
    if (e instanceof ManagerError) { emitErr({ json: false }, c, e); return; }
    throw e;
  }
  try {
    let data;
    if (command === 'remove') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError(`${command} 需要 <alias|appId>`);
    } else if (command === 'cleanup-wrapper') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError('cleanup-wrapper 需要 <alias|appId>');
      if (ctx.rest.length > 1) throw usageError(`无法识别的参数：${ctx.rest[1]}`);
    }
    switch (command) {
      case 'migrate': {
        if (ctx.home) throw usageError('migrate 不支持 --home；仅迁移默认数据目录');
        if (ctx.rest.some(x => x !== '--dry-run') || ctx.rest.length > 1) throw usageError('migrate 仅支持 --dry-run');
        data = migrateHome({ dryRun: ctx.rest.includes('--dry-run') });
        break;
      }
      case 'version': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = { version: MANAGER_VERSION }; break;
      case 'list': {
        const opts = parseNamed(ctx.rest, { '--watch': 'flag', '--interval': 'value' });
        if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
        const interval = parseWatchInterval(opts);
        if (interval != null) {
          await runWatch(ctx, command, interval, cmdList(ctx), () => cmdList(ctx));
          return;
        }
        data = cmdList(ctx);
        break;
      }
      case 'status': {
      const opts = parseNamed(ctx.rest, { '--tag': 'multi', '--probe': 'flag', '--ready': 'flag', '--resources': 'flag', '--history': 'flag', '--stats': 'flag', '--watch': 'flag', '--interval': 'value' });
      const interval = parseWatchInterval(opts);
      if (opts.has('--tag')) {
        if (opts.positional.length) throw usageError('--tag 与 <alias|appId> 不能同时使用');
        if (opts.has('--history') || opts.has('--stats')) throw usageError('--history/--stats 仅用于单应用 status，不与 --tag 组合');
        const read = () => cmdStatusByTags(ctx, parseTagFilters(opts.getAll('--tag')), opts.has('--probe'), opts.has('--ready'));
        if (interval != null) {
          await runWatch(ctx, command, interval, await read(), read);
          return;
        }
        data = await read();
      } else {
        if (opts.positional.length !== 1) throw usageError('status 需要 <alias|appId> 或 --tag <t>');
        const historyFlags = (opts.has('--history') || opts.has('--stats')) ? { history: opts.has('--history'), stats: opts.has('--stats') } : null;
        const read = () => cmdStatus(ctx, opts.positional[0], opts.has('--probe'), opts.has('--ready'), false, opts.has('--resources'), historyFlags);
        if (interval != null) {
          await runWatch(ctx, command, interval, await read(), read);
          return;
        }
        data = await read();
      }
      break;
    }
      case 'port': data = cmdPort(ctx, ctx.rest[0]); break;
      case 'doctor': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = await cmdDoctor(ctx); break;
      case 'health': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = await cmdHealth(ctx); break;
      // 管理台曲线专用：只读 runtime + 一次资源采样，跳过状态核验与端口探测。
      case 'sample':
        if (ctx.rest.length !== 1) throw usageError('sample 需要 <alias|appId>');
        data = sampleAppUsage(ctx.home, ctx.rest[0]);
        break;
      case 'detect': {
        const opts = parseNamed(ctx.rest, { '--root': 'value' });
        if (opts.positional.length || !opts.get('--root')) throw usageError('detect 需要 --root <dir>');
        data = detectProjects(path.resolve(opts.get('--root')));
        break;
      }
      case 'start': {
        const opts = parseNamed(ctx.rest, { '--tag': 'multi', '--ack-unresolved': 'value', '--force': 'flag', '--dry-run': 'flag', '--wait-ready': 'flag', '--ready-timeout': 'value', '--kill-port-owner': 'value' });
        if (opts.has('--tag')) {
          if (opts.has('--kill-port-owner')) throw usageError('批量启动不支持结束端口占用进程');
          if (opts.positional.length) throw usageError('--tag 与 <alias|appId> 不能同时使用');
          if (opts.has('--ack-unresolved')) throw usageError('start --tag 不支持 --ack-unresolved：请先逐个应用核验未结记录');
          data = await cmdStartByTags(ctx, parseTagFilters(opts.getAll('--tag')), stripTagArgs(ctx.rest));
        } else {
          if (!opts.positional.length) throw usageError('start 需要 <alias|appId> 或 --tag <t>');
          data = await cmdStart(ctx, opts.positional[0]);
        }
        break;
      }
      case 'stop': {
        const opts = parseNamed(ctx.rest, { '--tag': 'multi', '--tree': 'flag', '--grace': 'value', '--with-dependents': 'flag' });
        if (opts.has('--tag')) {
          if (opts.positional.length) throw usageError('--tag 与 <alias|appId> 不能同时使用');
          data = await cmdStopByTags(ctx, parseTagFilters(opts.getAll('--tag')), stripTagArgs(ctx.rest));
        } else {
          if (!opts.positional.length) throw usageError('stop 需要 <alias|appId> 或 --tag <t>');
          data = cmdStop(ctx, opts.positional[0]);
        }
        break;
      }
      case 'cleanup-wrapper': data = cmdCleanupWrapper(ctx, ctx.rest[0]); break;
      case 'restart': {
        const opts = parseNamed(ctx.rest, { '--tag': 'multi', '--force': 'flag', '--tree': 'flag', '--grace': 'value', '--dry-run': 'flag', '--wait-ready': 'flag', '--ready-timeout': 'value' });
        if (opts.has('--tag')) {
          if (opts.positional.length) throw usageError('--tag 与 <alias|appId> 不能同时使用');
          data = await cmdRestartByTags(ctx, parseTagFilters(opts.getAll('--tag')), stripTagArgs(ctx.rest));
        } else {
          if (!opts.positional.length) throw usageError('restart 需要 <alias|appId> 或 --tag <t>');
          data = await cmdRestart(ctx, opts.positional[0]);
        }
        break;
      }
      case 'remove': data = cmdRemove(ctx, ctx.rest[0]); break;
      case 'prune': data = cmdPrune(ctx); break;
      case 'logs': data = cmdLogs(ctx); break;
      case 'start-new': data = await cmdStartNew(ctx); break;
      case 'record-unmanaged': data = cmdRecordUnmanaged(ctx); break;
      case 'export': data = cmdExport(ctx); break;
      case 'import': data = cmdImport(ctx); break;
      case 'workbench': data = await cmdWorkbench(ctx, ctx.rest[0], ctx.rest[1]); break;
      case 'ui': await cmdUi(ctx); return; // 前台常驻直到 Ctrl+C，不走 emitOk
      default: throw usageError(`未知命令：${command}\n${usageText()}`);
    }
    emitOk(ctx, command, data);
  } catch (e) {
    // 已知契约错误按 ManagerError 输出；未知内部错误用 INTERNAL code 明确区分（#57），
    // 退出码仍为 5（数据损坏/内部错误一类），但不冒充 DATA_CORRUPT。
    if (e instanceof ManagerError) emitErr(ctx, command, e);
    else emitErr(ctx, command, new ManagerError('INTERNAL', `内部错误：${e.message}`, EXIT.DATA, { stack: e.stack }));
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
