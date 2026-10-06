import { z } from 'zod';

/** Plain positive decimal integer ('1e3', '0', '-1', '1.5', '05' are refused). */
const int = (d: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/, 'must be a positive integer')
    .refine((v) => Number.isSafeInteger(Number(v)), 'integer too large')
    .default(String(d))
    .transform(Number);
const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const DB_NAME_RE = /^[A-Za-z0-9_]+$/;

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().url(),
  DATABASE_READER_URL: z.string().url().optional(),
  DB_NAME: z.string().regex(DB_NAME_RE).optional(),
  RESOURCE_NAMESPACE: z.string().regex(DB_NAME_RE).optional(),
  PORT: int(3000),
  ASSET_BASE_URL: z.string().url(),
  SITE_BASE_URL: z.string().url(),
  RATE_LIMIT_MEMBER_PER_MIN: int(120),
  RATE_LIMIT_ADMIN_PER_MIN: int(600),
  CSV_MAX_BYTES: int(10485760),
  CSV_MAX_ROWS: int(1000000),
  DUE_SEND_INTERVAL_SECONDS: int(60),
  RESCAN_CRON: z.string().default('0 6 * * *'),
  FANOUT_BATCH_SIZE: int(1000),
  BUSINESS_TIMEZONE: z
    .string()
    .default('America/New_York')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown timezone'),
  QUEUE_IMPL: z.string().min(1).default('db'),
  AUTH_IMPL: z.string().min(1).default('header'),
  ADMIN_ACCOUNT_IDS: z
    .string()
    .default('1,2,3')
    .transform((s, ctx) => {
      const ids = s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number);
      if (ids.some((n) => !Number.isInteger(n) || n <= 0))
        ctx.addIssue({ code: 'custom', message: 'ADMIN_ACCOUNT_IDS must be ids' });
      return ids;
    }),
  STANDINS: bool,
  QUEUE_POLL_SECONDS: int(1),
  JOB_MAX_ATTEMPTS: int(5),
  JOB_LEASE_MINUTES: int(15),
  FANOUT_MAX_CONCURRENT: int(2),
  DUE_SEND_BATCH: int(1000),
  IMPORT_CHUNK: int(1000),
  EXPIRY_BATCH: int(10000),
  EXPIRY_DAILY_ROW_BUDGET: int(2000000),
  HOUSEKEEPING_CRON: z.string().default('*/5 * * * *'),
  EXPIRY_CRON: z.string().default('0 1 * * *'),
  DEAD_JOB_RETENTION_DAYS: int(30),
  WORKER_HEALTH_PORT: int(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = ReturnType<typeof loadConfig>;

function withDb(url: string, name: string | undefined): string {
  if (!name) return url;
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Parse the environment (§9.6). Pure: pass process.env (or a test object). Throws on invalid or refused config. */
export function loadConfig(env: Record<string, string | undefined>) {
  // An empty value is treated as unset, so the default applies.
  const cleaned = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]));
  const parsed = schema.safeParse(cleaned);
  // One line per missing/invalid variable (no ZodError JSON dump).
  if (!parsed.success)
    throw new Error(
      [
        'invalid configuration:',
        ...parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`),
      ].join('\n'),
    );
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  if (production && e.STANDINS) throw new Error('STANDINS=true is refused in production');
  if (production && e.AUTH_IMPL === 'header')
    throw new Error('AUTH_IMPL=header (stand-in) is refused in production');
  if (production && e.QUEUE_IMPL === 'db')
    throw new Error('QUEUE_IMPL=db (stand-in) is refused in production');
  const databaseUrl = withDb(e.DATABASE_URL, e.DB_NAME);
  const dbName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!DB_NAME_RE.test(dbName)) throw new Error('DATABASE_URL must name a database ([A-Za-z0-9_]+)');
  return {
    nodeEnv: e.NODE_ENV,
    production,
    databaseUrl,
    databaseReaderUrl: withDb(e.DATABASE_READER_URL ?? e.DATABASE_URL, e.DB_NAME),
    dbName,
    /** Prefix for every server-wide shared resource name (e.g. the scheduler's MySQL GET_LOCK, which is
     *  server-scoped, not per-database), so parallel worktrees on one MySQL server never collide. */
    resourceNamespace: e.RESOURCE_NAMESPACE ?? dbName,
    port: e.PORT,
    assetBaseUrl: e.ASSET_BASE_URL,
    siteBaseUrl: e.SITE_BASE_URL,
    rateLimitMemberPerMin: e.RATE_LIMIT_MEMBER_PER_MIN,
    rateLimitAdminPerMin: e.RATE_LIMIT_ADMIN_PER_MIN,
    csvMaxBytes: e.CSV_MAX_BYTES,
    csvMaxRows: e.CSV_MAX_ROWS,
    dueSendIntervalSeconds: e.DUE_SEND_INTERVAL_SECONDS,
    rescanCron: e.RESCAN_CRON,
    fanoutBatchSize: e.FANOUT_BATCH_SIZE,
    businessTimezone: e.BUSINESS_TIMEZONE,
    queueImpl: e.QUEUE_IMPL,
    authImpl: e.AUTH_IMPL,
    adminAccountIds: e.ADMIN_ACCOUNT_IDS,
    standins: e.STANDINS,
    queuePollSeconds: e.QUEUE_POLL_SECONDS,
    jobMaxAttempts: e.JOB_MAX_ATTEMPTS,
    jobLeaseMinutes: e.JOB_LEASE_MINUTES,
    fanoutMaxConcurrent: e.FANOUT_MAX_CONCURRENT,
    dueSendBatch: e.DUE_SEND_BATCH,
    importChunk: e.IMPORT_CHUNK,
    expiryBatch: e.EXPIRY_BATCH,
    expiryDailyRowBudget: e.EXPIRY_DAILY_ROW_BUDGET,
    housekeepingCron: e.HOUSEKEEPING_CRON,
    expiryCron: e.EXPIRY_CRON,
    deadJobRetentionDays: e.DEAD_JOB_RETENTION_DAYS,
    workerHealthPort: e.WORKER_HEALTH_PORT,
    logLevel: e.LOG_LEVEL,
  };
}
