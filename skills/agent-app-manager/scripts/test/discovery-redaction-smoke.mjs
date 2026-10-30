#!/usr/bin/env node
// 安全回归：命令模式歧义证据不得持久化原始命令行。
// 使用复制出的唯一 node 映像启动多个匹配后代，制造 DISCOVERY_AMBIGUOUS；命令带哨兵参数，
// 断言 CLI/status/runtime JSON 均不含原文，候选只保留身份字段与 cmdHash/cmdLength。
// 另先制造一次 DISCOVERY_TIMEOUT（进程已创建但非歧义错误），验证异常路径仍能从运行记录
// 定位并清理 wrapper/目标，而不是只依赖错误 detail 中登记的 PID。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { computeAppId } from '../lib/desc.mjs';
import { isWindows, hasProcessProbe, killTree, listDescendants } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const SENTINEL = 'PR_REDACTION_SENTINEL_DB_PASSWORD_7b2e5c91';
const MAIN_ENTRY = 'redact';
const TIMEOUT_ENTRY = 'timeout';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-discovery-redaction-'));
const home = path.join(base, 'home');
const project = path.join(base, 'app');
fs.mkdirSync(project, { recursive: true });
// 与 manager 一样使用 realpath 后的 root 计算 appId，兜底清理才能命中 runtime 文件。
const projectRoot = fs.realpathSync.native(project);
const appIdMain = computeAppId(projectRoot, MAIN_ENTRY);
const appIdTimeout = computeAppId(projectRoot, TIMEOUT_ENTRY);
const pendingAppIds = new Set([appIdMain, appIdTimeout]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* 保留原始输出 */ }
  return { status: r.status, json, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
};
const readRuntime = (appId) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8')); }
  catch { return null; }
};
// 清理证据不依赖断言是否已走到 detail 解析：运行记录中的 wrapper/logger/pid 与歧义 lastError
// 里的候选 PID 都作为兜底来源，并展开当前后代。
function collectCleanupPids(appIds, extraPids = []) {
  const ids = new Set();
  const add = (pid) => { if (Number.isInteger(pid) && pid > 0) ids.add(pid); };
  for (const pid of extraPids) add(pid);
  for (const appId of appIds) {
    const cur = readRuntime(appId)?.current;
    if (!cur) continue;
    add(cur.wrapperPid);
    add(cur.loggerPid);
    add(cur.pid);
    const m = /^discovery_ambiguous:\s*(\[.*\])$/.exec(cur.lastError ?? '');
    if (m) {
      try { for (const c of JSON.parse(m[1])) add(c?.pid); } catch { /* 非结构化旧记录 */ }
    }
  }
  for (const pid of [...ids]) for (const child of listDescendants(pid)) add(child);
  return [...ids];
}
async function cleanupApps(appIds, extraPids = []) {
  const ids = collectCleanupPids(appIds, extraPids);
  for (const pid of ids) killTree(pid);
  for (let i = 0; i < 20 && ids.some(isAlive); i++) await wait(250);
  const left = ids.filter(isAlive);
  if (left.length) throw new Error(`测试临时进程未清理（${appIds.join(', ')}）：${left.join(', ')}`);
  return ids;
}

if (isWindows && !hasProcessProbe()) {
  console.log('discovery redaction smoke skipped: 缺 pwsh 7');
  let cleaned = false;
  for (let i = 0; i < 150; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); cleaned = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (!cleaned) console.warn(`[warn] 临时目录清理超时，已跳过（不影响断言）：${base}`);
  process.exit(0);
}

