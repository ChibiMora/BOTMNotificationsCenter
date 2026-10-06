# Notification Center — Architecture & Contracts

> **Spec:** the product spec is the source of truth and lives at [`../spec.md`](../spec.md).
> This document restates the design from `../design-draft.md`, reorganised and settled during architecture review.
> Decisions are recorded as assumptions (A1–A55) and referenced from the architecture and contracts below.
> This document deliberately says nothing about storage engines, frameworks, libraries, or deployment.

---

## 1. Requirements (extracted from the spec)

- **R1** — Provide a notification center for members. (spec.md:39)
- **R2** — Support exactly three notification types: filter-based, CSV mass upload, and event-triggered. (spec.md:40–47)
- **R3** — Filter attributes live on the account table: Country (US, CA), Policy (Monthly, Annual), Relationship status (New Member, Friend, BFF), Credits. (spec.md:41–45)
- **R4** — Every notification is visible for 2 months (static months, not rolling) and is wiped after 2 months. (spec.md:48)
- **R5** — Each notification carries: icon or image, headline, subheadline, and a link to a page on the website. (spec.md:49–53)
- **R6** — Each notification shows a timestamp that consistently updates relative to when it went live ("sent 5 minutes ago"). (spec.md:54)
- **R7** — Each notification has a clicked / not-clicked state per member (blue bubble until first click). (spec.md:55)
- **R8** — The notification page lists the member's notifications most recent to least recent. (spec.md:56–57)
- **R9** — Active/inactive: inactive stops NEW sends only; notifications already delivered remain visible. Applies to event and filter types only (CSV is one-time). (spec.md:62)
- **R10** — "Remove from app" hides the notification from everyone, including members who have already seen it. (spec.md:63)
- **R11** — Event notifications use pre-created events: Shipped, Enrolled, Pre-enroll audiobook available. (spec.md:68–72)
- **R12** — Pre-enroll-audiobook notifications automatically go live at the purchased audiobook's publication date; this overrides any delay. (spec.md:72–73, 78)
- **R13** — An event notification may have a delay in days after the event; with no delay it sends immediately. (spec.md:74–77)
- **R14** — An event notification fires on every occurrence of the event (two referred friends → two notifications). (spec.md:81–82)
- **R15** — Filters are each multi-select; an unselected filter means "all". Credits min and max are inclusive and each individually optional. (spec.md:86–93)
- **R16** — While a filter notification is active, any account that comes to meet all criteria at any point must receive it. (spec.md:95)
- **R17** — A filter notification is sent at most once per static month per account. (spec.md:96–97)
- **R18** — CSV notifications: active is not editable; sent exactly once, at the date set in admin, to every account in the file. (spec.md:102–104)

---

## 2. Assumptions & decisions

