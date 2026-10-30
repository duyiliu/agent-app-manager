// 日志命令：logs 有界读取/统一日志源/跟踪。
import fs from 'node:fs';
import path from 'node:path';
import { readRuntimeStrict } from '../store.mjs';
import { usageError, notFoundError } from '../errors.mjs';
import { resolveLogFile, listSources, resolveSource, mergeStreamTails, followLogs } from '../log-sources.mjs';
import { readTailLines, filterLogEntries, parseSinceValue } from '../logs.mjs';
import { parseNamed } from './common.mjs';

const LOG_OPTION_SPEC = {
  '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag', '--src': 'value', '--list-sources': 'flag',
  '--grep': 'value', '--ignore-case': 'flag', '--context': 'value', '--since': 'value',
};

function hasLogFilterArg(opts) {
  return opts.has('--grep') || opts.has('--ignore-case') || opts.has('--context') || opts.has('--since');
}

// 内容过滤参数校验：非法正则/负数 context/无效 since 一律 usageError，不静默降级。
function parseLogFilters(opts) {
  const grep = opts.get('--grep');
  const ignoreCase = opts.has('--ignore-case');
  if (ignoreCase && grep == null) throw usageError('--ignore-case 需要与 --grep 一起使用');
  let regex = null;
  if (grep != null) {
    try { regex = new RegExp(grep, ignoreCase ? 'i' : ''); }
    catch (e) { throw usageError(`--grep 正则无效：${e.message}`); }
  }
  let context = 0;
  if (opts.has('--context')) {
    const raw = opts.get('--context');
    if (!/^\d+$/.test(raw)) throw usageError('--context 需要非负整数');
    context = Number(raw);
    if (!Number.isSafeInteger(context)) throw usageError('--context 需要非负整数');
    if (grep == null) throw usageError('--context 需要与 --grep 一起使用');
  }
  let sinceRaw = null;
  let sinceMs = null;
  if (opts.has('--since')) {
    sinceRaw = opts.get('--since');
    const parsed = parseSinceValue(sinceRaw);
    if (!parsed) throw usageError('--since 需要相对时长（如 30m/2h/1d）或行首时间戳（如 2026-10-25T10:00）');
    sinceMs = parsed.ms;
  }
  if (grep == null && sinceMs == null) return { active: false };
  return {
    active: true,
    options: { regex, context, sinceMs },
    meta: { grep, ignoreCase, context, contextSpecified: opts.has('--context'), sinceRaw },
  };
}

function withLogFilterMeta(data, filterInfo, stats) {
  if (!filterInfo.active) return data;
  const { meta } = filterInfo;
  const extra = { matched: stats.matched };
  if (meta.grep != null) { extra.grep = meta.grep; extra.ignoreCase = meta.ignoreCase; }
  if (meta.contextSpecified) extra.context = meta.context;
  if (meta.sinceRaw != null) { extra.since = meta.sinceRaw; extra.sinceSkipped = stats.noTimestamp; }
  const notes = [];
  if (meta.sinceRaw != null && stats.noTimestamp > 0) notes.push(`--since 仅按行首时间戳过滤：${stats.noTimestamp} 行无时间戳已跳过`);
  if (meta.grep != null && stats.matched === 0) notes.push('--grep 无命中');
  return { ...data, ...extra, ...(notes.length ? { note: [data.note, ...notes].filter(Boolean).join('；') } : {}) };
}

function filterSingleLog(data, filterInfo) {
  if (!filterInfo.active) return data;
  const f = filterLogEntries(data.lines, filterInfo.options);
  return withLogFilterMeta({ ...data, lines: f.lines }, filterInfo, f.stats);
}

function filterMergedLog(data, merged, filterInfo) {
  if (!filterInfo.active) return { ...data, lines: merged };
  const f = filterLogEntries(merged, {
    ...filterInfo.options,
    textOf: (entry) => entry.line,
    separator: () => ({ stream: null, line: '--' }),
  });
  return withLogFilterMeta({ ...data, lines: f.lines }, filterInfo, f.stats);
}

