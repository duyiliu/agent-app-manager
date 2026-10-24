// Retry policy for process-identity probes. Termination is deliberately never retried:
// a lost response after termination must not turn into an ambiguous second action.
export const PS_PROBE_ATTEMPTS = 3;

// 同步等待（CLI/短时探针场景）：locks 退避与 proc-linux 轮询共用，避免两处重复定义。
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function retryProcessProbe(action, invoke) {
  for (let attempt = 1; ; attempt++) {
    try { return invoke(); }
    catch (error) {
      if (!error.psTransient || action === 'terminate' || action === 'terminate-tree' || action === 'grace' || attempt >= PS_PROBE_ATTEMPTS) throw error;
    }
  }
}
