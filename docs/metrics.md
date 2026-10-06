# Metrics catalogue

All metrics go through `deps.metrics` (`src/lib/metrics.ts`): CloudWatch Embedded Metric Format lines written by the
logger, namespace `NotificationCenter`, timestamp from the injected clock. Dimensions are low-cardinality strings only:
never account ids, notification ids, public ids, request paths, tokens, notification content or CSV contents.

| Metric                               | Type   | Dimensions                                                                        | Emitted in                                                    | Serves (§11.4 / §11.5)                       |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `http_requests`                      | count  | `method`, `route` (template or `unmatched`), `status`                             | `src/middleware/requestContext.ts`                            | §11.4 request count/status by route          |
| `http_request_duration_ms`           | timing | `method`, `route`, `status`                                                       | `src/middleware/requestContext.ts`                            | §11.4 request duration by route              |
| `http_5xx`                           | count  | `route`, `status`                                                                 | `src/middleware/requestContext.ts`                            | §11.5 API 5xx rate                           |
| `member_not_found`                   | count  | none                                                                              | `src/middleware/requestContext.ts` (404 on `/notifications…`) | §11.4 member-route 404 rate (probing)        |
| `readiness_failed`                   | count  | `process` = `api` \| `worker`                                                     | `src/app.ts` (`/readyz`), `src/worker.ts` (`healthHandler`)   | §11.5 readiness failing                      |
| `job_outcome`                        | count  | `type`, `outcome` = `done` \| `retry` \| `dead` \| `lost_lease` \| `write_failed` | `src/queue/dbQueue.ts` (per attempt)                          | §11.4 job outcomes by type                   |
| `job_duration_ms`                    | timing | `type`                                                                            | `src/queue/dbQueue.ts` (per attempt)                          | §11.4 job duration by type                   |
| `queue_depth`                        | gauge  | none                                                                              | `src/queue/dbQueue.ts` `upkeep()` (once a minute)             | §11.4 queue depth (queued and due)           |
| `queue_oldest_age_seconds`           | gauge  | none                                                                              | `src/queue/dbQueue.ts` `upkeep()`                             | §11.4 oldest queued job age                  |
| `job_dead`                           | count  | `type`                                                                            | `src/jobs/index.ts` (onDead)                                  | §11.5 any job dead                           |
| `scheduled_run`                      | count  | `name`, `status` = `ok` \| `failed` \| `skipped`                                  | `src/scheduler/index.ts`                                      | §11.5 rescan / due_send not completed        |
| `timer_failed`                       | count  | `name`                                                                            | `src/scheduler/index.ts`                                      | scheduled job failures                       |
| `due_send_released`                  | count  | none                                                                              | `src/scheduler/dueSend.ts`                                    | §11.4 scheduled sends released               |
| `due_send_cancelled_deleted`         | count  | none                                                                              | `src/scheduler/dueSend.ts`                                    | §11.4 cancelled scheduled deliveries removed |
| `due_send_lag_seconds`               | gauge  | none                                                                              | `src/scheduler/dueSend.ts`                                    | §11.5 due-send lag above 5 minutes           |
| `trigger_enqueue_failed`             | count  | `job`                                                                             | `src/trigger/index.ts`                                        | §11.5 trigger enqueue failures above zero    |
| `fanout_filter_deliveries_written`   | count  | none                                                                              | `src/jobs/fanoutFilter.ts`                                    | §11.4 deliveries written                     |
| `fanout_filter_unusable_filters`     | count  | none                                                                              | `src/jobs/fanoutFilter.ts`                                    | drop counter                                 |
| `account_recheck_deliveries_written` | count  | none                                                                              | `src/jobs/accountRecheck.ts`                                  | §11.4 deliveries written                     |
| `account_recheck_unusable_filters`   | count  | none                                                                              | `src/jobs/accountRecheck.ts`                                  | drop counter                                 |
| `event_delivery_inserted`            | count  | `type`                                                                            | `src/jobs/eventDelivery.ts`                                   | §11.4 deliveries written                     |
| `event_delivery_invalid_payload`     | count  | none                                                                              | `src/jobs/eventDelivery.ts`                                   | drop counter                                 |
| `event_delivery_unknown_account`     | count  | `type`                                                                            | `src/jobs/eventDelivery.ts`                                   | drop counter                                 |
| `event_delivery_too_old`             | count  | `type`                                                                            | `src/jobs/eventDelivery.ts`                                   | drop counter                                 |
| `process_import_deliveries_written`  | count  | none                                                                              | `src/jobs/processImport.ts`                                   | §11.4 deliveries written                     |
| `process_import_unknown_accounts`    | count  | none                                                                              | `src/jobs/processImport.ts`                                   | drop counter                                 |
| `process_import_completed`           | count  | none                                                                              | `src/jobs/processImport.ts`                                   | import throughput                            |
| `process_import_failed`              | count  | `reason` = `removed` \| `dead`                                                    | `src/jobs/processImport.ts`                                   | import failures                              |
| `cancel_scheduled_deleted`           | count  | none                                                                              | `src/jobs/cancelScheduled.ts`                                 | §11.4 cancellation                           |
| `cancel_scheduled_contended`         | count  | none                                                                              | `src/jobs/cancelScheduled.ts`                                 | lock contention                              |
| `rescan_enqueued`                    | count  | none                                                                              | `src/scheduler/rescan.ts`                                     | §11.4 nightly rescan                         |
| `rescan_enqueue_failed`              | count  | none                                                                              | `src/scheduler/rescan.ts`                                     | rescan enqueue failures                      |
| `housekeeping_enqueue_failed`        | count  | `type`                                                                            | `src/scheduler/housekeeping.ts`                               | housekeeping enqueue failures                |
| `expiry_rows_archived`               | count  | none                                                                              | `src/scheduler/expiry.ts`                                     | §11.4 expiry                                 |
| `expiry_run_stopped`                 | count  | `reason`                                                                          | `src/scheduler/expiry.ts`                                     | expiry run cut short                         |

