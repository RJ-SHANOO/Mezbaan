# CLAUDE.md: Mezbaan Platform

Mezbaan is a multi-tenant restaurant SaaS with a strong POS and a complete inventory system.
It runs as an offline-capable desktop app in each branch and as a cloud platform on the server.

- **Target:** 100-1,000 restaurants, each with multiple branches and terminals.
- **Roles:** Super Admin, Restaurant Owner, Branch Manager, Cashier, Kitchen Staff.
- **Top priority:** billing must keep working. A failure in one module must never stop a sale or lose data.

---

## 1. How to work in this repo

1. Read this file, then check the task list for the first unchecked task in the current phase.
2. Work on one task at a time, in order, unless a task says it can run in parallel.
3. Before a large task, state your approach in a few lines. Ask only if a wrong guess is expensive to undo.
4. Add or update tests with the code. Run lint, typecheck and the affected tests before calling a task done.
5. Tick the task's checkbox in this file only when it meets the Definition of Done.
6. Make small commits that reference the task ID, for example `feat(pos): split bill by item [P2-21]`.
7. **Stop at each phase's exit gate.** Report the results and wait for approval before starting the next phase.
8. Do not add technology outside the approved stack without asking. Do not add Phase 4 infrastructure early.
9. If a task conflicts with a rule in section 2, the rule wins. Raise the conflict instead of working around it.
10. If `docs/modules.md` or `docs/database.md` exist from the old project, use them as functional reference only.

### Definition of Done

A task is done only when all of these are true:

- The feature works end to end, including its loading, empty, error and offline states.
- Tests cover the normal path, failures, permissions and tenant isolation.
- Lint, typecheck and tests pass in CI.
- Database changes are in a forward migration, with row-level security on any tenant table.
- Sensitive actions write to the audit log.
- A failure in this feature is contained and cannot crash another module.

---

## 2. Rules that must never be broken

### Data and money

1. **Tenant comes from the token only.** Never trust `restaurant_id` from a request body, query or header. Reject any conflict.
2. **Every tenant table has PostgreSQL row-level security.** It is a second barrier, and application code must still filter correctly.
3. **Prices come from server-owned data, never from client input.** Online, the server prices the order. Offline, the terminal uses only the signed, versioned price list synced from the server. The server recalculates each synced sale and flags any mismatch for review. It never silently changes a recorded sale.
4. **Financial records are append-only.** Never update or delete invoices, payments, refunds, commission entries or stock ledger rows. Correct them with compensating rows, and revoke `UPDATE` and `DELETE` on these tables at database level.
5. **Money is an integer in minor units** (`bigint`), never a float. All calculations go through `packages/domain` so the terminal and server produce identical results.
6. **Never build a feature that hides, removes or under-reports sales.** Voids, refunds and discounts are always recorded, attributed to a user, given a reason and visible in reports.
7. **Commission rate is locked at registration and snapshotted on each entry.** Later rate changes never alter past entries.

### Offline and sync

8. Every terminal write goes to SQLite and the operation log in one local transaction.
9. Every operation has a client-generated UUIDv7 ID and an `idempotencyKey`. Retrying can never create a duplicate.
10. Document numbers use a per-terminal series, such as `B1-T2-000123`, so offline terminals cannot collide.
11. Financial events merge by appending. For menu and settings data, the server's version wins.
12. Offline stock may go negative. Record and flag it, and never block a sale because of it.

### Reliability

13. No module may crash another. Keep the failure boundaries described in section 5.
14. A broker, report, printer or external service failure must never block a sale.
15. Every network and hardware call has a timeout. Background jobs retry with backoff, then move to a dead-letter queue.
16. Never swallow errors silently. Log them with context, and show the user a clear next step.

### Security

17. Never commit secrets. Validate all input at the boundary with shared schemas.
18. Kitchen APIs and screens never receive money fields.
19. The local database is encrypted. Device tokens can be revoked. Desktop updates are signed.
20. Use parameterized SQL only. Never log passwords, tokens or full payment details.

---

## 3. Technology stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces, Turborepo, TypeScript strict mode |
| Desktop | Tauri 2, with Rust kept to a thin layer for hardware, storage and the branch hub |
| UI | React, Vite, TypeScript, Tailwind, TanStack Query, Zustand |
| Local database | SQLite in WAL mode, encrypted |
| Backend | NestJS on Fastify |
| Main database | PostgreSQL with row-level security and partitioning |
| Connection pool | PgBouncer in transaction mode |
| Data access | Drizzle ORM and raw parameterized SQL where needed |
| Cache and jobs | Valkey or Redis, with BullMQ |
| Real-time | WebSockets |
| Validation | Zod schemas in `packages/contracts` |
| Files | S3-compatible storage |
| Events (Phase 4) | Redpanda through the Kafka API, fed by an outbox table |
| Analytics (Phase 4) | ClickHouse |
| Scale-out (only if needed) | Citus, sharded by `restaurant_id` |
| Operations | Docker, GitHub Actions, Prometheus, Grafana, Sentry |
| Testing | Vitest, Playwright, property-based tests, load tests with k6 |

---

## 4. Repository structure

```text
mezbaan/
├── apps/
│   ├── desktop/        # Tauri app: POS and kitchen only (offline, hardware access)
│   ├── web/            # QR menu, public site, Super Admin, and restaurant/branch admin
│   ├── api-pos/        # POS and sync API
│   ├── api-admin/      # Restaurant admin, inventory, platform admin
│   ├── api-public/     # QR ordering and public site
│   ├── api-reports/    # Reports
│   └── worker/         # Outbox, commission, settlements, notifications
├── packages/
│   ├── domain/         # Money, tax, pricing and state machines; no I/O
│   ├── contracts/      # API and sync schemas
│   ├── db/             # PostgreSQL schema, migrations, RLS policies
│   ├── local-db/       # SQLite schema and migrations
│   ├── sync/           # Operation log and sync client
│   ├── nest-core/      # Tenant context, auth, audit, errors, logging
│   └── ui/             # Shared React components and design tokens
├── infra/              # Docker, deployment, monitoring
└── docs/               # Decisions and runbooks
```

Each business module (`orders`, `billing`, `inventory` and so on) keeps its own controllers, services and tests. Modules talk through public service interfaces or events, never through another module's tables.

---

## 5. Architecture

```text
Branch:  POS terminals (Tauri + SQLite) <-> Branch hub <-> Kitchen and printers
                                               |
                                       Operation log sync
                                               v
Cloud:   API processes -> PostgreSQL (sale + outbox in one transaction)
                               |
                          Outbox relay -> Redpanda -> Consumers -> ClickHouse
                                          (Phase 4)
```

### Failure boundaries

| What fails | Required behavior |
|---|---|
| `api-pos` | Branches keep selling offline and sync after recovery |
| `api-admin` | POS and sync continue |
| `api-public` | POS, kitchen and admin continue |
| `api-reports` | Selling and stock continue; reports are delayed |
| `worker` | Jobs wait in the queue and resume with no loss |
| A desktop screen | An error boundary closes only that module; POS, kitchen and admin use separate windows |
| The desktop app or PC | A watchdog restarts the app, and the open order is restored from SQLite |
| Printer or cash drawer | The job is queued and retried; the sale completes and can be reprinted |
| Internet | The branch keeps working on the local network and syncs later |
| Branch hub | Terminals keep billing and printing locally and catch up when the hub returns |
| A bad update | The app rolls back, and a feature flag can turn off the problem module |

Server rules: each process runs at least two instances, has its own database connection pool, exposes health checks, and uses rolling deployments. Requests are rate-limited per restaurant.

### Database rules

- Every tenant table includes `restaurant_id`, and it is part of the primary key.
- Branch-level tables also include `branch_id`.
- Set the tenant with `SET LOCAL app.restaurant_id` inside each transaction, which works with PgBouncer transaction mode.
- Partition orders, ledger rows and audit logs by month.
- The outbox row is written in the same transaction as the business change.

---

## 6. Open decisions

Ask the owner when a task reaches one of these. Until then, keep the value configurable and do not guess.

- Peak orders per day per restaurant (sets load test targets).
- Team size (sets delivery estimates).
- Whether existing Mezbaan data needs migrating. The old docs list Laravel/MySQL and later notes list Node/Prisma/PostgreSQL.
- Launch market and its tax invoicing rules.
- Printers, cash drawers and POS PCs that must be supported.
- Mobile needs, such as an owner app or waiter tablets.

