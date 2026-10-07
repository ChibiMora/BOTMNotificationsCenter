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
| [`docs/build-issues.md`](docs/build-issues.md)   | Every place the build found the design silent, ambiguous or wrong, the choice made for each, and my decision on it (111 entries).                                                                                                                                                        |
| [`docs/code-audit.html`](docs/code-audit.html)   | Post-build audit of the code and of the tests (do the assertions encode the spec and the design, or something looser?), with my decisions.                                                                                                                                              |
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

Repeating the same request with the same `Idempotency-Key` replays the original response; keys are scoped per endpoint (filter and event creates share one scope), so the same key on an import upload or import run is a separate request, while the same key with a different body, or on the other of filter/event, is a 400.

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


## Workflow

I worked in three phases, each ending in a document that the next phase treated as its input: a reviewed architecture (`docs/architecture.md`), a standalone technical design (`docs/tech-design.html`), and the code with its issue ledger (`docs/build-issues.md`, `docs/code-audit.html`). The rule throughout was that AI generates, reviews and explains; I decide.

### How I approached it

1. **Rewrote the requirements in my own words** before anything else. This surfaced parts of the spec I had misread on the first pass.
2. **Designed by hand, data first.** I drew the tables, then worked through the API endpoints without AI. Writing the endpoints exposed columns the tables were missing and the background jobs the system would need (scheduled sends, monthly resends, expiry).
3. **Had AI audit my draft against the spec.** I fed the draft and the spec to Claude as separate documents and asked it to check coverage line by line, question my assumptions, lay out alternatives with tradeoffs, and tell me what I had missed. It produced 38 findings; I answered every one individually, accepting, rejecting, or substituting my own design. The decisions are the A# register in `docs/architecture.md`.
4. **Had AI write the tech design from the settled architecture**, as an HTML document with diagrams so the flows were easier to follow than prose, and iterated on it until I understood exactly how it intended to implement each piece. I then had four independent AI reviewers read the spec and the tech design cold (coverage, security, scale, consistency); they returned 61 items and 17 spec deviations, and I ruled on each. I did a final pass by hand for inconsistencies before freezing it.
5. **Had AI build the code from the frozen design**, split into eleven units (U0–U10). Each unit was built by a fresh agent from a self-contained brief: tests first, with the failing-test output shown before implementation; never modify a test to make it pass; never change a contract; when the design is ambiguous, pick the reading most consistent with the rest of it and record the choice instead of stopping. Each unit then had to pass two independent read-only reviews, a code review and a separate design-conformance audit, before it merged to `main`. I ran this overnight.
6. **Audited the output.** I read the open questions the build raised (all 111 in `docs/build-issues.md`) and decided each. I then ran two audits with no history of the build: one over the code alone, with `docs/` deliberately withheld, judging internal consistency, failure behaviour and cost rather than spec conformance; and one over the tests, reading assertion bodies rather than names against the spec and the tech design, since neither the builders nor the reviewers had read the spec directly. Both are in `docs/code-audit.html` with my decision on each finding. I ran the test suite myself and read the tests.

### What I delegated to AI

- Gap analysis of my design against the spec, and explaining concepts I asked about.
- Generating alternatives and weighing scale, performance and security tradeoffs so I could choose between them.
- Writing the architecture and tech-design documents from my decisions, and propagating each decision consistently through contracts, schema, flows, tests and diagrams.
- All implementation code, all code review passes, and maintaining the issue ledgers.

### What I did by hand

- The initial design: tables, endpoints, request and response shapes, error cases.
- Every decision at all three levels. When the AI suggested something I did not already understand, I had it explain, and where I was still unsure I looked up the pattern myself before accepting or proposing an alternative.
- The AI build process and prompts.
- Running the tests and reading them; reading the final code and SQL schemas against the requirements.

### Where I pushed back

A few representative cases; the full set is in the decision registers.

