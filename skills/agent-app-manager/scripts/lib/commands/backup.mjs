// 登记备份：export 导出注册表条目为带校验和的清单文件；import 校验后重建登记（#142）。
// 安全约束：envRefs 按引用导出；env 中命中敏感名的键不落明文，导出为占位并记入 redactedEnvKeys。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MANAGER_VERSION } from '../constants.mjs';
import { registryPath, readRegistry, atomicWriteJson } from '../store.mjs';
import { usageError, dataError } from '../errors.mjs';
import { isSensitiveEnvName } from '../env.mjs';
import { withRegistryLock } from '../locks.mjs';
import { parseNamed } from './common.mjs';

export const BACKUP_FORMAT = 'agent-app-manager/registry-export';
export const BACKUP_SCHEMA_VERSION = 1;

// 导出字段白名单：与 upsertApp 写入的字段集一致，运行期字段（updatedAt/configRevision 等）不带出。
const EXPORT_KEYS = [
  'alias', 'displayName', 'root', 'entry', 'cwd', 'mode', 'tags', 'exe', 'args',
  'command', 'expectedImage', 'discoverTimeoutMs', 'envRefs', 'envFile', 'env',
  'expectedPort', 'expectedPortConfidence', 'readyLogPattern', 'readyUrl',
  'logMaxBytes', 'restartPolicy', 'maxRestarts', 'backoffMs', 'onExit', 'dependsOn', 'sourceFingerprint',
];

function exportEntry(app) {
  const desc = {};
  for (const k of EXPORT_KEYS) if (app[k] !== undefined) desc[k] = app[k];
  for (const [k, v] of Object.entries(app)) if (k.startsWith('x-')) desc[k] = v;
  const redactedEnvKeys = [];
  if (desc.env && typeof desc.env === 'object') {
    const env = {};
    for (const [k, v] of Object.entries(desc.env)) {
      if (isSensitiveEnvName(k)) { redactedEnvKeys.push(k); continue; }
      env[k] = v;
    }
    desc.env = env;
  }
  const entry = { appId: app.appId, desc };
  if (redactedEnvKeys.length) entry.redactedEnvKeys = redactedEnvKeys;
  return entry;
}

// 排序键的稳定序列化：清单校验和与键序无关。
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function checksumOf(apps) {
  return crypto.createHash('sha256').update(stableStringify(apps)).digest('hex');
}

export function cmdExport(ctx) {
  const opts = parseNamed(ctx.rest, { '--out': 'value', '--tag': 'multi' });
  const out = opts.get('--out');
  if (!out) throw usageError('export 需要 --out <file>');
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const tags = new Set((opts.getAll('--tag') ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean));
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps)
    .filter((a) => !tags.size || (a.tags ?? []).some((t) => tags.has(t)))
    .sort((a, b) => a.appId.localeCompare(b.appId))
    .map(exportEntry);
  const payload = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    managerVersion: MANAGER_VERSION,
    appCount: apps.length,
    apps,
    checksum: checksumOf(apps),
  };
  try { fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n'); }
  catch (e) { throw dataError('DATA_UNWRITABLE', `导出文件写入失败（${out}）：${e.message}`); }
  const redacted = apps.filter((a) => a.redactedEnvKeys?.length).map((a) => ({ appId: a.appId, keys: a.redactedEnvKeys }));
  return {
    file: out, appCount: apps.length,
    ...(tags.size ? { tags: [...tags] } : {}),
    ...(redacted.length ? { redactedEnv: redacted, note: `env 中 ${redacted.reduce((n, r) => n + r.keys.length, 0)} 个敏感名键未导出明文，导入后需补录` } : {}),
  };
}

