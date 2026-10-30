#!/usr/bin/env node
/**
 * 编译校验：对仓库内所有 JS/ESM 源码执行 `node --check`。
 *
 * 本仓库是零依赖的纯 Node 脚本项目，没有打包产物，因此“编译”等价于
 * 全量语法/模块解析校验，用于在 CI 中作为最轻量的准入检查。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp', 'work']);
const EXTS = new Set(['.mjs', '.js', '.cjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push({
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      message: String(err.stderr || err.message).trim(),
    });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`✗ ${file}\n${message}\n`);
  }
  console.error(`语法校验失败：${failures.length}/${files.length} 个文件`);
  process.exit(1);
}

console.log(`语法校验通过：${files.length} 个文件`);

// 版本漂移校验：package.json 与 MANAGER_VERSION 必须一致，发版漏改任一处即拒绝。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const constantsFile = path.join(ROOT, 'skills/agent-app-manager/scripts/lib/constants.mjs');
const m = /MANAGER_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(constantsFile, 'utf8'));
if (!m || m[1] !== pkg.version) {
  console.error(`版本漂移：package.json=${pkg.version} 与 MANAGER_VERSION=${m?.[1] ?? '未找到'} 不一致`);
  process.exit(1);
}
