// 命令参数解析：CLI 各命令共享的 --name value/flag/multi 选项约定。
import { usageError } from '../errors.mjs';

// ---------- 简单选项解析 ----------

export function parseNamed(args, spec) {
  const single = new Map();
  const multi = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const kind = spec[a];
    if (kind === 'flag') {
      flags.add(a);
    } else if (kind === 'value') {
      const v = args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      single.set(a, v);
    } else if (kind === 'multi') {
      const v = args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      multi.set(a, [...(multi.get(a) ?? []), v]);
    } else if (a.startsWith('--')) {
      throw usageError(`未知选项：${a}`);
    } else {
      positional.push(a);
    }
  }
  return {
    get: (k) => single.get(k) ?? multi.get(k)?.[0],
    getAll: (k) => multi.get(k) ?? (single.has(k) ? [single.get(k)] : []),
    has: (k) => single.has(k) || multi.has(k) || flags.has(k),
    positional,
  };
}
