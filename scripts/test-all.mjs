#!/usr/bin/env node
/**
 * 发现式冒烟入口：自动执行 test/ 下全部 *.mjs 测试，不再手工维护名单。
 *
 * 用法：node scripts/test-all.mjs [-j 并发数] [测试名...]
 *   无参数：运行目录下所有测试（排除 SKIP 中的辅助文件/手动压测）。
 *   带参数：只运行指定测试，可写 cli-smoke 或 cli-smoke.mjs。
 *   -j/--jobs N：并发执行最多 N 个测试（默认 1 串行）。各测试用独立临时 home
 *     与 OS 分配端口，可安全并行；全局进程枚举类测试（EXCLUSIVE）留到并行批
 *     结束后单独串行，避免负载抖动。输出按测试缓冲、完成即整段打印，不交叉。
 *   --list-json：只打印测试名单 JSON（CI 矩阵用），不执行。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agent-app-manager', 'scripts', 'test');
// platform.mjs / lib.mjs 是测试辅助库（无可执行断言）；locks-stress 是手动压测，不进自动套件。
const SKIP = new Set(['platform.mjs', 'lib.mjs', 'locks-stress.mjs']);

const all = fs.readdirSync(TEST_DIR)
  .filter((n) => n.endsWith('.mjs') && !SKIP.has(n))
  .sort();
const args = process.argv.slice(2);
if (args[0] === '--list-json') {
  console.log(JSON.stringify(all));
  process.exit(0);
}

// -j/--jobs 参数：取参数值本身或后一个位置参数
let jobs = 1;
const wanted = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const m = /^-j(\d+)?$/.exec(a) ?? /^--jobs(?:=(\d+))?$/.exec(a);
  if (m) {
    const n = Number(m[1] ?? args[++i]);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`-j/--jobs 需要 >=1 的整数并发数（收到：${m[1] ?? args[i - 1]}）`);
      process.exit(2);
    }
    jobs = n;
    continue;
  }
  wanted.push(a);
}
jobs = Math.min(jobs, os.cpus().length || 4);

const tests = wanted.length
  ? wanted.map((w) => (w.endsWith('.mjs') ? w : `${w}.mjs`))
  : all;
const unknown = tests.filter((t) => !all.includes(t));
if (unknown.length) {
  console.error(`未知测试：${unknown.join(', ')}（可选：${all.join(', ')}）`);
  process.exit(2);
}

// 大测试先起跑，缩短尾部空窗：串行模式下顺序不影响总时长，并行下收益明显
const HEAVY_FIRST = ['runtime-smoke.mjs', 'manager-smoke.mjs', 'discovery-redaction-smoke.mjs', 'env-smoke.mjs'];
// 全局进程枚举/时间窗敏感的测试在并行负载下会抖动（pwsh 冷启动被拖慢、
// 哨兵时序被其他测试的进程活动干扰），并行模式下留到最后单独串行
const EXCLUSIVE = new Set(['windows-tree-smoke.mjs', 'discovery-redaction-smoke.mjs']);
const queue = [...tests].sort((a, b) =>
  (HEAVY_FIRST.includes(b) ? HEAVY_FIRST.indexOf(b) : HEAVY_FIRST.length) -
  (HEAVY_FIRST.includes(a) ? HEAVY_FIRST.indexOf(a) : HEAVY_FIRST.length));

const runOne = (test) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(TEST_DIR, test)], { env: process.env });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('error', (e) => resolve({ test, status: -1, error: e, out }));
  c.on('exit', (status, signal) => resolve({ test, status, signal, out }));
});

if (jobs === 1) {
  // 串行：输出直通终端，保留与 CI 历史一致的观感
  for (const test of tests) {
    console.log(`\n=== ${test} ===`);
    const r = spawnSync(process.execPath, [path.join(TEST_DIR, test)], { stdio: 'inherit', env: process.env });
    if (r.error || r.signal || r.status !== 0) {
      console.error(`\n${test} 失败（status=${r.status}${r.signal ? `, signal=${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}）`);
      process.exit(1);
    }
  }
  console.log(`\n全部 ${tests.length} 个冒烟测试通过`);
} else {
  // 并行：每个测试的输出缓冲成一段，完成即整段打印（多段不交叉）；
  // 失败不中止在跑的测试，全部结束后汇总。
  // EXCLUSIVE 中的测试先不入队，并行批结束后逐个串行跑
  const parallel = queue.filter((t) => !EXCLUSIVE.has(t));
  const exclusive = queue.filter((t) => EXCLUSIVE.has(t));
  const failures = [];
  const report = (r) => {
    process.stdout.write(`\n=== ${r.test} ===\n${r.out}`);
    if (r.error || r.signal || r.status !== 0) {
      failures.push(`${r.test}（status=${r.status}${r.signal ? `, signal=${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}）`);
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < parallel.length) report(await runOne(parallel[next++]));
  };
  await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, worker));
  for (const test of exclusive) report(await runOne(test));
  if (failures.length) {
    console.error(`\n${failures.length} 个冒烟测试失败：${failures.join('；')}`);
    process.exit(1);
  }
  console.log(`\n全部 ${tests.length} 个冒烟测试通过（-j ${jobs}）`);
}
