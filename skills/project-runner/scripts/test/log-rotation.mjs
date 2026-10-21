#!/usr/bin/env node
// Integration check for bounded stdout/stderr logging, target continuity, and no-op rotation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'log-writer.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-log-rotation-'));

function runLogger(name, limit, script, initialRuntime = { runId: 'run', phase: 'RUNNING' }) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  const outPath = path.join(dir, 'run.stdout.log');
  const errPath = path.join(dir, 'run.stderr.log');
  const runtimeFile = path.join(dir, 'runtime.json');
  const pidFile = path.join(dir, 'target.pid');
  fs.writeFileSync(runtimeFile, JSON.stringify({ current: initialRuntime }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    file: process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: process.env,
    outPath,
    errPath,
    runtimeFile,
    runId: 'run',
    limit,
    pidFile,
  }));
  return new Promise((resolve, reject) => {
    const logger = spawn(process.execPath, [SCRIPT, configPath], { stdio: 'ignore' });
    logger.once('error', reject);
    logger.once('exit', (code) => resolve({ code, outPath, errPath, runtimeFile, dir }));
  });
}

const runtimeOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).current;
const sizeOf = (file) => fs.statSync(file).size;

try {
  const rotated = await runLogger('rotated', 1024, "process.stdout.write('x'.repeat(1500)); setTimeout(() => { process.stdout.write('continued-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(rotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${rotated.outPath}.1`), 'oversized stdout should create the rotated file');
  assert(sizeOf(`${rotated.outPath}.1`) <= 1024, 'rotated stdout should be bounded');
  assert(sizeOf(rotated.outPath) <= 1024, 'current stdout should be bounded after rotation');
  assert(fs.readFileSync(rotated.outPath, 'utf8').includes('continued-after-rotation'), 'target output should continue after rotation');
  const outFlags = runtimeOf(rotated.runtimeFile).logRotated;
  assert.equal(outFlags.stdout, true, 'runtime should record the rotated stdout stream');
  assert.notEqual(outFlags.stderr, true, 'stdout rotation should not mark stderr');

  const rotatedErr = await runLogger('rotated-err', 1024, "process.stderr.write('e'.repeat(1500)); setTimeout(() => { process.stderr.write('continued-stderr-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(rotatedErr.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${rotatedErr.errPath}.1`), 'oversized stderr should create the rotated file');
  assert(sizeOf(`${rotatedErr.errPath}.1`) <= 1024, 'rotated stderr should be bounded');
  assert(sizeOf(rotatedErr.errPath) <= 1024, 'current stderr should be bounded after rotation');
  assert(fs.readFileSync(rotatedErr.errPath, 'utf8').includes('continued-stderr-after-rotation'), 'target stderr should continue after rotation');
  const errFlags = runtimeOf(rotatedErr.runtimeFile).logRotated;
  assert.equal(errFlags.stderr, true, 'runtime should record the rotated stderr stream');
  assert.notEqual(errFlags.stdout, true, 'stderr rotation should not mark stdout');
  assert(!fs.existsSync(`${rotatedErr.outPath}.1`), 'stderr rotation should not create a stdout rotated file');

  const both = await runLogger('both', 1024, "process.stdout.write('o'.repeat(1500)); process.stderr.write('e'.repeat(1500)); setTimeout(() => process.exit(0), 100);");
  assert.equal(both.code, 0);
  assert(fs.existsSync(`${both.outPath}.1`) && fs.existsSync(`${both.errPath}.1`), 'both streams should rotate independently');
  const bothFlags = runtimeOf(both.runtimeFile).logRotated;
  assert.equal(bothFlags.stdout, true);
  assert.equal(bothFlags.stderr, true);

  const legacy = await runLogger('legacy-flag', 1024, "process.stderr.write('e'.repeat(1500));", { runId: 'run', phase: 'RUNNING', logRotated: true });
  assert.equal(legacy.code, 0);
  assert.deepEqual(runtimeOf(legacy.runtimeFile).logRotated, { stdout: true, stderr: true }, 'legacy boolean marker should remain backwards compatible');

  const normal = await runLogger('normal', 1024, "process.stdout.write('small stdout\\n'); process.stderr.write('small stderr\\n');");
  assert.equal(normal.code, 0);
  assert(!fs.existsSync(`${normal.outPath}.1`), 'stdout below limit should not create a rotated file');
  assert(!fs.existsSync(`${normal.errPath}.1`), 'stderr below limit should not create a rotated file');
  assert.equal(fs.readFileSync(normal.outPath, 'utf8'), 'small stdout\n');
  assert.equal(fs.readFileSync(normal.errPath, 'utf8'), 'small stderr\n');
  assert.equal(runtimeOf(normal.runtimeFile).logRotated, undefined);

  for (const dir of [rotated.dir, rotatedErr.dir, both.dir, legacy.dir, normal.dir]) {
    assert(!fs.readdirSync(dir).some((name) => name.startsWith('.tmp-')), 'rotation markers should not leave orphan temp files');
  }
  console.log('log rotation checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
