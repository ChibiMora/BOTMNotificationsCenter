import type { Queue, JobType, JobHandlers, ConsumeOptions } from '../../src/queue/queue.js';
/**
 * In-memory Queue (§6.3): records enqueues; runAll drives handlers synchronously in order.
 * `runAt` is recorded on `enqueued` but NOT honoured: every job runs when `runAll` is called, whatever its runAt.
 * A job type with no registered handler is a wiring bug: runAll throws immediately (no retry, no onDead).
 */
export class FakeQueue implements Queue {
  enqueued: Array<{ type: JobType; payload: object; runAt?: Date }> = [];
  private handlers?: JobHandlers;
  private opts?: ConsumeOptions;
  private nextError?: Error;
  private ran = 0;
  constructor(private readonly o: { maxAttempts?: number } = {}) {}
  async enqueue(type: JobType, payload: object, opts?: { runAt?: Date }) {
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = undefined;
      throw e;
    }
    this.enqueued.push({ type, payload, ...(opts?.runAt ? { runAt: opts.runAt } : {}) });
  }
  async consume(handlers: JobHandlers, opts: ConsumeOptions) {
    this.handlers = handlers;
    this.opts = opts;
    return { stop: async () => {} };
  }
  failNextEnqueue(error: Error) {
    this.nextError = error;
  }
  /** Runs every enqueued job (including ones enqueued while running) once (enqueued keeps the full history), retrying failures up to maxAttempts, then onDead. */
  async runAll() {
    if (!this.handlers || !this.opts) throw new Error('consume() not called');
    const max = this.o.maxAttempts ?? 5;
    for (let i = this.ran; i < this.enqueued.length; i++, this.ran = i) {
      const job = this.enqueued[i]!;
      const handler = this.handlers[job.type];
      if (typeof handler !== 'function') {
        throw new Error(`FakeQueue: no handler registered for job type "${job.type}"`);
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await handler(job.payload, { attempt, heartbeat: async () => {} });
          break;
        } catch (e) {
          if (attempt >= max) {
            await this.opts.onDead(job.type, job.payload, e as Error);
            break;
          }
        }
      }
    }
  }
}
