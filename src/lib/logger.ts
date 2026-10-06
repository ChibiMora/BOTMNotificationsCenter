import { pino, type Logger } from 'pino';
export type { Logger };
export const createLogger = (level: string, bindings: Record<string, unknown> = {}) =>
  pino({ level, base: bindings });
