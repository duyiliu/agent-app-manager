import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { spawnPwsh, psProc } from '../lib/probe.mjs';
import { isWindows, killTree } from './platform.mjs';
if (!isWindows) { console.log('跳过 Windows 进程树检查'); process.exit(0); }
const script = fileURLToPath(new URL('./windows-tree.ps1', import.meta.url));
const result = spawnPwsh(['-NoProfile', '-NonInteractive', '-File', script], { encoding:'utf8', timeout:30000, windowsHide:true });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
// 无关哨兵未引用测试目录；清理入口必须拒绝，且进程仍存活。
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', windowsHide:true});
const identity = psProc('capture', {id:child.pid});
try {
  assert.equal(killTree(child.pid, path.join(path.dirname(script), '不存在的测试目录')), false);
  assert.equal(psProc('verify', {id:child.pid, ...identity}).result, 'ok');
} finally {
  if (identity.result === 'ok') psProc('terminate', {id:child.pid, ...identity});
}
console.log('无关哨兵清理保护通过');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-tree-safe-'));
const fixture = path.join(base, 'server.cjs');
fs.writeFileSync(fixture, 'setInterval(()=>{},1000);');
// 走 .cmd 批处理做 cmd 包装：spawn 经 libuv 会把带空格的参数整体加引号并用 \" 转义内部引号，
// 而 cmd /c 重新解析时不认反斜杠转义，整串会被当成命令名导致 wrapper 秒退。
const wrapper = path.join(base, 'run.cmd');
fs.writeFileSync(wrapper, `@"${process.execPath}" "${fixture}"\r\n`);
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', windowsHide:true});
const sentinelIdentity = psProc('capture', {id:sentinel.pid});
await new Promise(resolve => setTimeout(resolve, 100));
const root = spawn('cmd.exe', ['/d', '/c', wrapper], {stdio:'ignore', windowsHide:true});
const rootIdentity = psProc('capture', {id:root.pid});
const injectedScript = fileURLToPath(new URL('./windows-tree-integration.ps1', import.meta.url));
function invoke(mode, image = rootIdentity.image) {
  const r = spawnPwsh(['-NoProfile','-NonInteractive','-File',injectedScript,'-Mode',mode,'-RootId',String(root.pid),'-SentinelId',String(sentinel.pid),'-RootTime',rootIdentity.creationFileTime,'-RootImage',image], {encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}
try {
  const discovered = invoke('discover', path.basename(process.execPath));
  assert.equal(discovered.result, 'found');
  assert.equal(discovered.candidates.length, 1);
  assert.notEqual(discovered.candidates[0].pid, sentinel.pid);
  const rows = invoke('descendants');
  assert(rows.length >= 1);
  assert(!rows.some(row => row.pid === sentinel.pid));
  const realChild = rows.find(row => row.pid !== sentinel.pid && /node\.exe$/i.test(row.image || ''));
  assert(realChild, '后代快照里应包含真实的 node 子进程');
  const stopped = invoke('terminate-tree');
  // cmd /c 批处理的前台 node 被杀后批处理结束，wrapper 可能先于根终止自然退出：
  // terminated 与 exited 都合法，安全语义在 killedPids 上。
  assert(stopped.result === 'terminated' || stopped.result === 'exited', JSON.stringify(stopped));
  assert(stopped.killedPids.includes(realChild.pid), JSON.stringify(stopped));
  assert(!stopped.killedPids.includes(sentinel.pid));
  assert.equal(psProc('verify', {id:sentinel.pid, ...sentinelIdentity}).result, 'ok');
  console.log('发现、后代枚举和整树终止均保留旧哨兵');
} finally {
  killTree(root.pid, base);
  if (sentinelIdentity.result === 'ok') psProc('terminate', {id:sentinel.pid, ...sentinelIdentity});
  fs.rmSync(base, {recursive:true, force:true});
}