The §11.4 per-account-per-day abuse signal is not emitted; per-account spikes show in `event_delivery_inserted` and
`account_recheck_deliveries_written`, and a per-account view would need a `created_at` index on
`notification_deliveries`.

`/healthz` and `/readyz` carry their own fixed `route` values (`/healthz`, `/readyz`) in `http_requests`,
`http_request_duration_ms` and `http_5xx`, so probe traffic does not dominate `unmatched`. The worker counts
`readiness_failed{process=worker}` only when its database ping fails, not while it is shutting down gracefully.

`job_duration_ms` no longer carries `outcome`; the outcome is on `job_outcome`.

## §11.5 alarms

| Alarm                                     | Metric                                   | Threshold                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any job dead                              | `job_dead` (sum, any `type`)             | > 0 in 5 minutes                                                                                                                                                                                                    |
| Due-send lag                              | `due_send_lag_seconds` (max)             | > 300                                                                                                                                                                                                               |
| due_send not completed in 5 minutes       | `scheduled_run{name=due_send,status=ok}` | sum = 0 over 5 minutes (treat missing data as breaching)                                                                                                                                                            |
| Rescan not completed in 25 hours          | `scheduled_run{name=rescan,status=ok}`   | sum = 0 over 25 hours (missing data breaching)                                                                                                                                                                      |
| An import processing for more than 1 hour | **no metric yet**                        | Nothing emits the age of the oldest `processing` import. It needs a gauge (for example from housekeeping or a minute timer) or a check of `imports` where `status='processing'` and `updated_at` older than 1 hour. |
| Trigger enqueue failures                  | `trigger_enqueue_failed`                 | sum > 0                                                                                                                                                                                                             |
| API 5xx rate                              | `http_5xx` / `http_requests`             | ratio above an agreed rate (for example 1% over 5 minutes)                                                                                                                                                          |
| Readiness failing                         | `readiness_failed` by `process`          | > 0 for 3 consecutive minutes                                                                                                                                                                                       |
