// Command implementations, split by domain under ./commands/.
// Lifecycle commands run inside the per-app advisory lock; read-only commands never
// mutate beyond status writeback. Public import surface stays this file so callers
// (manager.mjs / tests) are decoupled from the internal layout.
export { parseNamed } from './commands/options.mjs';
export { cmdStartNew, cmdStart, cmdStop, cmdRestart, cmdCleanupWrapper, cmdRemove } from './commands/lifecycle.mjs';
export { cmdRecordUnmanaged } from './commands/registration.mjs';
export { cmdPort, cmdDoctor, cmdList, cmdStatus } from './commands/diagnostics.mjs';
export { cmdLogs } from './commands/logs.mjs';
export { cmdPrune } from './commands/maintenance.mjs';
export { cmdUi } from './commands/ui.mjs';
