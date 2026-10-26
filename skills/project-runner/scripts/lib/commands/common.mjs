// 简单选项解析：各 cmd* 共用的 --flag/--value 解析。
import { usageError } from '../errors.mjs';

// ---------- 简单选项解析 ----------

export function parseNamed(args, spec) {
  const single = new Map();
  const multi = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inlineValue; // --x=v 语法糖：拆出内联值后与空格分隔形式同路径处理
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { inlineValue = a.slice(eq + 1); a = a.slice(0, eq); }
    }
    const kind = spec[a];
    if (kind === 'flag') {
      if (inlineValue !== undefined) throw usageError(`${a} 不接受参数`);
      flags.add(a);
    } else if (kind === 'value') {
      const v = inlineValue ?? args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      single.set(a, v);
    } else if (kind === 'multi') {
      const v = inlineValue ?? args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      multi.set(a, [...(multi.get(a) ?? []), v]);
    } else if (a.startsWith('--')) {
      throw usageError(`未知选项：${a}${inlineValue !== undefined ? `=${inlineValue}` : ''}`);
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
