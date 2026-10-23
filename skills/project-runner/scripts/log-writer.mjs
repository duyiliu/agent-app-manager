#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch { /* best effort */ }
const { file, args, cwd, outPath, errPath, runtimeFile, runId, limit } = config;
let outSize = 0;
let errSize = 0;
try { outSize = fs.statSync(outPath).size; } catch { /* first write */ }
try { errSize = fs.statSync(errPath).size; } catch { /* first write */ }
let outFd = fs.openSync(outPath, 'a');
let errFd = fs.openSync(errPath, 'a');
const rotatedStreams = new Set();

function markRotated(stream) {
  if (rotatedStreams.has(stream)) return;
  rotatedStreams.add(stream);
  try {
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (rt.current?.runId === runId) {
      rt.current.logRotated = true;
      rt.current.logRotatedStreams = [...rotatedStreams];
      const tmp = `${runtimeFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(rt, null, 2) + '\n');
      fs.renameSync(tmp, runtimeFile);
    }
  } catch { /* best effort */ }
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(config.pidFile, String(target.pid));
function writeChunk(stream, input) {
  const isOut = stream === 'stdout';
  let chunk = input;
  let fd = isOut ? outFd : errFd;
  let size = isOut ? outSize : errSize;
  const filePath = isOut ? outPath : errPath;
  if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
  if (size + chunk.length > limit) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(`${filePath}.1`); } catch { /* absent */ }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* best effort */ }
    fd = fs.openSync(filePath, 'w');
    size = 0;
    if (isOut) outFd = fd; else errFd = fd;
    markRotated(stream);
  }
  fs.writeSync(fd, chunk);
  size += chunk.length;
  if (isOut) outSize = size; else errSize = size;
}
function forward(stream, isOut) {
  stream.on('data', (input) => {
    try {
      writeChunk(isOut ? 'stdout' : 'stderr', input);
    } catch { /* logging failure must not terminate the target */ }
  });
}
forward(target.stdout, true);
forward(target.stderr, false);
target.on('exit', (code, signal) => {
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  process.exitCode = code ?? (signal ? 1 : 0);
});
target.on('error', () => { process.exitCode = 1; });
