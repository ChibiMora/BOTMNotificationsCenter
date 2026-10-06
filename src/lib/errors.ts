export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'UNAVAILABLE';
/** The one error class (§3.2). The error middleware maps it to { "error": code, "message": message } with `status`. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}
export const validationError = (message: string) => new AppError('VALIDATION_ERROR', 400, message);
