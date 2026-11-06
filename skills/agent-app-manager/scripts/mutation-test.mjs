#!/usr/bin/env node
// 轻量变异测试器：验证单元测试能否"杀死"被故意改坏的源码。
// 做法：把 scripts/ 树复制到临时目录，对目标 lib 文件逐点施加一类变异，
// 用变异后的副本运行对应的 test/*.mjs；测试非零退出 = 变异体被杀死（kill），
// 测试仍全绿 = 存活（survived），存活点即测试盲区。
//
// 变异算子（行级，跳过注释行与 // 行内注释之后的内容）：
//   条件翻转：=== ↔ !==、> ↔ <=、>= ↔ <、< ↔ >=、<= ↔ >、&& ↔ ||
//   边界扰动：整数字面量 ±1（0→1，N>0→N+1 与 N-1 各一生成）
//   常量翻转：true ↔ false、null ↔ undefined
//   取反删除：删除一元 !（!x → x）
//   语句删除：整行清空（表达式语句，跳过声明/控制行——意义不明的等价变异多）
//
// 用法：
//   node scripts/mutation-test.mjs <lib文件> [测试文件...] [--limit N] [--lines a-b] [--json]
//   例：node scripts/mutation-test.mjs lib/restart.mjs test/unit-restart-notify.mjs
// 退出码：有存活变异体 → 2；全部杀死 → 0；用法错误 → 1。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// ---------- 参数 ----------
const args = process.argv.slice(2);
const files = [];
let limit = Infinity;
let lineRange = null;
let jsonOut = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--limit') { limit = Number(args[++i]); continue; }
  if (a === '--lines') { const [s, e] = args[++i].split('-').map(Number); lineRange = [s, e ?? s]; continue; }
  if (a === '--json') { jsonOut = true; continue; }
  files.push(a);
}
if (files.length < 1) {
  console.error('用法：node scripts/mutation-test.mjs <lib文件> [测试文件...] [--limit N] [--lines a-b] [--json]');
  process.exit(1);
}
const targetRel = files[0];
const targetAbs = path.resolve(SCRIPTS, targetRel);
if (!fs.existsSync(targetAbs)) { console.error(`目标不存在：${targetAbs}`); process.exit(1); }
const testFiles = files.slice(1);
if (!testFiles.length) { console.error('需要至少一个测试文件（如 test/unit-restart-notify.mjs）'); process.exit(1); }

// ---------- 行级变异点扫描 ----------

