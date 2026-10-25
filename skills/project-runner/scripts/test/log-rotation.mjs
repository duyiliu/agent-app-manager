#!/usr/bin/env node
// Integration check for bounded stdout logging, target continuity, and no-op rotation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTailLines } from '../lib/logs.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'log-writer.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-log-rotation-'));

function runLogger(name, limit, script, fileOverride, prepare) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  const home = path.join(dir, 'home');
  const appId = 'arotation';
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'));
  const outPath = path.join(dir, 'run.stdout.log');
  const errPath = path.join(dir, 'run.stderr.log');
  prepare?.({ dir, outPath, errPath });
  const runtimeFile = path.join(home, 'runtime', `${appId}.json`);
  const pidFile = path.join(dir, 'target.pid');
  fs.writeFileSync(runtimeFile, JSON.stringify({ schemaVersion: 1, appId, current: { runId: 'run', phase: 'RUNNING' } }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    file: fileOverride ?? process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: process.env,
    outPath,
    errPath,
    home,
    appId,
    runtimeFile,
    runId: 'run',
    limit,
    pidFile,
  }));
  return new Promise((resolve, reject) => {
    const logger = spawn(process.execPath, [SCRIPT, configPath], {
      stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    logger.once('error', reject);
    logger.once('exit', (code) => resolve({ code, outPath, errPath, runtimeFile }));
  });
}

try {
  const rotated = await runLogger('rotated', 1024, "process.stdout.write('x'.repeat(1500)); setTimeout(() => { process.stdout.write('continued-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(rotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${rotated.outPath}.1`), 'oversized output should create the rotated file');
  assert(fs.statSync(`${rotated.outPath}.1`).size <= 1024, 'rotated output should be bounded');
  assert(fs.readFileSync(rotated.outPath, 'utf8').includes('continued-after-rotation'), 'target output should continue after rotation');
  assert.equal(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stdout']);

  const errRotated = await runLogger('err-rotated', 1024,
    "process.stderr.write('e'.repeat(1500)); setTimeout(() => { process.stderr.write('stderr-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(errRotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${errRotated.errPath}.1`), 'oversized stderr should create the rotated file');
  assert(fs.statSync(`${errRotated.errPath}.1`).size <= 1024, 'rotated stderr should be bounded');
  assert(fs.readFileSync(errRotated.errPath, 'utf8').includes('stderr-after-rotation'), 'stderr should continue after rotation');
  assert.deepEqual(JSON.parse(fs.readFileSync(errRotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stderr']);

  // rename 失败（用目录占住 .1，unlink 与 rename 都失败）时不得 open('w')
  // 截断当前批次日志；保留内容继续 append，并在 runtime 标记轮转失败。
  const blockedRotate = await runLogger('rotate-blocked', 1024,
    "process.stdout.write('a'.repeat(1200)); setTimeout(() => { process.stdout.write('after-blocked-rotation\\n'); process.exit(0); }, 100);",
    undefined,
    ({ outPath }) => fs.mkdirSync(`${outPath}.1`));
  assert.equal(blockedRotate.code, 0, 'rename 失败不应影响目标进程退出码');
  const blockedContent = fs.readFileSync(blockedRotate.outPath, 'utf8');
  assert(blockedContent.startsWith('a'.repeat(1024)), 'rename 失败时当前日志不得被截断');
  assert(blockedContent.includes('after-blocked-rotation'), 'rename 失败后仍应继续追加日志');
  assert(fs.statSync(`${blockedRotate.outPath}.1`).isDirectory(), '占住 .1 的目录应保留');
  assert.deepEqual(JSON.parse(fs.readFileSync(blockedRotate.runtimeFile, 'utf8')).current.logRotateFailedStreams,
    ['stdout'], 'rename 失败应持久化 logRotateFailedStreams');

  // 占位目录移除后，定时器应重试轮转并在下一次写入前完成，旧证据仍然保留。
  const retryScript = [
    "const fs = require('node:fs');",
    "process.stdout.write('r'.repeat(1200));",
    "setTimeout(() => { process.stdout.write('trigger-rotate\\n'); }, 20);",
    "setTimeout(() => { try { fs.rmdirSync('run.stdout.log.1'); } catch {} }, 250);",
    "setTimeout(() => { process.stdout.write('after-retry-rotation\\n'); process.exit(0); }, 1000);",
  ].join('');
  const retried = await runLogger('rotate-retry', 1024, retryScript, undefined,
    ({ outPath }) => fs.mkdirSync(`${outPath}.1`));
  assert.equal(retried.code, 0);
  assert(fs.statSync(`${retried.outPath}.1`).isFile(), '占位目录移除后应重试轮转成功');
  assert(fs.readFileSync(`${retried.outPath}.1`, 'utf8').includes('trigger-rotate'), '重试轮转应保留失败期间的日志');
  assert(fs.readFileSync(retried.outPath, 'utf8').includes('after-retry-rotation'), '重试轮转后应继续写入当前日志');
  const retriedRuntime = JSON.parse(fs.readFileSync(retried.runtimeFile, 'utf8')).current;
  assert.deepEqual(retriedRuntime.logRotateFailedStreams, ['stdout'], '此前失败记录应保留以供诊断');
  assert.equal(retriedRuntime.logRotated, true);
  assert.deepEqual(retriedRuntime.logRotatedStreams, ['stdout']);

  const normal = await runLogger('normal', 1024, "process.stdout.write('small output\\n');");
  assert.equal(normal.code, 0);
  assert(!fs.existsSync(`${normal.outPath}.1`), 'output below limit should not create a rotated file');
  assert.equal(fs.readFileSync(normal.outPath, 'utf8'), 'small output\n');
  // pidFile=0 契约：目标 spawn 失败时快速落 SPAWN_FAILED 所需的错误信号
  const spawnFailed = await runLogger('spawn-failed', 1024, "process.stdout.write('never')", 'Z:/definitely/missing/target.exe');
  assert.equal(spawnFailed.code, 1, 'spawn 失败时 logger 应以非零码退出');
  assert.equal(fs.readFileSync(path.join(temp, 'spawn-failed', 'target.pid'), 'utf8'), '0', 'spawn 失败应写 pidFile=0');
  assert.match(fs.readFileSync(path.join(temp, 'spawn-failed', 'run.stderr.log'), 'utf8'), /target spawn failed/, 'spawn 错误应落入 stderr 批次日志');

  const utf8File = path.join(temp, 'utf8-tail.log');
  const utf8Body = Buffer.from('中\n'.repeat(20000) + 'X');
  fs.writeFileSync(utf8File, Buffer.concat([Buffer.alloc(65533, 0x61), Buffer.from('中'), utf8Body]));
  const tail = readTailLines(utf8File, 3);
  assert.deepEqual(tail.lines, ['中', '中', 'X'], 'tail must preserve UTF-8 when its byte window starts inside a code point');
  assert(!tail.lines.some((line) => line.includes('\uFFFD')), 'tail must not replace characters at its byte boundary');
  console.log('log rotation checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
