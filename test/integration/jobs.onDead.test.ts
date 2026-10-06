// Dead-letter hook logging (§9.5): the 'job dead' line carries the payload's ids only, never the raw payload.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { testDb } from '../helpers/db.js';
import { makeTestDeps } from '../helpers/deps.js';
import { onDead } from '../../src/jobs/index.js';

const db = testDb();
afterAll(() => db.destroy());

const deadFields = async (type: string, payload: Record<string, unknown>) => {
  const deps = makeTestDeps({ db });
  const spy = vi.spyOn(deps.log, 'error');
  await onDead(deps)!(type as never, payload as never, new Error('boom'));
  const call = spy.mock.calls.find((c) => c[1] === 'job dead');
  expect(call).toBeDefined();
  return call![0] as Record<string, unknown>;
};

describe('onDead logging', () => {
  it('logs event_delivery ids explicitly and no payload key or content fields', async () => {
    const fields = await deadFields('event_delivery', {
      type: 'account_created',
      accountId: 7,
      occurredAt: '2026-01-01T00:00:00.000Z',
      occurrenceKey: 'k-1',
      requestId: 'req-1',
      secret: 'do not log',
    });
    expect(fields).not.toHaveProperty('payload');
    expect(fields).toMatchObject({
      type: 'event_delivery',
      accountId: 7,
      occurrenceKey: 'k-1',
      requestId: 'req-1',
    });
    expect(JSON.stringify(fields)).not.toContain('do not log');
    expect(fields.err).toBeInstanceOf(Error);
  });

  it('logs notificationId for cancel_scheduled and omits absent ids', async () => {
    const fields = await deadFields('cancel_scheduled', { notificationId: 42 });
    expect(fields).not.toHaveProperty('payload');
    expect(fields).toMatchObject({ type: 'cancel_scheduled', notificationId: 42 });
    expect(fields).not.toHaveProperty('accountId');
    expect(fields).not.toHaveProperty('requestId');
  });

  it('logs importId and runId for process_import', async () => {
    const fields = await deadFields('process_import', { importId: 999999, runId: 3 });
    expect(fields).not.toHaveProperty('payload');
    expect(fields).toMatchObject({ type: 'process_import', importId: 999999, runId: 3 });
  });
});
