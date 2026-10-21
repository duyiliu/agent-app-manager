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
try { outSize = fs.statSync(outPath).size; } catch { /* first write */ }
let outFd = fs.openSync(outPath, 'a');
let errFd = fs.openSync(errPath, 'a');
let rotated = false;

function markRotated() {
  if (rotated) return;
  rotated = true;
  try {
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (rt.current?.runId === runId) {
      rt.current.logRotated = true;
      const tmp = `${runtimeFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(rt, null, 2) + '\n');
      fs.renameSync(tmp, runtimeFile);
    }
  } catch { /* best effort */ }
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(config.pidFile, String(target.pid));
function forward(stream, isOut) {
  stream.on('data', (input) => {
    try {
      let chunk = input;
      if (isOut && chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
      if (isOut && outSize + chunk.length > limit) {
        fs.closeSync(outFd);
        try { fs.unlinkSync(`${outPath}.1`); } catch { /* absent */ }
        try { fs.renameSync(outPath, `${outPath}.1`); } catch { /* best effort */ }
        outFd = fs.openSync(outPath, 'w');
        outSize = 0;
        markRotated();
      }
      fs.writeSync(isOut ? outFd : errFd, chunk);
      if (isOut) outSize += chunk.length;
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
