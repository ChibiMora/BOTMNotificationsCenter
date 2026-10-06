# Notification Center

Backend design for a Book of the Month member notification center: an API that lets admins publish notifications to members (by filter, by triggered event, or by CSV upload) and lets members list, open, and mark notifications as clicked.

Stack mandated by the spec: Node.js, TypeScript, Koa, Aurora MySQL.

## Documents

| File | Purpose |
|------|---------|
| [`docs/spec.md`](docs/spec.md) | Product and engineering requirements. Source of truth; wins any disagreement. |
| [`docs/design-draft.md`](docs/design-draft.md) | Original design draft that the review started from. Kept as-is for history. |
| [`docs/architecture.md`](docs/architecture.md) | Reviewed architecture: requirements (R#), decisions and assumptions (A#), API contracts, data model. Historical record of the design-review phase. |
| [`docs/tech-design.html`](docs/tech-design.html) | Standalone technical design. Open it in a browser: behaviour rules, full API contracts, schema, module layout, core-flow and lifecycle diagrams, background jobs, testing strategy, implementation units, and the decision register. This is the document an implementation works from. |

## Status

Design phase complete; no implementation yet.

## Reading order

1. `docs/spec.md` for what is being built.
2. `docs/tech-design.html` for how. It is self-contained and does not require the other documents.
3. `docs/architecture.md` only if you want the reasoning trail behind a decision.
