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

function runLogger(name, limit, script, fileOverride) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  const home = path.join(dir, 'home');
  const appId = 'arotation';
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'));
  const outPath = path.join(dir, 'run.stdout.log');
  const errPath = path.join(dir, 'run.stderr.log');
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
