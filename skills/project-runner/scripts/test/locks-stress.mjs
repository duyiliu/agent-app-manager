#!/usr/bin/env node
// 锁并发压测（nightly）：多进程争抢同一个 registry 全局锁。
// 只断言两件事：不出现锁错误码；互斥没有被破坏（不会有两人同时在临界区）。
// 不放进 PR 门禁：进程调度抖动会让耗时随机器变化，但任何 LOCK_* 失败都是实现缺陷，
// 应由夜间任务稳定暴露，而不是让 PR 随机变红。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withRegistryLock } from '../lib/locks.mjs';
import { sleepSync } from '../lib/proc.mjs';

const SELF = fileURLToPath(import.meta.url);
const WORKERS = Number(process.env.PR_LOCK_STRESS_WORKERS ?? 4);
const ROUNDS = Number(process.env.PR_LOCK_STRESS_ROUNDS ?? 1500);
const TIMEOUT_MS = Number(process.env.PR_LOCK_STRESS_TIMEOUT_MS ?? 180000);
// 锁本身不重试：忙就报 LOCK_BUSY。压测里的 worker 扮演调用方，自己退避重归。
const BAD_CODES = new Set(['LOCK_UNWRITABLE']);
const BUSY_DEADLINE_MS = 60000;

// 子进程模式：反复抢锁，临界区内记录「锁文件当前写着谁」。
// 只要 owner 不是自己，就证明互斥被破坏（锁被别人占着，我却进来了）。
function runWorker(home, rounds) {
  const lockLog = path.join(home, 'mutex.log');
  const lockFile = path.join(home, 'locks', 'registry.lock');
  const fails = [];
  let busyRetries = 0;
  const deadline = Date.now() + BUSY_DEADLINE_MS;
  for (let i = 0; i < rounds;) {
    try {
      withRegistryLock(home, 'stress', () => {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid; } catch { owner = 'gone'; }
        fs.appendFileSync(lockLog, `+ ${process.pid} owner=${owner} ${process.hrtime.bigint()}\n`);
        fs.appendFileSync(lockLog, `- ${process.pid} owner=${owner} ${process.hrtime.bigint()}\n`);
      });
      i++;
    } catch (e) {
      if (e.code === 'LOCK_BUSY' && Date.now() < deadline) { busyRetries++; sleepSync(1); continue; }
      fails.push(e.code ?? 'UNKNOWN');
      i++;
    }
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, rounds, fails, busyRetries }));
}

function spawnWorker(home, rounds) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, '--worker', home, String(rounds)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// 互斥校验：进入标记之间不允许出现另一个进程的进入标记；
// 同时校验临界区内读到的锁持有者就是自己（owner 不一致即锁被抢走）。
function checkMutex(file) {
  const violations = [];
  const stack = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [op, pid, ownerField] = line.trim().split(/\s+/);
    if (!op) continue;
    const owner = String(ownerField ?? '').replace('owner=', '');
    if (op === '+') {
      if (stack.length) violations.push(`pid ${pid} 进入时 pid ${stack[stack.length - 1]} 尚未退出`);
      if (owner !== pid) violations.push(`pid ${pid} 进入时锁持有者是 ${owner}`);
      stack.push(pid);
    } else {
      if (stack[stack.length - 1] !== pid) violations.push(`pid ${pid} 退出与栈顶 ${stack[stack.length - 1] ?? '空'} 不匹配`);
      else stack.pop();
    }
  }
  if (stack.length) violations.push(`仍有 ${stack.length} 个进程未退出`);
  return violations;
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-locks-stress-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: WORKERS }, () => spawnWorker(home, ROUNDS)));
  const elapsed = Date.now() - t0;

  const problems = [];
  let totalRounds = 0;
  let totalBusy = 0;
  for (const r of results) {
    if (r.code !== 0) { problems.push(`worker 退出码 ${r.code}：${r.stderr.trim().slice(0, 400)}`); continue; }
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { problems.push(`worker 输出无法解析：${r.stdout.slice(0, 200)}`); continue; }
    totalRounds += parsed.rounds;
    totalBusy += parsed.busyRetries ?? 0;
    for (const code of parsed.fails) {
      if (BAD_CODES.has(code)) problems.push(`${code}（pid=${parsed.pid}）`);
    }
    if (parsed.fails.length) problems.push(`pid=${parsed.pid} 失败 ${parsed.fails.length} 次：${[...new Set(parsed.fails)].join(',')}`);
  }
  const mutexViolations = checkMutex(path.join(home, 'mutex.log'));
  problems.push(...mutexViolations);

  if (problems.length) {
    console.log(`FAIL 锁并发压测（${WORKERS} 进程 × ${ROUNDS} 次，${elapsed}ms）`);
    for (const p of problems.slice(0, 10)) console.log(`  - ${p}`);
    console.log(`  现场保留：${base}`);
    process.exit(1);
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`ok  锁并发压测：${WORKERS} 进程 × ${ROUNDS} 次，共 ${totalRounds} 次抢锁（调用方重试 ${totalBusy} 次），无锁错误、无互斥破坏（${elapsed}ms）`);
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv[3], Number(process.argv[4]));
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