- **A1** — There are two API surfaces: an internal/admin one used only via the company website, and an external one used by the member app.
- **A2** — Authentication is a logged-in session; unauthenticated calls get 401. Admin authorization comes from A34's pre-existing role system.
- **A3** — Storage keeps the **path/key only** (`image_key`, `link_path`); the service composes the completed URL at read time by prepending the configured **base URL** for each (asset base for images, site base for links). Write-side handling (accept a path, or accept a full URL and strip the base) is a tech-design detail.
- **A4** — Deliveries are materialized per account in `notifications_accounts` ("fan-out on write") by asynchronous batch workers, triggered on create, import, activation, and event occurrence.
- **A5** — Delivery state is tracked per delivery row: `is_clicked`, server-set `sent_at` and `due_at`, under an auto-increment delivery id (A20).
- **A7** — Expiry operates on **delivery rows**, based on go-live (`sent_at`) — not on the notification, and not on creation date. Mechanism: archive + delete (A23).
- **A9** — Member visibility rule: a member sees a notification if a **sent** delivery row exists for them (`sent_at` non-null), the notification is not `removed` (A18), and the delivery is within the window (A15). `active` only gates *new* sends (R9).
- **A10** — The import CSV carries **account ids only**; content (image, headline, subheadline, link) and the send date are supplied once on the notification record.
- **A11** — Filter storage: policy/relationship/country hold a **set of selected values** per filter (representation is a tech-design detail; see A45); credits are **two optional integer columns `credits_min`/`credits_max`** (inclusive).
- **A12** — Event-type notifications are triggered *internally via code*: the code paths where actions happen call an internal class (specified in the tech design) that creates and schedules the delivery rows. Not an HTTP endpoint.
- **A13** — Trigger call sites may invoke the class more than once for one occurrence (retries); duplicates must not duplicate member notifications. Handled by A38 (occurrence key) and A50 (admin request key).
- **A14** — Account data is readable by this system at filter-evaluation time (failure behavior: A39).
- **A15** — "Static month" = **calendar month**: a delivery is visible if its `sent_at` falls in the current or previous calendar month; wiped when a third month starts (live Aug 15 → gone Oct 1). Visibility counts from go-live, not creation. Boundary timezone per A28.
- **A16** — The audiobook publication date lives in an existing table this system can read directly. Date changes handled per A49.
- **A17** — **Rescan job**: on a recurring schedule, for each active filter notification, insert delivery rows for accounts that match the filters and have no delivery row in the current calendar month. This catches newly-eligible accounts (R16) and, run at month start, produces the R17 monthly resend (A21). Cadence is an outstanding product confirmation (§5) — it sets the delivery latency.
- **A18** — "Remove from app" is a **`removed` flag on the notification**, set via `PUT /admin/notifications/:id` and honored by every member-facing read.
- **A19** — **Scheduled sends are unsent delivery rows with `due_at`**: event delay → event time + delay; pre-enroll → publication date (A16); CSV → the notification's `live_date`. A frequent due-send job sends every unsent row with `due_at <= now` (sets `sent_at`). Unsent rows are never member-visible (A9).
- **A20** — `notifications_accounts` has an **auto-increment primary key** (the delivery id): repeat deliveries are distinct, addressable rows.
- **A21** — There is **no `sent` flag**: "sent" is derived (`sent_at` non-null) and "sent this month" is derived (a row with `sent_at` in the current month exists). Monthly resends are **new delivery rows** created by A17 — each resend is a new member-visible entry with its own timestamp and a fresh unclicked bubble (A48).
- **A22** — The internal list **is filterable by notification type and by date**. (Param details — which date field, single vs range — are tech-design items.)
- **A23** — **Expiry = archive + delete**: the monthly job moves delivery rows that fell out of the A15 window into `archived_notifications_accounts` (same shape + archive timestamp) and deletes them from `notifications_accounts`, keeping the hot table small while preserving audit. Member reads never consult the archive. Notification records themselves are kept indefinitely (A51).
- **A24** — **Filter API semantics: every filter is optional; omitted (or empty) = all**, handled in code. `credits`, `minimum`, `maximum` are all optional.
- **A25** — `isActive` defaults to **false** when omitted on create.
- **A26** — `PUT /admin/notifications/:id` **rejects `isActive` changes on CSV-type notifications** with `400 VALIDATION_ERROR` (R18).
- **A27** — **Naming canon**: tables `notification_types`, `notifications_filters`; the FK is on the `type` column referencing `notification_types(id)`; all columns snake_case; all JSON keys camelCase; error code spelled `UNAUTHORIZED`.
- **A28** — **All timestamps — in every table and on both API surfaces — carry full date + time in UTC**, ISO-8601 format, rendered locally by clients. A15's calendar-month boundaries are computed in UTC.
- **A29** — **Cursor pagination on both list endpoints, page size capped at 25.** List responses are an envelope: `{ "items": [...], "nextCursor": string | null }`.
- **A30** — **Remove is irreversible**, and `PUT /admin/notifications/:id` has a defined `400` for invalid bodies.
- **A31** — **Error matrix**: one shared envelope `{ "error": "<CODE>", "message": "optional detail" }`. Defined per operation below: 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN` (authenticated but not admin, internal ops), 404 `NOT_FOUND`, 409 `CONFLICT` (concurrent state change on PUT). Shared generic responses, same envelope: 429 `RATE_LIMITED`, 500 `INTERNAL`, 503 `UNAVAILABLE`.
- **A32** — CSV import **silently de-duplicates repeated accountIDs**.
- **A33** — Rate limiting stays **generic**: shared 429 envelope; numeric limits and the CSV size cap are deferred to tech design/ops.
- **A34** — Admin authorization uses the **pre-existing role system**: every internal operation requires an admin role from it (403 otherwise).
- **A35** — Clicked state is set by a **dedicated external call, `POST /notifications/:id/clicked`**, sent by the app when the member actually opens the notification. `GET /notifications/:id` has no side effects, so prefetching the detail endpoint is harmless.
- **A36** — Cached member-facing responses are **actively purged when a notification is removed**, so `removed` propagates immediately.
- **A37** — External `GET /notifications/:id` returns **404 unless the calling member has a sent, non-removed, in-window delivery of that notification** (A9's rule applied per-object). A member can only ever read what is in their own list.
- **A38** — The event trigger call carries an **occurrence key** identifying the real-world occurrence (e.g., the shipment id), and delivery creation is **unique on (notification, account, occurrence key)**: a duplicate invocation finds the existing row and does nothing. `notifications_accounts` has an optional `occurrence_key` column.
- **A39** — When account data is unavailable (or a read fails) during filter evaluation, **jobs skip the run and retry on the next schedule**; the "no delivery row this month" rule makes catch-up automatic and duplicate-free.
- **A40** — **The external surface is keyed by delivery id**: list items, the detail fetch, and the clicked call all address a delivery, and every lookup enforces `account_id = caller` (returning A37's 404 otherwise). This disambiguates repeat deliveries of one notification (each has its own entry, timestamp, and bubble) and makes the ownership check structural. The internal surface stays keyed by notification id. Note: a delivery id is still guessable — the `account_id = caller` check is what provides the security, not the id shape (see also A54).
- **A41** — External **list items carry no `image`**; the image is returned only on the detail view. Outstanding product/design confirmation in §5.
- **A42** — The event trigger call **never fails the business action**: it is enqueue-only/fire-and-forget from the caller's perspective; failures are logged and retried inside the notification system (safe under A38's occurrence-key dedupe).
- **A43** — CSV import is **reportable**: the response returns an **import id**; row-level results (including **unknown accountIDs, which are reported**, with valid rows still processed) are produced asynchronously and fetched via an import-status operation — the report is not computed inline in the upload request. Max file size: deferred to tech design.
- **A44** — The internal surface lives under the **`/admin` path prefix** (`/admin/notifications`, …); external member routes keep the bare paths. Combined with A34's role check.
- **A45** — **Filter values are arrays, and country codes are canonical account-table codes (`US`, `CA`)**: each filter is an optional array of allowed values, omitted or empty = all (A24); an account matches a filter when its value is in the array. Storage holds the selected value *set* per filter (exact representation — value rows vs list column — is a tech-design detail).
- **A46** — **Worker guarantees**: (1) the API/trigger/jobs hand fan-out work to workers through a queue; (2) a worker run inserts delivery rows in batches; (3) processing is **at-least-once with idempotent inserts** — retries cannot double-deliver, because each type has a natural uniqueness rule (event: occurrence key per A38; filter: one row per account per calendar month per A17/A21; CSV: one row per account per notification); (4) an admin can see whether a send/import finished or failed (A43's import status; job status for activations).
- **A47** — **Deactivating or removing a notification cancels its pending unsent delivery rows** (`due_at` in the future, `sent_at` null): they will not fire. Matches spec.md:62 "no NEW notifications will go out".
- **A48** — A monthly filter resend appears to the member as a **new entry with its own timestamp and a fresh unclicked bubble** (consequence of A21, confirmed with the author).
- **A49** — Publication-date changes are handled by the **due-send job re-reading the publication date just before sending**: if the date moved later, `due_at` is pushed forward instead of sending. Self-healing, no watcher needed.
- **A50** — Admin **create and import requests carry a client-generated request key**; the server treats a repeated key as the same submission and returns the original result instead of creating a duplicate (same pattern as A38). Transport (header vs body field) is a tech-design detail.
- **A51** — Notification **records (`notifications` rows) are kept indefinitely**; only delivery rows are archived (A23). Preserves definition-level audit and keeps archived deliveries' references intact.
- **A52** — `notifications_accounts.account_id` carries a **foreign key to the accounts table with cascade on account deletion**: a deleted member's delivery rows go with them, and no delivery can reference a nonexistent account. The **archive table carries a bare `account_id` with no FK**, preserving audit history past account deletion. Assumes the accounts table lives in the same database (per spec.md:41). Erasure-policy confirmation in §5.
- **A53** — The **2-month window applies to member visibility only** (R4/A15). The internal admin list is **unbounded** — it returns all notification records (kept indefinitely per A51), including scheduled future CSV sends — managed by pagination (A29) and the type/date filters (A22).
- **A54** — **The external surface exposes opaque delivery ids**: each delivery row carries a server-generated random `public_id` (unique, no order or count information), and all member-facing ids — list items, detail, clicked — are `public_id`s. The auto-increment delivery id (A20) remains the internal PK for storage and joins and never leaves the admin/internal side. Closes the volume-inference leak on top of A40's access check. Generation scheme: tech design.
- **A55** — **Creation is split into per-type endpoints**: `POST /admin/notifications/filter` and `POST /admin/notifications/event`, each with an unconditional schema (no "required-if-type" rules), consistent with `POST /admin/notifications/imports`. Both carry the A50 request key.

---

## 3. Architecture

- **API service** with two surfaces (A1): internal routes under the `/admin` prefix (A44), guarded by the pre-existing admin role (A34); member routes on bare paths:
  - *Internal (admin)*: list (filterable — A22), get one, create (filter/event — A55), import (CSV), update (activate/deactivate, remove).
  - *External (member)*: list my notifications, get one, report a click (A35).
- **Event trigger interface (internal)** — a class called in-process where actions happen (Shipped, Enrolled, Pre-enroll purchase); creates delivery rows, immediately sent or scheduled via `due_at` (A12, A19). Enqueue-only, never fails the business action (A42); duplicate-safe via the occurrence key (A38).
- **Asynchronous batch-send workers** (A46) — receive fan-out work via a queue; insert delivery rows in batches; at-least-once processing with idempotent inserts (occurrence key / per-month / per-notification uniqueness), so retries never double-deliver; send and import outcomes are visible to admins (A43).
- **Scheduled jobs** (all operate on delivery rows):
  - **Rescan (A17, recurring)** — inserts delivery rows for accounts matching an active filter notification with no row this calendar month; at month start this is the R17 resend (A21). Cadence: §5.
  - **Due-send (A19, frequent)** — sends every unsent row with `due_at <= now`, setting `sent_at`; re-reads the publication date for pre-enroll rows first (A49). Covers event delays, publication dates, and CSV send dates.
  - **Expiry/archive (A23, monthly)** — moves delivery rows outside the A15 window to the archive table and deletes them from the hot table.
- **Response caching** on list endpoints, with **active purge on remove** (A36) so `removed` propagates immediately. Cache scope/TTL otherwise a tech-design detail.

External dependencies:

- **Account data** — filter evaluation input (R3, R15, R16); on read failure, jobs skip and retry next run (A39).
- **Event call sites** — invoke the trigger interface (A12).
- **Audiobook publication-date table** — read for pre-enroll `due_at` (A16, A49).
- **Pre-existing admin role system** — authorizes all internal operations (A34).

---

## 4. Contracts

### 4.1 Data structures

Names per A27's canon.

**notifications**
| Field | Type | Notes |
|---|---|---|
| id | numeric id, auto-increment | internal/admin only — the external surface sees only delivery `public_id`s (A54) |
| image_key | string | required; stores the path/key only — completed URL composed with the configured base URL on read (A3) |
| headline | string | required |
| subheadline | string | required |
| link_path | string | required; path only, base URL prepended on read (A3) |
| active | boolean | required; defaults false on create (A25) |
| type | reference → notification_types | required (A27) |
| removed | boolean | server-set via PUT `remove`; irreversible (A18, A30); honored by every member-facing read |
| live_date | timestamp | CSV type only: the admin-set send date (A10) |
| delay | integer | event type only: days after the event (R13) |
| went_live_at | timestamp | server-set; notification-level go-live — per-delivery time lives in `sent_at`; remaining role pinned in the tech design |
| created_at | timestamp | server-set |

All timestamps per A28 (full date+time, UTC, ISO-8601).

**notification_types**
| Field | Type | Notes |
|---|---|---|
| id | numeric id | |
| name | string | required |

**notifications_accounts** (per-delivery)
| Field | Type | Notes |
|---|---|---|
| id | numeric id, auto-increment | primary key — the internal delivery id (A20); never exposed externally |
| public_id | string, unique | server-generated opaque id; the only delivery identifier the external surface sees (A54) |
| notifications_id | reference → notifications | required |
| account_id | reference → accounts | required; FK with cascade on account deletion (A52) |
| is_clicked | boolean | default false; set by `POST /notifications/:id/clicked` (A35); idempotent |
| sent_at | timestamp | server-set; null = scheduled, non-null = live. Drives "sent 5 minutes ago" (R6), the external `liveDate`, the A15 window, and "sent this month" (A21) |
| due_at | timestamp | server-set; when this delivery should go live (A19). Unsent rows are never member-visible (A9) |
| occurrence_key | string, optional | event type: identifies the real-world occurrence (e.g., shipment id); unique with (notifications_id, account_id) so duplicate trigger calls are no-ops (A38) |

**archived_notifications_accounts** (A23) — written only by the expiry job, read only for audit; never consulted by member reads. Rows are copied verbatim from `notifications_accounts` (original values preserved, including the delivery id) and deleted from the hot table in the same operation.

| Field | Type | Notes |
|---|---|---|
| id | numeric id | primary key — the original delivery id, preserved on archive (not re-generated) |
| public_id | string | preserved from the original row (A54) |
| notifications_id | reference → notifications | the parent record always exists, since notification records are kept indefinitely (A51) |
| account_id | numeric | **bare column, no FK** (A52) — audit history survives account deletion; erasure-policy confirmation in §5 |
| is_clicked | boolean | as at archive time |
| sent_at | timestamp | original go-live time (UTC — A28) |
| due_at | timestamp | original scheduled time; unsent-and-cancelled rows (A47) are deleted, not archived — only sent deliveries reach this table |
| occurrence_key | string, optional | preserved from the original row (A38) |
| archived_at | timestamp | server-set; when the expiry job moved the row |

**notifications_filters**
| Field | Type | Notes |
|---|---|---|
| notifications_id | reference → notifications | |
| policy | set of values, optional | absent/empty = all (A24, A45); representation of the set is a tech-design detail |
| relationship | set of values, optional | absent/empty = all (A45) |
| credits_min | integer, optional | inclusive; absent = no minimum (A11) |
| credits_max | integer, optional | inclusive; absent = no maximum (A11) |
| country | set of values, optional | absent/empty = all; canonical account-table codes `US`/`CA` (A45) |

### 4.2 Internal (admin) operations

All internal routes live under the **`/admin` prefix** (A44). All bodies, including errors, are JSON except the CSV file payload. All internal operations require login (401) **and** an admin role (403) per A34. Error envelope per A31: `{ "error": "<CODE>", "message": "optional detail" }`. All timestamps are ISO-8601 UTC strings (A28).

Bodies below are **type specs, not examples**: each field is written as `"name": type // description`, enum fields list their options in the comment (`status: string // processing | completed | failed`), and fields are required unless the comment says optional.

