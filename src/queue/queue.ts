// TYPE-ONLY (§6.3, §8.2). Implementations (dbQueue, real adapter) belong to later units.
export type JobType =
  'fanout_filter' | 'process_import' | 'event_delivery' | 'account_recheck' | 'cancel_scheduled';
/** Event triggers (§8.2). Defined here because queue/ must not import trigger/. */
export type EventTrigger = 'shipped' | 'enrolled' | 'preenrollAudiobook';
type Base = { requestId?: string };
export interface JobPayloads {
  fanout_filter: Base & { notificationId: number };
  process_import: Base & { importId: number; runId: number };
  /** `occurredAt` is an ISO-8601 UTC string on the wire (e.g. '2026-10-01T12:00:00Z'), not a Date. */
  event_delivery: Base & { type: EventTrigger; accountId: number; occurredAt: string; occurrenceKey: string };
  account_recheck: Base & { accountId: number };
  cancel_scheduled: Base & { notificationId: number };
}
export interface JobContext {
  attempt: number;
  heartbeat(): Promise<void>;
}
export type JobHandlers = Record<JobType, (payload: any, ctx: JobContext) => Promise<void>>;
export interface ConsumeOptions {
  onDead(type: JobType, payload: object, error: Error): Promise<void>;
}
export interface Queue {
  enqueue(type: JobType, payload: object, opts?: { runAt?: Date }): Promise<void>;
  /** After the final attempt `onDead` is called once and the job is not delivered again. */
  consume(handlers: JobHandlers, opts: ConsumeOptions): Promise<{ stop(): Promise<void> }>;
}
