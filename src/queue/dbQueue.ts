// Temporary stand-in Queue on the `jobs` table (§8.1, §5.7). The ONLY module that reads or writes `jobs`.
// Every "now" comes from the injected clock and is bound as a parameter (never UTC_TIMESTAMP()) so tests drive time.
//
// - `locked_at` doubles as the completion time of `done`/`dead` rows (the §5.7 table has no completed_at column);
//   done-row retention (7 days) and dead-row retention (DEAD_JOB_RETENTION_DAYS) are measured from it.
// - Claims use `FORCE INDEX (idx_jobs_claim)`: the scan must walk the claim index in (status, run_at) order and stop at
//   the limit; a table scan + filesort would lock every queued row and starve concurrent claimers (SKIP LOCKED would
//   then skip them all).
// - Fencing rule: every write a worker makes to a row it claimed (heartbeat, done, dead, back-to-queued) is guarded by
//   `status = 'running' AND locked_by = <this worker> AND attempts = <the attempt it claimed>`. Connections disable
//   mysql2 FOUND_ROWS, so update() returns rows CHANGED. The outcome writes always change `status`, so 0 there means
//   the lease was lost (upkeep re-queued or dead-lettered the row and possibly another worker owns it now): the worker
//   logs "lost lease" and does nothing else. A heartbeat can legitimately change nothing (same-second `locked_at`), so
//   its 0 is confirmed by a read under the same fence before it reports "lease lost".
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Knex } from 'knex';
import type { Config } from '../config/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { Metrics } from '../lib/metrics.js';
import type { ConsumeOptions, JobHandlers, JobType, Queue } from './queue.js';

export interface DbQueueParts {
  db: Knex;
  clock: Clock;
  log: Logger;
  metrics: Metrics;
  workerId?: string;
  /** When true, consume() only registers handlers; the caller drives poll()/runOnce()/upkeep() (tests). */
  manual?: boolean;
  /** Poll-loop sleep (default: setTimeout). Injected by tests to drive the loop without real sleeps. */
  wait?: (ms: number) => Promise<void>;
}

interface ClaimedJob {
  id: number;
  type: JobType;
  payload: object;
  attempts: number;
}

/** Max jobs claimed per query and max jobs in flight per worker. */
const CLAIM_LIMIT = 10;
const DONE_RETENTION_DAYS = 7;
const UPKEEP_INTERVAL_MS = 60_000;
const DONE_DELETE_CHUNK = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FANOUT: JobType = 'fanout_filter';

