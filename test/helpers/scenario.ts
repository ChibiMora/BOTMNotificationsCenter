/**
 * Scenario (end-to-end) wiring, §10.3: the real Koa app (testApp) sharing ONE Deps with the real stand-in database
 * queue in manual mode, the real job handlers, a FixedClock, and the seeded stand-in accounts.
 *
 *   const s = await scenario(db);      // db from testDb(), destroyed by the test file in afterAll
 *   await s.runWorker();               // steps the queue until nothing is runnable at the current clock
 *   await s.member(23);                // GET /notifications as account 23 -> items
 */
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { Deps } from '../../src/lib/deps.js';
import type { JobHandlers } from '../../src/queue/queue.js';
import { createQueue } from '../../src/queue/index.js';
import { jobHandlers, onDead } from '../../src/jobs/index.js';
import { NotificationTrigger } from '../../src/trigger/index.js';
import { testConfig } from './db.js';
import { makeTestDeps } from './deps.js';
import { testApp } from './app.js';
import { FixedClock } from './clock.js';

export const SEEDED_IDS = Array.from({ length: 72 }, (_, i) => i + 1);
export const DAY = 86_400_000;

export interface MemberItem {
  id: string;
  headline: string;
  subheadline: string;
  isClicked: boolean;
  liveDate: string;
}

export type ScenarioOptions = {
  config?: Partial<Deps['config']>;
  /** Wraps the real handler map (e.g. to make one job type fail on purpose). */
  handlers?: (real: JobHandlers) => JobHandlers;
};

export async function scenario(db: Knex, opts: ScenarioOptions = {}) {
  const config = { ...testConfig(), queueImpl: 'db' as const, ...opts.config };
  const clock = new FixedClock();
  const base = makeTestDeps({ db, config, clock });
  const queue = createQueue(config, {
    db,
    clock,
    log: base.log,
    metrics: base.metrics,
    manual: true,
  } as Parameters<typeof createQueue>[1]);
  const t = testApp({ ...base, db, config, clock, queue });
  const deps = t.deps;
  const real = jobHandlers(deps);
  await queue.consume(opts.handlers ? opts.handlers(real) : real, { onDead: onDead(deps) });
  const step = () => (queue as unknown as { runOnce(): Promise<number> }).runOnce();

  /** Steps the worker until no job is runnable now; a cap makes a runaway loop fail fast instead of hanging. */
  const runWorker = async (cap = 200) => {
    let ran = 0;
    for (;;) {
      const n = await step();
      if (n === 0) return ran;
      ran += n;
      if (ran > cap) throw new Error(`runWorker: more than ${cap} jobs ran; runaway loop?`);
    }
  };

  const as = (id: number) => String(id);
  const admin = {
    filter: (body: object) =>
      t.request
        .post('/admin/notifications/filter')
        .set('X-Account-Id', '1')
        .set('Idempotency-Key', randomUUID())
        .send(body),
    event: (body: object) =>
      t.request
        .post('/admin/notifications/event')
        .set('X-Account-Id', '1')
        .set('Idempotency-Key', randomUUID())
        .send(body),
    patch: (id: string, body: object) =>
      t.request.patch(`/admin/notifications/${id}`).set('X-Account-Id', '1').send(body),
    upload: (notification: object, csv: string, acct = '1') =>
      t.request
        .post('/admin/notifications/imports')
        .set('X-Account-Id', acct)
        .set('Idempotency-Key', randomUUID())
        .field('notification', JSON.stringify(notification))
        .attach('file', Buffer.from(csv), 'ids.csv'),
    getImport: (id: unknown) =>
      t.request.get(`/admin/notifications/imports/${String(id)}`).set('X-Account-Id', '1'),
    rerun: (id: unknown) =>
      t.request
        .post(`/admin/notifications/imports/${String(id)}/runs`)
        .set('X-Account-Id', '1')
        .set('Idempotency-Key', randomUUID())
        .send({}),
  };

  /** GET /notifications as a member; asserts 200 and returns the items. */
  const member = async (id: number): Promise<MemberItem[]> => {
    const r = await t.request.get('/notifications').set('X-Account-Id', as(id));
    if (r.status !== 200)
      throw new Error(`GET /notifications as ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.items as MemberItem[];
  };

  /** Seeded account ids whose member list has at least one item with this headline, ascending. */
  const seenBy = async (headline: string, ids: number[] = SEEDED_IDS) => {
    const out: number[] = [];
    for (const id of ids) {
      if ((await member(id)).some((i) => i.headline === headline)) out.push(id);
    }
    return out;
  };

  const trigger = new NotificationTrigger({ queue: deps.queue, log: deps.log, metrics: deps.metrics });

  return { ...t, deps, clock, queue, runWorker, admin, member, seenBy, trigger, as };
}

export const content = (headline: string) => ({
  image: '/img/s.png',
  headline,
  subheadline: 'Scenario',
  link: '/books/s',
});
