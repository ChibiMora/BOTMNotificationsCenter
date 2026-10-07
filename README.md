# Notification Center

Backend for a Book of the Month member notification center. Admins publish in-app notifications to members (by attribute filter, by triggered event, or by CSV upload of account ids), and members list, open and mark their notifications as clicked.

Stack: Node 22, TypeScript (strict, ESM), Koa, knex over mysql2, MySQL 8 (Aurora MySQL in production), zod, pino, vitest + supertest.

## Status

Implemented. The service exposes three entry points:

- **Admin HTTP surface** (`/admin/notifications…`): list, get, create filter notification, create event notification, CSV import, import report, re-run an import, and `PATCH` to activate, deactivate or remove.
- **Member HTTP surface** (`/notifications…`): list my notifications, get one, `PATCH` to mark one clicked.
- **`NotificationTrigger`**: an in-process class for business code, with `record(event)` and `accountChanged(accountId)`.

Three stand-ins replace systems this service does not own, so it runs end to end today: a seeded `accounts` table, header authentication, and a database-backed job queue. Each is refused when `NODE_ENV=production`, so **the service is not deployable to production as is**. See [What's missing for true production readiness](#whats-missing-for-true-production-readiness).

## Documents

| File                                             | Purpose                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/spec.md`](docs/spec.md)                   | Product and engineering requirements. Source of truth; wins any disagreement.                                                                                                                                                                                                            |
| [`docs/design-draft.md`](docs/design-draft.md)   | Original design draft that the review started from. Kept as-is for history.                                                                                                                                                                                                              |
| [`docs/architecture.md`](docs/architecture.md)   | Reviewed architecture: requirements (R#), decisions and assumptions (A#), API contracts, data model. Historical record of the design-review phase.                                                                                                                                       |
| [`docs/tech-design.html`](docs/tech-design.html) | Standalone technical design. Open it in a browser: behaviour rules, full API contracts, schema, module layout, core-flow and lifecycle diagrams, background jobs, testing strategy, implementation units, and the decision register. This is the document the implementation works from. |
| [`docs/build-issues.md`](docs/build-issues.md)   | Every place the build found the design silent, ambiguous or wrong, the choice made for each, and what is needed to close it.                                                                                                                                                             |
| [`docs/metrics.md`](docs/metrics.md)             | Every metric the service emits and the alarms it serves.                                                                                                                                                                                                                                 |

Reading order:

1. `docs/spec.md` for what is being built.
2. `docs/tech-design.html` for how. It is self-contained and does not require the other documents.
3. `docs/build-issues.md` for where the code fills in or departs from the design.
4. `docs/architecture.md` only if you want the reasoning trail behind a decision.

## Run it locally

Prerequisites: Node 22, npm, Docker.

```sh
docker compose up -d mysql      # one MySQL 8 on 127.0.0.1:3306, root/root, shared by every checkout
npm ci
```

Configuration is read from the environment (every name and default: `src/config/index.ts`; minimal set: `.env.example`). Set these in every shell that runs the service:

```sh
export DATABASE_URL=mysql://root:root@127.0.0.1:3306/notification_center
export DB_NAME=nc_local                 # overrides the database named in DATABASE_URL
export STANDINS=true AUTH_IMPL=header QUEUE_IMPL=db
export ASSET_BASE_URL=https://assets.example.com SITE_BASE_URL=https://www.example.com
```

Create the database. `create` creates it, runs the migrations and, with `STANDINS=true`, seeds the 72 stand-in accounts (ids 1–3 are the admins under the default `ADMIN_ACCOUNT_IDS=1,2,3`). `migrate` only runs migrations; `drop` drops the database.

```sh
npm run db -- create nc_local
```

Start the two processes, each in its own shell with the environment above:

```sh
PORT=3000 npx tsx src/api.ts                    # API; health at GET :3000/healthz
WORKER_HEALTH_PORT=3001 npx tsx src/worker.ts   # queue consumer + scheduler; health at GET :3001/healthz
```

Built form: `npm run build`, then `node dist/src/api.js` and `node dist/src/worker.js`; `node dist/scripts/db.js migrate <DB_NAME>` runs migrations as a release step. The `Dockerfile` builds one image for both processes; its default command is the API.

Deployment: migrations are forward-only (expand → migrate → contract: add columns/tables first, deploy code that uses
them, remove the old ones in a later release); rollback is redeploying the previous image, never a down-migration. The
release step `node dist/scripts/db.js migrate <DB_NAME>` needs only the database settings (`DATABASE_URL`; the argument
names the database) — no application settings — and refuses `STANDINS=true` under `NODE_ENV=production`. Migrations
are recorded by extension-less name, so a database migrated from the `.ts` sources and one migrated by the image agree.
The image's HEALTHCHECK probes `HEALTH_PORT` when set; otherwise it tries `PORT` (default 3000), then
`WORKER_HEALTH_PORT` (default 3001), and is healthy if either answers. Each container runs one process, so the API and
the worker are healthy with no extra settings, even when they share one env file.

### Examples

Responses below are real, trimmed. Create a filter notification as admin 1:

```sh
curl -s -X POST localhost:3000/admin/notifications/filter \
  -H 'Content-Type: application/json' -H 'X-Account-Id: 1' \
  -H 'Idempotency-Key: 6f1c2b6e-4d0a-4c55-9a43-2f6d1b7e9c01' \
  -d '{"image":"/img/fall-picks.png","headline":"Fall picks are here","subheadline":"Five new books this month","link":"/books/fall","isActive":true,"filters":{"country":["US"],"policy":["monthly"]}}'
```

```
201 {"id":1,"type":"filter","image":"https://assets.example.com/img/fall-picks.png","headline":"Fall picks are here",
     "link":"https://www.example.com/books/fall","isActive":true,"isRemoved":false,
     "activatedAt":"2026-10-06T10:18:03Z","filters":{"policy":["monthly"],"country":["US"]}, ...}
```

A few seconds later (the worker does the fan-out), list as a matching member:

```sh
curl -s localhost:3000/notifications -H 'X-Account-Id: 4'
```

```
200 {"items":[{"id":"dl_L7b1vLlbutXS","headline":"Fall picks are here","subheadline":"Five new books this month",
     "isClicked":false,"liveDate":"2026-10-06T10:18:03Z"}],"nextCursor":null}
```

Mark it clicked (use the `id` from your own list):

```sh
curl -s -X PATCH localhost:3000/notifications/dl_L7b1vLlbutXS \
  -H 'Content-Type: application/json' -H 'X-Account-Id: 4' -d '{"isClicked":true}'
```

```
200 {"id":"dl_L7b1vLlbutXS", ..., "liveDate":"2026-10-06T10:18:03Z","isClicked":true}
```

A non-admin on the admin surface gets 403 (and another member's delivery id gives 404 `NOT_FOUND`):

```sh
curl -s -w ' %{http_code}\n' -X POST localhost:3000/admin/notifications/filter \
  -H 'Content-Type: application/json' -H 'X-Account-Id: 4' \
  -H 'Idempotency-Key: 6f1c2b6e-4d0a-4c55-9a43-2f6d1b7e9c02' -d '{}'
```

```
{"error":"FORBIDDEN"} 403
```

### Tests

```sh
npm run test:unit   # no database needed
npm test            # typecheck -> unit -> integration -> contract (end to end, including scenario tests)
npm run lint
```

Integration and contract tests need the MySQL container. The test setup creates, migrates and seeds its database itself (`DATABASE_URL` defaults to the one above, `DB_NAME` to `notification_center_test`) and holds a MySQL named lock on it for the whole run, so a second run against the same database fails fast instead of colliding.

Several checkouts can test in parallel against the one MySQL server by giving each its own database:

```sh
DB_NAME=nc_checkout_a npm test     # in checkout A
DB_NAME=nc_checkout_b npm test     # in checkout B
npm run db -- drop nc_checkout_a   # clean up afterwards
```

## Architecture at a glance

```
admin website --HTTP--> API process (src/api.ts) <--HTTP-- member app
                          /admin/notifications...   /notifications...
business code --> NotificationTrigger (in-process; only enqueues)
                          |
                       job queue (stand-in: jobs table)
                          |
                 worker process (src/worker.ts)
                 queue consumer: fan-out, events, imports, cancellation
                 scheduler: due-send, daily rescan, expiry, housekeeping
                          |
                 MySQL / Aurora (one database shared by both processes)
```

- **Two processes, one codebase, one database.** The API serves both HTTP surfaces; the worker consumes the queue and runs the scheduled jobs.
- **"Sending" means inserting a row** in `notification_deliveries`. There is no push, email or SMS.
- **Scheduled sends** are delivery rows with `sent_at` unset and a `due_at`; the due-send job (every `DUE_SEND_INTERVAL_SECONDS`, default 60) releases due rows by setting `sent_at`.
- **The month window:** a member sees deliveries that went live in the current or previous calendar month, in UTC; older rows are expired by a daily job.
- **Stand-ins:** accounts (`STANDINS=true`), authentication (`AUTH_IMPL=header`: `X-Account-Id` names the caller, `ADMIN_ACCOUNT_IDS` the admins), queue (`QUEUE_IMPL=db`, the `jobs` table). Each sits behind one adapter or interface.
- **Metrics** are written as structured log lines in CloudWatch embedded metric format; the catalogue is `docs/metrics.md`.

Contracts, schema, flows and jobs are in [`docs/tech-design.html`](docs/tech-design.html).

## Architecture decisions and tradeoffs

- **Fan-out on write, one row per delivery.** Every recipient gets their own row, which makes member reads cheap and gives per-delivery clicked state and the once-per-month rule. Cost: a whole-base filter writes one row per member (pages of `FANOUT_BATCH_SIZE`), a burst of write load per campaign.
- **One idempotent insert path with a dedupe key.** Fan-out, rescans, events and imports all insert through the same function; a unique dedupe key per delivery makes retried and duplicate jobs harmless. Cost: every source must encode its identity into that key correctly.
- **Scheduled sends are rows, not delayed queue jobs.** Future deliveries are written unsent and released by due-send, so they are visible and cancellable in SQL and do not depend on the queue's delay feature. Cost: a polling job and up to one interval of latency.
- **Cancellation is enforced at release.** Deactivate records a cutoff; due-send releases only rows of an active notification created after it, and a cleanup job deletes the rest. Cost: the release statement carries the rule, with a residual window (see Concerns).
- **Queue behind an interface, with a temporary database stand-in.** Nothing outside `src/queue` knows which queue runs. Cost: the `jobs` table is a throughput ceiling, not built to scale, and must be replaced by the company queue.
- **No response caching.** Member reads hit indexed rows directly, so nothing needs invalidating on deactivate, remove or click. Cost: every read is a database query.

## Concerns

Items to raise in a real code review or revisit. Numbers refer to entries in [`docs/build-issues.md`](docs/build-issues.md); most entries need either a tech-design change or a confirmation.

- **Decided (63): deactivation versus an in-flight release.** Due-send locks delivery rows only, not the notification row. An admin deactivate therefore always succeeds, but one batch already being released (up to `DUE_SEND_BATCH`, default 1000 rows) can still go live just after it, with a `sent_at` earlier than the deactivation; remove still hides them at once. The strict alternative is to lock the notification row, which costs 409s on admin updates while a release runs. Decided: the window is accepted; admin updates must not fail.
- **Idempotency keys live in three tables (77)** (`notifications`, `imports`, `import_runs`) with no constraint across them; "same key, different endpoint is a 400" is enforced by application reads, not by the database.
- **Shared locks on account rows during due-send (65).** Setting `sent_at` changes an index that contains the account id, so MySQL re-checks the foreign key and holds shared locks on the batch's account rows until commit; writes to those accounts wait. Removing it needs a schema change.
- **Dropped events have metrics but no alarm (69).** Events dropped without a retry (invalid payload, unknown account, older than the window) are logged and counted, never reach the dead-job alarm, and no alarm is defined for them.
- **An event can be lost between commit and enqueue** (tech design §13.3). The trigger enqueues after the business write commits and swallows failures, so a crash or queue outage in that gap loses that occurrence; it is counted, not recovered.
- **Query plans not verified at volume (45, 59).** The cursor comparison may not range-seek in MySQL, and expiry ordering needed a workaround because no index serves `(sent_at, id)`. Neither can be judged on test-sized data.
- **Import reports are uncapped** (§13.9): every rejected id is returned.

## Assumptions

Where the spec was ambiguous, the design (or, where it was silent, the build) decided:

- "The last 2 months" means the current and previous calendar month, in UTC.
- A filter notification reaches a member at most once per calendar month, and again in a later month if they still match.
- Refer-a-friend is an `enrolled` event, with the referring member as the recipient.
- A pre-ordered audiobook is the event at publication, delivered immediately.
- CSV import: ids not in `accounts` are skipped and listed in the import report; a malformed file is rejected as a whole.
- The credits filter is one inclusive range (`minimum`, `maximum`, each optional).
- `isActive` must be stated explicitly when creating filter and event notifications.
- Remove is permanent: a removed notification cannot be changed again (409) and leaves members' lists at once.
- The real `accounts` table, session and role system, and queue have the shapes in tech design §1.4, each isolated behind one adapter.

## What's missing for true production readiness

- Real adapters for the session and role system (`AuthProvider`) and the company job queue (`Queue`); production configuration refuses to start without them.
- The real `accounts` table, with its shape and stored values confirmed against the stand-in.
- An outbox for trigger events, so an event cannot be lost between the business commit and the enqueue.
- Alarms and dashboards wired to the metrics in `docs/metrics.md`.
- Load testing of fan-out, due-send and expiry at real volumes, including the index questions in build-issues 45 and 59.
- Secrets management and deployment wiring (environments, separate API and worker services, `node dist/scripts/db.js migrate <DB_NAME>` as a release step).
- Rate limiting shared across instances; limits are currently enforced per API instance.
- Decisions on the open entries in `docs/build-issues.md`, starting with entry 63.

## Workflow

The repository was produced in stages: a product spec (`docs/spec.md`), an architecture review (`docs/architecture.md`), a standalone technical design (`docs/tech-design.html`), then implementation in eleven units (U0–U10) by AI coding agents. Each unit was built tests-first from a written brief that quoted the design, then reviewed by two independent passes, a code review and a separate design-conformance audit, with fix rounds until both accepted it. Every place the design was silent, ambiguous or wrong was recorded in `docs/build-issues.md` with the choice made.

> TODO (author): this section must be in your own words. Points only you can write: how you broke the problem down and why in that order; what you delegated to AI and what you kept; where you pushed back on its output (for example the decisions recorded in docs/build-issues.md that you changed or confirmed); what you did by hand; what you would do differently with more time.