- **Member API keying.** The AI proposed exposing the notification id and bolting on an ownership check. I countered with keying the member endpoints on the delivery row's own opaque id, so ownership is part of the lookup rather than a check beside it.
- **REST hygiene.** The design carried verb endpoints (`/clicked`, `/retry`). I asked for resources only: click became `PATCH` on the delivery, re-running an import became a `runs` resource, and I had the remaining method inconsistencies listed and fixed.
- **Publication date.** The audit raised "pre-order with no publication date yet." I asked why a job would ever need the date if the publication itself is the event. That removed a whole scheduling mechanism from the design.
- **"At any point" eligibility.** The AI proposed a more frequent rescan; I asked whether that actually met the requirement and whether account-change hooks were better. When pressed it said both; I decided to do both: hooks for immediacy, the daily rescan as the safety net.
- **Idempotency keys.** The build enforced a cross-endpoint rule with racy reads across three tables and proposed a new shared table to fix it. I asked what the check actually bought and scoped keys per endpoint instead, which removed the race by removing the rule. The code got smaller.
- **Scheduler catch-up.** The design had recorded "no catch-up" as accepted. The audit showed a missed expiry run would wait a day after a deploy. I reversed the decision but capped it: one catch-up per timer for the most recent missed run, so a worker down for a week runs one expiry, not seven.
- **Invented limits.** The AI added a 1,000-entry cap to import error reports and a content cache. I asked why each existed; neither had a reason, and both were removed.
- **Things I declined for sake of time.** The admin audit trail and `/admin` network hardening (the host codebase's responsibility), hardening the temporary queue stand-in, and a fix for corrupt filters that the API already prevents.


### With more time

I would spend it reading the final code and tests more thoroughly myself. The audits were useful, but I relied on them more than I would want to for code going to production.

## Architecture decisions and tradeoffs

- **Fan-out on write, one row per delivery.** Every recipient gets their own row, which makes member reads cheap and gives per-delivery clicked state and the once-per-month rule. Cost: a whole-base filter writes one row per member (pages of `FANOUT_BATCH_SIZE`), a burst of write load per campaign.
- **Filter eligibility: hooks plus a daily rescan.** A member who qualifies days after a filter notification goes live is caught either by the account-change hook or by the rescan. I chose both rather than instrumenting every code path that can change an account: a delay is better than a missed member, and the rescan keeps correctness in one place.
- **Scheduled sends are rows, not delayed queue jobs.** Future deliveries are written unsent and released by due-send, so they are visible and cancellable in SQL and do not depend on the queue's delay feature. Cost: a polling job and up to one interval of latency.
- **Cancellation is enforced at release.** Deactivate records a cutoff; due-send releases only rows of an active notification created after it, and a cleanup job deletes the rest. Cost: the release statement carries the rule, with a residual window (see Concerns).
- **One idempotent insert path with a dedupe key.** Fan-out, rescans, events and imports all insert through the same function; a unique dedupe key per delivery makes retried and duplicate jobs harmless. Cost: every source must encode its identity into that key correctly.
- **Archive on expiry rather than delete.** Expired deliveries move to a separate table so the main table stays small and the history survives for auditing. I would confirm with product that history is wanted; if not, this becomes a delete.
- **Lookup table for notification type, not an enum.** Adding a type is a row, not a migration. I would have kept the enum if product had said no new types were foreseeable.
- **Cursor pagination for the member list.** Notifications arrive at any time; offsets would skip or repeat items when a new one lands mid-scroll.
- **Queue behind an interface, with a temporary database stand-in.** Nothing outside `src/queue` knows which queue runs. Cost: the `jobs` table is a throughput ceiling, not built to scale, and must be replaced by the company queue.
- **No response caching.** Member reads hit indexed rows directly, so nothing needs invalidating on deactivate, remove or click. Cost: every read is a database query.
- **Deprioritized:** admin audit trail, `/admin` network hardening, cross-instance rate limiting, a per-notification fan-out lock, capacity numbers, and an admin dashboard beyond the endpoints the member side needs to make sense.

## Concerns

Items to raise in a real code review or revisit. Numbers refer to entries in [`docs/build-issues.md`](docs/build-issues.md); letters (H/M/L) to findings in [`docs/code-audit.html`](docs/code-audit.html). Each has my decision recorded there.

- **No admin audit trail.** Any admin can message the whole member base or permanently remove a notification with no record of who did it. I left it out as its own project, but I would raise it immediately.
- **The tests confirm the code, not the spec.** They were written by the same agent as the code. The test audit found four concurrency tests that would pass under a sequential run (they do not force the race), several tests whose names promise more than the body checks, and tests that pin behaviour the design never states. I would tighten the concurrency tests first.
- **The production guard is a string match (H1).** Stand-ins are refused only when `NODE_ENV` is exactly `production`; any other value (`staging`, unset) accepts any caller's claimed account id. The guard should be inverted so stand-ins need an explicit opt-in.
- **Decided (63): deactivation versus an in-flight release.** Due-send locks delivery rows only, not the notification row. An admin deactivate therefore always succeeds, but one batch already being released (up to `DUE_SEND_BATCH`, default 1000 rows) can still go live just after it. The strict alternative costs 409s on admin updates while a release runs. Decided: the window is accepted; admin updates must not fail.
- **Daily rescan cost scales with notifications × accounts (M1).** Every active filter notification walks the whole accounts table every day, and housekeeping re-enqueues a fan-out every five minutes for any notification with no delivery this month, so an empty-audience notification is scanned 288 times a day. Recording "fan-out completed for month M" on the notification would remove most of it. Deferred until there are real numbers.
- **Coupled to the host's `accounts` table (H3, 61, 65).** Deliveries carry a foreign key with `ON DELETE CASCADE`, eligibility is SQL over four `accounts` columns, due-send holds shared locks on up to 1000 account rows per batch, and an account delete can deadlock with expiry. Accepted for now; the owner of `accounts` needs to agree.
- **Deploys cost long jobs an attempt (M4).** A job interrupted by shutdown stays `running` until its 15-minute lease expires, and attempts are counted at claim time, so five unlucky deploys dead-letter a fan-out. Belongs to the queue stand-in.
- **Dropped events have metrics but no alarm (69),** and **an event can be lost between commit and enqueue** (tech design §13.3): the trigger enqueues after the business write commits and swallows failures. Counted, not recovered; an outbox is the fix.
- **Query plans not verified at volume (45, 59).** The cursor comparison may not range-seek in MySQL, and expiry ordering needed a workaround because no index serves `(sent_at, id)`.
- **Import reports are uncapped** (§13.9), and admins have no view of import results beyond the report endpoint.
- **Documentation.** The code is commented heavily but does not follow a documentation standard.

## Assumptions

Where the spec was ambiguous, I decided:

- **"Wiped after 2 months"** means hidden from members and archived, not deleted; retention is a product and legal question.
- **"Static months"** means the current and previous calendar month, in UTC, counted from go-live rather than creation.
- **Images** are stored in cloud object storage; the API accepts a path and the service builds the URL from a configured base. Each notification has its own image.
- **Member list responses** carry only the headline, subheadline and clicked state; the image and the rest load on the detail view.
- **Only `isActive` and remove are editable** after creation, since the spec names only those; it must be stated explicitly on create. Whether reactivation is allowed is an open product question.
- **Refer-a-friend** is an `enrolled` event, with the referring member as the recipient. A pre-ordered audiobook is the event at publication, delivered immediately.
- **CSV import:** ids not in `accounts` are skipped and listed in the report; a malformed file is rejected whole.
- **The credits filter** is one inclusive range (`minimum`, `maximum`, each optional).
- **Remove is permanent:** a removed notification cannot be changed again (409) and leaves members' lists at once.
- **Delivery is in-app only;** no push, email or SMS.
- **An admin UI exists or is being built elsewhere;** this repository owns only the external contracts. The real `accounts` table, session and role system, and queue have the shapes in tech design §1.4, each isolated behind one adapter, because I had no access to the existing codebase.

## What's missing for true production readiness

- **A real message queue.** The `jobs` table is a stand-in that will not scale; the `Queue` interface is the contract for the company's queue (Kafka or otherwise).
- **Real adapters** for the session and role system (`AuthProvider`) and the real `accounts` table, with its shape and stored values confirmed against the stand-in. Production configuration refuses to start without them.
- **A way for the business code to call `NotificationTrigger`.** Nothing in this repository calls it and `package.json` has no `exports`, so the integration shape (published package or internal endpoint) is undecided, and the first real caller is unwritten. The contracts into existing code (trigger call sites, account data) also need verifying against the actual codebase rather than my assumptions.
- **An outbox** for trigger events, so an event cannot be lost between the business commit and the enqueue.
- **CSV uploads in object storage, not MySQL.** Files are capped at `CSV_MAX_BYTES` (10 MiB) but parsed in the API process with no concurrency limit and stored as a `MEDIUMBLOB`; the cap is not validated against the column size.
- **Alarms and dashboards** wired to the metrics in `docs/metrics.md`, and the metric choices themselves confirmed, since many were my assumptions.
- **Load testing** of fan-out, due-send and expiry at real volumes, including the index questions in build-issues 45 and 59 and the rescan cost in M1.
- **Secrets management and deployment wiring** (environments, separate API and worker services, `node dist/scripts/db.js migrate <DB_NAME>` as a release step), and rate limiting that is shared across instances and counts unauthenticated requests (today it runs after auth, per instance).
- **An admin audit trail** and an admin view of import status and errors.
