import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageError, conflictError, dataError } from './errors.mjs';
import { detectLegacySkills, noticeLegacySkillsOnce, legacySkillNotice } from './legacy-skill.mjs';

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// 副本中的历史日志路径改指向新目录；源目录和源记录完全不修改。
function rebasePaths(value, legacy, target) {
  if (typeof value === 'string' && path.isAbsolute(value)) {
    const rel = path.relative(legacy, value);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      return path.join(target, rel);
    }
  }
  if (Array.isArray(value)) return value.map(v => rebasePaths(v, legacy, target));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebasePaths(v, legacy, target)]));
  }
  return value;
}

function liveWriterEvidence(legacy) {
  const evidence = [];
  const locks = path.join(legacy, 'locks');
  if (fs.existsSync(locks)) {
    for (const name of fs.readdirSync(locks).filter(name => name.endsWith('.lock'))) {
      evidence.push({ type: 'lock', path: path.join(locks, name) });
    }
  }
  const runtime = path.join(legacy, 'runtime');
  if (!fs.existsSync(runtime)) return evidence;
  for (const name of fs.readdirSync(runtime).filter(name => name.endsWith('.json'))) {
    const current = JSON.parse(fs.readFileSync(path.join(runtime, name), 'utf8')).current;
    for (const field of ['pid', 'loggerPid', 'wrapperPid']) {
      const pid = current?.[field];
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); evidence.push({ type: 'process', field, pid, record: name }); }
      catch (e) { if (e.code !== 'ESRCH') evidence.push({ type: 'process', field, pid, record: name, probe: e.code }); }
    }
    if (current?.phase === 'STARTING' || current?.phase === 'BACKOFF') {
      evidence.push({ type: 'phase', phase: current.phase, record: name });
    }
  }
  return evidence;
}

function hasLiveWriter(legacy) { return liveWriterEvidence(legacy).length > 0; }

export function migrateHome({ userHome = os.homedir(), dryRun = false } = {}) {
  const source = path.join(userHome, '.project-runner');
  const target = path.join(userHome, '.agent-app-manager');
  const sourceExists = exists(source), targetExists = exists(target);
  const result = { source, target, sourceExists, targetExists, dryRun, evidence: [], legacySkills: [] };
  // 旧 Skill 探测独立于数据目录：两个都只报告，不删除、不阻止命令。
  try { result.legacySkills = detectLegacySkills({ userHome }); }
  catch (e) { result.legacySkillsError = e.message; }
  if (targetExists) return { ...result, action: 'none', reason: 'target_exists' };
  if (!sourceExists) return { ...result, action: 'none', reason: 'source_missing' };
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw dataError('HOME_MIGRATION_FAILED', `旧数据目录不是普通目录：${source}`);
  try { result.evidence = liveWriterEvidence(source); }
  catch (e) { throw dataError('HOME_MIGRATION_FAILED', `无法检查旧数据目录：${source}`, { cause: e.message }); }
  if (exists(`${target}.migration.lock`)) result.evidence.push({ type: 'migration_lock', path: `${target}.migration.lock` });
  if (result.evidence.length) {
    if (!dryRun) throw conflictError('HOME_MIGRATION_BUSY', '旧数据目录存在活动进程或锁，请检查后重试', result);
    return { ...result, action: 'blocked', reason: 'active_or_locked' };
  }
  if (dryRun) return { ...result, action: 'copy', reason: 'ready' };
  const outcome = migrateLegacyHome(source, target);
  if (!outcome) throw conflictError('HOME_MIGRATION_BUSY', '复制期间发现活动实例，请检查后重试', result);
  if (outcome === 'skipped') return { ...result, action: 'none', reason: exists(target) ? 'target_exists' : 'source_missing', targetExists: exists(target) };
  return { ...result, action: 'copied', reason: 'completed', targetExists: true };
}

// 首次运行提示要能直接照着做：给出当前 manager 入口的 migrate 命令。
function migrateHint() {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('manager.mjs') ? `node "${entry}" migrate` : 'manager.mjs migrate';
}

