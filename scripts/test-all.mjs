#!/usr/bin/env node
/**
 * 发现式冒烟入口：自动执行 test/ 下全部 *.mjs 测试，不再手工维护名单。
 *
 * 用法：node scripts/test-all.mjs [测试名...]
 *   无参数：运行目录下所有测试（排除 SKIP 中的辅助文件/手动压测）。
 *   带参数：只运行指定测试，可写 cli-smoke 或 cli-smoke.mjs。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agent-app-manager', 'scripts', 'test');
// platform.mjs 是测试辅助库（无可执行断言）；locks-stress 是手动压测，不进自动套件。
const SKIP = new Set(['platform.mjs', 'locks-stress.mjs']);

const all = fs.readdirSync(TEST_DIR)
  .filter((n) => n.endsWith('.mjs') && !SKIP.has(n))
  .sort();
const wanted = process.argv.slice(2);
const tests = wanted.length
  ? wanted.map((w) => (w.endsWith('.mjs') ? w : `${w}.mjs`))
  : all;
const unknown = tests.filter((t) => !all.includes(t));
if (unknown.length) {
  console.error(`未知测试：${unknown.join(', ')}（可选：${all.join(', ')}）`);
  process.exit(2);
}

for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const r = spawnSync(process.execPath, [path.join(TEST_DIR, test)], { stdio: 'inherit', env: process.env });
  if (r.error || r.signal || r.status !== 0) {
    console.error(`\n${test} 失败（status=${r.status}${r.signal ? `, signal=${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}）`);
    process.exit(1);
  }
}
console.log(`\n全部 ${tests.length} 个冒烟测试通过`);