// 屏蔽行内 // 注释与字符串/模板字面量的内容，避免在文本里做无意义替换；
// 屏蔽方式是替换为等长空格：变异点索引必须仍对齐原行。模板 ${expr} 内的
// 表达式保留原字符（会照常产生变异点）。
const stripLine = (line) => {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') { out += ' '.repeat(n - i); break; } // 行注释
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch; out += q; i++;
      while (i < n && line[i] !== q) {
        if (q === '`' && line[i] === '$' && line[i + 1] === '{') {
          out += '${'; i += 2;
          let depth = 1;
          while (i < n && depth) {
            out += line[i];
            if (line[i] === '{') depth++;
            else if (line[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (line[i] === '\\') { out += ' '; i++; }
        out += ' '; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += ch; i++;
  }
  return out;
};

const BINARY_OPS = [
  ['===', '!=='], ['!==', '==='],
  ['>=', '<'], ['<=', '>'], ['>', '<='], ['<', '>='],
  ['&&', '||'], ['||', '&&'],
];
const LITERAL_FLIPS = [
  ['true', 'false'], ['false', 'true'],
  ['null', 'undefined'], ['undefined', 'null'],
];

// 计算一个变异点：返回 { kind, start, end, replacement }（基于原行字符偏移）
function mutationsInLine(line, lineNo) {
  const code = stripLine(line);
  const out = [];
  const seen = new Set();
  const push = (kind, start, end, replacement) => {
    const key = `${kind}:${start}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, line: lineNo, start, end, replacement, preview: line.slice(start, end) });
  };
  // 二元运算符：先扫三元/等号族再扫单字符，索引互斥用 seen 去重
  for (const [a, b] of BINARY_OPS) {
    let idx = 0;
    for (;;) {
      idx = code.indexOf(a, idx);
      if (idx < 0) break;
      // ===/!== 不与 = / ! 粘连；单字符 <>/&| 不与同字符或 = 粘连
      const prev = code[idx - 1] ?? '';
      const next = code[idx + a.length] ?? '';
      const ok = a.length >= 2
        ? true
        : !['<', '>', '=', '&', '|'].includes(prev) && !['<', '>', '=', '&', '|'].includes(next);
      const isEq = a === '===' || a === '!==';
      const eqOk = isEq ? (prev !== '=' && next !== '=' && prev !== '!') : true;
      if (ok && eqOk) push('op-flip', idx, idx + a.length, b);
      idx += a.length;
    }
  }
  // 常量翻转（词边界）
  for (const [a, b] of LITERAL_FLIPS) {
    const re = new RegExp(`\\b${a}\\b`, 'g');
    let m;
    while ((m = re.exec(code))) push('literal-flip', m.index, m.index + a.length, b);
  }
  // 取反删除：! 后接标识符/(/!，排除 !==（上面已覆盖）
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '!') continue;
    const nxt = code[i + 1] ?? '';
    const prev = code[i - 1] ?? '';
    if (nxt === '=' || prev === '=' || prev === '!') continue;
    if (/[A-Za-z_$(!~]/.test(nxt)) push('negation-remove', i, i + 1, '');
  }
  // 边界扰动：整数字面量（不在标识符内、不带小数点/指数）
  const numRe = /(?<![\w$.])(\d+)(?![\w.]|[eE][+-]?\d)/g;
  let m;
  while ((m = numRe.exec(code))) {
    const v = Number(m[1]);
    if (v > 1e6) continue; // 端口/字节上限这类大数 ±1 多为等价变异，跳过
    push('boundary+1', m.index, m.index + m[1].length, String(v + 1));
    if (v > 0) push('boundary-1', m.index, m.index + m[1].length, String(v - 1));
  }
  return out;
}

const source = fs.readFileSync(targetAbs, 'utf8');
const lines = source.split('\n');
const mutants = [];
let inBlockComment = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 粗糙的块注释跟踪（字符串内的 /* 罕见，可接受）
  let scan = line;
  if (inBlockComment) {
    const end = scan.indexOf('*/');
    if (end < 0) continue;
    inBlockComment = false;
    scan = scan.slice(end + 2);
  }
  const start = scan.indexOf('/*');
  if (start >= 0) {
    const end = scan.indexOf('*/', start + 2);
    if (end < 0) { inBlockComment = true; scan = scan.slice(0, start); }
    else scan = scan.slice(0, start) + scan.slice(end + 2);
  }
  if (!scan.trim() || scan.trim().startsWith('//')) continue;
  if (lineRange && (i + 1 < lineRange[0] || i + 1 > lineRange[1])) continue;
  for (const mut of mutationsInLine(line, i + 1)) mutants.push({ ...mut });
}
mutants.splice(0, Math.max(0, mutants.length - limit)); // --limit 取后 N 个（前面多为表面积小的）
if (!mutants.length) { console.error('未发现可变异点'); process.exit(1); }

// ---------- 工作副本 ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mutate-'));
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
};
copyDir(SCRIPTS, work); // scripts/ 全量拷贝（lib/test/manager-ui 都可能被测试 import）

const mutatedTarget = path.join(work, path.relative(SCRIPTS, targetAbs));
const applyMutant = (mut) => {
  const srcLines = fs.readFileSync(mutatedTarget, 'utf8').split('\n');
  const l = srcLines[mut.line - 1];
  srcLines[mut.line - 1] = l.slice(0, mut.start) + mut.replacement + l.slice(mut.end);
  fs.writeFileSync(mutatedTarget, srcLines.join('\n'));
};
const restoreTarget = () => fs.copyFileSync(targetAbs, mutatedTarget);
const syntaxOk = () => spawnSync(process.execPath, ['--check', mutatedTarget], { encoding: 'utf8' }).status === 0;

// 基线：未变异副本应全绿；否则测试本身有问题，变异结果无意义
const runTests = () => {
  for (const t of testFiles) {
    const r = spawnSync(process.execPath, [path.join(work, t)], {
      encoding: 'utf8', timeout: 120000, cwd: work,
      env: { ...process.env, PATH: '/usr/bin:/bin' }, // 避免 pyenv shim 假失败
    });
    if (r.status !== 0) return { test: t, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  return null;
};
const baseline = runTests();
if (baseline) {
  console.error(`基线失败：未变异副本的 ${baseline.test} 未通过，先修测试再谈变异。\n${baseline.output.slice(-2000)}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// ---------- 逐变异体执行 ----------
const results = [];
for (const mut of mutants) {
  applyMutant(mut);
  const valid = syntaxOk();
  const killed = valid ? !!runTests() : null; // 语法无效 = 编译即死，不算测试功劳
  results.push({ ...mut, valid, killed });
  restoreTarget();
}
fs.rmSync(work, { recursive: true, force: true });

const counted = results.filter((r) => r.valid);
const survived = counted.filter((r) => !r.killed);
const invalid = results.filter((r) => !r.valid);
const report = {
  target: targetRel,
  tests: testFiles,
  mutants: counted.length,
  killed: counted.length - survived.length,
  survived: survived.map((r) => ({ line: r.line, kind: r.kind, from: r.preview, to: r.replacement, text: lines[r.line - 1].trim() })),
  skippedInvalid: invalid.length,
  killRate: counted.length ? Math.round(((counted.length - survived.length) / counted.length) * 1000) / 10 : 0,
};
if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${targetRel}：${report.killed}/${report.mutants} 杀死（${report.killRate}%），语法无效跳过 ${invalid.length} 个`);
  for (const s of report.survived) {
    console.log(`  存活 L${s.line} [${s.kind}] ${s.from} → ${s.to}    ${s.text.slice(0, 100)}`);
  }
}
process.exit(survived.length ? 2 : 0);