export function cmdImport(ctx) {
  const opts = parseNamed(ctx.rest, { '--from': 'value', '--dry-run': 'flag', '--force': 'flag' });
  const from = opts.get('--from');
  if (!from) throw usageError('import 需要 --from <file>');
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const dryRun = opts.has('--dry-run');
  const force = opts.has('--force');
  let payload;
  try { payload = JSON.parse(fs.readFileSync(from, 'utf8')); }
  catch (e) { throw dataError('DATA_CORRUPT', `备份文件不可读或损坏（${from}）：${e.message}`); }
  if (!payload || typeof payload !== 'object' || payload.format !== BACKUP_FORMAT) {
    throw dataError('DATA_CORRUPT', `备份文件格式不符（${from}）：format 期望 ${BACKUP_FORMAT}`);
  }
  if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw dataError('DATA_UNSUPPORTED', `备份 schemaVersion=${payload.schemaVersion} 不受支持（期望 ${BACKUP_SCHEMA_VERSION}），整体拒绝`);
  }
  if (!Array.isArray(payload.apps) || payload.checksum !== checksumOf(payload.apps)) {
    throw dataError('DATA_CORRUPT', `备份清单校验和不匹配（${from}），整体拒绝导入`);
  }
  const planned = [];
  const skipped = [];
  const warnings = [];
  const danglingDependsOn = [];
  const buildPlan = () => {
    const reg = readRegistry(ctx.home);
    // buildPlan 在锁外与锁内各跑一次：三组结果都要重置，否则 warnings 会重复累积。
    planned.length = 0; skipped.length = 0; warnings.length = 0; danglingDependsOn.length = 0;
    const aliasOwner = new Map(Object.values(reg.apps).map((a) => [a.alias.toLowerCase(), a.appId]));
    for (const rec of payload.apps) {
      const appId = rec?.appId;
      const desc = rec?.desc;
      if (!appId || !desc || typeof desc.alias !== 'string' || !desc.alias) {
        throw dataError('DATA_CORRUPT', `备份条目缺少 appId/desc.alias，整体拒绝导入`);
      }
      const sameId = reg.apps[appId];
      const aliasClash = aliasOwner.get(desc.alias.toLowerCase());
      const aliasConflict = aliasClash && aliasClash !== appId ? aliasClash : null;
      if ((sameId || aliasConflict) && !force) {
        skipped.push({ appId, alias: desc.alias, reason: sameId ? 'appId 已存在' : `alias 已被 ${aliasConflict} 占用` });
        continue;
      }
      planned.push({ rec, appId, desc, replaceAppId: sameId ? appId : null, evictAppId: aliasConflict });
      if (!fs.existsSync(desc.root ?? '')) warnings.push(`${desc.alias}: root 不存在（${desc.root ?? '未提供'}），导入后 start 前需人工确认`);
      if (!Array.isArray(desc.envRefs)) desc.envRefs = desc.envRefs ?? [];
      if (rec.redactedEnvKeys?.length) warnings.push(`${desc.alias}: ${rec.redactedEnvKeys.length} 个敏感 env 键未在备份中，导入后需补录`);
    }
    // 依赖目标必须落在「本次导入 ∪ 注册表现存」范围内，否则导入会静默产生悬空依赖，
    // 直到 start 才暴露 DEP_UNKNOWN（#173）。只警告不拒绝，口径与 root 不存在一致。
    const aliasIndex = new Map(Object.entries(reg.apps).map(([id, a]) => [a.alias.toLowerCase(), id]));
    for (const p of planned) aliasIndex.set(p.desc.alias.toLowerCase(), p.appId);
    for (const p of planned) {
      for (const ref of p.desc.dependsOn ?? []) {
        const key = String(ref).trim();
        if (reg.apps[key] || aliasIndex.has(key.toLowerCase())) continue;
        danglingDependsOn.push({ appId: p.appId, alias: p.desc.alias, dependency: key });
        warnings.push(`${p.desc.alias}: 依赖 ${key} 未随备份导入且未登记，start 将拒绝`);
      }
    }
    return reg;
  };
  const apply = (reg) => {
    const now = new Date().toISOString();
    for (const p of planned) {
      if (p.evictAppId) delete reg.apps[p.evictAppId];
      const desc = p.desc;
      reg.apps[p.appId] = {
        appId: p.appId, alias: desc.alias, displayName: desc.displayName ?? desc.alias,
        root: desc.root, entry: desc.entry, cwd: desc.cwd ?? desc.root,
        mode: desc.mode, tags: desc.tags ?? [], exe: desc.exe ?? null, args: desc.args ?? [],
        command: desc.command ?? null, expectedImage: desc.expectedImage ?? null,
        discoverTimeoutMs: desc.discoverTimeoutMs ?? null, envRefs: desc.envRefs ?? [],
        envFile: desc.envFile ?? null, env: desc.env ?? {},
        expectedPort: desc.expectedPort ?? null, expectedPortConfidence: desc.expectedPortConfidence ?? null,
        readyLogPattern: desc.readyLogPattern ?? null, readyUrl: desc.readyUrl ?? null,
        logMaxBytes: desc.logMaxBytes ?? null, restartPolicy: desc.restartPolicy ?? 'never',
        maxRestarts: desc.maxRestarts ?? null, backoffMs: desc.backoffMs ?? null,
        onExit: desc.onExit ?? null, dependsOn: desc.dependsOn ?? [], sourceFingerprint: desc.sourceFingerprint ?? null,
        ...Object.fromEntries(Object.entries(desc).filter(([k]) => k.startsWith('x-'))),
        configRevision: 1, createdAt: reg.apps[p.appId]?.createdAt ?? now, updatedAt: now,
      };
    }
    atomicWriteJson(registryPath(ctx.home), reg);
  };
  let reg = buildPlan();
  if (dryRun) {
    return {
      dryRun: true, from,
      wouldImport: planned.map((p) => ({ appId: p.appId, alias: p.desc.alias, ...(p.replaceAppId ? { replaces: p.replaceAppId } : {}), ...(p.evictAppId ? { evictsAliasOwner: p.evictAppId } : {}) })),
      skipped, warnings,
      ...(danglingDependsOn.length ? { danglingDependsOn } : {}),
      note: 'dry-run 未写入任何登记；确认后去掉 --dry-run 执行',
    };
  }
  withRegistryLock(ctx.home, 'import', () => {
    reg = buildPlan(); // 锁内重算：锁外计划可能已过期
    apply(reg);
  });
  return {
    from, imported: planned.map((p) => ({ appId: p.appId, alias: p.desc.alias })),
    skipped, warnings,
    ...(danglingDependsOn.length ? { danglingDependsOn } : {}),
    note: '已重建登记（未启动任何应用）；敏感 env 键与 envRefs 引用的密钥需按原渠道补齐',
  };
}