// Bounded log tail implementation lives in scripts/lib/logs.mjs.
export function cmdLogs(ctx, ref) {
  if (!ref) throw usageError('logs 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), LOG_OPTION_SPEC);
  const lines = opts.has('--lines') ? Number(opts.get('--lines')) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');

  // 统一日志源列表：与 ui 的日志源选择器同一数据（run:批次 / hint:非受管线索 / tmp:.tmp 兼容日志）
  if (opts.has('--list-sources')) {
    if (opts.has('--src') || opts.has('--run') || opts.has('--stream') || opts.has('--follow') || hasLogFilterArg(opts)) {
      throw usageError('--list-sources 只列出日志源，不能与 --src/--run/--stream/--follow/--grep/--context/--since 同时使用');
    }
    return { ...listSources(ctx.home, ref), note: '用 logs <alias|appId> --src <src> 读取对应日志源（可配合 --lines/--follow）' };
  }

  const filterInfo = parseLogFilters(opts);

  // 统一日志源读取：复用 ui 的 resolveSource，--src 已完整定位文件，与 --run/--stream 互斥
  const src = opts.get('--src');
  if (src != null) {
    if (opts.has('--run') || opts.has('--stream')) throw usageError('--src 已指定日志源，不能与 --run/--stream 同时使用');
    const t = resolveSource(ctx.home, ref, src);
    if (t.merged) {
      if (opts.has('--follow')) throw usageError('合并日志源不支持 --follow；请在 manager ui 选择合并源跟随');
      const parts = {};
      for (const stream of ['stdout', 'stderr']) {
        if (fs.existsSync(t.files[stream])) parts[stream] = readTailLines(t.files[stream], lines);
      }
      const merged = mergeStreamTails(parts.stdout?.lines ?? [], parts.stderr?.lines ?? []);
      const data = {
        appId: t.appId, alias: t.alias, src, runId: t.runId, stream: 'both', merged: true,
        lines: merged,
        truncated: { stdout: parts.stdout?.truncated ?? false, stderr: parts.stderr?.truncated ?? false },
        skippedBytes: { stdout: parts.stdout?.skippedBytes ?? 0, stderr: parts.stderr?.skippedBytes ?? 0 },
        files: t.files,
        missingStreams: ['stdout', 'stderr'].filter((stream) => !parts[stream]),
        orderNote: 'stdout/stderr 无统一时间戳；合并顺序为近似顺序',
      };
      if (!filterInfo.active) {
        return { ...data, lines: merged.map(({ stream, line }) => (stream === 'stderr' ? `[err] ${line}` : line)) };
      }
      const filtered = filterMergedLog(data, merged, filterInfo);
      return { ...filtered, lines: filtered.lines.map((entry) => (entry.stream === 'stderr' ? `[err] ${entry.line}` : entry.line)) };
    }
    if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（src=${src}）`);
    if (opts.has('--follow')) {
      if (ctx.json) throw usageError('--follow 与 --json 不兼容');
      const rt = readRuntimeStrict(ctx.home, t.appId);
      // hint/tmp 源没有受管身份，followLogs 会提示无法自动结束，直到 Ctrl+C
      followLogs(ctx.home, t.appId, rt, t.runId, t.file, lines, filterInfo.active ? filterInfo.options : null);
      return { following: true };
    }
    const r = readTailLines(t.file, lines);
    return filterSingleLog({ appId: t.appId, alias: t.alias, src, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file }, filterInfo);
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
    const merged = mergeStreamTails(parts.stdout?.lines ?? [], parts.stderr?.lines ?? []);
    const data = {
      appId: t.appId, alias: t.alias, runId: t.runId, stream: 'both',
      lines: merged,
      truncated: { stdout: parts.stdout?.truncated ?? false, stderr: parts.stderr?.truncated ?? false },
      skippedBytes: { stdout: parts.stdout?.skippedBytes ?? 0, stderr: parts.stderr?.skippedBytes ?? 0 },
      files,
      missingStreams: Object.keys(has).filter((s) => !has[s]),
    };
    return filterMergedLog(data, merged, filterInfo);
  }
  const t = resolveLogFile(ctx.home, ref, opts.get('--run'), stream);
  if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（runId=${t.runId}, stream=${t.stream}）`);
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    const rt = readRuntimeStrict(ctx.home, t.appId);
    followLogs(ctx.home, t.appId, rt, t.runId, t.file, lines, filterInfo.active ? filterInfo.options : null);
    return { following: true };
  }
  const r = readTailLines(t.file, lines);
  return filterSingleLog({ appId: t.appId, alias: t.alias, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file }, filterInfo);
}