**GET /admin/notifications** — list all notifications, unbounded by the member 2-month window (A53); includes inactive, removed, and scheduled-future records.
- Query parameters: `cursor` (opaque, optional), `limit` (≤ 25, default 25) (A29); `type` and date filter (A22; exact date params in the tech design).
- Response `200 OK`:

```json
{
  "items": [
    {
      "id": integer,         // internal notification id (A54: never exposed to members)
      "headline": string,    // headline text shown in the notification header
      "subheadline": string, // secondary text shown under the headline
      "type": string,        // filter | event | csv
      "createdAt": string,   // ISO-8601 UTC — when the notification was created
      "liveDate": string,    // ISO-8601 UTC — when the notification goes/went live
      "isActive": boolean,   // whether new sends are enabled (R9)
      "isRemoved": boolean   // whether removed from app (A18)
    }
  ],
  "nextCursor": string | null  // opaque; pass back as ?cursor= for the next page (A29)
}
```

- Errors: 401 `UNAUTHORIZED`, 403 `FORBIDDEN`; generic 429/500/503.

**GET /admin/notifications/:id** — fetch one notification.
- Response `200 OK`:

```json
{
  "id": integer,         // internal notification id
  "image": string,       // completed image URL (composed from image_key — A3)
  "headline": string,    // headline text shown in the notification header
  "subheadline": string, // secondary text shown under the headline
  "link": string,        // completed URL of the linked site page (composed from link_path — A3)
  "isActive": boolean,   // whether new sends are enabled (R9)
  "isRemoved": boolean,  // whether removed from app (A18)
  "createdAt": string,   // ISO-8601 UTC — when the notification was created
  "liveDate": string,    // ISO-8601 UTC — when the notification goes/went live
  "type": string         // filter | event | csv
}
```

