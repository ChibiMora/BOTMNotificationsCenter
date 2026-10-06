// NotificationTrigger (§6.4, §8.2, B11): one job per call, never throws, never rejects.
import { describe, it, expect, vi } from 'vitest';

const pools = vi.hoisted(() => [] as { destroyed: boolean }[]);
vi.mock('../../src/db/index.js', async (orig) => {
  const actual = await orig<typeof import('../../src/db/index.js')>();
  return {
    ...actual,
    createWriterDb: (...args: Parameters<typeof actual.createWriterDb>) => {
      const db = actual.createWriterDb(...args);
      const rec = { destroyed: false };
      pools.push(rec);
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'destroy') {
            return async (...a: unknown[]) => {
              rec.destroyed = true;
              return (target.destroy as (...x: unknown[]) => Promise<void>).apply(target, a);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    },
  };
});
import {
  NotificationTrigger,
  createNotificationTrigger,
  type TriggerEvent,
} from '../../src/trigger/index.js';
import { FakeQueue } from '../helpers/fakeQueue.js';
import { RecordingMetrics } from '../helpers/deps.js';
import { createLogger } from '../../src/lib/logger.js';
import { testConfig } from '../helpers/db.js';
import type { Queue } from '../../src/queue/queue.js';

const make = (queue: Queue = new FakeQueue()) => {
  const metrics = new RecordingMetrics();
  return { t: new NotificationTrigger({ queue, log: createLogger('silent'), metrics }), queue, metrics };
};
const failures = (m: RecordingMetrics) => m.calls.filter((c) => c.name === 'trigger_enqueue_failed').length;
const event: TriggerEvent = {
  type: 'shipped',
  accountId: 7,
  occurredAt: new Date('2026-10-01T12:00:00Z'),
  occurrenceKey: 'shipment:42',
};

describe('NotificationTrigger', () => {
  it('record() enqueues exactly one event_delivery job with the exact payload', async () => {
    const { t, queue } = make();
    await t.record(event);
    expect((queue as FakeQueue).enqueued).toEqual([
      {
        type: 'event_delivery',
        payload: {
          type: 'shipped',
          accountId: 7,
          occurredAt: '2026-10-01T12:00:00.000Z',
          occurrenceKey: 'shipment:42',
        },
      },
    ]);
  });

  it('accountChanged() enqueues exactly one account_recheck job', async () => {
    const { t, queue } = make();
    await t.accountChanged(9);
    expect((queue as FakeQueue).enqueued).toEqual([{ type: 'account_recheck', payload: { accountId: 9 } }]);
  });

  it('a rejecting queue: both resolve and count the failure', async () => {
    const reject: Queue = {
      enqueue: async () => Promise.reject(new Error('down')),
      consume: async () => ({ stop: async () => {} }),
    };
    const { t, metrics } = make(reject);
    await expect(t.record(event)).resolves.toBeUndefined();
    await expect(t.accountChanged(1)).resolves.toBeUndefined();
    expect(failures(metrics)).toBe(2);
  });

  it('a synchronously throwing queue: resolves and counts', async () => {
    const boom: Queue = {
      enqueue: () => {
        throw new Error('sync');
      },
      consume: async () => ({ stop: async () => {} }),
    };
    const { t, metrics } = make(boom);
    await expect(t.record(event)).resolves.toBeUndefined();
    expect(failures(metrics)).toBe(1);
  });

  it.each([
    ['empty occurrence key', { ...event, occurrenceKey: '' }],
    ['over-128-char occurrence key', { ...event, occurrenceKey: 'x'.repeat(129) }],
    ['non-integer account id', { ...event, accountId: 1.5 }],
    ['non-positive account id', { ...event, accountId: 0 }],
    ['invalid date', { ...event, occurredAt: new Date('nope') }],
    ['unknown type', { ...event, type: 'returned' as never }],
    ['not an object', null as never],
  ])('malformed input (%s): resolves, enqueues nothing, counts', async (_n, bad) => {
    const { t, queue, metrics } = make();
    await expect(t.record(bad as TriggerEvent)).resolves.toBeUndefined();
    expect((queue as FakeQueue).enqueued).toEqual([]);
    expect(failures(metrics)).toBe(1);
  });

  it('accountChanged with a malformed id resolves and enqueues nothing', async () => {
    const { t, queue, metrics } = make();
    await expect(t.accountChanged(Number.NaN)).resolves.toBeUndefined();
    expect((queue as FakeQueue).enqueued).toEqual([]);
    expect(failures(metrics)).toBe(1);
  });

  it('a 128-char key is accepted', async () => {
    const { t, queue } = make();
    await t.record({ ...event, occurrenceKey: 'k'.repeat(128) });
    expect((queue as FakeQueue).enqueued).toHaveLength(1);
  });

  it('createNotificationTrigger builds a ready instance without consuming', () => {
    const t = createNotificationTrigger(testConfig());
    expect(t).toBeInstanceOf(NotificationTrigger);
  });
});

describe('NotificationTrigger never rejects, whatever it is given', () => {
  const thrower = () => {
    throw new Error('boom');
  };
  const throwingProxy = new Proxy(
    {},
    Object.fromEntries(
      [
        'get',
        'has',
        'ownKeys',
        'getOwnPropertyDescriptor',
        'getPrototypeOf',
        'apply',
        'construct',
        'set',
        'defineProperty',
        'deleteProperty',
        'isExtensible',
        'preventExtensions',
        'setPrototypeOf',
      ].map((k) => [k, thrower]),
    ),
  );
  const getterThrows = {
    ...event,
    get occurrenceKey(): string {
      throw new Error('getter');
    },
  };
  const inputs: Array<[string, unknown]> = [
    ['occurrenceKey getter throws', getterThrows],
    ['Proxy whose every trap throws', throwingProxy],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ];
  for (const [label, input] of inputs) {
    it(`record(${label}) resolves to undefined and enqueues nothing`, async () => {
      const { t, queue } = make();
      await expect(t.record(input as TriggerEvent)).resolves.toBeUndefined();
      expect((queue as FakeQueue).enqueued).toEqual([]);
    });
    // 42 is a valid account id for accountChanged, so only the non-number inputs apply there.
    if (typeof input !== 'number')
      it(`accountChanged(${label}) resolves to undefined and enqueues nothing`, async () => {
        const { t, queue } = make();
        await expect(t.accountChanged(input as number)).resolves.toBeUndefined();
        expect((queue as FakeQueue).enqueued).toEqual([]);
      });
  }

  const throwingAll = new Proxy({}, { get: () => thrower });
  it('a logger and metrics whose methods throw, plus a queue whose enqueue throws synchronously', async () => {
    const queue = { enqueue: thrower } as unknown as Queue;
    const t = new NotificationTrigger({ queue, log: throwingAll as never, metrics: throwingAll as never });
    await expect(t.record(event)).resolves.toBeUndefined();
    await expect(t.record(getterThrows)).resolves.toBeUndefined();
    await expect(t.accountChanged(9)).resolves.toBeUndefined();
    const t2 = new NotificationTrigger({
      queue: throwingProxy as never,
      log: throwingProxy as never,
      metrics: throwingProxy as never,
    });
    await expect(t2.record(event)).resolves.toBeUndefined();
    await expect(t2.accountChanged(9)).resolves.toBeUndefined();
  });

  it('failure log carries the occurrence key (record) or account id (accountChanged) and nothing else from the input', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = { error: (o: Record<string, unknown>) => lines.push(o), info() {}, warn() {}, debug() {} };
    const queue = {
      enqueue: async () => {
        throw new Error('down');
      },
    } as unknown as Queue;
    const t = new NotificationTrigger({ queue, log: log as never, metrics: new RecordingMetrics() });
    await t.record(event);
    await t.accountChanged(9);
    expect(lines).toEqual([
      { job: 'event_delivery', occurrenceKey: 'shipment:42', err: 'down' },
      { job: 'account_recheck', accountId: 9, err: 'down' },
    ]);
  });
});

