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

function runLogger(name, limit, script, fileOverride, runtimeState) {
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
  fs.writeFileSync(runtimeFile, JSON.stringify(runtimeState
    ?? { schemaVersion: 1, appId, current: { runId: 'run', phase: 'RUNNING' } }));
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
  const normalRt = JSON.parse(fs.readFileSync(normal.runtimeFile, 'utf8'));
  assert.equal(normalRt.current.exit.code, 0, '正常退出应记录 exit.code=0');
  assert.equal(normalRt.current.exit.signal, null, '正常退出不应带信号');
  assert.match(normalRt.current.exit.at, /^\d{4}-\d{2}-\d{2}T/, '退出证据应带 ISO 时间');

  const nonZero = await runLogger('non-zero', 1024, 'process.exit(7);');
  assert.equal(nonZero.code, 7, 'logger 应沿用目标的非零退出码');
  const nonZeroRt = JSON.parse(fs.readFileSync(nonZero.runtimeFile, 'utf8'));
  assert.equal(nonZeroRt.current.exit.code, 7, '非零退出应记录具体 code');
  assert.equal(nonZeroRt.current.exit.signal, null);

  if (process.platform !== 'win32') {
    const signalled = await runLogger('signalled', 1024,
      "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);");
    const signalledRt = JSON.parse(fs.readFileSync(signalled.runtimeFile, 'utf8'));
    assert.equal(signalledRt.current.exit.signal, 'SIGTERM', '被信号终止应记录 signal');
    assert.equal(signalledRt.current.exit.code, null, '信号终止的 code 应为 null');
  }

  // 迟到的 close 不得写到新 run：当前记录已切换为 other-run 时必须原样保留。
  const mismatch = await runLogger('mismatch', 1024, 'process.exit(0);', undefined, {
    schemaVersion: 1, appId: 'arotation',
    current: { runId: 'other-run', phase: 'RUNNING', exitNote: 'keep' },
  });
  assert.equal(mismatch.code, 0);
  const mismatchCurrent = JSON.parse(fs.readFileSync(mismatch.runtimeFile, 'utf8')).current;
  assert.equal(mismatchCurrent.runId, 'other-run', '不应改写其他 run 的记录');
  assert.equal(mismatchCurrent.exitNote, 'keep');
  assert(!Object.prototype.hasOwnProperty.call(mismatchCurrent, 'exit'), '旧 run 的退出信息不得写入当前 run');

  // pidFile=0 契约：目标 spawn 失败时快速落 SPAWN_FAILED 所需的错误信号
  const spawnFailed = await runLogger('spawn-failed', 1024, "process.stdout.write('never')", 'Z:/definitely/missing/target.exe');
  assert.equal(spawnFailed.code, 1, 'spawn 失败时 logger 应以非零码退出');
  assert.equal(fs.readFileSync(path.join(temp, 'spawn-failed', 'target.pid'), 'utf8'), '0', 'spawn 失败应写 pidFile=0');
  assert.match(fs.readFileSync(path.join(temp, 'spawn-failed', 'run.stderr.log'), 'utf8'), /target spawn failed/, 'spawn 错误应落入 stderr 批次日志');
  assert(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(spawnFailed.runtimeFile, 'utf8')).current, 'exit'),
    'spawn 失败不得伪装成正常/信号退出证据');

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