- Errors: 401, 403, 404 `NOT_FOUND`; generic.

**POST /admin/notifications/filter** — create a filter notification (A55).
- Request (every filter optional; omitted/empty = all — A24/A45):

```json
{
  "image": string,          // completed image URL; stored as its key (A3)
  "headline": string,       // headline text shown in the notification header
  "subheadline": string,    // secondary text shown under the headline
  "link": string,           // completed URL of the linked site page; stored as its path (A3)
  "isActive": boolean,      // optional; default false (A25)
  "filters": {              // optional; each field optional — omitted/empty = all (A24/A45)
    "country": string[],        // "US" | "CA" — canonical account-table codes (A45)
    "policy": string[],         // "monthly" | "annual"
    "relationStatus": string[], // "newMember" | "friend" | "bff"
    "credits": {
      "minimum": integer,   // optional; inclusive lower bound (R15)
      "maximum": integer    // optional; inclusive upper bound (R15)
    }
  }
}
```

- Carries the client-generated **request key** (A50); a repeated key returns the original result. Transport: tech design.
- Response `201 Created`. If active, the rescan/workers create delivery rows.
- Errors: 400 `VALIDATION_ERROR`, 401, 403; generic.

**POST /admin/notifications/event** — create an event notification (A55).
- Request:

```json
{
  "image": string,          // completed image URL; stored as its key (A3)
  "headline": string,       // headline text shown in the notification header
  "subheadline": string,    // secondary text shown under the headline
  "link": string,           // completed URL of the linked site page; stored as its path (A3)
  "isActive": boolean,      // optional; default false (A25)
  "eventTrigger": string,   // shipped | enrolled | preenrollAudiobook — the pre-created events (R11)
  "delay": integer          // optional; days after the event; ignored for pre-enroll (R12/A19)
}
```

