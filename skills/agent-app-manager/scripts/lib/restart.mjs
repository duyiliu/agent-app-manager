// Restart-policy contract shared by desc validation, launch registration and the
// detached log-writer supervisor. Pure helpers only: no I/O, no process probing.

export const RESTART_POLICIES = new Set(['never', 'on-failure']);
export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_BACKOFF_MS = 1000;
export const MAX_RESTARTS_LIMIT = 100;
export const MAX_BACKOFF_MS = 600000;

// 校验可选的 restartPolicy/maxRestarts/backoffMs；错误文案与 desc 其他字段一致。
export function validateRestartFields(d, errs) {
  const policy = d.restartPolicy ?? 'never';
  if (!RESTART_POLICIES.has(policy)) {
    errs.push(`restartPolicy 只能是 ${[...RESTART_POLICIES].join(' 或 ')}`);
  }
  if (d.maxRestarts != null) {
    if (policy !== 'on-failure') errs.push('maxRestarts 仅在 restartPolicy=on-failure 时可用');
    else if (!Number.isInteger(d.maxRestarts) || d.maxRestarts < 0 || d.maxRestarts > MAX_RESTARTS_LIMIT) {
      errs.push(`maxRestarts 需为 0-${MAX_RESTARTS_LIMIT} 的整数`);
    }
  }
  if (d.backoffMs != null) {
    if (policy !== 'on-failure') errs.push('backoffMs 仅在 restartPolicy=on-failure 时可用');
    else if (!Number.isInteger(d.backoffMs) || d.backoffMs < 0 || d.backoffMs > MAX_BACKOFF_MS) {
      errs.push(`backoffMs 需为 0-${MAX_BACKOFF_MS} 的整数`);
    }
  }
  return errs;
}

// 规范化入注册表的值：never 不保留无意义的限界，避免状态里出现“看似生效”的字段。
export function normalizeRestartFields(d) {
  const restartPolicy = d.restartPolicy ?? 'never';
  if (restartPolicy !== 'on-failure') {
    return { restartPolicy, maxRestarts: null, backoffMs: null };
  }
  return {
    restartPolicy,
    maxRestarts: d.maxRestarts ?? DEFAULT_MAX_RESTARTS,
    backoffMs: d.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
}

// 兼容旧注册表/手工改坏的记录：只接受受支持的值，非法值降级为 never/默认限界。
// 不做自动重启比错误地重启更安全。
export function effectiveRestartSettings(source = {}) {
  const restartPolicy = source.restartPolicy === 'on-failure' ? 'on-failure' : 'never';
  if (restartPolicy === 'never') return { restartPolicy, maxRestarts: 0, backoffMs: 0 };
  const maxRestarts = Number.isInteger(source.maxRestarts) && source.maxRestarts >= 0
    && source.maxRestarts <= MAX_RESTARTS_LIMIT ? source.maxRestarts : DEFAULT_MAX_RESTARTS;
  const backoffMs = Number.isInteger(source.backoffMs) && source.backoffMs >= 0
    && source.backoffMs <= MAX_BACKOFF_MS ? source.backoffMs : DEFAULT_BACKOFF_MS;
  return { restartPolicy, maxRestarts, backoffMs };
}

// 崩溃语义：信号终止或非 0 退出码。正常 code=0 退出不属于 on-failure 的重启对象。
// 退出证据不可得（code 与 signal 均缺失）是第三态：不计入 crash，也不计入 clean。
export function isCrashExit(code, signal) {
  return signal != null || (code != null && code !== 0);
}

// 重启间隔：base × min(2^(attempt-1), 上限) × (1 + rand[0,0.5))，再收敛到
// MAX_BACKOFF_MS 内（#198）。批量场景同刻齐步会把外部依赖再次打挂、常数间隔又
// 不会随连续失败变长；抖动错开节奏、指数加长给依赖恢复窗口。rand 可注入便于测试。
const BACKOFF_JITTER_SPAN = 0.5;
export function computeRestartDelay(backoffMs, attempt, rand = Math.random) {
  const base = Number.isInteger(backoffMs) && backoffMs > 0 ? backoffMs : DEFAULT_BACKOFF_MS;
  const n = Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  const growth = Math.min(2 ** (n - 1), Math.max(1, Math.floor(MAX_BACKOFF_MS / base)));
  const jitter = 1 + Math.min(Math.max(rand() || 0, 0), 0.999999) * BACKOFF_JITTER_SPAN;
  return Math.min(MAX_BACKOFF_MS, Math.round(base * growth * jitter));
}

// 纯决策：返回 stop（不重启）/ dead（达到上限）/ restart（下一次自动重启）。
export function planRestart(settings, restartCount, code, signal, rand = Math.random) {
  if (settings.restartPolicy !== 'on-failure') return { action: 'stop', reason: 'policy-never' };
  // 证据缺失时不按崩溃处理：一个正常退出但采集不到 code 的目标不应触发
  // on-failure 自动重启；落 STOPPED + evidence 供人工判断（#157）。
  if (code == null && signal == null) return { action: 'stop', reason: 'exit-evidence-unavailable' };
  if (!isCrashExit(code, signal)) return { action: 'stop', reason: 'clean-exit' };
  const count = Number.isInteger(restartCount) && restartCount >= 0 ? restartCount : 0;
  if (count >= settings.maxRestarts) {
    return { action: 'dead', reason: 'max-restarts', restartCount: count };
  }
  return {
    action: 'restart', reason: 'on-failure',
    restartCount: count + 1, delayMs: computeRestartDelay(settings.backoffMs, count + 1, rand),
  };
}

export function exitDescription(code, signal) {
  if (signal != null) return `signal=${signal}`;
  return `code=${code == null ? 'unknown' : code}`;
}
