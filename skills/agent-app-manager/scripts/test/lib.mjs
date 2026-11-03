// 测试共享夹具：manager CLI 调用、锁空闲屏障与 LOCK_BUSY 兜底退避。
// 产品代码不依赖本文件；各冒烟用同一口径等待后台 log-writer / exit-watcher 收尾。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');

// 同步睡眠：同步 cli() 里的退避不能改成 await。
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 与 locks.mjs 的冲突信封同口径；依赖编排会把子命令的 LOCK_BUSY 包进 detail.cause。
export const isLockBusy = (out) => out?.json?.error?.code === 'LOCK_BUSY'
  || out?.json?.error?.detail?.cause === 'LOCK_BUSY';

const lockFiles = (home) => {
  try { return fs.readdirSync(path.join(home, 'locks')).filter((n) => n.endsWith('.lock')); }
  catch { return []; }
};

const lockDetail = (home, names) => names.map((name) => {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'locks', name), 'utf8').trim(); } catch { /* 正在释放 */ }
  return `${name}${raw ? `：${raw}` : ''}`;
}).join('；');

const lockIdleError = (home, names, timeoutMs) =>
  new Error(`用例开始前锁未释放（等待 ${timeoutMs}ms）：${lockDetail(home, names)}`);

// 锁空闲屏障：等 home/locks 下没有任何 *.lock。
// 后台 log-writer（log-exit / log-rotation）与 exit-watcher 持同一把 app 锁，只做一次读改写就释放，
// 但慢 runner 上收尾窗口会盖住紧随其后的 CLI 调用。这里只认「目录为空」这一客观事实，
// 与后台定时器相位解耦；超时把锁内容打出来再失败，比 LOCK_BUSY 信封更直接。
export function waitLocksIdle(home, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const names = lockFiles(home);
    if (!names.length) return;
    if (Date.now() >= deadline) throw lockIdleError(home, names, timeoutMs);
    sleep(50);
  }
}

export async function waitLocksIdleAsync(home, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const names = lockFiles(home);
    if (!names.length) return;
    if (Date.now() >= deadline) throw lockIdleError(home, names, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const childEnvOf = ({ env, unsetEnv }) => {
  if (!env && !unsetEnv) return process.env;
  const out = { ...process.env, ...env };
  for (const key of unsetEnv ?? []) delete out[key];
  return out;
};

const parseJson = (stdout) => { try { return JSON.parse(stdout || ''); } catch { return null; } };

export function runManager(home, args, {
  timeout = 120000, env, unsetEnv, json = true, retryEmptyOutput = false,
} = {}) {
  const invoke = () => {
    const r = spawnSync(process.execPath, [MANAGER, '--home', home, ...(json ? ['--json'] : []), ...args], {
      encoding: 'utf8', timeout, windowsHide: true, env: childEnvOf({ env, unsetEnv }),
    });
    return {
      code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
      text: `${r.stdout ?? ''}${r.stderr ?? ''}`, json: parseJson(r.stdout),
    };
  };
  let out = invoke();
  // 慢速 Windows runner 上偶发：命令以非 0 退出但 stdout/stderr 全空（连错误信封都没有），
  // 复跑一次即恢复。真实失败一定会带 JSON 错误信封，所以只对「全空」重试。
  if (retryEmptyOutput && out.code !== 0 && !out.text.trim()) {
    console.log(`  note 空输出退出（status=${out.code ?? '-'}，signal=${out.signal ?? '-'}），重试一次：${args.join(' ')}`);
    out = invoke();
  }
  return out;
}

// 屏障 + 兜底退避：屏障挡住后台收尾窗口，退避收拾「屏障看到空闲后定时器恰好到点」的残余。
// 只对 LOCK_BUSY 生效，其他错误原样返回、不掩盖。
export function runManagerWithLockRetry(home, args, { lockWaitMs = 5000, lockIdleMs = 10000, ...opts } = {}) {
  const deadline = Date.now() + lockWaitMs;
  let delay = 100;
  for (;;) {
    waitLocksIdle(home, lockIdleMs);
    const out = runManager(home, args, opts);
    if (!isLockBusy(out) || Date.now() >= deadline) return out;
    console.log(`  note LOCK_BUSY（${out.json?.error?.detail?.file ?? '锁忙'}），退避 ${delay}ms 后重试：${args.join(' ')}`);
    sleep(delay);
    delay = Math.min(delay * 2, 1000);
  }
}

// 异步版：ui-smoke 需要同时跑本地 HTTP 服务，不能用 spawnSync 阻塞事件循环。
export async function runManagerAsync(home, args, {
  timeout = 120000, env, unsetEnv, json = true, lockWaitMs = 5000, lockIdleMs = 10000,
} = {}) {
  const deadline = Date.now() + lockWaitMs;
  let delay = 100;
  for (;;) {
    await waitLocksIdleAsync(home, lockIdleMs);
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [MANAGER, '--home', home, ...(json ? ['--json'] : []), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], env: childEnvOf({ env, unsetEnv }),
      });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } }, timeout);
      c.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, text: stdout + stderr, json: parseJson(stdout) });
      });
    });
    if (!isLockBusy(out) || Date.now() >= deadline) return out;
    console.log(`  note LOCK_BUSY（${out.json?.error?.detail?.file ?? '锁忙'}），退避 ${delay}ms 后重试：${args.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1000);
  }
}
