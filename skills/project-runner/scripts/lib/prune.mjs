// Prune planning/execution: retention-expired run logs (incl. rotated), stale-lock
// residue, orphan atomic-write temp files and per-run pid/sink meta files.
// Always preserves current run and prevRuns-referenced runIds; read-only plan by default.
import fs from 'node:fs';
import path from 'node:path';
import { runtimePath, readRuntimeStrict } from './store.mjs';
import { withLock } from './locks.mjs';
import { ID_RE } from './desc.mjs';
import { ManagerError } from './constants.mjs';
import { dataError } from './errors.mjs';
import { RUN_LOG_FILE_RE, RUN_META_FILE_RE } from './logs.mjs';

const STALE_LOCK_RE = /^[A-Za-z0-9._-]+\.lock\.stale-\d+$/;
const TMP_ORPHAN_RE = /^\.tmp-\d+-[0-9a-f]+$/;
const TMP_ORPHAN_RECENT_MS = 60 * 1000;

const fileSizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function isSafeRegularFile(root, file) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  let current = root;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
  }
  return true;
}

// 只收集 home 内的普通文件；不跟随任何符号链接，绝不触碰 home 之外的文件
function walkHomeFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(p);
      else if (st.isFile()) out.push(p);
    }
  };
  visit(root);
  return out;
}

export function planPrune(home) {
  const plan = { home, logs: [], staleLocks: [], tmpOrphans: [], skipped: [] };
  const logsDir = path.join(home, 'logs');
  for (const appId of fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []) {
    const dir = path.join(logsDir, appId);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      plan.skipped.push({ kind: 'logs', target: dir, reason: '符号链接目录，跳过' });
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!ID_RE.test(appId)) {
      plan.skipped.push({ kind: 'logs', target: dir, reason: '目录名不是合法 appId，跳过' });
      continue;
    }
    if (!fs.existsSync(runtimePath(home, appId))) {
      plan.skipped.push({ kind: 'logs', target: dir, reason: '无运行记录可判定保留范围，跳过' });
      continue;
    }
    try {
      withLock(home, appId, 'prune', () => {
        const rt = readRuntimeStrict(home, appId); // 损坏/不兼容 → DATA_* 向上抛，prune 整体拒绝
        const retain = new Set((rt?.prevRuns ?? []).map((p) => p.runId));
        if (rt?.current?.runId) retain.add(rt.current.runId);
        const files = [];
        for (const name of fs.readdirSync(dir)) {
          const m = RUN_LOG_FILE_RE.exec(name) ?? RUN_META_FILE_RE.exec(name);
          if (!m || retain.has(m[1])) continue;
          const file = path.join(dir, name);
          if (!isSafeRegularFile(home, file)) {
            plan.skipped.push({ kind: 'logs', target: file, reason: '不是 home 内的普通文件或路径包含符号链接，跳过' });
            continue;
          }
          files.push({ runId: m[1], stream: m[2], file, size: fileSizeOf(file) });
        }
        if (files.length) plan.logs.push({ appId, files });
      });
    } catch (e) {
      // 锁忙/锁损坏/缺 pwsh：只跳过该应用的日志回收，不阻塞其余残留清理
      if (e instanceof ManagerError && ['LOCK_BUSY', 'LOCK_CORRUPT', 'PWSH_MISSING'].includes(e.code)) {
        plan.skipped.push({ kind: 'logs', target: dir, reason: `${e.code}: ${e.message}` });
        continue;
      }
      throw e;
    }
  }
  const locksDir = path.join(home, 'locks');
  for (const name of fs.existsSync(locksDir) ? fs.readdirSync(locksDir) : []) {
    if (!STALE_LOCK_RE.test(name)) continue;
    const file = path.join(locksDir, name);
    if (!isSafeRegularFile(home, file)) {
      plan.skipped.push({ kind: 'locks', target: file, reason: '不是 home 内的普通文件或路径包含符号链接，跳过' });
      continue;
    }
    plan.staleLocks.push({ file, size: fileSizeOf(file) });
  }
  const recentCutoff = Date.now() - TMP_ORPHAN_RECENT_MS;
  for (const file of walkHomeFiles(home)) {
    if (!TMP_ORPHAN_RE.test(path.basename(file))) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= recentCutoff) {
      plan.skipped.push({ kind: 'tmp', target: file, reason: '近期修改，可能是进行中的原子写，跳过' });
      continue;
    }
    plan.tmpOrphans.push({ file, size: fileSizeOf(file) });
  }
  return plan;
}

export function applyPrune(plan) {
  const apply = (items, kind) => {
    const removed = [];
    for (const item of items) {
      try {
        if (!isSafeRegularFile(plan.home, item.file)) {
          plan.skipped.push({ kind, target: item.file, reason: '路径已变化或包含符号链接，跳过' });
          continue;
        }
        fs.unlinkSync(item.file);
        removed.push(item);
      } catch (e) {
        if (e.code === 'ENOENT') plan.skipped.push({ kind, target: item.file, reason: '删除时已不存在（可能已被并发操作清理）' });
        else throw dataError('DATA_UNWRITABLE', `回收失败（${item.file}）：${e.message}`);
      }
    }
    return removed;
  };
  for (const app of plan.logs) app.files = apply(app.files, 'logs');
  plan.logs = plan.logs.filter((a) => a.files.length);
  plan.staleLocks = apply(plan.staleLocks, 'locks');
  plan.tmpOrphans = apply(plan.tmpOrphans, 'tmp');
}
