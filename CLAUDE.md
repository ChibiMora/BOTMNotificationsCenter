# Notification Center — agent guide

Backend for a Book of the Month member notification center: admins publish in-app notifications (by attribute filter, triggered event, or CSV of account ids); members list, open and click them. Node 22, TypeScript (strict, ESM), Koa, knex over mysql2, MySQL 8, zod, pino, vitest + supertest.

This file is a map. Do not re-summarize the documents below; read the one that answers your question.

## Where to look

| Question | Read |
| --- | --- |
| What must the system do? (source of truth; wins any disagreement) | `docs/spec.md` |
| How is it designed? Behaviour rules, API contracts, schema, flows, jobs, implementation units, decision register | `docs/tech-design.html` (standalone; open in a browser or read the HTML) |
| Where does the code fill in or depart from the design, and what was decided? | `docs/build-issues.md` (111 numbered entries, each with the owner's decision) |
| What did the post-build code and test audit find, and what was decided? | `docs/code-audit.html` (findings H1–H3, M1–M7, L1–L8; test-audit groups A–D) |
| What metrics exist and what alarms they serve | `docs/metrics.md` |
| Why a design decision was made (reasoning trail) | `docs/architecture.md` (A# decisions, R# requirements) |
| How to run locally, example requests, workflow, concerns, assumptions | `README.md` |
| Every config name and default | `src/config/index.ts` |

Precedence when documents disagree: spec > build-issues decision > tech design > architecture.

## Architecture in brief

Two processes, one codebase, one MySQL database.

- `src/api.ts` — HTTP. Admin surface `/admin/notifications…` (list, get, create filter/event, CSV import, import report, re-run import, `PATCH` activate/deactivate/remove). Member surface `/notifications…` (list, get, `PATCH` clicked).
- `src/worker.ts` — queue consumer (`src/jobs`: fan-out, event delivery, account recheck, import processing, cancel scheduled) plus scheduler (`src/scheduler`: due-send every 60 s on every worker; rescan, expiry, housekeeping on the leader).
- `src/trigger` — `NotificationTrigger`, an in-process class the business code calls with `record(event)` / `accountChanged(accountId)`. It only enqueues.
- "Sending" means inserting a row in `notification_deliveries` through the one insert path, `src/lib/insertDeliveries.ts`, with a unique dedupe key. There is no push, email or SMS.
- Scheduled sends are delivery rows with `sent_at` NULL and a `due_at`; due-send releases them. Cancellation is one SQL rule in `src/lib/cancellation.ts`, enforced at release time. Members see deliveries that went live in the current or previous UTC calendar month; expiry archives older rows.
- Stand-ins for systems this service does not own, each behind one adapter/interface and refused when `NODE_ENV=production`: seeded `accounts` table (`STANDINS=true`), header auth (`AUTH_IMPL=header`, `X-Account-Id`, admins from `ADMIN_ACCOUNT_IDS`), jobs-table queue (`QUEUE_IMPL=db`).
- All time comes from the injected `deps.clock`; never use SQL `NOW()`. Dependencies are wired by hand in the two composition roots into one `Deps` object.

Layout: `src/admin`, `src/member`, `src/jobs`, `src/scheduler`, `src/queue`, `src/trigger`, `src/eligibility`, `src/lib`, `src/middleware`, `src/config`, `src/db`; `migrations/` (knex, forward-only); `scripts/db.ts` (create/migrate/drop) and `scripts/seed.ts`; `test/unit`, `test/integration`, `test/contract`, `test/helpers`.

## Build and test

```sh
docker compose up -d mysql          # MySQL 8 on 127.0.0.1:3306, root/root
npm ci
npm run typecheck                   # tsc --noEmit
npm run lint                        # eslint
npm run test:unit                   # no database
npm test                            # typecheck -> unit -> integration -> contract (needs MySQL)
npm run build                       # tsc -> dist/
```

Integration and contract tests create, migrate and seed their own database (`DB_NAME` defaults to `notification_center_test`) and hold a MySQL named lock for the run. For parallel checkouts or worktrees, give each its own database: `DB_NAME=nc_<name> npm test`, and `npm run db -- drop nc_<name>` afterwards.

To run the service: set the environment in `.env.example` (plus `DB_NAME`), `npm run db -- create <DB_NAME>`, then `PORT=3000 npx tsx src/api.ts` and `WORKER_HEALTH_PORT=3001 npx tsx src/worker.ts` in separate shells. Full instructions and example `curl` calls are in `README.md`.

## Working rules

- Tests first: a change to behaviour starts with a failing test; never edit a test to make it pass.
- Do not change an API contract or the schema without a corresponding tech-design change and a `docs/build-issues.md` entry.
- Where the design is silent or ambiguous, take the reading most consistent with the rest of it and record the choice in `docs/build-issues.md` rather than stopping.
- Stand-ins must keep working now and keep being refused in production.
- Log ids, never notification content. The database layer already strips SQL text from errors; keep it that way.
- Match the surrounding code: strict zod objects on every input, one `Deps` object, comments that cite the spec or design section (`§7.4`, `B5`) they implement.
