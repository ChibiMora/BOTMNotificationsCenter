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

/** The 404 message per resource (§3.2); `undefined` renders the bare { error: "NOT_FOUND" } body. */
const NOT_FOUND_MESSAGES = {
  notification: 'notification not found',
  import: undefined,
  delivery: undefined,
} as const;

/** The one "not found" construction site for admin and member handlers. */
export const notFound = (resource: keyof typeof NOT_FOUND_MESSAGES) =>
  new AppError('NOT_FOUND', 404, NOT_FOUND_MESSAGES[resource]);
