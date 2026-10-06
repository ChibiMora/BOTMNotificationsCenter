import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
const base = {
  DATABASE_URL: 'mysql://root:root@127.0.0.1:3306/nc',
  ASSET_BASE_URL: 'https://a.example.com',
  SITE_BASE_URL: 'https://s.example.com',
};
describe('config', () => {
  it('defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 3000,
      rateLimitMemberPerMin: 120,
      rateLimitAdminPerMin: 600,
      csvMaxBytes: 10485760,
      csvMaxRows: 1000000,
      dueSendIntervalSeconds: 60,
      rescanCron: '0 6 * * *',
      fanoutBatchSize: 1000,
      businessTimezone: 'America/New_York',
      queueImpl: 'db',
      authImpl: 'header',
      adminAccountIds: [1, 2, 3],
      standins: false,
      queuePollSeconds: 1,
      jobMaxAttempts: 5,
      jobLeaseMinutes: 15,
      fanoutMaxConcurrent: 2,
      dueSendBatch: 1000,
      importChunk: 1000,
      expiryBatch: 10000,
      expiryDailyRowBudget: 2000000,
      housekeepingCron: '*/5 * * * *',
      expiryCron: '0 1 * * *',
      deadJobRetentionDays: 30,
      workerHealthPort: 3001,
      logLevel: 'info',
      dbName: 'nc',
      resourceNamespace: 'nc',
    });
    expect(c.databaseReaderUrl).toBe(c.databaseUrl);
  });
  it('DB_NAME overrides both urls; namespace follows', () => {
    const c = loadConfig({ ...base, DATABASE_READER_URL: 'mysql://r:r@reader:3306/nc', DB_NAME: 'u0_x' });
    expect(new URL(c.databaseUrl).pathname).toBe('/u0_x');
    expect(new URL(c.databaseReaderUrl).pathname).toBe('/u0_x');
    expect(c.resourceNamespace).toBe('u0_x');
    expect(loadConfig({ ...base, RESOURCE_NAMESPACE: 'ns' }).resourceNamespace).toBe('ns');
  });
  it('invalid env refused', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow();
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ ...base, DB_NAME: 'bad-name;' })).toThrow();
    expect(() => loadConfig({ ...base, STANDINS: 'maybe' })).toThrow();
  });
  it('stand-ins refused in production', () => {
    const prod = { ...base, NODE_ENV: 'production', AUTH_IMPL: 'real', QUEUE_IMPL: 'sqs' };
    expect(loadConfig(prod).authImpl).toBe('real');
    expect(() => loadConfig({ ...prod, STANDINS: 'true' })).toThrow(/STANDINS/);
    expect(() => loadConfig({ ...prod, AUTH_IMPL: 'header' })).toThrow(/AUTH_IMPL/);
    expect(() => loadConfig({ ...prod, QUEUE_IMPL: 'db' })).toThrow(/QUEUE_IMPL/);
  });
  it('empty string is unset: the default applies', () => {
    const c = loadConfig({ ...base, PORT: '', FANOUT_BATCH_SIZE: '', LOG_LEVEL: '' });
    expect(c.port).toBe(3000);
    expect(c.fanoutBatchSize).toBe(1000);
    expect(c.logLevel).toBe('info');
  });
  it('numeric settings must be plain positive integers', () => {
    expect(loadConfig({ ...base, PORT: '4000' }).port).toBe(4000);
    for (const v of ['0', '1e3', '-1', '1.5', ' 5', '0x10', '05'])
      expect(() => loadConfig({ ...base, PORT: v }), v).toThrow();
    for (const k of [
      'FANOUT_BATCH_SIZE',
      'JOB_MAX_ATTEMPTS',
      'JOB_LEASE_MINUTES',
      'DUE_SEND_INTERVAL_SECONDS',
      'RATE_LIMIT_MEMBER_PER_MIN',
      'EXPIRY_DAILY_ROW_BUDGET',
      'DEAD_JOB_RETENTION_DAYS',
      'FANOUT_MAX_CONCURRENT',
    ])
      expect(() => loadConfig({ ...base, [k]: '0' }), k).toThrow();
  });
  it('DB_NAME override keeps the DATABASE_URL query string', () => {
    const c = loadConfig({
      ...base,
      DATABASE_URL: 'mysql://u:p@h:3306/main?ssl=true&charset=utf8mb4',
      DB_NAME: 'other',
    });
    expect(c.databaseUrl).toBe('mysql://u:p@h:3306/other?ssl=true&charset=utf8mb4');
    expect(c.dbName).toBe('other');
  });
});