- Carries the **request key** (A50).
- Response `201 Created`. Deliveries are created per occurrence by the trigger interface (A12, A19).
- Errors: 400 `VALIDATION_ERROR`, 401, 403; generic.

**POST /admin/notifications/imports** — create a CSV-type notification (A10).
- Request: the notification record once (JSON part) + the CSV file (single column `accountID`); encoding (multipart vs file reference) is a tech-design detail:

```json
{
  "image": string,       // completed image URL; stored as its key (A3)
  "headline": string,    // headline text shown in the notification header
  "subheadline": string, // secondary text shown under the headline
  "link": string,        // completed URL of the linked site page; stored as its path (A3)
  "liveDate": string     // ISO-8601 UTC — when the send happens (A19)
}
```

- Duplicate accountIDs are silently de-duplicated (A32); unknown accountIDs are **reported** in the async import report while valid rows still process (A43). Max file size: tech design.
- The request carries a client-generated **request key** (A50), like the create endpoints.
- Response `202 Accepted` with `{ "importId": integer }` — row validation runs asynchronously (A43). Delivery rows are created with `due_at = liveDate` (A19).
- Errors: 400 (malformed request/CSV shape), 401, 403; generic.

**GET /admin/notifications/imports/:importId** — the import's status and row-level report (A43).
- Response `200 OK`:

