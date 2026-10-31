// 日志命令：logs 有界读取/统一日志源/跟踪。
import fs from 'node:fs';
import path from 'node:path';
import { readRuntimeStrict } from '../store.mjs';
import { usageError, notFoundError } from '../errors.mjs';
import { resolveLogFile, listSources, resolveSource, mergeStreamTails, mergeMultiTails, followLogs, followTagLogs } from '../log-sources.mjs';
import { readTailLines, filterLogEntries, parseSinceValue } from '../logs.mjs';
import { parseTagFilters } from '../desc.mjs';
import { parseNamed } from './common.mjs';
import { selectAppsByTags } from './lifecycle.mjs';

const LOG_OPTION_SPEC = {
  '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag', '--src': 'value', '--list-sources': 'flag',
  '--grep': 'value', '--ignore-case': 'flag', '--context': 'value', '--since': 'value', '--tag': 'multi',
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

// ---------- logs --tag：多应用 current 批次交错合并（#140/#144） ----------

// 每应用取 current 受管批次的 stdout/stderr（或 --stream 指定单流），先各自双流归并、
// 再按位置比例跨应用交错；JSON 行内附 appId/src 定位符，命中可直接 --src 跟进。
export function cmdLogsByTags(ctx, opts) {
  if (opts.positional.length) throw usageError('--tag 与 <alias|appId> 不能同时使用');
  if (opts.has('--src')) throw usageError('--tag 与 --src 不能同时使用');
  if (opts.has('--run')) throw usageError('--tag 按各应用 current 批次合并，与 --run 不能同时使用');
  if (opts.has('--list-sources')) throw usageError('--list-sources 限单应用，与 --tag 不能同时使用');
  const tags = parseTagFilters(opts.getAll('--tag'));
  const stream = opts.get('--stream') ?? 'both';
  if (!['stdout', 'stderr', 'both'].includes(stream)) throw usageError('--stream 只能是 stdout、stderr 或 both');
  const lines = opts.has('--lines') ? Number(opts.get('--lines')) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');
  const filterInfo = parseLogFilters(opts);
  const apps = selectAppsByTags(ctx.home, tags);
  if (!apps.length) throw notFoundError(`没有应用带有标签：${tags.join(', ')}（可用 list 查看 tags）`);
  const streams = stream === 'both' ? ['stdout', 'stderr'] : [stream];
  const skipped = [];
  const truncatedApps = [];
  const parts = [];
  const followSources = [];
  for (const app of apps) {
    let rt = null;
    try { rt = readRuntimeStrict(ctx.home, app.appId); } catch { /* 记录损坏/缺失按无可读批次跳过，不整体失败 */ }
    const cur = rt?.current;
    if (!cur || !cur.managed || !cur.runId) {
      skipped.push({ alias: app.alias, appId: app.appId, reason: '无受管运行批次' });
      continue;
    }
    const files = {};
    for (const s of streams) {
      const file = cur.logPaths?.[s] ?? path.join(ctx.home, 'logs', app.appId, `${cur.runId}.${s}.log`);
      if (fs.existsSync(file)) files[s] = file;
    }
    if (!Object.keys(files).length) {
      skipped.push({ alias: app.alias, appId: app.appId, runId: cur.runId, reason: '批次日志不存在' });
      continue;
    }
    if (opts.has('--follow')) {
      for (const [s, file] of Object.entries(files)) {
        followSources.push({
          appId: app.appId, alias: app.alias, runId: cur.runId, file, stream: s,
          managedIdentity: cur.pid != null && cur.creationFileTime && cur.image ? cur : null,
        });
      }
      continue;
    }
    const tails = {};
    for (const [s, file] of Object.entries(files)) tails[s] = readTailLines(file, lines);
    if (Object.values(tails).some((t) => t.truncated)) truncatedApps.push(app.alias);
    const mergedLines = streams.length === 2
      ? mergeStreamTails(tails.stdout?.lines ?? [], tails.stderr?.lines ?? [])
      : (tails[streams[0]]?.lines ?? []).map((line) => ({ stream: streams[0], line }));
    parts.push({ alias: app.alias, appId: app.appId, runId: cur.runId, lines: mergedLines });
  }
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    if (!followSources.length) throw notFoundError(`标签 ${tags.join(', ')} 下的应用均无可跟随的受管日志批次`);
    for (const s of skipped) process.stderr.write(`[跳过 ${s.alias}：${s.reason}]\n`);
    followTagLogs(ctx.home, followSources, lines, filterInfo.active ? filterInfo.options : null);
    return { following: true };
  }
  if (!parts.length) throw notFoundError(`标签 ${tags.join(', ')} 下的应用均无可读日志批次`);
  const merged = mergeMultiTails(parts).map((e) => ({ ...e, src: `run:${e.runId}.${e.stream}` }));
  const data = {
    tagMode: true, tags, stream, apps: parts.map((p) => ({ alias: p.alias, appId: p.appId, runId: p.runId })),
    lines: merged,
    ...(skipped.length ? { skipped } : {}),
    ...(truncatedApps.length ? { truncatedApps } : {}),
  };
  const notes = [];
  if (skipped.length) notes.push(`跳过：${skipped.map((s) => `${s.alias}（${s.reason}）`).join('、')}`);
  if (truncatedApps.length) notes.push(`以下应用日志量超上限，仅尾部窗口参与合并：${truncatedApps.join('、')}（完整内容可用 logs <alias> --src run:<runId>.<stream> 查看）`);
  if (filterInfo.active) {
    const f = filterLogEntries(merged, {
      ...filterInfo.options,
      textOf: (entry) => entry.line,
      separator: () => ({ alias: null, appId: null, runId: null, stream: null, line: '--', src: null }),
    });
    const hitApps = [...new Set(f.lines.filter((l) => l.alias).map((l) => l.alias))];
    if (hitApps.length) notes.push(`命中可用 logs <alias> --src run:<runId>.<stream> 跟进上下文（行内 src 字段）`);
    return { ...withLogFilterMeta({ ...data, lines: f.lines }, filterInfo, f.stats), ...(notes.length ? { note: notes.join('；') } : {}) };
  }
  return { ...data, ...(notes.length ? { note: notes.join('；') } : {}) };
}

// Bounded log tail implementation lives in scripts/lib/logs.mjs.
export function cmdLogs(ctx) {
  const opts = parseNamed(ctx.rest, LOG_OPTION_SPEC);
  if (opts.has('--tag')) return cmdLogsByTags(ctx, opts);
  if (opts.positional.length !== 1) throw usageError('logs 需要 <alias|appId> 或 --tag <t>');
  const ref = opts.positional[0];
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
