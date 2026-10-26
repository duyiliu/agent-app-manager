// Command implementations: each cmd* takes the parsed ctx and returns the JSON
// data contract (or throws ManagerError). Lifecycle commands run inside the
// per-app advisory lock; read-only commands never mutate beyond status writeback.
// #56：实现按域拆到 lib/commands/；本文件仅作统一出口（manager.mjs 导入路径不变）。
export { parseNamed } from './commands/common.mjs';
export { cmdStartNew, cmdStart, cmdStop, cmdRestart, cmdCleanupWrapper } from './commands/lifecycle.mjs';
export { cmdRecordUnmanaged, cmdRemove } from './commands/registry.mjs';
export { cmdPort, portDiagnosis, cmdDoctor, cmdList, cmdStatus, cmdHealth } from './commands/diagnose.mjs';
export { cmdLogs } from './commands/logs.mjs';
export { cmdPrune } from './commands/prune.mjs';
export { cmdUi } from './commands/ui.mjs';
