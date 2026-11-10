#!/usr/bin/env node
// lib/repo.mjs 单元测试：应用工作目录的 git 主仓库归属解析。
// 覆盖普通仓库、仓库子目录、worktree 的 gitdir 指针、submodule 继续向上、
// Paseo 工作区元数据兜底（无 .git 的 worktree）、非 Git 目录、已删除目录与空值；
// 不启动任何进程。
// 用法：node scripts/test/unit-repo.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { resolveRepoRoot } from '../lib/repo.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-unit-repo-'));
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const w = (f, c) => { mk(path.dirname(f)); fs.writeFileSync(f, c, 'utf8'); };
// 普通仓库 / worktree / submodule 的目录骨架
const repo = path.join(base, 'main-repo');
const wt = path.join(base, 'wt-feature');
const nested = path.join(repo, 'module', 'src', 'deep');
const sub = path.join(repo, 'vendor', 'sub-lib');
const plain = path.join(base, 'plain-dir');
for (const d of [path.join(repo, '.git'), path.join(repo, '.git', 'worktrees', 'wt-feature'), nested, path.join(sub, 'src'), plain]) mk(d);
w(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
w(path.join(repo, '.git', 'worktrees', 'wt-feature', 'gitdir'), `${path.join(wt, '.git')}\n`);
w(path.join(repo, '.git', 'worktrees', 'wt-feature', 'HEAD'), 'ref: refs/heads/feature-x\n');
// worktree 的 .git 是指针文件；git 在 Windows 上写正斜杠路径，这里两种都覆盖。
w(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt-feature').replace(/\\/g, '/')}\n`);
// detached HEAD（内容不是 ref 指针）：branch 解析为 null。
mk(path.join(base, 'detached-repo', '.git'));
w(path.join(base, 'detached-repo', '.git', 'HEAD'), 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n');
// submodule：gitdir 指向超级仓库的 .git/modules/<name>，应继续向上归到超级仓库。
w(path.join(repo, '.git', 'modules', 'sub-lib', 'HEAD'), 'ref: refs/heads/main\n');
w(path.join(sub, '.git'), 'gitdir: ../../../.git/modules/sub-lib\n');

// Paseo 工作区记录：无 .git 的 worktree 靠 worktreeRoot → mainRepoRoot 归组。
const paseoFile = path.join(base, 'paseo-workspaces.json');
const paseoMain = path.join(base, 'paseo-main');
const paseoWt = path.join(base, 'paseo-worktrees', 'abc', 'wt-a');
const paseoWtGone = path.join(base, 'paseo-worktrees', 'abc', 'wt-gone');
const writePaseo = (rows) => w(paseoFile, JSON.stringify(rows, null, 2));
writePaseo([
  { worktreeRoot: paseoWt.replace(/\\/g, '/'), mainRepoRoot: paseoMain, kind: 'worktree', isPaseoOwnedWorktree: true, branch: 'paseo-feat', updatedAt: '2026-11-01T00:00:00Z' },
  { worktreeRoot: paseoWtGone.replace(/\\/g, '/'), mainRepoRoot: paseoMain, kind: 'worktree', isPaseoOwnedWorktree: true, branch: 'paseo-gone-feat', updatedAt: '2026-11-02T00:00:00Z' },
  { worktreeRoot: path.join(base, 'not-owned').replace(/\\/g, '/'), mainRepoRoot: paseoMain, kind: 'worktree', isPaseoOwnedWorktree: false, updatedAt: '2026-11-03T00:00:00Z' },
  { worktreeRoot: path.join(base, 'plain-ws').replace(/\\/g, '/'), mainRepoRoot: paseoMain, kind: 'project', isPaseoOwnedWorktree: true, updatedAt: '2026-11-04T00:00:00Z' },
]);
const noPaseo = path.join(base, 'no-paseo.json');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

try {
  await check('普通仓库根返回自身与当前分支', async () => {
    assert.deepEqual(await resolveRepoRoot(repo, { paseoFile: noPaseo }), { root: path.resolve(repo), worktree: false, branch: 'main' });
  });
  await check('仓库内子目录向上归到仓库根', async () => {
    assert.deepEqual(await resolveRepoRoot(nested, { paseoFile: noPaseo }), { root: path.resolve(repo), worktree: false, branch: 'main' });
  });
  await check('worktree 归并到主仓库并标记 worktree 与各自分支', async () => {
    assert.deepEqual(await resolveRepoRoot(wt, { paseoFile: noPaseo }), { root: path.resolve(repo), worktree: true, branch: 'feature-x' });
  });
  await check('detached HEAD 返回 null 分支', async () => {
    assert.deepEqual(await resolveRepoRoot(path.join(base, 'detached-repo'), { paseoFile: noPaseo }), { root: path.resolve(path.join(base, 'detached-repo')), worktree: false, branch: null });
  });
  await check('submodule 继续向上归到超级仓库', async () => {
    assert.deepEqual(await resolveRepoRoot(path.join(sub, 'src'), { paseoFile: noPaseo }), { root: path.resolve(repo), worktree: false, branch: 'main' });
  });
  await check('尾部分隔符与大小写归一', async () => {
    assert.deepEqual(await resolveRepoRoot(repo + path.sep, { paseoFile: noPaseo }), { root: path.resolve(repo), worktree: false, branch: 'main' });
  });
  await check('非 Git 目录返回 null', async () => {
    assert.equal(await resolveRepoRoot(plain, { paseoFile: noPaseo }), null);
  });
  await check('已删除目录返回 null', async () => {
    assert.equal(await resolveRepoRoot(path.join(base, 'missing'), { paseoFile: noPaseo }), null);
  });
  await check('空值与缺失参数返回 null', async () => {
    assert.equal(await resolveRepoRoot('', { paseoFile: noPaseo }), null);
    assert.equal(await resolveRepoRoot(null, { paseoFile: noPaseo }), null);
    assert.equal(await resolveRepoRoot(undefined, { paseoFile: noPaseo }), null);
  });

  await check('Paseo worktree 记录归并到主仓库并返回记录分支', async () => {
    mk(paseoWt);
    assert.deepEqual(await resolveRepoRoot(paseoWt, { paseoFile }), { root: path.resolve(paseoMain), worktree: true, branch: 'paseo-feat' });
  });
  await check('Paseo worktree 内的子目录同样归并', async () => {
    const inner = path.join(paseoWt, 'cah-childhealth', 'server');
    mk(inner);
    assert.deepEqual(await resolveRepoRoot(inner, { paseoFile }), { root: path.resolve(paseoMain), worktree: true, branch: 'paseo-feat' });
  });
  await check('已删除的 Paseo worktree 目录仍能按记录归并', async () => {
    assert.deepEqual(await resolveRepoRoot(paseoWtGone, { paseoFile }), { root: path.resolve(paseoMain), worktree: true, branch: 'paseo-gone-feat' });
  });
  await check('非 Paseo 自建或非 worktree 记录不生效', async () => {
    mk(path.join(base, 'not-owned'));
    mk(path.join(base, 'plain-ws'));
    assert.equal(await resolveRepoRoot(path.join(base, 'not-owned'), { paseoFile }), null);
    assert.equal(await resolveRepoRoot(path.join(base, 'plain-ws'), { paseoFile }), null);
  });
  await check('git 元数据优先于 Paseo 记录', async () => {
    // wt 有 .git 指针指向 main-repo；Paseo 记录即使存在也不应覆盖 git 结论。
    assert.deepEqual(await resolveRepoRoot(wt, { paseoFile }), { root: path.resolve(repo), worktree: true, branch: 'feature-x' });
  });
  await check('Paseo 记录损坏或缺失时忽略', async () => {
    const broken = path.join(base, 'broken.json');
    w(broken, '{not-json');
    assert.equal(await resolveRepoRoot(plain, { paseoFile: broken }), null);
    assert.equal(await resolveRepoRoot(plain, { paseoFile: path.join(base, 'nope.json') }), null);
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failed) { console.error(`\nunit-repo: ${failed} 项失败`); process.exit(1); }
console.log('\nunit-repo: 全部通过');