let mainWrapperPid = 0;
let timeoutWrapperPid = 0;
const mainCandidatePids = [];
try {
  // 复制成唯一映像名，避免并行测试/历史残留的同名 node 进程被误当作后代候选。
  const targetName = isWindows ? `pr-redaction-node-${process.pid}.exe` : `pr-redaction-node-${process.pid}`;
  const targetExe = path.join(project, targetName);
  fs.copyFileSync(process.execPath, targetExe);
  if (!isWindows) fs.chmodSync(targetExe, 0o755);
  fs.writeFileSync(path.join(project, 'two.js'),
    'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"ignore"});\n'
    + 'setInterval(() => {}, 1000);\n', 'utf8');

  // Windows 上 NoDefaultCurrentDirectoryInExePath=1 时 cmd 不搜索当前目录，必须加 .\ 前缀。
  const commandPrefix = isWindows ? `.\\${targetName}` : `./${targetName}`;
  const writeDesc = (filename, entry, expectedImage, discoverTimeoutMs) => {
    const file = path.join(base, filename);
    fs.writeFileSync(file, JSON.stringify({
      alias: `redact-${entry}`, root: projectRoot, entry, mode: 'node',
      command: `${commandPrefix} two.js --db-password=${SENTINEL}`,
      expectedImage, discoverTimeoutMs,
    }), 'utf8');
    return file;
  };

  // 异常路径验证：进程已创建，但返回 DISCOVERY_TIMEOUT（非歧义），此时 finally 的兜底清理
  // 必须能从 runtime 记录找到 wrapper 并终止整棵进程树。
  const timeoutImage = isWindows ? `pr-redaction-missing-${process.pid}.exe` : `pr-redaction-missing-${process.pid}`;
  const timeoutRun = cli('start-new', '--desc', writeDesc('timeout.json', TIMEOUT_ENTRY, timeoutImage, 2000));
  if (isWindows && (timeoutRun.status === 4 || timeoutRun.json?.error?.code === 'PWSH_MISSING')) {
    console.log('discovery redaction smoke skipped: 缺 pwsh 7');
  } else {
    assert.equal(timeoutRun.status, 3, timeoutRun.text);
    assert.equal(timeoutRun.json.error.code, 'DISCOVERY_TIMEOUT', timeoutRun.text);
    timeoutWrapperPid = timeoutRun.json.error.detail?.wrapperPid ?? 0;
    // 只从 runtime 记录取清理证据（不借助错误 detail），验证异常路径的兜底来源。
    const timeoutPids = collectCleanupPids([appIdTimeout]);
    assert(timeoutPids.some(isAlive), `超时场景未从 runtime 定位到可清理进程：${timeoutPids.join(', ')}`);
    await cleanupApps([appIdTimeout]);
    assert(!timeoutPids.some(isAlive), `超时场景清理后进程仍存活：${timeoutPids.filter(isAlive).join(', ')}`);
    pendingAppIds.delete(appIdTimeout);
    console.log('discovery timeout cleanup fallback ok');

    const r = cli('start-new', '--desc', writeDesc('main.json', MAIN_ENTRY, targetName, 15000));
    // 先登记兜底证据，再做断言：即使返回非 DISCOVERY_AMBIGUOUS，finally 也能清理已创建进程。
    const detail = r.json?.error?.detail ?? {};
    mainWrapperPid = detail.wrapperPid ?? 0;
    for (const c of detail.candidates ?? []) {
      if (Number.isInteger(c?.pid)) mainCandidatePids.push(c.pid);
    }
    assert.equal(r.status, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_AMBIGUOUS', r.text);
    const candidates = detail.candidates ?? [];
    assert(candidates.length >= 2, `歧义候选不足：${JSON.stringify(candidates)}`);
    const allowedKeys = new Set(['pid', 'image', 'comm', 'creationFileTime', 'cmdHash', 'cmdLength']);
    for (const c of candidates) {
      assert(Object.keys(c).every((k) => allowedKeys.has(k)), `候选含非白名单字段：${Object.keys(c).join(',')}`);
      assert.equal(c.cmd, undefined, 'CLI 候选仍携带原始 cmd');
      assert.equal(typeof c.cmdLength, 'number', '候选缺少 cmdLength 证据');
      assert.match(c.cmdHash, /^[0-9a-f]{16}$/, '候选缺少 cmdHash 证据');
    }

    const s = cli('status', `redact-${MAIN_ENTRY}`);
    assert.equal(s.status, 0, s.text);
    assert.equal(s.json.data.status, 'UNKNOWN', s.text);
    const runtimeRaw = fs.readFileSync(path.join(home, 'runtime', `${s.json.data.appId}.json`), 'utf8');
    for (const [label, text] of [['CLI', r.text], ['status', s.text], ['runtime JSON', runtimeRaw]]) {
      assert(!text.includes(SENTINEL), `${label} 泄露候选命令行原文`);
    }
    const persisted = JSON.parse(runtimeRaw).current.lastError;
    assert(!/"cmd"\s*:/.test(persisted), `runtime lastError 仍含原始 cmd：${persisted}`);
    console.log('discovery redaction smoke ok');
  }
} finally {
  try {
    await cleanupApps([...pendingAppIds], [timeoutWrapperPid, mainWrapperPid, ...mainCandidatePids]);
  } finally {
    let removed = false;
    for (let i = 0; i < 20 && !removed; i++) {
      try { fs.rmSync(base, { recursive: true, force: true }); removed = true; }
      catch { await wait(100); }
    }
    if (!removed) throw new Error(`临时目录未能清理：${base}`);
  }
}