```json
{
  "importId": integer,
  "status": string,            // processing | completed | failed
  "totalRows": integer,        // rows in the uploaded CSV
  "accepted": integer,         // deliveries created
  "duplicatesIgnored": integer, // repeated accountIDs silently dropped (A32)
  "errors": [
    {
      "row": integer,          // 1-based CSV row number
      "accountId": integer,    // the rejected account id
      "reason": string         // UNKNOWN_ACCOUNT (A43)
    }
  ]
}
```

- Errors: 401, 403, 404; generic.

**PUT /admin/notifications/:id** — change activation or remove from app.
- Body — exactly one of the two keys:

```json
{ "isActive": boolean }  // enable or disable new sends (R9); rejected for CSV type (A26)
```
```json
{ "remove": true }       // literal true only; removes from app for everyone; irreversible (A18, A30)
```

- `isActive` on a CSV-type notification → 400 (A26, R18).
- Deactivate and remove both cancel pending unsent delivery rows (A47); remove also purges caches (A36).
- Response `200 OK`. Activation hands fan-out to workers.
- Errors: 400 `VALIDATION_ERROR` (bad body, isActive-on-CSV), 401, 403, 404, 409 `CONFLICT` (concurrent state change); generic.

### 4.3 External (member) operations

Require member login (401). Visibility per A9: sent ∧ not removed ∧ in window.
**All external `:id`s are opaque delivery public ids** (`notifications_accounts.public_id` — A40/A54), and every `:id` lookup enforces `account_id = caller` (A37): a row that doesn't exist, isn't the caller's, is unsent, is removed, or is out of window returns the same 404.

