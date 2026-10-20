// Shared CLI/API contract constants. Keep server and manager responses in sync.
export const SCHEMA_VERSION = 1;
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, NOT_FOUND: 2, CONFLICT: 3, DEPENDENCY: 4, DATA: 5 });

export function errorStatus(error) {
  if (error.status) return error.status;
  switch (error.code) {
    case 'NOT_FOUND': return 404;
    case 'USAGE': return 400;
    case 'PWSH_MISSING': return 503;
    case 'CONFLICT': return 409;
    default: return 500;
  }
}
