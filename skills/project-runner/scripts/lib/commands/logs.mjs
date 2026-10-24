// 日志域命令：统一日志源列表与有界读取（受管批次 / 非受管线索 / .tmp），支持 follow。
// 有界 tail 实现在 ../logs.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { usageError, notFoundError } from '../errors.mjs';
import { readRuntimeStrict } from '../store.mjs';
import { resolveLogFile, listSources, resolveSource, mergeStreamTails, followLogs } from '../log-sources.mjs';
import { readTailLines } from '../logs.mjs';
import { parseNamed } from './options.mjs';

export function cmdLogs(ctx, ref) {
  if (!ref) throw usageError('logs 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag', '--src': 'value', '--list-sources': 'flag' });
  const lines = opts.has('--lines') ? Number.parseInt(opts.get('--lines'), 10) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');

  // 统一日志源列表：与 ui 的日志源选择器同一数据（run:批次 / hint:非受管线索 / tmp:.tmp 兼容日志）
  if (opts.has('--list-sources')) {
    if (opts.has('--src') || opts.has('--run') || opts.has('--stream') || opts.has('--follow')) {
      throw usageError('--list-sources 只列出日志源，不能与 --src/--run/--stream/--follow 同时使用');
    }
    return { ...listSources(ctx.home, ref), note: '用 logs <alias|appId> --src <src> 读取对应日志源（可配合 --lines/--follow）' };
  }

  // 统一日志源读取：复用 ui 的 resolveSource，--src 已完整定位文件，与 --run/--stream 互斥
  const src = opts.get('--src');
  if (src != null) {
    if (opts.has('--run') || opts.has('--stream')) throw usageError('--src 已指定日志源，不能与 --run/--stream 同时使用');
    const t = resolveSource(ctx.home, ref, src);
    if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（src=${src}）`);
    if (opts.has('--follow')) {
      if (ctx.json) throw usageError('--follow 与 --json 不兼容');
      const rt = readRuntimeStrict(ctx.home, t.appId);
      // hint/tmp 源没有受管身份，followLogs 会提示无法自动结束，直到 Ctrl+C
      followLogs(rt, t.runId, t.file, lines);
      return { following: true };
    }
    const r = readTailLines(t.file, lines);
    return { appId: t.appId, alias: t.alias, src, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
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
    return {
      appId: t.appId, alias: t.alias, runId: t.runId, stream: 'both',
      lines: mergeStreamTails(parts.stdout?.lines ?? [], parts.stderr?.lines ?? []),
      truncated: { stdout: parts.stdout?.truncated ?? false, stderr: parts.stderr?.truncated ?? false },
      skippedBytes: { stdout: parts.stdout?.skippedBytes ?? 0, stderr: parts.stderr?.skippedBytes ?? 0 },
      files,
      missingStreams: Object.keys(has).filter((s) => !has[s]),
    };
  }
  const t = resolveLogFile(ctx.home, ref, opts.get('--run'), stream);
  if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（runId=${t.runId}, stream=${t.stream}）`);
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    const rt = readRuntimeStrict(ctx.home, t.appId);
    followLogs(rt, t.runId, t.file, lines);
    return { following: true };
  }
  const r = readTailLines(t.file, lines);
  return { appId: t.appId, alias: t.alias, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
}
