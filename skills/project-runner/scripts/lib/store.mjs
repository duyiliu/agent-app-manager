import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMA_VERSION, EXIT, ManagerError } from './constants.mjs';

const dataError = (code, message) => new ManagerError(code, message, EXIT.DATA);

export function registryPath(home) { return path.join(home, 'registry.json'); }
export function runtimePath(home, appId) { return path.join(home, 'runtime', `${appId}.json`); }
export function lockPath(home, name) { return path.join(home, 'locks', `${name}.lock`); }

function parseStructured(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw dataError('DATA_UNREADABLE', `${label} 不可读（${file}）：${e.message}`); }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { throw dataError('DATA_CORRUPT', `${label} 损坏，拒绝覆盖并保留原件（${file}）：${e.message}`); }
  if (!obj || typeof obj !== 'object' || obj.schemaVersion !== SCHEMA_VERSION) {
    throw dataError('DATA_UNSUPPORTED', `${label} schemaVersion=${obj && obj.schemaVersion} 不受支持（期望 ${SCHEMA_VERSION}），拒绝覆盖（${file}）`);
  }
  return obj;
}

export function readRegistry(home) {
  const file = registryPath(home);
  if (!fs.existsSync(file)) return { schemaVersion: SCHEMA_VERSION, apps: {} };
  const reg = parseStructured(file, '注册表');
  if (!reg.apps || typeof reg.apps !== 'object') throw dataError('DATA_CORRUPT', `注册表结构无效（缺少 apps，${file}）`);
  return reg;
}

export function readRuntimeStrict(home, appId) {
  const file = runtimePath(home, appId);
  if (!fs.existsSync(file)) return null;
  const rt = parseStructured(file, `运行记录(${appId})`);
  if (rt.appId !== appId) throw dataError('DATA_CORRUPT', `运行记录 appId 不匹配（${file}）`);
  return rt;
}

export function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try { fs.renameSync(tmp, file); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw dataError('DATA_UNWRITABLE', `写入失败（${file}）：${e.message}`);
  }
}
