#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { atomicWriteJson } from './lib/store.mjs';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch { /* best effort */ }
const { file, args, cwd, outPath, errPath, runtimeFile, runId, limit } = config;

// stdout/stderr share the same limit and rotation policy; each stream keeps its own
// descriptor and size so a hot stderr cannot grow without bound.
const sinks = {
  stdout: { path: outPath, fd: null, size: 0 },
  stderr: { path: errPath, fd: null, size: 0 },
};
for (const sink of Object.values(sinks)) {
  try { sink.size = fs.statSync(sink.path).size; } catch { /* first write */ }
  sink.fd = fs.openSync(sink.path, 'a');
}
const rotated = { stdout: false, stderr: false };

function markRotated(stream) {
  if (rotated[stream]) return;
  rotated[stream] = true;
  try {
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (rt.current?.runId === runId) {
      // Older writers only set a boolean. Keep that meaning (both streams may have
      // rotated) while new records distinguish streams.
      const previous = rt.current.logRotated;
      const flags = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? { ...previous }
        : previous === true ? { stdout: true, stderr: true } : {};
      flags[stream] = true;
      rt.current.logRotated = flags;
      // Shared atomic writer keeps temp names compatible with manager prune
      // (`.tmp-<pid>-<hex>`) and cleans up after a failed rename.
      atomicWriteJson(runtimeFile, rt);
    }
  } catch { /* best effort */ }
}

function rotate(stream) {
  const sink = sinks[stream];
  try { fs.closeSync(sink.fd); } catch { /* best effort */ }
  try { fs.unlinkSync(`${sink.path}.1`); } catch { /* absent */ }
  try { fs.renameSync(sink.path, `${sink.path}.1`); } catch { /* best effort */ }
  sink.fd = fs.openSync(sink.path, 'w');
  sink.size = 0;
  markRotated(stream);
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(config.pidFile, String(target.pid));
function forward(stream, name) {
  const sink = sinks[name];
  stream.on('data', (input) => {
    try {
      let chunk = input;
      const oversized = chunk.length > limit;
      if (oversized) chunk = chunk.subarray(chunk.length - limit);
      if (oversized || sink.size + chunk.length > limit) rotate(name);
      fs.writeSync(sink.fd, chunk);
      sink.size += chunk.length;
    } catch { /* logging failure must not terminate the target */ }
  });
}
forward(target.stdout, 'stdout');
forward(target.stderr, 'stderr');
target.on('exit', (code, signal) => {
  for (const sink of Object.values(sinks)) {
    try { fs.closeSync(sink.fd); } catch {}
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
target.on('error', () => { process.exitCode = 1; });
