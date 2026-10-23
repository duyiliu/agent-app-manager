// Retry policy for process-identity probes. Termination is deliberately never retried:
// a lost response after termination must not turn into an ambiguous second action.
export const PS_PROBE_ATTEMPTS = 3;

export function retryProcessProbe(action, invoke) {
  for (let attempt = 1; ; attempt++) {
    try { return invoke(); }
    catch (error) {
      if (!error.psTransient || action === 'terminate' || action === 'terminate-tree' || action === 'grace' || attempt >= PS_PROBE_ATTEMPTS) throw error;
    }
  }
}