export class DbQueue implements Queue {
  private readonly workerId: string;
  private handlers?: JobHandlers;
  private opts?: ConsumeOptions;
  private fanoutInFlight = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private lastUpkeep = 0;
  private stopped = false;
  /** Wakes the poll loop's wait early (job settled, stop()). */
  private wake?: () => void;
  /** Set when a wake-up fires while nobody is waiting (e.g. a job settled during poll()); the next wait returns at once. */
  private pendingWake = false;
  /** Serialises claim steps so the free-slot and fan-out-slot counts read before a claim's await stay valid. */
  private claimChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly parts: DbQueueParts,
  ) {
    this.workerId = (parts.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`).slice(
      0,
      64,
    );
  }

  async enqueue(type: JobType, payload: object, opts: { runAt?: Date } = {}): Promise<void> {
    await this.parts.db('jobs').insert({
      type,
      payload: JSON.stringify(payload),
      run_at: opts.runAt ?? this.parts.clock.now(),
    });
  }

  /**
   * Registers handlers and starts the poll loop (unless manual). The loop never awaits claimed jobs: it keeps claiming
   * while fewer than CLAIM_LIMIT jobs are in flight. stop() stops claiming and resolves once in-flight handlers settle.
   */
  async consume(handlers: JobHandlers, opts: ConsumeOptions): Promise<{ stop(): Promise<void> }> {
    this.stopped = false;
    this.handlers = handlers;
    this.opts = opts;
    if (this.parts.manual) {
      // Manual mode: nothing runs on its own; the caller's explicit poll()/runOnce()/upkeep() remain usable after stop().
      return { stop: async () => {} };
    }
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    const sleep =
      this.parts.wait ??
      ((ms: number) =>
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }));
    const wait = (ms: number) => {
      if (this.pendingWake) {
        this.pendingWake = false;
        return Promise.resolve();
      }
      return Promise.race([sleep(ms), new Promise<void>((r) => (this.wake = r))]).finally(() => {
        clearTimeout(timer);
        this.wake = undefined;
      });
    };
    const base = this.config.queuePollSeconds * 1000;
    const loop = async () => {
      let errors = 0;
      while (!stopping) {
        let claimed = 0;
        // Upkeep has its own try/catch and its gate advances whatever the result, so a persistently failing upkeep
        // (e.g. lock-wait timeouts) never stops claiming. The gate uses the injected clock like every other "now".
        const nowMs = this.parts.clock.now().getTime();
        if (nowMs - this.lastUpkeep >= UPKEEP_INTERVAL_MS) {
          this.lastUpkeep = nowMs;
          try {
            await this.upkeep();
          } catch (e) {
            this.parts.log.error({ err: e }, 'queue upkeep failed; claiming continues');
          }
        }
        try {
          claimed = await this.poll();
          errors = 0;
        } catch (e) {
          errors++;
          this.parts.log.error({ err: e, consecutiveErrors: errors }, 'queue poll failed; backing off');
        }
        if (stopping) break;
        if (errors > 0) await wait(Math.min(base * 2 ** (errors - 1), BACKOFF_MAX_MS));
        else if (claimed === 0 || this.inFlight.size >= CLAIM_LIMIT) await wait(base);
      }
    };
    const running = loop();
    return {
      stop: async () => {
        stopping = true;
        this.wake?.();
        await running;
        await this.drain();
        this.detach();
      },
    };
  }

  /** After stop(): handlers are dropped and poll()/runOnce()/upkeep() become no-ops, so nothing runs after stop. */
  private detach() {
    this.stopped = true;
    this.handlers = undefined;
  }

  /** One non-blocking claim step: claims up to the free in-flight capacity, starts the jobs, returns how many. */
  async poll(): Promise<number> {
    if (this.stopped) return 0;
    return this.serial(async () => {
      const free = CLAIM_LIMIT - this.inFlight.size;
      if (free <= 0) return 0;
      const jobs = await this.claimNow(free);
      for (const j of jobs) this.track(j);
      return jobs.length;
    });
  }

  /** Resolves once every in-flight job has settled. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** One claim-and-run step that awaits the jobs it claimed (tests); resolves with how many were claimed. */
  async runOnce(): Promise<number> {
    if (this.stopped) return 0;
    const started = await this.serial(async () => {
      const jobs = await this.claimNow(Math.max(0, CLAIM_LIMIT - this.inFlight.size));
      return jobs.map((j) => this.track(j));
    });
    await Promise.all(started);
    return started.length;
  }

  /** Runs claim steps one at a time on this instance (poll(), runOnce() and claim() may be called concurrently). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.claimChain.then(fn);
    this.claimChain = next.catch(() => undefined);
    return next;
  }

  private track(job: ClaimedJob): Promise<void> {
    const p = this.run(job).finally(() => {
      this.inFlight.delete(p);
      if (this.wake) this.wake();
      else this.pendingWake = true;
    });
    this.inFlight.add(p);
    return p;
  }

  /**
   * Claims up to `limit` due jobs (FOR UPDATE SKIP LOCKED) with attempts left. The fan-out cap is applied in the query:
   * other types are selected separately, so fan-outs ahead of them in the queue never block them.
   */
  claim(limit = CLAIM_LIMIT): Promise<ClaimedJob[]> {
    return this.serial(() => this.claimNow(limit));
  }

  private async claimNow(limit: number): Promise<ClaimedJob[]> {
    if (limit <= 0) return [];
    const now = this.parts.clock.now();
    const fanoutSlots = Math.min(limit, Math.max(0, this.config.fanoutMaxConcurrent - this.fanoutInFlight));
    const claimed = await this.parts.db.transaction(async (trx) => {
      const due = (n: number, fanout: boolean): Promise<(ClaimedJob & { run_at: Date })[]> =>
        trx
          .from(trx.raw('?? FORCE INDEX (idx_jobs_claim)', ['jobs']))
          .select('id', 'type', 'payload', 'attempts', 'run_at')
          .where('status', 'queued')
          .andWhere('run_at', '<=', now)
          .andWhere('attempts', '<', this.config.jobMaxAttempts)
          .andWhere('type', fanout ? '=' : '<>', FANOUT)
          .orderBy([{ column: 'run_at' }, { column: 'id' }])
          .limit(n)
          .forUpdate()
          .skipLocked();
      const others = await due(limit, false);
      const fanouts = fanoutSlots > 0 ? await due(fanoutSlots, true) : [];
      const take = [...others, ...fanouts]
        // Same order as each select: run_at, then id.
        .sort((x, y) => x.run_at.getTime() - y.run_at.getTime() || Number(x.id) - Number(y.id))
        .slice(0, limit);
      if (take.length > 0) {
        await trx('jobs')
          .whereIn(
            'id',
            take.map((r) => r.id),
          )
          .update({
            status: 'running',
            locked_by: this.workerId,
            locked_at: now,
            attempts: trx.raw('attempts + 1'),
          });
      }
      return take.map(({ id, type, payload, attempts }) => ({ id, type, payload, attempts }));
    });
    for (const j of claimed) {
      j.attempts += 1;
      if (typeof j.payload === 'string') j.payload = JSON.parse(j.payload);
      if (j.type === FANOUT) this.fanoutInFlight++;
    }
    return claimed;
  }

  /** Update fenced to the lease this worker holds on `job` (see the fencing rule above). Returns rows changed. */
  private fenced(job: ClaimedJob, values: Record<string, unknown>): Promise<number> {
    return this.ownRow(job).update(values);
  }

  /** The row `job` as long as this worker still holds its lease (status running, locked by us, same attempt). */
  private ownRow(job: ClaimedJob) {
    return this.parts.db('jobs').where({
      id: job.id,
      status: 'running',
      locked_by: this.workerId,
      attempts: job.attempts,
    });
  }

  /**
   * Refreshes the lease. Rows CHANGED is 0 both when the lease is lost and when `locked_at` already holds this second
   * (DATETIME is whole seconds), so a 0 is confirmed with a read under the same fence before aborting.
   */
  private async heartbeat(job: ClaimedJob): Promise<void> {
    if ((await this.fenced(job, { locked_at: this.parts.clock.now() })) > 0) return;
    if (await this.ownRow(job).first('id')) return;
    throw new Error(`lease lost on job ${job.id} (attempt ${job.attempts}); abort`);
  }

  private async callOnDead(type: JobType, payload: object, error: Error, jobId: number): Promise<void> {
    try {
      await this.opts?.onDead(type, payload, error);
    } catch (e) {
      this.parts.log.error({ err: e, jobId, type }, 'onDead failed; job stays dead');
    }
  }

  /** Runs one claimed job. Never rejects: outcome writes and onDead are outside the handler's try/catch. */
  private async run(job: ClaimedJob): Promise<void> {
    const started = Date.now();
    const { clock, log, metrics } = this.parts;
    let outcome: 'done' | 'retry' | 'dead' | 'lost_lease' | 'write_failed' = 'done';
    let error: Error | undefined;
    try {
      const handler = this.handlers?.[job.type];
      if (typeof handler !== 'function') throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(job.payload, {
        attempt: job.attempts,
        heartbeat: () => this.heartbeat(job),
      });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    try {
      const now = clock.now();
      let changed: number;
      if (!error) {
        changed = await this.fenced(job, {
          status: 'done',
          locked_by: null,
          locked_at: now,
        });
      } else if (job.attempts >= this.config.jobMaxAttempts) {
        outcome = 'dead';
        const lastError = error.stack ?? error.message;
        changed = await this.fenced(job, {
          status: 'dead',
          locked_by: null,
          locked_at: now,
          last_error: lastError,
        });
        if (changed === 1) await this.callOnDead(job.type, job.payload, error, job.id);
      } else {
        outcome = 'retry';
        changed = await this.fenced(job, {
          status: 'queued',
          locked_by: null,
          locked_at: null,
          run_at: new Date(now.getTime() + 2 ** job.attempts * MINUTE_MS),
          last_error: error.stack ?? error.message,
        });
      }
      if (changed === 0) {
        outcome = 'lost_lease';
        log.warn({ jobId: job.id, type: job.type, attempt: job.attempts }, 'lost lease; result discarded');
      }
    } catch (e) {
      // Leave the row `running`: the lease mechanism re-queues (or dead-letters) it.
      outcome = 'write_failed';
      log.error({ err: e, jobId: job.id, type: job.type }, 'job outcome write failed; left to the lease');
    } finally {
      if (job.type === FANOUT) this.fanoutInFlight--;
      const durationMs = Date.now() - started;
      log.info(
        {
          jobId: job.id,
          type: job.type,
          attempt: job.attempts,
          outcome,
          durationMs,
        },
        'job attempt',
      );
      metrics.count('job_outcome', 1, { type: job.type, outcome });
      metrics.timing('job_duration_ms', durationMs, { type: job.type });
    }
  }

  /**
   * Stand-in upkeep: running jobs past the lease are re-queued, or dead-lettered (onDead once, by the worker whose
   * update changed the row) when they have no attempts left; done rows older than 7 days are deleted.
   */
  async upkeep(): Promise<void> {
    if (this.stopped) return;
    const { db, clock } = this.parts;
    const now = clock.now();
    const leaseCutoff = new Date(now.getTime() - this.config.jobLeaseMinutes * MINUTE_MS);
    const exhausted: ClaimedJob[] = await db('jobs')
      .select('id', 'type', 'payload', 'attempts')
      .where('status', 'running')
      .andWhere('locked_at', '<', leaseCutoff)
      .andWhere('attempts', '>=', this.config.jobMaxAttempts);
    for (const j of exhausted) {
      const error = new Error(`lease expired on final attempt ${j.attempts}`);
      const changed = await db('jobs')
        .where({ id: j.id, status: 'running', attempts: j.attempts })
        .andWhere('locked_at', '<', leaseCutoff)
        .update({
          status: 'dead',
          locked_by: null,
          locked_at: now,
          last_error: error.message,
        });
      if (changed === 1) {
        const payload = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
        await this.callOnDead(j.type, payload, error, j.id);
      }
    }
    await db('jobs')
      .where('status', 'running')
      .andWhere('locked_at', '<', leaseCutoff)
      .andWhere('attempts', '<', this.config.jobMaxAttempts)
      .update({ status: 'queued', locked_by: null, locked_at: null });
    // A queued row with no attempts left (JOB_MAX_ATTEMPTS lowered) is never claimed: dead-letter it, fenced on
    // status and attempts so onDead runs exactly once.
    const stranded: ClaimedJob[] = await db('jobs')
      .select('id', 'type', 'payload', 'attempts')
      .where('status', 'queued')
      .andWhere('attempts', '>=', this.config.jobMaxAttempts);
    for (const j of stranded) {
      const error = new Error(
        `no attempts left (${j.attempts} >= JOB_MAX_ATTEMPTS ${this.config.jobMaxAttempts})`,
      );
      const changed = await db('jobs')
        .where({ id: j.id, status: 'queued', attempts: j.attempts })
        .update({ status: 'dead', locked_by: null, locked_at: now, last_error: error.message });
      if (changed === 1) {
        const payload = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
        await this.callOnDead(j.type, payload, error, j.id);
      }
    }
    // Chunked so one large delete never holds locks long enough to time out.
    const doneCutoff = new Date(now.getTime() - DONE_RETENTION_DAYS * DAY_MS);
    for (;;) {
      const deleted = await db('jobs')
        .where('status', 'done')
        .andWhere('locked_at', '<', doneCutoff)
        .limit(DONE_DELETE_CHUNK)
        .del();
      if (deleted < DONE_DELETE_CHUNK) break;
    }
    // §11.4 queue depth (queued jobs that are due) and the age of the oldest one, measured from its run_at.
    const [due] = await db('jobs')
      .where('status', 'queued')
      .andWhere('run_at', '<=', now)
      .count({ n: '*' })
      .min({ oldest: 'run_at' });
    const oldest = due?.oldest ? new Date(due.oldest as Date).getTime() : null;
    this.parts.metrics.gauge('queue_depth', Number(due?.n ?? 0));
    this.parts.metrics.gauge(
      'queue_oldest_age_seconds',
      oldest === null ? 0 : Math.floor((now.getTime() - oldest) / 1000),
    );
  }

  /** Not part of Queue: housekeeping calls it when the configured queue provides it (§8.3). Returns rows deleted. */
  async purgeDead(): Promise<number> {
    const cutoff = new Date(this.parts.clock.now().getTime() - this.config.deadJobRetentionDays * DAY_MS);
    return this.parts.db('jobs').where('status', 'dead').andWhere('locked_at', '<', cutoff).del();
  }
}
