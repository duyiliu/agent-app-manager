// 应用工作目录的 git 仓库归属解析（管理台「工作目录」分组用）。
// 依据两类**真实元数据**，不按目录名或内容猜测：
//   1. `.git` 目录表示普通仓库根；`.git` 文件是 worktree/submodule 的 `gitdir:` 指针，
//      worktree 归并到主仓库，子目录向上归到所在仓库；
//   2. 没有 `.git` 的目录（如 Paseo 复制的 worktree）查 Paseo 工作区记录
//      `~/.paseo/projects/workspaces.json` 的 `worktreeRoot → mainRepoRoot`。
// 两者都解析不到（非 Git 目录、目录已删除、无权限）返回 null，由调用方按原目录分组。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 向上查找的层数上限：应用 root 不应深埋在仓库内的深层子目录，超过即视为非项目目录。
const MAX_DEPTH = 16;
// 主仓库内 worktree 的元数据目录：<repo>/.git/worktrees/<name>
const WORKTREE_GITDIR_RE = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/;
const PASEO_WORKSPACES_FILE = path.join(os.homedir(), '.paseo', 'projects', 'workspaces.json');

async function statOrNull(p) {
  try { return await fs.stat(p); } catch { return null; }
}

// `.git` 文件首行的 `gitdir: <path>`；相对指针按 `.git` 所在目录解析。
async function readGitdirPointer(dotGit) {
  try {
    const text = await fs.readFile(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    return m ? path.resolve(path.dirname(dotGit), m[1]) : null;
  } catch { return null; }
}

// 读 git HEAD 取当前分支：`ref: refs/heads/<name>` → 分支名；
// detached / 不可读 / 空指针一律 null（UI 不显示，不猜测）。
async function readBranch(headDir) {
  try {
    const text = await fs.readFile(path.join(headDir, 'HEAD'), 'utf8');
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(text);
    return m ? m[1] : null;
  } catch { return null; }
}

// 路径比较键：统一分隔符、去尾斜杠，Windows 盘符/UNC 路径大小写不敏感。
function normalizeKey(p) {
  const raw = String(p ?? '').trim();
  if (!raw) return '';
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(raw);
  const n = (windows ? raw.replace(/\\/g, '/') : raw).replace(/\/+$/, '');
  return windows ? n.toLowerCase() : n;
}

// Paseo 工作区记录的解析结果按文件 mtime 缓存：425 条记录 278KB，不能被每个应用的
// 列表轮询重复解析。文件不存在或损坏时返回 null，不影响其他来源。
const paseoCache = new Map();
async function loadPaseoWorktrees(file) {
  const st = await statOrNull(file);
  if (!st?.isFile()) { paseoCache.delete(file); return null; }
  const hit = paseoCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.map;
  try {
    const rows = JSON.parse(await fs.readFile(file, 'utf8'));
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      // 只认 Paseo 自己创建且仍在工作区模型里的 worktree；普通目录/历史垃圾不碰。
      if (row?.kind !== 'worktree' || row?.isPaseoOwnedWorktree !== true) continue;
      const wt = normalizeKey(row.worktreeRoot);
      const main = typeof row.mainRepoRoot === 'string' && row.mainRepoRoot.trim();
      if (!wt || !main) continue;
      // 同一 worktreeRoot 可能有多条历史记录：以 updatedAt 最新的一条为准。
      const at = Date.parse(row.updatedAt ?? '') || 0;
      const branch = typeof row.branch === 'string' && row.branch.trim() ? row.branch.trim() : null;
      const prev = map.get(wt);
      if (!prev || at >= prev.at) map.set(wt, { root: path.resolve(main), branch, at });
    }
    const value = new Map([...map].map(([k, v]) => [k, { root: v.root, branch: v.branch }]));
    paseoCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, map: value });
    return value;
  } catch { return null; }
}

// root 等于 worktreeRoot 或位于其下（应用 root 可能是 worktree 内的子目录）；
// 多层嵌套时取最长的 worktreeRoot。
function matchPaseoWorktree(root, map) {
  if (!map) return null;
  const key = normalizeKey(root);
  if (!key) return null;
  let best = null;
  for (const [wt, main] of map) {
    if (key !== wt && !key.startsWith(wt + '/')) continue;
    if (!best || wt.length > best.wt.length) best = { wt, main };
  }
  return best ? { root: best.main.root, worktree: true, branch: best.main.branch ?? null } : null;
}

/**
 * 解析 root 所属的 git 主仓库与当前分支。
 * @param {string} root 应用登记的真实工作目录
 * @param {{paseoFile?: string}} [options] 测试/特殊部署可覆盖 Paseo 工作区记录路径
 * @returns {Promise<{root: string, worktree: boolean, branch: string|null} | null>}
 *   普通仓库根返回自身；worktree 返回主仓库路径且 worktree=true；
 *   branch 为当前检出分支（detached/不可读为 null）；
 *   submodule 等其它 gitdir 指针继续向上找超级仓库；找不到返回 null。
 */
export async function resolveRepoRoot(root, { paseoFile = PASEO_WORKSPACES_FILE } = {}) {
  const start = String(root ?? '').trim();
  if (!start) return null;
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const dotGit = path.join(dir, '.git');
    const st = await statOrNull(dotGit);
    if (st?.isDirectory()) return { root: dir, worktree: false, branch: await readBranch(dotGit) };
    if (st?.isFile()) {
      const gitdir = await readGitdirPointer(dotGit);
      const m = gitdir ? WORKTREE_GITDIR_RE.exec(gitdir) : null;
      if (m) return { root: path.resolve(m[1]), worktree: true, branch: await readBranch(gitdir) };
      // 读不出指针或非 worktree（submodule / 稀疏检出等）：继续向上，找到的
      // 超级仓库才是归档单位；逐级向上自然终止于盘符根或仓库自身。
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 没有任何 git 元数据：Paseo 自己管理的 worktree（复制时可能不带 .git）。
  return matchPaseoWorktree(start, await loadPaseoWorktrees(paseoFile));
}
