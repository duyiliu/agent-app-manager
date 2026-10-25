#!/usr/bin/env node
// 文档一致性回归（issue #90）：锁定管理台“默认只读展示 + 显式确认的本机启停/移除、
// 无令牌、仅 127.0.0.1”口径，以及 cleanup-wrapper 的恢复边界，防止 README/design/
// SKILL/references 再次出现“只读管理台 / 一次性令牌”等过期表述。
// 用法：node skills/project-runner/scripts/test/docs-consistency.mjs（无外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const docs = {
  'README.md': read('README.md'),
  'docs/design.md': read('docs/design.md'),
  'skills/project-runner/SKILL.md': read('skills/project-runner/SKILL.md'),
  'skills/project-runner/references/manager.md': read('skills/project-runner/references/manager.md'),
  'examples/spring-boot-demo/README.md': read('examples/spring-boot-demo/README.md'),
};

const failures = [];
const includes = (file, needle) => {
  try { assert(docs[file].includes(needle), `${file} 缺少：${needle}`); }
  catch (e) { failures.push(e.message); }
};
const excludes = (file, needle) => {
  try { assert(!docs[file].includes(needle), `${file} 仍含过期表述：${needle}`); }
  catch (e) { failures.push(e.message); }
};

// README：入口描述与详情卡能力一致，不再称“统一只读”。
excludes('README.md', '统一只读 Web 管理台');
excludes('README.md', 'manager ui 只读管理台页面');
includes('README.md', '默认只读展示');
includes('README.md', '启停/移除须页面显式二次确认');
includes('README.md', '启动/停止/重启/移除');

// design：§2.2、P0+、AC08 统一为无令牌、仅本机、启停/移除走 POST /api/lifecycle。
excludes('docs/design.md', 'v1 只读');
excludes('docs/design.md', '本地只读管理台');
excludes('docs/design.md', '不提供启动/停止/重启操作');
excludes('docs/design.md', '一次性令牌');
includes('docs/design.md', '默认只读展示 + 显式确认的本机生命周期操作');
includes('docs/design.md', '无令牌');
includes('docs/design.md', 'POST `/api/lifecycle`');
includes('docs/design.md', 'cleanup-wrapper <alias|appId>');
includes('docs/design.md', '禁止把 UNKNOWN 直接当 STOPPED 重试');

// SKILL description：与 references 中的本机管理台能力一致。
excludes('skills/project-runner/SKILL.md', '只读管理台');
includes('skills/project-runner/SKILL.md', '默认只读展示，启停/移除须页面显式二次确认');
includes('skills/project-runner/SKILL.md', 'cleanup-wrapper <别名|appId>');

// references：内部入口列出 cleanup-wrapper，并写清只清 wrapper、目标候选/后代人工处置。
includes('skills/project-runner/references/manager.md', 'cleanup-wrapper <别名|appId>');
includes('skills/project-runner/references/manager.md', '只清理该 wrapper');
includes('skills/project-runner/references/manager.md', '目标候选与后代必须按进程证据人工核验处置');
includes('skills/project-runner/references/manager.md', '禁止直接把 UNKNOWN 当 STOPPED 重试');
includes('skills/project-runner/references/manager.md', '`--ack-unresolved` 仍只属于 `start`/`remove`');
// cleanup-wrapper 当前实现不接受 ack；文档不得暗示它能替代 start/remove 的 ack。
excludes('skills/project-runner/references/manager.md', 'cleanup-wrapper [--ack-unresolved');

// 示例 README 的旧端口/令牌说明已随管理台契约移除。
excludes('examples/spring-boot-demo/README.md', '8198');
excludes('examples/spring-boot-demo/README.md', '需要令牌');
includes('examples/spring-boot-demo/README.md', '127.0.0.1:8199');
includes('examples/spring-boot-demo/README.md', '无令牌');

if (failures.length) {
  for (const msg of failures) console.log(`  FAIL ${msg}`);
  process.exitCode = 1;
} else {
  console.log('  ok  文档一致性：管理台启停/无令牌与 cleanup-wrapper 恢复边界');
}
