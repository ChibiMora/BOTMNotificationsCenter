import { describe, it, expect, vi } from 'vitest';
import { FakeQueue } from '../helpers/fakeQueue.js';
const noop = async () => {};
const handlers = (h: Partial<Record<string, any>>) => ({
  fanout_filter: noop,
  process_import: noop,
  event_delivery: noop,
  account_recheck: noop,
  cancel_scheduled: noop,
  ...h,
});
describe('FakeQueue', () => {
  it('records and runs in order', async () => {
    const q = new FakeQueue();
    const seen: number[] = [];
    await q.enqueue('account_recheck', { accountId: 1 });
    await q.enqueue('account_recheck', { accountId: 2 }, { runAt: new Date(0) });
    expect(q.enqueued).toHaveLength(2);
    expect(q.enqueued[1]!.runAt).toEqual(new Date(0));
    await q.consume(
      handlers({
        account_recheck: async (p: any) => {
          seen.push(p.accountId);
        },
      }),
      { onDead: noop },
    );
    await q.runAll();
    expect(seen).toEqual([1, 2]);
  });
  it('retries to maxAttempts then onDead once', async () => {
    const q = new FakeQueue({ maxAttempts: 3 });
    const attempts: number[] = [];
    const onDead = vi
      .fn<(type: string, payload: object, error: Error) => Promise<void>>()
      .mockResolvedValue(undefined);
    await q.consume(
      handlers({
        cancel_scheduled: async (_p: any, ctx: any) => {
          attempts.push(ctx.attempt);
          throw new Error('boom');
        },
      }),
      { onDead },
    );
    await q.enqueue('cancel_scheduled', { notificationId: 9 });
    await q.runAll();
    expect(attempts).toEqual([1, 2, 3]);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0]![0]).toBe('cancel_scheduled');
  });
  it('failNextEnqueue rejects once', async () => {
    const q = new FakeQueue();
    q.failNextEnqueue(new Error('down'));
    await expect(q.enqueue('account_recheck', { accountId: 1 })).rejects.toThrow('down');
    await q.enqueue('account_recheck', { accountId: 1 });
    expect(q.enqueued).toHaveLength(1);
  });
  it('runAll throws immediately for a job type with no registered handler', async () => {
    const q = new FakeQueue({ maxAttempts: 3 });
    const onDead = vi
      .fn<(type: string, payload: object, error: Error) => Promise<void>>()
      .mockResolvedValue(undefined);
    await q.enqueue('account_recheck', { accountId: 1 });
    await q.consume({} as any, { onDead });
    await expect(q.runAll()).rejects.toThrow(/no handler registered for job type "account_recheck"/);
    expect(onDead).not.toHaveBeenCalled();
  });
});