function migrateLegacyHome(legacy, target) {
  const lock = `${target}.migration.lock`;
  let fd;
  let staging;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') throw conflictError('HOME_MIGRATION_BUSY',
      `数据目录正在复制；若升级进程已退出，请检查后移除锁：${lock}`);
    throw e;
  }
  try {
    if (exists(target) || !exists(legacy)) return 'skipped';
    const stat = fs.lstatSync(legacy);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw dataError('HOME_MIGRATION_FAILED', `旧数据目录不是普通目录，未自动复制：${legacy}`);
    }
    if (hasLiveWriter(legacy)) {
      process.stderr.write(`数据目录升级暂缓：旧目录 ${legacy} 仍有受管应用或日志进程在运行，本次继续使用旧目录。\n停止这些应用后执行：${migrateHint()}\n`);
      return false;
    }
    staging = fs.mkdtempSync(`${target}.copy-`);
    fs.cpSync(legacy, staging, {
      recursive: true, force: false, errorOnExist: true,
      filter: source => {
        // 锁属于旧实例的瞬时状态，不复制到新目录。
        if (source === path.join(legacy, 'locks')) return false;
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`旧目录含符号链接，请人工确认：${source}`);
        return true;
      },
    });
    const runtime = path.join(staging, 'runtime');
    if (fs.existsSync(runtime)) {
      for (const name of fs.readdirSync(runtime).filter(name => name.endsWith('.json'))) {
        const file = path.join(runtime, name);
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify(rebasePaths(record, legacy, target), null, 2) + '\n');
      }
    }
    fs.mkdirSync(path.join(staging, 'locks'), { recursive: true });
    // 发布前再次检查；两个目录都存在时不覆盖、不合并。
    if (exists(target)) return 'skipped';
    if (hasLiveWriter(legacy)) {
      process.stderr.write(`数据目录升级暂缓：复制期间旧目录 ${legacy} 出现活动应用，本次继续使用旧目录。\n停止这些应用后执行：${migrateHint()}\n`);
      return false;
    }
    fs.renameSync(staging, target);
    staging = null;
    return true;
  } catch (e) {
    if (e.code === 'HOME_MIGRATION_FAILED') throw e;
    throw dataError('HOME_MIGRATION_FAILED',
      `数据目录复制失败，旧目录保持不变：${legacy} → ${target}`, { cause: e.message });
  } finally {
    try {
      if (staging) {
        if (path.dirname(staging) !== path.dirname(target) || !staging.startsWith(`${target}.copy-`)) {
          throw new Error('拒绝清理未验证的临时目录');
        }
        fs.rmSync(staging, { recursive: true, force: true });
      }
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

function notifyLegacySkills(userHome) {
  try {
    const notice = legacySkillNotice(detectLegacySkills({ userHome }));
    if (notice) process.stderr.write(`${notice}\n`);
  } catch { /* 探测失败不影响数据目录升级 */ }
}

export function resolveHome(argHome, readOnly = false, { userHome = os.homedir(), migrate = true } = {}) {
  let raw = argHome;
  let copied = false;
  let legacyPending = false;
  if (!raw) {
    const target = path.join(userHome, '.agent-app-manager');
    const legacy = path.join(userHome, '.project-runner');
    if (!exists(target) && exists(legacy)) {
      if (migrate) { if (migrateLegacyHome(legacy, target)) copied = true; else { raw = legacy; legacyPending = true; } }
      else raw = legacy; // dry-run 保持零写入，同时仍能读取旧登记。
    }
    raw ||= target;
  }
  if (!path.isAbsolute(raw)) throw usageError(`--home 需要绝对路径：${raw}`);
  if (readOnly) {
    // 只读命令不落提示标记：复制完成或升级受阻时顺带提示一次。
    if (copied || legacyPending) notifyLegacySkills(userHome);
    return fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
  }
  fs.mkdirSync(raw, { recursive: true });
  const home = fs.realpathSync.native(raw);
  for (const d of ['runtime', 'logs', 'locks']) fs.mkdirSync(path.join(home, d), { recursive: true });
  if (copied) notifyLegacySkills(userHome);
  else if (!argHome) noticeLegacySkillsOnce(home, { userHome });
  return home;
}
