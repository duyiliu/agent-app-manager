// Shared CLI/API contract constants. Keep server and manager responses in sync.
export const SCHEMA_VERSION = 1;
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, NOT_FOUND: 2, CONFLICT: 3, DEPENDENCY: 4, DATA: 5 });

// 进程探针等待上限（Windows pwsh 与 Linux /proc 共用同一语义）
export const TERMINATE_WAIT_MS = 10000;
export const COMMAND_DISCOVER_TIMEOUT_MS = 45000;

// 统一错误类型：manager 与 lib 共用同一类，instanceof 检查才能跨模块生效
export class ManagerError extends Error {
  constructor(code, message, exitCode, detail) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

// ManagerError 退出码契约 → HTTP 状态；数据损坏必须原样透出，不静默当空数据
export function errorStatus(error) {
  if (error.status) return error.status;
  switch (error.exitCode) {
    case 1: return 400;
    case 2: return 404;
    case 3: return 409;
    case 4: return 503;
    case 5: return 500;
    default: return 500;
  }
}