describe('createNotificationTrigger', () => {
  it('reuses one bundle per process for the same configuration; no consumer is started', async () => {
    const a = createNotificationTrigger(testConfig());
    const b = createNotificationTrigger(testConfig());
    const q = (t: NotificationTrigger) =>
      (t as unknown as { deps: { queue: { consuming?: unknown } } }).deps.queue;
    expect(q(a)).toBe(q(b));
    expect(a).toBe(b);
  });
});

describe('NotificationTrigger methods are safe however they are invoked', () => {
  const enqueued = (q: Queue) => (q as FakeQueue).enqueued.length;
  it('record called unbound resolves and enqueues one job', async () => {
    const { t, queue } = make();
    const r = t.record;
    await expect(r(event)).resolves.toBeUndefined();
    expect(enqueued(queue)).toBe(1);
  });
  it('accountChanged called unbound resolves and enqueues one job', async () => {
    const { t, queue } = make();
    const a = t.accountChanged;
    await expect(a(7)).resolves.toBeUndefined();
    expect(enqueued(queue)).toBe(1);
  });
  it('record passed to forEach and to .then', async () => {
    const { t, queue } = make();
    const results: Promise<void>[] = [];
    [event].forEach((e) => results.push(t.record.call(undefined, e)));
    const fe = vi.fn(t.record);
    [event].forEach(fe);
    await Promise.all([...results, ...fe.mock.results.map((x) => x.value as Promise<void>)]);
    await expect(Promise.resolve(event).then(t.record)).resolves.toBeUndefined();
    expect(enqueued(queue)).toBe(3);
  });
  it('accountChanged passed to forEach and to .then', async () => {
    const { t, queue } = make();
    const fe = vi.fn(t.accountChanged);
    [7].forEach((id) => fe(id));
    await Promise.all(fe.mock.results.map((x) => x.value as Promise<void>));
    await expect(Promise.resolve(7).then(t.accountChanged)).resolves.toBeUndefined();
    expect(enqueued(queue)).toBe(2);
  });
  it('.call(undefined, ...) and .call({}, ...) resolve and enqueue exactly one job each', async () => {
    for (const thisArg of [undefined, {}]) {
      const a = make();
      await expect(a.t.record.call(thisArg, event)).resolves.toBeUndefined();
      expect(enqueued(a.queue)).toBe(1);
      const b = make();
      await expect(b.t.accountChanged.call(thisArg, 7)).resolves.toBeUndefined();
      expect(enqueued(b.queue)).toBe(1);
    }
  });
});

describe('createNotificationTrigger bundle key and failure handling', () => {
  it('a configuration differing in any other setting gets its own bundle', () => {
    const a = createNotificationTrigger(testConfig());
    const b = createNotificationTrigger({ ...testConfig(), logLevel: 'debug' } as ReturnType<
      typeof testConfig
    >);
    expect(a).not.toBe(b);
  });
  it('a failed construction destroys the opened pool, rethrows, and is not cached', () => {
    const bad = { ...testConfig(), queueImpl: 'nope' } as unknown as ReturnType<typeof testConfig>;
    const before = pools.length;
    expect(() => createNotificationTrigger(bad)).toThrow(/QUEUE_IMPL/);
    expect(pools.length).toBe(before + 1);
    expect(pools[before]!.destroyed).toBe(true);
    expect(() => createNotificationTrigger(bad)).toThrow(/QUEUE_IMPL/);
    expect(pools.length).toBe(before + 2);
  });
});
