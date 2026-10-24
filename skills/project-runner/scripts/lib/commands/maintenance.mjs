// 回收域命令：prune 默认 dry-run，--apply 才删除超保留期日志/死锁残留/孤儿临时文件。
import { usageError } from '../errors.mjs';
import { planPrune, applyPrune } from '../prune.mjs';
import { parseNamed } from './options.mjs';

export function cmdPrune(ctx) {
  const opts = parseNamed(ctx.rest, { '--dry-run': 'flag', '--apply': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  if (opts.has('--dry-run') && opts.has('--apply')) throw usageError('--dry-run 与 --apply 不能同时使用');
  const dryRun = !opts.has('--apply'); // 默认 dry-run：只打印将删内容，--apply 才真正删除
  const plan = planPrune(ctx.home);
  if (!dryRun) applyPrune(plan);
  const all = [...plan.logs.flatMap((a) => a.files), ...plan.staleLocks, ...plan.tmpOrphans];
  return {
    dryRun,
    logs: plan.logs,
    staleLocks: plan.staleLocks,
    tmpOrphans: plan.tmpOrphans,
    skipped: plan.skipped,
    summary: { files: all.length, bytes: all.reduce((n, f) => n + (f.size ?? 0), 0) },
    note: dryRun ? '默认 dry-run：未删除任何文件；确认后加 --apply 执行删除' : '已删除以上文件；current 运行日志与 runtime/registry 证据一律保留',
  };
}