---

## 7. Task list

Completed tasks below carry a one-line summary only. Full implementation notes, debugging
history and scope decisions for each task live in `docs/task-log.md`, keyed by task ID — open
that file only when you need that detail (e.g. picking up related work).

### Phase 1: Foundation

**Goal:** a secure, tested base on which all modules can run offline.

**Repo and infrastructure**
- [x] **P1-01** Set up the monorepo in section 4 with strict TypeScript, ESLint, Prettier and Turborepo.
- [x] **P1-02** Add Docker Compose for local PostgreSQL, PgBouncer, Valkey and S3-compatible storage.
- [x] **P1-03** Add CI for lint, typecheck, tests and builds, with migrations checked on every pull request.
- [x] **P1-04** Add Sentry, structured logging, Prometheus metrics and health endpoints.
- [x] **P1-05** Create `api-pos`, `api-admin`, `api-public`, `api-reports` and `worker` as separately deployable processes.

**Shared domain**
- [x] **P1-06** Build `packages/domain` money utilities using integer minor units, with property-based tests.
- [x] **P1-07** Add tax, discount, service charge and rounding calculations with fixed test cases shared by terminal and server.
- [x] **P1-08** Build `packages/contracts` with shared Zod schemas and generated TypeScript types.

**Tenancy, identity and audit**
- [x] **P1-09** Create restaurant, branch, user, role, permission and device tables with row-level security.
- [x] **P1-10** Build tenant context middleware that takes the tenant only from the token and sets it per transaction.
- [x] **P1-11** Build login, refresh tokens, logout, password reset and server-side session revocation.
- [x] **P1-12** Build permission checks for the five roles, including branch-level access.
- [ ] **P1-13** Add a manager PIN for approving sensitive actions, online and offline. Online half + offline primitives (P1-27/P1-27b) done; still no Tauri UI wiring — nothing to wire into until Phase 2's POS terminal exists. [task-log.md#p1-13](docs/task-log.md#p1-13)
- [x] **P1-14** Build the append-only audit log and record who, what, when, where and which device.
- [x] **P1-15** Build restaurant onboarding: signup, first branch, default roles and locked commission settings.
- [x] **P1-16** Port `TenantIsolationTest`, extend it to every endpoint and RLS policy, and make it a required CI check.
- [x] **P1-17** Build Branch CRUD and user invitation screens as the reference pattern for later modules. Lives in `apps/web`, not desktop — needs no offline/hardware access. [task-log.md#p1-17](docs/task-log.md#p1-17)

**Desktop foundation**
- [x] **P1-18** Create the Tauri 2 app with separate POS and kitchen windows, and error boundaries per module.
- [x] **P1-19** Add encrypted SQLite in WAL mode with migrations and an integrity check at startup.
- [x] **P1-20** Add device pairing, token storage and remote device revocation.
- [x] **P1-21** Add signed auto-updates with staged rollout and automatic rollback. Signing, staged-rollout check and rollback detection done; watchdog (P1-22) handles the restart. Verified end to end on all 4 platforms via the tag-triggered release workflow — **future releases must push `main` before pushing the tag**. [task-log.md#p1-21](docs/task-log.md#p1-21)
- [x] **P1-22** Add a watchdog that restarts the app and restores in-progress work. PID-liveness supervision, restart backoff, crash detection and the pending-work primitive built and tested; packaging resolved via a standalone crate + a release.yml prebuild step (avoids a WiX ICE30 collision). [task-log.md#p1-22](docs/task-log.md#p1-22)
- [x] **P1-23** Add remote per-module feature flags per restaurant. `feature_flags` table + 3 endpoints in `api-admin`, super-admin-only writes (incident kill switch), tested at all layers; fixed a `TenantContextGuard` super-admin gap along the way. No management UI or desktop consumer yet (natural follow-ons). [task-log.md#p1-23](docs/task-log.md#p1-23)

**Sync and outbox**
- [x] **P1-24** Build the local operation log, with each write and its operation saved in one transaction. `operation_log.rs` + `record_once()` in the Tauri shell, satisfying rules 8-9; exercised with a synthetic write since no real business write exists yet. [task-log.md#p1-24](docs/task-log.md#p1-24)
- [x] **P1-25** Build the sync client: batching, ordering, retry with backoff, and resume after a crash. `sync_client.rs`'s `run_sync_cycle()`; nothing is marked synced until acknowledged, so crash-resume needs no special handling. Verified on CI (local compile blocked by an env-specific OpenSSL/Perl issue). [task-log.md#p1-25](docs/task-log.md#p1-25)
- [x] **P1-26** Build the server sync endpoint with idempotency, validation and a per-operation result. `POST /sync/operations` in `api-pos`, device-token authed, idempotent via `ON CONFLICT DO NOTHING`. Tested at all layers; fixed a DI provider gap in `SyncModule` along the way. [task-log.md#p1-26](docs/task-log.md#p1-26)
- [x] **P1-27** Build downstream sync for menu, prices, staff and settings with versioned, signed snapshots, including each manager's PIN hash so approvals in P1-13 work offline. `GET /sync/snapshot`/`public-key`, Ed25519-signed staff+branches snapshot. Menu/prices not yet included (Phase 2). Client-side verification is P1-27b. [task-log.md#p1-27](docs/task-log.md#p1-27)
- [x] **P1-27b** Build offline manager-PIN verification: once P1-27 syncs the signed PIN-hash bundle, verify a manager's PIN against it locally with no server round-trip, and apply the same lockout rule as the online path. Verifies against P1-27's signed snapshot, same scrypt params/lockout as the server, cross-checked against a real Node-generated hash. No UI wiring yet. [task-log.md#p1-27b](docs/task-log.md#p1-27b)
- [x] **P1-28** Build per-terminal document number series. Format `B{branch_number}-T{terminal_number}-{sequence:06}` — server-assigned branch/terminal numbers (DB trigger + UNIQUE index) plus a local SQLite sequence; neither half needs the other, which is what prevents collisions. Not yet wired into a real invoice flow (P2-18). [task-log.md#p1-28](docs/task-log.md#p1-28)
- [x] **P1-29** Add a sync status indicator showing online state, pending count and last successful sync. `sync_status.rs` tracks last-sync/online state + pending count; polled every 15s, wired into both POS and kitchen windows. [task-log.md#p1-29](docs/task-log.md#p1-29)
- [x] **P1-30** Build the PostgreSQL outbox table and a worker that processes it with no broker. `outbox` table + a polling `OutboxWorkerService` (`SELECT ... FOR UPDATE SKIP LOCKED`), capped retry to `dead_letter`. No real producer/handler yet (Phase 2+). [task-log.md#p1-30](docs/task-log.md#p1-30)
- [x] **P1-31** Add fault tests for lost connections, duplicates, crashes mid-sync and terminals offline for several days. Closed the real gaps beyond what P1-24/25/26 already covered: lost-connection-mid-large-backlog-then-resume, and a concurrent identical-idempotency-key race. [task-log.md#p1-31](docs/task-log.md#p1-31)

**Performance**
- [x] **P1-32** Add `pg_stat_statements`, slow query logging and a performance dashboard. `pg_stat_statements` + slow-query logging enabled, Grafana dashboard auto-provisioned from `infra/grafana/`, verified end to end against the local stack. [task-log.md#p1-32](docs/task-log.md#p1-32)
- [x] **P1-33** Add N+1 query detection and query plan checks for critical queries in CI. `query-counter.ts` catches N+1 shapes; `query-plan.test.ts` runs `EXPLAIN` under real RLS tenant context for 3 critical queries, both run via existing `pnpm test`. Found/fixed missing device-token indexes. [task-log.md#p1-33](docs/task-log.md#p1-33)
- [x] **P1-34** Make Turborepo build caching work locally and in CI. Already configured since P1-01; verified end to end locally and in real CI logs — no code change needed, verification-only. [task-log.md#p1-34](docs/task-log.md#p1-34)
- [x] **P1-35** Make sync send only changes, in compressed batches, with backoff and a random delay so terminals do not all reconnect at once. Added gzip batches + jittered backoff; fixed a real gap where `ReqwestSyncTransport` never sent its device-token header. [task-log.md#p1-35](docs/task-log.md#p1-35)

**Exit gate:** sync passes all fault tests; tenant isolation tests cover every endpoint; killing any process leaves the others running.

**Exit gate review (2026-11-09):** All three criteria passed (sync fault tests, tenant isolation coverage — closed a gap where `api-pos`'s e2e tests weren't a dedicated required CI check, process independence verified manually). [task-log.md#phase-1-exit-gate-review-2026-11-09](docs/task-log.md#phase-1-exit-gate-review-2026-11-09)

---

### Phase 2: Complete offline POS

**Goal:** a cashier can run a full service, with or without internet, and no sale is ever lost.

**Catalog**
- [x] **P2-01** Build categories and products with images, SKU, barcode and availability by branch. Backend only (UI deferred until the catalog settles). `categories`/`products` + `product_branch_availability` exclusion list. Found/fixed a tenant-scoped-FK gap — RLS doesn't protect bare FKs. [task-log.md#p2-01](docs/task-log.md#p2-01)
- [x] **P2-02** Build variants such as size, and modifier groups with required and optional rules and min/max choices. Backend only. `product_variants`/`modifier_groups`/`modifier_options`/`product_modifier_groups`, min/max pair convention (0 = optional). Found/fixed a longstanding `ANALYZE`-as-wrong-role bug in P1-33's `query-plan.test.ts`. [task-log.md#p2-02](docs/task-log.md#p2-02)
- [x] **P2-03** Build combos and deals with fixed and choice-based items. Backend only. `combos` → `combo_slots` (fixed/choice) → `combo_slot_items`; a fixed slot rejects a second distinct product, reusing P2-02's min/max convention. [task-log.md#p2-03](docs/task-log.md#p2-03)
- [x] **P2-04** Build versioned price lists with branch, order type and time-based pricing. Backend only. `price_lists`/`price_list_items`, genuinely versioned and append-only once published; `PriceResolutionService.resolvePrice` picks the best match by priority/specificity/recency, or `null` if unpriced. [task-log.md#p2-04](docs/task-log.md#p2-04)
- [x] **P2-05** Build tax rules, tax-inclusive and tax-exclusive pricing, and service charge settings. Backend only. `tax_rules` (stacking components), `tax_settings` (inclusive/exclusive), `service_charge_settings` — same branch/orderType scoping convention as price lists. First nest-core caller of `packages/domain`'s tax functions. [task-log.md#p2-05](docs/task-log.md#p2-05)
- [x] **P2-06** Build out-of-stock (86) marking that syncs quickly to all terminals and kitchen screens. Backend only. `product_stock_status` exclusion-list table, per-branch, new `pos.mark_out_of_stock` permission. The actual push-to-terminals transport doesn't exist yet (depends on P2-36-39's hub) — documented gap, not dropped. [task-log.md#p2-06](docs/task-log.md#p2-06)

**Tables and order types**
- [x] **P2-07** Build floors, table layout, status colors, seat counts and QR code records. Backend only, own `TablesModule`. `floors` + `dining_tables` (status/seat count/QR token, QR token deliberately plaintext — it's public by design). New `tables.manage` permission. Status colors are a presentation concern, not stored data. [task-log.md#p2-07](docs/task-log.md#p2-07)
- [x] **P2-08** Add table transfer, merge and split. `OrdersService.transferTable`/`mergeTables`/`splitTable` plus `POST /orders/:id/transfer|merge|split` (api-pos), all `pos.sell`-gated. [task-log.md#p2-08](docs/task-log.md#p2-08)
- [x] **P2-09** Support dine-in, takeaway and delivery orders, each with its own workflow. Lives in `api-pos`'s own `OrdersModule` — the order header only (no line items yet, that's P2-12). Dine-in/table-id rule enforced twice: in `OrdersService` and as a Postgres CHECK constraint. Gated by existing `pos.sell`. [task-log.md#p2-09](docs/task-log.md#p2-09)
- [x] **P2-10** Add customer and address capture for delivery, plus rider assignment and delivery status. `delivery_details` (1:1 on an order, not a reusable customer profile — that's P4-04) + `delivery_riders` (lightweight roster, not a user account/role). Gated by `pos.sell`. [task-log.md#p2-10](docs/task-log.md#p2-10)

**POS terminal**
- [x] **P2-11** Build a fast touch-first POS screen with category grid, search, barcode scanning and keyboard shortcuts. Full pipeline built (scoped with owner 2026-11-12): server snapshot gains resolved menu+prices, new Rust `menu_cache.rs` + Tauri commands, React `PosScreen` with category grid/search/barcode/keyboard shortcuts. No cart yet (P2-12). Rust side reviewed by hand, not locally compiled (pre-existing OpenSSL/Perl env issue) — CI is authoritative. [task-log.md#p2-11](docs/task-log.md#p2-11)
- [x] **P2-12** Build the cart with quantities, modifiers, notes and seat or course assignment. Same three-layer pipeline scope as P2-11: server `order_items`/`order_item_modifiers` with snapshot pricing (closed a gap — modifier options are now priceable, 3-way exclusivity); snapshot+Rust `menu_cache.rs` gain modifier data; frontend `ModifierPicker`/`cart.ts`/`CartPanel`. Cart is local-only state — not yet wired to the real server order (no login flow on desktop yet). Rust side reviewed by hand, CI authoritative (same env issue as P2-11). [task-log.md#p2-12](docs/task-log.md#p2-12)
- [x] **P2-13** Build order state machine and status history in `packages/domain`, rejecting illegal transitions. `order-state-machine.ts` (pure, I/O-free) replaces P2-09's placeholder status check; append-only `order_status_history` table (UPDATE/DELETE revoked). New `GET /orders/:id/status-history`. [task-log.md#p2-13](docs/task-log.md#p2-13)
- [x] **P2-14** Add hold and recall of orders, and running tabs for dine-in tables. New `held` status (open↔held, held→cancelled; held→closed stays illegal). A table stays occupied while `open` or `held`. `OrdersService.getTableTab` (`GET /tables/:tableId/tab`) returns the running total via `packages/domain`. [task-log.md#p2-14](docs/task-log.md#p2-14)
- [x] **P2-15** Add fire-to-kitchen by item or course, and tracking of what was already sent. `OrderItemsService.fireItems` stamps un-fired items with `firedAt`/`firedByUserId`, targeted by item IDs or by course; already-fired items are skipped rather than re-sent, so re-firing a course only sends what's new. New `POST /orders/:orderId/items/fire`. No kitchen-ticket UI yet (P3-02) — this is the POS-side record of what was sent. [task-log.md#p2-15](docs/task-log.md#p2-15)
- [x] **P2-16** Prevent two terminals from silently overwriting the same open order on the local network. A new partial unique index (`orders_table_occupancy_idx`) is the real guard behind one-order-per-table — the existing app-level pre-check reads then decides, which two concurrent terminals can both pass; the index is what actually fails the loser's write. Every read-then-write order mutation (`transition`, transfer/merge/split, `OrderItemsService.requireOpenOrder`) now locks its order row with `SELECT ... FOR UPDATE`, so a second concurrent request serializes behind the first instead of racing it on stale data. [task-log.md#p2-16](docs/task-log.md#p2-16)
- [x] **P2-17** Show clear offline, syncing and price-list-version status on the POS screen. The offline/online half already existed (P1-29's `SyncStatusIndicator`); new here is a persistent "prices as of" readout — `sync_status.rs` now persists the snapshot's version (a server timestamp) on every successful `sync_menu`, so `PosScreen` can show it immediately on mount and distinguish "syncing now" / "prices as of {time}" / "prices not yet synced", surviving a crash or error-boundary reset rather than depending on this mount's own sync call resolving. [task-log.md#p2-17](docs/task-log.md#p2-17)

**Billing and payments**
- [x] **P2-18** Generate invoices with per-terminal numbers, using only domain calculations and a price version. New append-only `invoices` table (UPDATE/DELETE revoked). `InvoicesService.generate` is a second step after `OrdersService.close` — it computes totals purely from the order's already price-list-versioned items via `packages/domain` and `TaxCalculationService.previewCharges` (no re-pricing), and mints a `B{branch_number}-T{terminal_number}-{sequence:06}` number from a new per-device counter. That counter is intentionally separate from P1-28's desktop-local one — no real offline terminal sales flow exists yet to reconcile them. New `POST`/`GET /orders/:id/invoice`. [task-log.md#p2-18](docs/task-log.md#p2-18)
- [x] **P2-19** Add cash, card, bank transfer and wallet payment methods, configurable by restaurant, including tips. New `payment_method_settings` (exclusion-list convention, same as feature flags — absence means enabled) and append-only `payments` table (UPDATE/DELETE revoked). `PaymentsService.record` validates the invoice exists, the method is enabled, and the amount/tip are non-negative; deliberately allows more than one payment row per invoice without enforcing they sum to the total, or reconciling a single checkout across methods — that's P2-20's job. New `GET`/`PUT /payment-method-settings` (api-admin) and `GET`/`POST /invoices/:invoiceId/payments` (api-pos). [task-log.md#p2-19](docs/task-log.md#p2-19)
- [x] **P2-20** Add split payments across multiple methods, with exact change calculation. `PaymentsService.record` now locks the invoice (`SELECT ... FOR UPDATE`, same convention as P2-16) and sums every payment already recorded against it, rejecting anything that would push the total past the invoice's own total — this is what turns P2-19's "more than one payment row is allowed" into a real, reconciled split. Cash payments may pass a `tenderedMinor` above `amountMinor`; the server computes and returns the exact `changeMinor`, never the caller. New `GET /invoices/:invoiceId/balance` for the running total a split-payment flow checks before each step. [task-log.md#p2-20](docs/task-log.md#p2-20)
- [x] **P2-21** Add split bills by item, by seat, by amount and into equal parts. "By amount" needed no new code — P2-19/P2-20's existing flexible per-payment `amountMinor` already supports it. The other three: `order_items` gains a nullable `invoiceId` (set once billed), replacing P2-18's old one-invoice-per-order UNIQUE index — an order can now carry several invoices, each over a disjoint item subset (`InvoicesService.generate` takes optional `itemIds`; `splitBySeat`/`splitByItems` are thin wrappers calling it once per group). "Equal parts" reuses `packages/domain`'s existing `allocate` (no new domain code) via `PaymentsService.suggestEqualSplit` — a suggestion only; collecting each share is still an ordinary split payment. New `GET`/`POST /orders/:id/invoices[/split-by-seat|/split-by-items]` and `GET /invoices/:invoiceId/split`. [task-log.md#p2-21](docs/task-log.md#p2-21)
- [x] **P2-22** Add bill-level and item-level discounts with limits, reason codes and manager approval. The first real consumer of P1-13's `ManagerPinService` — `DiscountsService` calls it directly (new `pos.discount.approve` permission) whenever a discount exceeds the restaurant's own-authority limit (`discount_limit_settings`; unconfigured means every discount needs approval, the safer default). Reuses `packages/domain`'s existing `applyPercentageDiscount`/`applyFixedDiscount` for the clamped money math — no new domain code. A discount never rewrites `unitPriceMinor`; `order_items`/`orders` each gain their own discount columns, and `computeOrderTotal`/`InvoicesService.generate` subtract them. Reason codes are a restaurant-defined list (`discount_reason_codes`), not free text. New `POST`/`DELETE /orders/:id/discount` and `.../items/:itemId/discount` (api-pos), `GET`/`PUT /discount-reason-codes` and `/discount-limits` (api-admin). **Needs `pnpm db:seed` rerun** to pick up the new `pos.discount.approve` grant before e2e tests relying on it will pass. [task-log.md#p2-22](docs/task-log.md#p2-22)
- [x] **P2-23** Add voids before and after kitchen firing, with reason, approval and an audit record. `VoidsService` reuses P2-22's `ManagerPinService` pattern — approval only above `firedAt`, no limits table needed. Closed a real bypass gap in `OrderItemsService.removeItem` (hard-deleted even fired items) and a pre-existing response gap where discount fields were never mapped in `toItemResponse`. [task-log.md#p2-23](docs/task-log.md#p2-23)
- [x] **P2-24** Add full and partial refunds through compensating rows, with approval and audit. `RefundsService` mirrors P2-22/P2-23's `ManagerPinService` pattern, but approval is unconditional — a refund always reverses already-collected money, so there's no own-authority tier at all. New append-only `refunds` table (UPDATE/DELETE revoked) + `refund_reason_codes`; added `billing.refund.approve` to `branch_manager`'s seed grant (the permission itself pre-existed). [task-log.md#p2-24](docs/task-log.md#p2-24)
- [x] **P2-25** Add credit customers with an append-only account ledger, credit limits and repayments. `CreditCustomersService` (new `credit_customers` + append-only `credit_ledger_entries`) — no manager-PIN approval, unlike discounts/voids/refunds: a charge within the customer's own configured limit is an ordinary POS action. New `credit.manage` permission (admin CRUD/limits) vs. `pos.sell` (charge/repayment at the till). [task-log.md#p2-25](docs/task-log.md#p2-25)
- [x] **P2-26** Reconcile synced sales on the server: recalculate totals and send mismatches to a review queue. Scoped to "every invoice once recorded," not a sync-specific payload — no real offline sale has ever synced through `/sync/operations` yet (that's P2-45). `ReconciliationService` independently recomputes totals via the outbox (apps/worker's first real handler); mismatches land in a new append-only-by-convention `invoice_reconciliation_flags` table, read via `GET /reconciliation-flags` (api-reports). [task-log.md#p2-26](docs/task-log.md#p2-26)

**Cash and shifts**
- [x] **P2-27** Build shift open and close, with opening float and counted cash by denomination. `ShiftsService` (new `shifts` table, one open shift per till enforced by a partial unique index, same two-layer convention as P2-16's table-occupancy index) — `close` only counts and records; over/short and X/Z reports are deliberately deferred to P2-29. [task-log.md#p2-27](docs/task-log.md#p2-27)
- [x] **P2-28** Add cash in and cash out with reason codes, plus cash drawer open logging. `CashMovementsService` — append-only `cash_movements` + `cash_drawer_open_events` (a cash-in/out auto-logs its own drawer-open event); new `cash_movement_reason_codes` (same inclusion-list convention as discount/void/refund). No balance check against expected drawer cash — that's P2-29's over/short job. [task-log.md#p2-28](docs/task-log.md#p2-28)
- [x] **P2-29** Add over/short calculation, X report (mid-shift) and Z report (end of shift). `ShiftReportsService` derives "sales so far" by joining payments to invoices generated on the shift's own device within its time window — payments/invoices were never given a `shiftId` column, so this reads by device+time instead of a schema change. Documented gap: refunds carry no payment method, so cash refunds aren't subtracted from expected cash. [task-log.md#p2-29](docs/task-log.md#p2-29)
- [x] **P2-30** Add business-day close per branch, which blocks new sales on a closed day without losing offline sales. `BusinessDaysService.requireOpenForSale` gates `OrdersService.create` (new optional 4th constructor param, so every existing test instantiating `OrdersService` directly still compiles unchanged). `asOfBusinessDate` lets a future offline-sync replay check the sale's own original date instead of "today" — deliberately not exposed on the public `/orders` HTTP contract, only usable by a direct `OrdersService.create` caller. New `business_day.manage` permission — **needs `pnpm db:seed` rerun**. [task-log.md#p2-30](docs/task-log.md#p2-30)

**Printing and hardware**
- [x] **P2-31** Build ESC/POS support for USB and network printers in the Rust layer, with timeouts. `escpos.rs` (pure byte-building, unit-tested) + `printer_transport.rs` (`NetworkPrinter` over `TcpStream`, `UsbPrinter` over a new `rusb` dependency, both timeout-bounded — rule 15). New `print_raw_escpos` Tauri command is the primitive; no real caller yet (P2-32's queue, P2-33's templates build on top). Rust side reviewed by hand, not locally compiled (same pre-existing OpenSSL/Perl env issue as P2-11/P2-12) — CI is authoritative. [task-log.md#p2-31](docs/task-log.md#p2-31)
- [x] **P2-32** Build a persistent print queue with retry, failure alerts and reprint marked as a copy. New local SQLite `print_jobs` table (survives a crash/restart, same as `operation_log`); `print_queue.rs` claims due jobs and records outcomes as short separate SQL statements so the actual send never happens while the DB mutex is held (rule 14). Capped retries with exponential backoff → `dead_letter`, same shape as the server outbox (P1-30). A reprint re-renders with a "*** COPY ***" banner via P2-31's `escpos.rs`, not just a DB flag. No UI polls the failure-alert primitive yet. [task-log.md#p2-32](docs/task-log.md#p2-32)
- [x] **P2-33** Build configurable receipt templates with logo, tax details and footer. Backend: new `receipt_settings` (one row per restaurant, logo URL reference/header/footer text/tax-breakdown and service-charge toggles), `GET`/`PUT /receipt-settings` (`menu.manage`, api-admin) + read-only `GET /receipt-settings` (`pos.sell`, api-pos). Rust: `receipt_template.rs` renders settings + invoice content into real ESC/POS bytes via P2-31's `escpos.rs` (which gained a `raster_image` builder method for the logo). Documented gap: converting a `logoUrl`'s actual image file into the 1-bit raster bytes needs an image-decoding crate this project doesn't have — the template already knows how to use a pre-converted bitmap, nothing converts one yet. [task-log.md#p2-33](docs/task-log.md#p2-33)
- [x] **P2-34** Add cash drawer control, and barcode scanner support as keyboard input. Barcode-as-keyboard-input was already fully built in P2-11 (`useBarcodeScanner.ts`) — verified, no new work needed. Cash drawer: `escpos.rs` gained `kick_drawer` (ESC p, the command P2-31 deliberately left out) + a new `kick_cash_drawer` Tauri command that sends directly (never through P2-32's print queue — a drawer kick is "do it now," not something to retry later). No UI caller yet, and it doesn't log a P2-28 `cash_drawer_open_event` server-side — documented gap, not wired. [task-log.md#p2-34](docs/task-log.md#p2-34)
- [x] **P2-35** Add a printer test and setup screen that branch staff can use without developer help. New `PrinterSetupScreen.tsx` (network IP or USB-device-picker, Test Print, Open Drawer, persists via `printer_settings.rs`, shows a dead-letter/retry alert from P2-32's queue). New Rust: `printer_discovery.rs` (lists plugged-in USB devices so staff never type a vendor/product ID), `printer_settings.rs`/`printer_settings_commands.rs`. Fixed a consistency gap found along the way: several P2-32/33/34 Rust structs were missing the project's `#[serde(rename_all = "camelCase")]` convention — fixed before any real frontend code could hit the mismatch. [task-log.md#p2-35](docs/task-log.md#p2-35)

**Branch hub**
- [x] **P2-36** Add hub mode to the desktop app: local WebSocket and HTTP server with paired devices only. `hub_auth.rs` (pure, offline token verification against a cached roster — same SHA-256 hash as the server's `hashOpaqueToken`) + `hub_roster.rs` (local SQLite cache, refreshed from a new `GET /devices/roster`) + `hub_server.rs` (sync `tiny_http`/`tungstenite` servers — new deps, no async runtime added). `GET /health` needs no token; everything else, HTTP or WebSocket, is rejected without one matching the roster. No real shared-data protocol yet (P2-38); a WS connection just gets one `hub_hello` then closes. [task-log.md#p2-36](docs/task-log.md#p2-36)
- [x] **P2-37** Add automatic hub discovery on the local network, with manual IP as a fallback. `hub_discovery.rs` (new, std-only — no new dependency): a tiny UDP broadcast request/reply protocol, scoped by `restaurantId` so a foreign restaurant's terminal on the same physical LAN gets no reply. Wired into `hub_server::start` as a third background listener alongside P2-36's HTTP/WS servers, so starting a hub makes it discoverable with its own real ports automatically. `check_hub_reachable` is the manual-IP fallback — just a `GET /health`, same trust model as P2-35's printer-IP entry. No frontend screen yet — same scoping as P2-36. [task-log.md#p2-37](docs/task-log.md#p2-37)
- [x] **P2-38** Share orders, table status and kitchen tickets between devices through the hub while offline. `hub_state.rs` (pure conflict logic — caller-supplied monotonic `version`, strictly-newer-wins, same spirit as rule 9's idempotency) + a new local `hub_shared_state` table so the relay survives a hub restart. `hub_server.rs`'s WebSocket connection is now a real persistent relay (was P2-36's one-shot `hub_hello`-then-close): snapshot on connect, then bidirectional `state_update`s, broadcast to every other connection, never echoed to the sender. Found and fixed a real resource-leak bug while building this — `stop()` wasn't closing already-open connections, only the three fixed listener threads. New `apps/desktop/src/shared/hub-client.ts` (pure TS, no Rust) is the non-hub side — a plain browser `WebSocket`, since only the hub itself needs a server. [task-log.md#p2-38](docs/task-log.md#p2-38)
- [x] **P2-39** Make terminals keep billing if the hub fails, and catch up when it returns. "Keep billing" already held by construction — sales go through `OrdersService`/local SQLite/the real server sync, none of which `hub-client.ts` touches at all; verified, not rebuilt. "Catch up" is what's new: `hub-client.ts` gained jittered-backoff auto-reconnect (same shape as P1-35's sync backoff) and a bounded outbox (keyed by entity, so a newer queued update replaces an older one instead of both being kept) flushed in full the moment the connection reopens. `onConnectionStateChange` lets a frontend show "hub offline" without its own retry bookkeeping. [task-log.md#p2-39](docs/task-log.md#p2-39)

**Basic reports for the pilot**
- [x] **P2-40** Add a daily sales summary, payment breakdown and void, discount and refund reports. `api-reports`' first real feature. `SalesReportsService` scopes every report to one branch's business day (same local-timezone concept as P2-30, via a hand-rolled `Intl.DateTimeFormat` zoned-midnight conversion — no timezone library in this codebase). Reuses `packages/domain`'s discount/money functions directly for void/discount line values rather than re-deriving new math. Deliberately basic (matches the section heading): discount report is item-level only, bill-level discounts left for a later reporting task — documented, not silently dropped. [task-log.md#p2-40](docs/task-log.md#p2-40)

**Performance**
- [x] **P2-41** Index SQLite for POS searches, and use list virtualization for long menus and order lists. SQLite: composite indexes covering both the filter AND `ORDER BY` for the category/modifier-browsing queries (the common path); the free-text name/sku/barcode substring search is left as a documented full-scan — a leading-wildcard `LIKE` can't use a plain b-tree index regardless, and FTS5's trigram tokenizer availability couldn't be confirmed without a build this session. Frontend: added `@tanstack/react-virtual` (user chose this over hand-rolling, given AskUserQuestion) to `ProductGrid`/`CartPanel`, each with a size threshold below which the original, already-tested plain rendering is used unchanged. [task-log.md#p2-41](docs/task-log.md#p2-41)
- [x] **P2-42** Load POS, kitchen and admin screens separately through code splitting. POS vs. kitchen (desktop) were already separately loaded since P1-18 (`pos.html`/`kitchen.html`, two real Vite multi-page entries) — verified, not rebuilt. The actual gap was *within* `apps/web` (Super Admin/QR-menu/public-site/restaurant-admin all share one app per section 4): its 4 pages were all eagerly bundled together. Converted to `React.lazy()` per page, wrapped in one `Suspense` boundary — zero new dependencies, Vite code-splits a dynamic `import()` automatically. [task-log.md#p2-42](docs/task-log.md#p2-42)
- [x] **P2-43** Cache versioned menus and prices in Redis, and clear the cache when a new version is published. First real consumer of section 3's "Valkey or Redis" entry — new `RedisModule` (mirrors `DbModule`'s shape) + `MenuSnapshotCacheService`, caching `SyncSnapshotService`'s expensive per-branch catalog+N+1-price-resolution computation behind a generation-bumping key (`PriceListsService.publish` bumps it — the canonical "new version" event). A 5-minute TTL is the safety net for catalog edits that don't explicitly invalidate (documented gap, not every mutation). Both new dependents (`PriceListsService`, `SyncSnapshotService`) wired into api-admin and api-pos respectively. [task-log.md#p2-43](docs/task-log.md#p2-43)
- [x] **P2-44** Serve optimized images with WebP, resizing and long-lived caching through R2 and Cloudflare, with Brotli or gzip for web assets. `ImageUploadService` (new `StorageModule`, first real S3 consumer) resizes/re-encodes to WebP and uploads with a far-future `Cache-Control`, behind a new `POST /images` (api-admin). `apps/web`'s build now also emits `.br`/`.gz` sibling files — pre-compression only, since no Dockerfile/reverse-proxy exists anywhere in this repo yet to actually serve the right one. [task-log.md#p2-44](docs/task-log.md#p2-44)
- [x] **P2-45** Keep the desktop POS working from local data, with no network call in the sale path. `offline_sales.rs` prices the cart (via a new Rust `charges.rs` port of `packages/domain`), mints a P1-28 document number, and records the invoice in one local transaction through P1-24's `record_once` — no network call anywhere in the path. Fed by a synced, signed tax-config cache (new `charges.rs`/`menu_cache.rs` work) and this terminal's own paired branch/terminal number (`device_identity.rs`). [task-log.md#p2-45](docs/task-log.md#p2-45)
- [x] **P2-46** Add cursor pagination to all large API lists. Used `packages/contracts`' existing `PageRequestSchema`/`pageResponseSchema` (built in P1-08, never consumed until now) plus a new `packages/nest-core/src/cursor-pagination.ts` keyset helper (`seekCondition`/`toPage`, ordered by `(createdAt, id)` DESC). Wired into the 5 genuinely unbounded, ever-growing lists: orders, shifts, business days, a credit customer's ledger, and reconciliation flags. Catalog/config lists (products, categories, price lists, reason codes, etc.) are bounded by restaurant/branch size, not transaction volume — scoped out, documented rather than silently skipped. [task-log.md#p2-46](docs/task-log.md#p2-46)

**Exit gate:** a pilot branch runs full service, including an internet outage and a hub restart, with no lost or duplicated sales. Totals match between terminals and server.

**Exit gate hardening (2026-11-19):** attempting to verify "totals match between terminals and server" found it was not actually checkable yet — `/sync/operations` had never turned a synced offline sale into a real server-side order/invoice (it only stored the raw operation). Closed that gap (new `OfflineSaleSyncService` + `devices.defaultActorUserId`, since desktop still has no login flow to attribute a sale to a real cashier) and ran an automated fault-injection simulation covering the terminal-to-server axis: a synced offline sale creates a real order/invoice with the terminal's own recorded totals, a network-interruption retry creates no duplicate, and P2-26's existing reconciliation independently recalculates and correctly flags a deliberate mismatch without ever altering the recorded sale. Hub-restart resilience remains separately verified at the Rust unit level (P2-38/P2-39) — not re-tested here. **A real pilot-branch run is still the only way to close this gate for real** (live hardware, an actual internet outage, real staff) — this hardening only makes the terminal-to-server half of it genuinely checkable, not yet checked in production. [task-log.md#exit-gate-hardening-2026-11-19](docs/task-log.md#exit-gate-hardening-2026-11-19)

---

### Phase 3: Kitchen, complete core inventory and platform billing

**Goal:** kitchen flow, accurate stock and food cost, and platform revenue.

**Kitchen**
- [x] **P3-01** Build kitchen stations and routing rules by product and category. `kitchen_stations` (name, sort order, own printer host/port) + `kitchen_routing_rules` (exactly one of category/product per rule). `resolveStation` prefers a product-specific rule over a category one, falling back to unrouted. [task-log.md#p3-01](docs/task-log.md#p3-01)
- [x] **P3-02** Build kitchen tickets with no money fields, including add-ons, voids and rush flags. `KitchenTicketsService` builds a ticket purely from fired order items/modifiers — no price field anywhere in the shape (rule 18). `rush` is a per-ticket cashier flag. [task-log.md#p3-02](docs/task-log.md#p3-02)
- [x] **P3-03** Build the kitchen display: queue, timers, bump, recall and order-ready status. Real Tauri window (`apps/desktop/src/kitchen/App.tsx`) polling a device-token-authed terminal API every 5s — station-grouped queue, color-coded elapsed timer, bump/recall, an "order ready" banner once every ticket for an order is bumped. `kitchen_ticket_states` is the exclusion-list convention again (a bump is a row, a recall is a DELETE). [task-log.md#p3-03](docs/task-log.md#p3-03)
- [x] **P3-04** Add kitchen printer support, with fallback from display to printer and back. User's explicit choice: print *always* alongside the display rather than a detected fallback, since "is the display up" can't be reliably checked from here. `kitchen_ticket_template.rs` renders real ESC/POS bytes; dedup tracked in localStorage over the same 3-hour window the display polls. [task-log.md#p3-04](docs/task-log.md#p3-04)
- [x] **P3-05** Make the kitchen flow work offline through the hub. An offline-fired ticket relays over P2-38's hub (its first real caller) instead of the server; the display merges hub entries with its normal poll, and bump/recall republishes to the hub for a hub-sourced ticket. Documented gap: an offline ticket's station is always null (routing rules aren't synced to the terminal), so it always lands in "Unrouted." [task-log.md#p3-05](docs/task-log.md#p3-05)
- [x] **P3-06** Add preparation time reports by station and product. `KitchenPrepTimeReportsService.getReport` — avg/min/max fired-to-bumped seconds, grouped by station and product/variant, scoped to one branch's business day. [task-log.md#p3-06](docs/task-log.md#p3-06)

**Inventory items and ledger**
- [x] **P3-07** Build inventory items, categories, SKU, barcode and storage locations (such as store and kitchen). `inventory_categories`/`inventory_items` (SKU/barcode partial-unique-per-restaurant, same convention as products.ts) + branch-scoped `storage_locations`. [task-log.md#p3-07](docs/task-log.md#p3-07)
- [x] **P3-08** Build units and conversions, such as purchase in cartons, store in kg and use in grams. `units` (restaurant-defined) + `inventory_item_unit_conversions`, a star shape centered on each item's own base unit — no full pairwise conversion table. [task-log.md#p3-08](docs/task-log.md#p3-08)
- [x] **P3-09** Build the append-only stock ledger with movement types: purchase, sale, return, wastage, adjustment, count, production and transfer. `stock_ledger` with all 8 types, UPDATE/DELETE revoked (rule 4). Direction is a signed `quantityDelta`, never implied by the type — this task defines the shape only, every type got a real caller from whichever later task needed it. [task-log.md#p3-09](docs/task-log.md#p3-09)
- [x] **P3-10** Build branch and location stock levels derived from the ledger, with a rebuild tool to verify them. `stock_levels` is a materialized cache of the ledger, updated in the same transaction as every ledger write. `StockLevelsService.rebuild` replays the whole ledger and diffs against what's stored, with `apply: true` to actually correct drift. [task-log.md#p3-10](docs/task-log.md#p3-10)
- [x] **P3-11** Add weighted average costing, with the unit cost snapshotted on each movement. `blendWeightedAverageCost` (`packages/domain`) folds a costed increase into the running average; a decrease is always valued at the current average and never moves it — the rule every later batching/costing task leans on. [task-log.md#p3-11](docs/task-log.md#p3-11)
- [x] **P3-12** Add negative stock flags and a review screen for offline sales. `negative_stock_flags`, written in the same transaction as the movement that caused it (rule 12), generic across every movement type. `review` marks a flag reviewed — never deleted, never reviewed twice. [task-log.md#p3-12](docs/task-log.md#p3-12)

**Recipes and production**
- [x] **P3-13** Build recipes per product and variant, with quantities, units and yield percentage. Backend only. `recipes`/`recipe_items`, exactly-one-owner CHECK constraint (same convention as order_items.ts/price_list_items.ts). Deliberately not versioned yet — P3-19 is what adds that. [task-log.md#p3-13](docs/task-log.md#p3-13)
- [x] **P3-14** Add recipe rules for modifiers, such as extra cheese adding ingredients. Backend only. Extended `recipes.modifierOptionId` as a fourth owner type — a modifier's own recipe is summed with the base recipe at consumption time (P3-17's job, not this one's). [task-log.md#p3-14](docs/task-log.md#p3-14)
- [x] **P3-15** Add sub-recipes and semi-finished items, such as sauces and marinated meat. Backend only. `inventory_items.itemType` ("raw"/"semi_finished") + `recipes.semiFinishedItemId` as a fifth-no-fourth owner type, with a self-reference guard; a deeper cycle (sauce A uses sauce B uses sauce A) is a documented gap, not caught here. [task-log.md#p3-15](docs/task-log.md#p3-15)
- [x] **P3-16** Add production batches that consume ingredients and add finished stock. `ProductionService` — first real caller of stock_ledger's "production" movement type; refactored `StockLedgerService.recordMovement` into a `recordMovementInTx` so a batch's several ingredient deductions and one finished-stock increase commit atomically. Output cost is derived from consumed ingredients' own current cost, divided by batch quantity. Added a same-branch guard for consumption/output locations (caught before shipping, not a later fix). [task-log.md#p3-16](docs/task-log.md#p3-16)
- [x] **P3-17** Auto-deduct stock from synced sales through idempotent outbox processing. `SalesStockDeductionService` — first real caller of stock_ledger's "sale" type, wired via a new "invoice.stock_deduct" outbox event from both `InvoicesService.generate` AND `OfflineSaleSyncService` (the latter builds its own invoice, doesn't call the former — found and closed before this would have silently skipped offline sales). Idempotent via a pre-write check against existing "sale" rows for the invoiceId. [task-log.md#p3-17](docs/task-log.md#p3-17)
- [x] **P3-18** Handle voids and refunds: a choice of return to stock or record as wastage, with a reason. New shared `stock-deduction-shared.ts` (recipe+modifier expansion, reused by P3-17 too). Void's choice only applies post-fire (pre-fire never touched stock); refund's is the mirror image (sale already deducted, so "wastage" is a no-op and "return_to_stock" is what adds a row). [task-log.md#p3-18](docs/task-log.md#p3-18)
- [x] **P3-19** Snapshot the recipe version and cost on each sale for accurate food cost history. `recipes.version` (plain counter, not full history) + append-only `order_item_food_costs`, written by `SalesStockDeductionService` using each ingredient's current weighted-average cost. Scoped to the item's own base recipe only — a modifier's own recipe version isn't separately tracked, documented not dropped. [task-log.md#p3-19](docs/task-log.md#p3-19)

**Purchasing and suppliers**
- [x] **P3-20** Build supplier records, the items each supplies, and price history. `suppliers`/`supplier_items`/`supplier_item_prices` (price history append-only, "current" is just the latest row). [task-log.md#p3-20](docs/task-log.md#p3-20)
- [x] **P3-21** Build purchase orders with draft, approval, sent, partly received and closed states. `purchase_orders`/`purchase_order_items`, ManagerPinService-gated approval. Only draft->approved->sent is actually driven by this task — partly_received/closed exist as states but nothing here reaches them; that's P3-22's job on purpose. [task-log.md#p3-21](docs/task-log.md#p3-21)
- [x] **P3-22** Build goods received notes with partial delivery, price differences and rejected items. Append-only `goods_received_notes`/`goods_received_note_items`; first real caller of stock_ledger's "purchase" type and `purchase_order_items.receivedQuantity`. Renamed the shared unit-conversion helper off its recipe-only name since this is its third, non-recipe caller. [task-log.md#p3-22](docs/task-log.md#p3-22)
- [x] **P3-23** Build supplier invoices and three-way matching across order, receipt and invoice. Append-only `supplier_invoices`/`supplier_invoice_items`; three checks per line (exceeds ordered, exceeds received, price mismatch) produce a `supplier_invoice_match_flags` row, same "additive diagnostic, never touches the document" shape as P2-26's reconciliation. [task-log.md#p3-23](docs/task-log.md#p3-23)
- [x] **P3-24** Build purchase returns through compensating stock movements. Append-only `purchase_returns`/`purchase_return_items` + `purchase_order_items.returnedQuantity`. Reuses stock_ledger's "return" type with a negative delta — same type P3-18's refunds use positive, direction is signed not type-implied. No manager-PIN gate here — the task doesn't ask for one and the chain's only explicit approval moment is P3-21's own. [task-log.md#p3-24](docs/task-log.md#p3-24)
- [x] **P3-25** Build an append-only supplier ledger with payments and outstanding balances. `SupplierLedgerService` — the accounts-payable mirror of CreditCustomersService (P2-25); every recorded supplier invoice automatically charges it (unlike a customer credit sale, a payable isn't optional), no separate "payments" table needed, same reasoning credit ledger entries have no separate "repayments" table. [task-log.md#p3-25](docs/task-log.md#p3-25)

**Stock control**
- [x] **P3-26** Build full and cycle stock counts, with blind count entry and offline support. `stock_counts`/`stock_count_items` — `expectedQuantity` snapshotted at count-start but withheld from every response while a count is in_progress, only visible once submitted. Doesn't touch stock_ledger at all — that's deliberately P3-27's job. "Offline support" is the blind per-line submit already being a flat, idempotent-by-construction write, not a separate mechanism. [task-log.md#p3-26](docs/task-log.md#p3-26)
- [x] **P3-27** Add variance review and approval before stock is adjusted. New `approved` status, ManagerPinService-gated (no own-authority tier, same as a refund). One "count" stock_ledger movement per line that actually differs. Found and fixed two real gaps first: both `submitLineCount` and `finalize` only checked for status `"submitted"`, not also blocking an already-`"approved"` count from being edited/resubmitted. [task-log.md#p3-27](docs/task-log.md#p3-27)
- [x] **P3-28** Add wastage entry with reason codes and approval limits. `WastageService` — a standalone stock loss with no sale/void/purchase behind it (distinct from P3-18's void-triggered wastage). `wastage_limit_settings` mirrors discount_limit_settings' own-authority-limit shape, checked against the entry's *cost* (quantity × current average cost via the shared `computeLineCost` from P3-19), not raw quantity. [task-log.md#p3-28](docs/task-log.md#p3-28)
- [x] **P3-29** Add minimum and par levels with low-stock alerts on the dashboard. `ParLevelsService` (`item_par_levels`, min/par per location+item) + `getLowStock`, joining against `stock_levels` for every item at or below its own minimum — a dashboard read, not a push notification. [task-log.md#p3-29](docs/task-log.md#p3-29)
- [x] **P3-30** Add an inventory audit trail showing the full history behind any stock number. `GET /stock-ledger/audit-trail` — every ledger row for one item+location, oldest first, with a running balance computed in memory as it walks the rows. [task-log.md#p3-30](docs/task-log.md#p3-30)

**Inventory reports**
- [x] **P3-31** Add stock on hand, stock valuation and stock movement reports. `InventoryReportsService.getStockOnHand`/`getStockValuation`/`getStockMovementReport`, read-only off `stock_levels`/`stock_ledger`. An uncosted item contributes nothing to a value total rather than guessing. [task-log.md#p3-31](docs/task-log.md#p3-31)
- [x] **P3-32** Add theoretical versus actual food cost and variance reports. `getFoodCostVarianceReport` — theoretical cost from P3-19's per-sale recipe-cost snapshots, actual cost from real stock_ledger sale+wastage movements over the same window; a restaurant with no extra wastage nets to zero variance by construction. [task-log.md#p3-32](docs/task-log.md#p3-32)
- [x] **P3-33** Add wastage, purchase and supplier reports. `getWastageReport`/`getPurchaseReport`/`getSupplierActivityReport` — the last one has no table of its own, it's purchased value and returned quantity joined by supplier. [task-log.md#p3-33](docs/task-log.md#p3-33)

**Platform billing and admin**
- [x] **P3-34** Build commission entries from paid invoices, with the rate snapshotted and idempotent processing. `CommissionService.processPayment` — one row per payment actually collected, idempotent via a unique-indexed existence check, rate read fresh and frozen onto the row forever (rule 7). [task-log.md#p3-34](docs/task-log.md#p3-34)
- [x] **P3-35** Add commission reversals when a refund occurs. `CommissionService.processRefund` — a signed-negative "reversal" row in the same table; a fully refunded sale's charge+reversal nets to exactly zero. [task-log.md#p3-35](docs/task-log.md#p3-35)
- [x] **P3-36** Add the hybrid fixed + commission plan and configurable billing cycles. `BillingPlanService`/`billing_plans` — flat fee + commission rate + cycle length per restaurant, read fresh by each commission run. [task-log.md#p3-36](docs/task-log.md#p3-36)
- [x] **P3-37** Build `CommissionRun` with idempotent runs and a nightly settlement job. `CommissionRunService.processPeriod`, idempotent per (restaurant, period, currency); `CommissionRunScheduler` is a plain self-scheduling `setTimeout` loop, chosen over a cron library via `AskUserQuestion`. [task-log.md#p3-37](docs/task-log.md#p3-37)
- [x] **P3-38** Build settlement statements and payment recording. `SettlementStatementsService` — one statement per commission run; payment recording is its own append-only row, same shape as every other ledger in this codebase. [task-log.md#p3-38](docs/task-log.md#p3-38)
- [x] **P3-39** Build Super Admin: restaurant list, status, plans, devices, platform revenue and support tools. `RestaurantsAdminService`/`PlatformRevenueService` in `apps/api-admin`. Found and fixed a real RLS-bypass bug class along the way: an `*AsSuperAdmin` method without an explicit `restaurantId` filter silently returns cross-tenant data, since `isSuperAdmin: true` makes RLS permit every row — closed in 3 services plus a pre-existing P1-23 instance of the same bug. [task-log.md#p3-39](docs/task-log.md#p3-39)
- [x] **P3-40** Add full audit logging and a clear visible notice whenever Super Admin acts on a restaurant's data. `audit_logs.actingAsSuperAdmin` stamped automatically; `SuperAdminNoticeInterceptor` sets an `X-Acting-As-Super-Admin` response header — had to use rxjs `finalize()` not `tap()` so the header survives an error response too. [task-log.md#p3-40](docs/task-log.md#p3-40)

**Performance**
- [x] **P3-41** Add database indexes based on real inventory and report queries, and remove unused ones. Added indexes to 9 previously-unindexed schema files — `stock_ledger`, the busiest inventory table, had zero beyond its primary key. Verified with `EXPLAIN` under real RLS context against deliberately skewed seed data (an even seed would hide a missing index as a false pass). [task-log.md#p3-41](docs/task-log.md#p3-41)
- [x] **P3-42** Use set-based batch processing for stock deductions and commission runs, while keeping them idempotent. `expandInvoiceIngredientsBatch`/`computeInvoiceLineCostsBatch`/`recordSaleDeductionsInTx` turn a sale's stock deduction into a handful of queries regardless of item count — safe to batch because a decrease never touches the weighted-average cost (P3-11). `CommissionRunService` batched the same way across currencies. [task-log.md#p3-42](docs/task-log.md#p3-42)
- [x] **P3-43** Run heavy reports and exports through background jobs with separate BullMQ queues and concurrency limits, so they cannot slow down sales. `ReportsQueueService` (first BullMQ use in this codebase); every report controller now runs its job through the queue, response-shape mapping moved into `apps/api-reports`'s new handler provider. Found a real NestJS DI bug along the way — plain constructor injection silently resolved every dependency to `undefined`; fixed with explicit `@Inject()`. [task-log.md#p3-43](docs/task-log.md#p3-43)

**Exit gate:** stock movements reconcile with real sales in the pilot; a ledger rebuild matches stored stock levels; commission matches invoices and refunds; the kitchen works through an internet outage.

**Exit gate review (2026-11-26):** Three criteria verified by a real smoke test (deleted after use): a sale's stock deduction matches its recipe and reconciliation both passes a correct invoice and catches a deliberately broken one; a ledger rebuild reports zero drift after a real sale and correctly catches (and `apply: true` fixes) a deliberately corrupted stock_levels row; a payment's commission charge and a refund's exact reversal net to zero, with the locked rate column confirmed genuinely unwritable at the DB level. The 4th (kitchen offline) is design-verified only (hub relay in `App.tsx`/`offline-kitchen-ticket.ts` is real) — still provable for real only with live hardware, same as the P2-45 hardening's own conclusion. Also found and fixed in this pass: P3-01–12 and P3-29–43 were genuinely complete in code but their checkboxes and task-log entries had never been written — backfilled both. [task-log.md#phase-3-exit-gate-review-2026-11-26](docs/task-log.md#phase-3-exit-gate-review-2026-11-26)

---

### Phase 4: Growth and scale

**Goal:** customer-facing channels, full reporting, advanced inventory and proven capacity for 1,000 restaurants.

**Customer-facing**
- [ ] **P4-01** Build QR scan, public menu and order placement, with server-side pricing and rate limits.
- [ ] **P4-02** Send QR orders to the POS and kitchen, with cashier approval configurable by restaurant.
- [ ] **P4-03** Build restaurant website pages and settings.
- [ ] **P4-04** Build customer records, order history and optional loyalty points.
- [ ] **P4-05** Add customer data export and deletion that keep financial records intact through anonymization.

**Management and reports**
- [ ] **P4-06** Build branch expenses with categories, attachments and approval.
- [ ] **P4-07** Build sales reports by hour, product, category, staff, order type and branch.
- [ ] **P4-08** Build tax reports, profit estimates and owner dashboards across branches.
- [ ] **P4-09** Add scheduled report exports to CSV, Excel and PDF, handled by background jobs.
- [ ] **P4-10** Ask the owner for the launch market's tax rules, then build the required tax-authority integration. If launch requires it, do this before commercial launch.

**Advanced inventory**
- [ ] **P4-11** Add batch and expiry tracking, with first-expiry-first-out suggestions and expiry alerts.
- [ ] **P4-12** Add branch stock transfers with request, dispatch, receive and discrepancy steps.
- [ ] **P4-13** Add central purchasing across branches.
- [ ] **P4-14** Add reorder suggestions from par levels and sales history.
- [ ] **P4-15** Add demand forecasting and link it to purchase suggestions, as suggestions only.

**Scale**
- [ ] **P4-16** Add Redpanda and publish outbox events to `orders`, `billing`, `inventory` and `sync`, keyed by `restaurant_id`.
- [ ] **P4-17** Make all consumers idempotent, with dead-letter topics and lag monitoring.
- [ ] **P4-18** Add ClickHouse and move heavy reports to it, keeping PostgreSQL as the financial record.
- [ ] **P4-19** Add PostgreSQL read replicas, and a standby with automatic failover.
- [ ] **P4-20** Add monthly partition automation and a data retention policy.
- [ ] **P4-21** Add point-in-time recovery and run a documented restore drill.
- [ ] **P4-22** Load test lunch and dinner peaks at 1,000 restaurants, including mass reconnect sync bursts. Get the peak order figure from the owner first.
- [ ] **P4-23** Fix what the load tests reveal. Add Citus or move a hot path to Go only if measurements show it is needed.
- [ ] **P4-24** Run fault tests: kill each process, the broker, the hub and the database primary during live traffic.
- [ ] **P4-25** Write runbooks for incidents, deployment, rollback, restore and new-branch setup.

**Performance**
- [ ] **P4-26** Add k6 performance tests against agreed limits for critical paths, and fail the build on a significant regression.
- [ ] **P4-27** Add PgBouncer pool tuning, read routing for reports, and capacity limits per process based on load test results.
- [ ] **P4-28** Review costs per restaurant, including VPS, R2 and data retention.

**Exit gate:** load tests pass at the agreed peak; killing any component causes no lost sale; the restore drill succeeds; all runbooks are complete.

---

## 8. Testing required in every phase

| Area | Requirement |
|---|---|
| Tenant isolation | Every endpoint and RLS policy; required in CI |
| Money | Same test cases on terminal and server, plus property tests |
| Sync | Lost connections, retries, duplicates, crashes and long offline periods |
| Hardware | Real printers and cash drawers on low-spec Windows 10 or later PCs |
| Fault injection | Kill a process or the app mid-sale; billing continues and no data is lost |
| End to end | Playwright flows for each critical POS and inventory path |

---

## 9. Performance requirements

Starting targets, to be tested on a low-spec Windows 10 POS PC and adjusted only after measuring:

- Adding an item to the cart: under 100 ms.
- Finishing a sale locally: under 500 ms, with printing and sync never holding it up.
- Desktop app startup: under 3 seconds.
- Main POS API reads: p95 under 200 ms at normal load.

Rules:

- Measure before optimizing. Add caches, new services or rewrites only when data shows they are needed.
- Performance work must never weaken tenant isolation, financial accuracy, offline safety or the rules in section 2. Never cache data across tenants, and always include `restaurant_id` in cache keys.