**GET /notifications** — the member's notifications.
- Query parameters: `cursor`, `limit` (≤ 25) (A29).
- Response `200 OK`, sorted by `liveDate` descending (R8). `id` is the opaque delivery public id (A54); no `image` in list items — the image appears only on the detail view (A41):

```json
{
  "items": [
    {
      "id": string,          // opaque delivery public id, e.g. "dl_8f3a92kx" (A54)
      "headline": string,    // headline text shown in the notification header
      "subheadline": string, // secondary text shown under the headline
      "clicked": boolean,    // whether this delivery has ever been clicked (R7)
      "liveDate": string     // ISO-8601 UTC — when this delivery went live (sent_at)
    }
  ],
  "nextCursor": string | null  // opaque; pass back as ?cursor= for the next page (A29)
}
```

- Errors: 401; generic.

**GET /notifications/:id** — one delivery's full content. **No side effects** (A35 — clicks are reported via the dedicated call below):

```json
{
  "id": string,          // opaque delivery public id (A54)
  "image": string,       // completed image URL (A3)
  "headline": string,    // headline text shown in the notification header
  "subheadline": string, // secondary text shown under the headline
  "link": string,        // completed URL of the linked site page (A3)
  "liveDate": string,    // ISO-8601 UTC — when this delivery went live (sent_at)
  "clicked": boolean     // whether this delivery has ever been clicked (R7)
}
```

