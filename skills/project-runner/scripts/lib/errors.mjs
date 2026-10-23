// Error factories for the ManagerError contract. Shared by manager and lib modules.
import { ManagerError, EXIT } from './constants.mjs';

export const usageError = (m, d) => new ManagerError('USAGE', m, EXIT.USAGE, d);
export const notFoundError = (m, d) => new ManagerError('NOT_FOUND', m, EXIT.NOT_FOUND, d);
export const conflictError = (code, m, d) => new ManagerError(code, m, EXIT.CONFLICT, d);
export const dependencyError = (m, d) => new ManagerError('PWSH_MISSING', m, EXIT.DEPENDENCY, d);
export const dataError = (code, m, d) => new ManagerError(code, m, EXIT.DATA, d);