- Errors: 401; 404 per the A37/A40 rule above; generic.

**POST /notifications/:id/clicked** — marks this delivery clicked (A35); called by the app when the member actually opens the notification. Idempotent — repeat calls are no-ops.
- No request body. Response `204 No Content`.
- Errors: 401; 404 per the A37/A40 rule; generic.

---

## 5. Outstanding confirmations

Everything else in this document is settled. Three items await product/legal confirmation; none blocks the tech design:

- **Rescan cadence (A17)** — how quickly must a newly-eligible member receive a filter notification? The rescan schedule is that latency (daily = up to a day).
- **Icon-less list rows (A41)** — the external list omits the image; the spec's per-notification element list includes "icon or image" (spec.md:49–55), so confirm against the UI design.
- **Erasure policy for archived deliveries (A52)** — archived rows keep `account_id` past account deletion for audit; confirm with product/legal that erasure requirements don't demand purging them too.

---

## 6. Alternatives considered

Each entry names the chosen option, the rejected one, and the tradeoff.

- **ALT1 — Fan-out on write (chosen, A4) vs fan-out on read.** Materialized delivery rows make reads cheap and give R14/R17 bookkeeping an explicit home, at the cost of write amplification and queue infrastructure; read-time evaluation would have made every list expensive and the once-per-month rule hard to prove.
- **ALT2 — Dedicated click call (chosen, A35) vs marking clicked on the detail GET.** One extra client call buys a side-effect-free GET that is safe to cache, prefetch, and retry.
- **ALT3 — Archive at expiry (chosen, A23) vs hard delete.** Preserves "what did we send" audit at the cost of a second table.
- **ALT4 — `/admin` path prefix + role checks (chosen, A44/A34) vs a separately deployed admin service.** Near-zero cost isolation (one middleware, network rules possible on the prefix); a separate service remains the escalation path if the admin side grows.
- **ALT5 — Periodic rescan (chosen, A17) vs account-change-driven hooks.** One uncoupled mechanism that cannot miss an account, at the cost of delivery latency up to the job cadence; hooks would have required instrumenting every account-writing code path forever.
- **ALT6 — Opaque external ids (chosen, A54) vs sequential.** Closes volume-inference from id gaps on top of A40's access check, at the cost of one extra column.
- **ALT7 — Per-type creation endpoints (chosen, A55) vs one polymorphic POST.** Flat unconditional schemas eliminate "required-if-type" validation — where most of the draft's contract defects lived — and match the import endpoint's existing shape.
- **ALT8 — Persisted due-at rows (chosen, A19) vs a cron that scans for due delays.** Scheduled sends are explicit, inspectable, cancellable (A47) and reschedulable (A49) rows; a scanning job would store the schedule implicitly and re-derive due-ness every run.
- **ALT9 — Per-notification `removed` flag (chosen, A18) vs per-delivery hiding.** One flag honored by every read path removes instantly and atomically; per-row hiding would need mass updates and would miss rows created afterwards.
- **ALT10 — Monthly resend as new rows (chosen, A21) vs resetting a `sent` flag.** New rows preserve send history, give each resend its own timestamp and bubble (A48), and remove the reset/send race; the flag would have made a resend invisible.
