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
- [ ] **P1-13** Add a manager PIN for approving sensitive actions, online and offline. Online half (server-side approve/lockout/audit) done; the offline-verification primitives it depends on (P1-27, P1-27b) are now done too, but there's still no Tauri command wiring them into an actual "approve this sensitive action" UI flow — nothing to wire into yet, since Phase 2's POS terminal (where a void/refund/discount would actually prompt for a manager PIN) doesn't exist. Check this box once that wiring exists and is exercised by a real flow, not just unit tests of the underlying primitives.
- [x] **P1-14** Build the append-only audit log and record who, what, when, where and which device.
- [x] **P1-15** Build restaurant onboarding: signup, first branch, default roles and locked commission settings.
- [x] **P1-16** Port `TenantIsolationTest`, extend it to every endpoint and RLS policy, and make it a required CI check.
- [x] **P1-17** Build Branch CRUD and user invitation screens as the reference pattern for later modules. Lives in `apps/web` (React/Vite), not the Tauri desktop app — branch/staff management needs no offline support or hardware access, and doesn't need P1-18's Tauri shell to exist first (decided 2026-11-07; see the repo structure note in section 4).

**Desktop foundation**
- [x] **P1-18** Create the Tauri 2 app with separate POS and kitchen windows, and error boundaries per module.
- [x] **P1-19** Add encrypted SQLite in WAL mode with migrations and an integrity check at startup.
- [x] **P1-20** Add device pairing, token storage and remote device revocation.
- [x] **P1-21** Add signed auto-updates with staged rollout and automatic rollback. Signing, the staged-rollout update-check endpoint, and rollback *detection* are built and tested end to end; the actual restart-with-the-rolled-back-binary execution is P1-22's watchdog (done — see P1-22). The tag-triggered release workflow (.github/workflows/release.yml) has now run for real and succeeded end to end on all 4 platforms (`desktop-v0.1.0-test8`): real signed MSI/NSIS/deb/rpm/AppImage/dmg bundles plus `.sig` files and `latest.json` published to a draft GitHub Release. Getting there took a real debugging trail across several dry-run tags, each a genuine pre-existing bug, not a new regression: (1) a step `if:` referenced the `secrets` context, which isn't valid there (only env/github/inputs/job/matrix/needs/runner/steps/strategy/vars are) — GitHub silently rejects the *entire workflow file* for this, on every push, not just ones reaching that step; `actionlint` caught it. (2) the workspace-build step only built `@mezbaan/contracts`, not its `@mezbaan/domain` dependency, so a fresh checkout failed type-checking — fixed with `--filter "@mezbaan/contracts..."` (dependency-direction suffix, not prefix). (3) `tauri-action`'s GitHub Release creation 403'd ("Resource not accessible by integration") regardless of `contents: write` at job *or* workflow level — turned out to be unrelated to permissions scope entirely: GITHUB_TOKEN refuses to create a release when `target_commitish` (always the triggering commit SHA) isn't reachable from a branch that exists on the remote, and only *tags* had ever been pushed, never `main` itself. Confirmed by reproducing tauri-action's exact REST call directly via curl. **Future releases must push `main` before pushing the tag**, not just the tag — documented at the top of release.yml.
- [x] **P1-22** Add a watchdog that restarts the app and restores in-progress work. The watchdog's own logic (PID-liveness supervision, restart backoff/cap, clean-shutdown-vs-crash detection, launch-at-login via tauri-plugin-autostart) and the generic save/load/clear-pending-work primitive are built and unit-tested. The packaging gap is now resolved: the watchdog lives in its own standalone crate (`apps/desktop/watchdog`, not a second `[[bin]]` under src-tauri's own Cargo.toml) built via a dedicated prebuild step in release.yml (compile, rename to the `<name>-<target-triple>` convention, drop into `binaries/`, *then* `tauri build`). The first attempt kept it as a same-package `[[bin]]` — that compiles fine, but a real `tauri build` surfaced a genuine WiX failure (ICE30: two Components both installing `mezbaan-watchdog.exe`, because Tauri's Windows bundler auto-bundles every `[[bin]]` of the app's own package *in addition to* the configured `externalBin` sidecar copy of the same binary). Moving it to an unrelated crate fixed it; verified locally with a full `tauri build` (throwaway signing key) producing both `mezbaan-desktop_0.1.0_x64_en-US.msi` and the NSIS `-setup.exe`, each with exactly one watchdog Component in the generated `main.wxs`. See `apps/desktop/src-tauri/binaries/PLACEHOLDER.md` for the full story.
- [x] **P1-23** Add remote per-module feature flags per restaurant. A `feature_flags` table (restaurant_id + module_key, RLS: any tenant member can read their own restaurant's rows, only a super-admin session can write) backs three endpoints in `api-admin`: `GET /feature-flags` (self, any authenticated member), `GET /restaurants/:id/feature-flags` and `PUT /restaurants/:id/feature-flags/:moduleKey` (cross-restaurant, super-admin only — an incident-response kill switch per section 5, not a restaurant self-service setting, so Owner gets no say over it even for their own restaurant). Module keys are free text (Zod-validated lowercase snake_case), not a closed DB enum, since Phases 2-4 will keep adding modules; absence of a row means "enabled." Fully tested at all three layers (service, RLS, HTTP tenant-isolation e2e) per section 8. Along the way, fixed a real gap in `TenantContextGuard`: it rejected *any* restaurantId a super-admin token ever named (its own restaurantId claim is null, so everything "conflicted") — the first precedent in this repo for a super-admin route targeting another tenant by id, so nothing had hit this before. Deliberately doesn't include a management UI (Super Admin screens are P3-39's job, not this task's) or a desktop/POS consumer (there's no sync/API client on that side yet — P1-24 through P1-26 are still unchecked) — both are natural follow-ons once those exist, not missing pieces of this task.

**Sync and outbox**
- [x] **P1-24** Build the local operation log, with each write and its operation saved in one transaction. Lives in the Tauri shell (`apps/desktop/src-tauri/src/operation_log.rs`), same as P1-19/P1-22 — `packages/local-db` is still just the placeholder stub it's always been; the real local SQLite layer has consistently ended up in Rust, not that TS package. An `operation_log` table (id = client-generated UUIDv7, UNIQUE idempotency_key, operation_type, payload, synced_at reserved for P1-25) plus `record_once()`: one transaction that checks the idempotency key, runs the caller's actual write, and appends the log row — so a write and its log entry always commit or roll back together (rule 8), and retrying with the same idempotency key reruns nothing and creates no duplicate (rule 9). Generic by design, same as P1-22's pending-work primitive before it: there's no real business write to call it from yet (orders/cart are Phase 2), so it's exercised here with a synthetic write against a throwaway table. `list_unsynced()` is the minimal read-back P1-25's sync client is expected to build on; nothing here marks a row synced — that bookkeeping is P1-25's to design.
- [x] **P1-25** Build the sync client: batching, ordering, retry with backoff, and resume after a crash. `apps/desktop/src-tauri/src/sync_client.rs`: `run_sync_cycle()` batches every unsynced `operation_log` row (P1-24) in order, sends each batch through a `SyncTransport` trait (retrying with exponential backoff on failure, capped attempts), and marks accepted operations synced via `operation_log::mark_synced()`. "Resume after a crash" needs no special handling — nothing is marked synced until acknowledged, so a crash mid-cycle just leaves those rows for the next run to pick up again, proven by a test that fails a cycle on purpose and confirms a later one recovers the same operation. `ReqwestSyncTransport` is the real implementation; tests run against an in-memory mock so they don't need a live server (P1-26 doesn't exist yet). Local compile got stuck behind an environment-specific problem (reqwest as a new direct dependency triggered a from-source OpenSSL rebuild that hit Cygwin's perl shadowing Strawberry Perl on PATH, a Windows+git-bash dev-machine issue, not a code one) — verified clean on CI's Ubuntu runner instead (all 3 jobs green on commit 395345d).
- [x] **P1-26** Build the server sync endpoint with idempotency, validation and a per-operation result. `POST /sync/operations` in `api-pos`, device-token authenticated like `/devices/me` (`DeviceAuthGuard`) — tenant comes from the device record, not a user JWT, since a background sync cycle has no logged-in session. A `sync_operations` table (id = client UUIDv7 as primary key, UNIQUE per-restaurant idempotency_key) backs it: one bulk insert per batch with `ON CONFLICT (restaurant_id, idempotency_key) DO NOTHING`, so a retried batch (rule 9) upserts nothing new and every operation still comes back `"accepted"`, whether new or already recorded — verified with both a changed-id and an exact-same-id-and-key retry. `payload` is stored as the same JSON-encoded string the client sends (matches the Rust client's wire format, `apps/desktop/src-tauri/src/sync_client.rs`), not parsed — nothing interprets `operation_type`-specific contents yet (Phase 2). Tested at all three layers (service, RLS, HTTP e2e with real device pairing). One real bug caught along the way: `SyncModule` didn't list `DeviceService`/`AuditLogService`/`DeviceAuthGuard` as providers, so Nest's DI container couldn't resolve the guard — crashed the whole app at boot (not a catchable test failure) until fixed, same provider list `DevicesTerminalModule` already needed for the same reason.
- [x] **P1-27** Build downstream sync for menu, prices, staff and settings with versioned, signed snapshots, including each manager's PIN hash so approvals in P1-13 work offline. `GET /sync/snapshot` in `api-pos`, device-token authenticated like the upstream sync endpoint — returns `{ version, contentJson, signature }`, Ed25519-signed over `contentJson`'s exact bytes (never a re-serialization of the parsed object — Rust and JS JSON encoders don't promise the same key order, so the client must verify the literal string it received). `GET /sync/public-key` (no auth, it's a public key) lets ops fetch the verification key out of band to embed in the desktop build, rather than trusting a key delivered over the same channel it authenticates. Content is staff (id, displayName, email, roleKey, branchId, status, and `pinHash` — null until that user has set a manager PIN) and branches, the closest thing to "settings" that exists today. **menu and prices aren't included** — no schema exists yet (Phase 2, P2-01/P2-04); the content shape is where that section gets added once they do. Tested at both layers (service + HTTP e2e, including a tenant-isolation case and a round-trip signature-verification case). The client side — fetching, storing, and actually verifying a snapshot offline — is P1-27b, not this task; don't check P1-13 off from this alone, it also needs P1-27b.
- [x] **P1-27b** Build offline manager-PIN verification: once P1-27 syncs the signed PIN-hash bundle, verify a manager's PIN against it locally with no server round-trip, and apply the same lockout rule as the online path. Depends on P1-19 (local SQLite) and P1-27. `apps/desktop/src-tauri/src/snapshot_sync.rs` fetches P1-27's snapshot and verifies its Ed25519 signature (pure-Rust `ed25519-dalek`, no OpenSSL) before anything downstream trusts it; `manager_pin_offline.rs` ingests the staff list wholesale (rule 11) and verifies a PIN with the exact same scrypt parameters and lockout thresholds (5 attempts, 15 min) as `packages/nest-core/src/manager-pin.service.ts`/`password.ts` — cross-checked against a real Node-generated hash, not just Rust round-tripping with itself, so a parameter mismatch couldn't silently pass. Lockout state is tracked locally (own counter, since there's nothing to ask the server while offline), separate from the server's. Doesn't include a Tauri command wiring this into an actual "approve this action" UI flow — same reason P1-22 left pending-work unwired: there's no real sensitive-action UI to trigger it from yet (Phase 2's POS terminal, P2-11 onward, is still unchecked). That's also why P1-13 stays unchecked below even though both its offline-half dependencies are now done.
- [x] **P1-28** Build per-terminal document number series. Format is `B{branch_number}-T{terminal_number}-{sequence:06}` — a two-part collision guarantee: `branch_number`/`terminal_number` are server-assigned once (at branch creation / device pairing), sequential and UNIQUE (`branches`/`devices` each got a new column + a DB trigger that auto-assigns the next one and a UNIQUE index as the real enforcement, not just the trigger's usual-case behavior — a genuine concurrent-create race fails outright rather than silently duplicating a number), so two terminals can never share a prefix; the trailing sequence (`apps/desktop/src-tauri/src/document_number.rs`) is a purely local SQLite counter needing no server round-trip, never reused or reset. Neither half needs to know what the other is doing, which is what actually makes two offline terminals unable to collide (rule 10). The trigger (not application code) assigns the number so every insert path — the real services and every existing test fixture — gets a correct number automatically; `BranchRecord`/`DeviceRecord` and their Zod schemas now carry the new fields. Doesn't wire `next_document_number()` into an actual invoice/receipt flow — nothing to wire into yet (Phase 2's P2-18 is that consumer).
- [x] **P1-29** Add a sync status indicator showing online state, pending count and last successful sync. `sync_status.rs` stores last-successful-sync-at and last-attempt-online in `app_metadata` (P1-19's key-value store) and reads pending count from `operation_log` (P1-24); `sync_client.rs`'s `run_sync_cycle` records every attempt. Exposed via `get_sync_status` and polled every 15s by `SyncStatusIndicator.tsx`, wired into both the POS and kitchen windows.
- [x] **P1-30** Build the PostgreSQL outbox table and a worker that processes it with no broker. `outbox` table (`packages/db/src/schema/outbox.ts`, RLS tenant-isolated like every other tenant table) plus two halves in `packages/nest-core`: `OutboxService.record(entry, tx?)` for any api-* process to write a row inside its own business transaction (same `tx?` convention as `AuditLogService.record`, satisfying section 5's "the outbox row is written in the same transaction as the business change"), and `OutboxWorkerService` for `apps/worker` to actually process it — polls directly (no Redpanda/BullMQ, per this task's literal "no broker"), claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED` under a super-admin tenant context (safe for the "at least two instances" rule in section 5 — two worker processes polling at once can't double-claim a row), and retries a failed handler with capped exponential backoff before moving it to `dead_letter` after 5 attempts (rule 15). Only `apps/worker`'s `AppModule` passes `autoStart: true`; every other process importing `OutboxModule` gets just the writer. Tested at the service/RLS/worker-unit layers (11 new nest-core tests across `outbox.service.test.ts` and `outbox-worker.service.test.ts`, plus 3 new `rls.test.ts` cases, including a super-admin cross-tenant-visibility case the worker itself depends on) and end-to-end by actually booting the worker against the local Postgres and watching it poll and retry real rows. **No real producer or handler exists yet** — every actual business event (orders, sales, stock) is Phase 2+ — so `apps/worker`'s `handlers` map is empty today; an event with no registered handler fails and dead-letters like any other handler error rather than being silently skipped (rule 16). `dead_letter` rows just sit in the same table with that status — no separate dead-letter view/alerting/requeue tooling exists, since nothing has produced one for real yet to justify designing that UI.
- [x] **P1-31** Add fault tests for lost connections, duplicates, crashes mid-sync and terminals offline for several days. Most of this exit-gate requirement was already covered incidentally by P1-24/25/26's own tests (retry-with-backoff, resume-after-crash, server-side idempotent retries). Added two targeted tests to close the real gaps: `sync_client.rs`'s `survives_a_lost_connection_partway_through_a_large_offline_backlog` combines a large multi-batch backlog ("offline for days"), a lost connection that exhausts retries mid-cycle ("crash mid-sync"), and a resumed cycle afterward — proving nothing already-synced is resent and nothing after the failure point is lost. `sync.service.test.ts`'s new concurrency test fires two identical-idempotency-key submissions with `Promise.all` (a genuine DB-level race, not sequential retries) to prove the unique constraint dedupes under real concurrency. Found and fixed one real issue along the way: my own earlier manual boot-test of the P1-30 worker had left real rows in the local dev Postgres `outbox` table, which broke an unrelated P1-30 test when it ran a cross-tenant claim — not a bug in the code, just dev-DB cleanup owed from the previous task.

**Performance**
- [x] **P1-32** Add `pg_stat_statements`, slow query logging and a performance dashboard. Postgres's Compose `command` sets `shared_preload_libraries=pg_stat_statements` and `log_min_duration_statement` (default 200ms, matching section 9's API-read target) — slow queries now land in `docker compose logs postgres`. `migrate.ts` runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` right after migrations. Dashboard is Grafana (approved stack), auto-provisioned from `infra/grafana/` — no manual setup: API p95 latency and request rate per service (from P1-04's existing `http_request_duration_seconds`), Postgres connections and cache-hit ratio, and the slowest statements from `pg_stat_statements` via a `postgres-exporter` custom query. Verified end-to-end against the real local stack: extension has 54 tracked statements, `postgres-exporter`'s `/metrics` exposes them, Grafana's `/api/health` is OK, and Prometheus actually scraped a briefly-started `api-pos` through `host.docker.internal` (confirms that resolves correctly on this Docker Desktop setup, the one part that couldn't be checked by reading config alone).
- [ ] **P1-33** Add N+1 query detection and query plan checks for critical queries in CI.
- [ ] **P1-34** Make Turborepo build caching work locally and in CI.
- [ ] **P1-35** Make sync send only changes, in compressed batches, with backoff and a random delay so terminals do not all reconnect at once.

**Exit gate:** sync passes all fault tests; tenant isolation tests cover every endpoint; killing any process leaves the others running.

---

### Phase 2: Complete offline POS

**Goal:** a cashier can run a full service, with or without internet, and no sale is ever lost.

**Catalog**
- [ ] **P2-01** Build categories and products with images, SKU, barcode and availability by branch.
- [ ] **P2-02** Build variants such as size, and modifier groups with required and optional rules and min/max choices.
- [ ] **P2-03** Build combos and deals with fixed and choice-based items.
- [ ] **P2-04** Build versioned price lists with branch, order type and time-based pricing.
- [ ] **P2-05** Build tax rules, tax-inclusive and tax-exclusive pricing, and service charge settings.
- [ ] **P2-06** Build out-of-stock (86) marking that syncs quickly to all terminals and kitchen screens.

**Tables and order types**
- [ ] **P2-07** Build floors, table layout, status colors, seat counts and QR code records.
- [ ] **P2-08** Add table transfer, merge and split.
- [ ] **P2-09** Support dine-in, takeaway and delivery orders, each with its own workflow.
- [ ] **P2-10** Add customer and address capture for delivery, plus rider assignment and delivery status.

**POS terminal**
- [ ] **P2-11** Build a fast touch-first POS screen with category grid, search, barcode scanning and keyboard shortcuts.
- [ ] **P2-12** Build the cart with quantities, modifiers, notes and seat or course assignment.
- [ ] **P2-13** Build order state machine and status history in `packages/domain`, rejecting illegal transitions.
- [ ] **P2-14** Add hold and recall of orders, and running tabs for dine-in tables.
- [ ] **P2-15** Add fire-to-kitchen by item or course, and tracking of what was already sent.
- [ ] **P2-16** Prevent two terminals from silently overwriting the same open order on the local network.
- [ ] **P2-17** Show clear offline, syncing and price-list-version status on the POS screen.

**Billing and payments**
- [ ] **P2-18** Generate invoices with per-terminal numbers, using only domain calculations and a price version.
- [ ] **P2-19** Add cash, card, bank transfer and wallet payment methods, configurable by restaurant, including tips.
- [ ] **P2-20** Add split payments across multiple methods, with exact change calculation.
- [ ] **P2-21** Add split bills by item, by seat, by amount and into equal parts.
- [ ] **P2-22** Add bill-level and item-level discounts with limits, reason codes and manager approval.
- [ ] **P2-23** Add voids before and after kitchen firing, with reason, approval and an audit record.
- [ ] **P2-24** Add full and partial refunds through compensating rows, with approval and audit.
- [ ] **P2-25** Add credit customers with an append-only account ledger, credit limits and repayments.
- [ ] **P2-26** Reconcile synced sales on the server: recalculate totals and send mismatches to a review queue.

**Cash and shifts**
- [ ] **P2-27** Build shift open and close, with opening float and counted cash by denomination.
- [ ] **P2-28** Add cash in and cash out with reason codes, plus cash drawer open logging.
- [ ] **P2-29** Add over/short calculation, X report (mid-shift) and Z report (end of shift).
- [ ] **P2-30** Add business-day close per branch, which blocks new sales on a closed day without losing offline sales.

**Printing and hardware**
- [ ] **P2-31** Build ESC/POS support for USB and network printers in the Rust layer, with timeouts.
- [ ] **P2-32** Build a persistent print queue with retry, failure alerts and reprint marked as a copy.
- [ ] **P2-33** Build configurable receipt templates with logo, tax details and footer.
- [ ] **P2-34** Add cash drawer control, and barcode scanner support as keyboard input.
- [ ] **P2-35** Add a printer test and setup screen that branch staff can use without developer help.

**Branch hub**
- [ ] **P2-36** Add hub mode to the desktop app: local WebSocket and HTTP server with paired devices only.
- [ ] **P2-37** Add automatic hub discovery on the local network, with manual IP as a fallback.
- [ ] **P2-38** Share orders, table status and kitchen tickets between devices through the hub while offline.
- [ ] **P2-39** Make terminals keep billing if the hub fails, and catch up when it returns.

**Basic reports for the pilot**
- [ ] **P2-40** Add a daily sales summary, payment breakdown and void, discount and refund reports.

**Performance**
- [ ] **P2-41** Index SQLite for POS searches, and use list virtualization for long menus and order lists.
- [ ] **P2-42** Load POS, kitchen and admin screens separately through code splitting.
- [ ] **P2-43** Cache versioned menus and prices in Redis, and clear the cache when a new version is published.
- [ ] **P2-44** Serve optimized images with WebP, resizing and long-lived caching through R2 and Cloudflare, with Brotli or gzip for web assets.
- [ ] **P2-45** Keep the desktop POS working from local data, with no network call in the sale path.
- [ ] **P2-46** Add cursor pagination to all large API lists.

**Exit gate:** a pilot branch runs full service, including an internet outage and a hub restart, with no lost or duplicated sales. Totals match between terminals and server.

---

### Phase 3: Kitchen, complete core inventory and platform billing

**Goal:** kitchen flow, accurate stock and food cost, and platform revenue.

**Kitchen**
- [ ] **P3-01** Build kitchen stations and routing rules by product and category.
- [ ] **P3-02** Build kitchen tickets with no money fields, including add-ons, voids and rush flags.
- [ ] **P3-03** Build the kitchen display: queue, timers, bump, recall and order-ready status.
- [ ] **P3-04** Add kitchen printer support, with fallback from display to printer and back.
- [ ] **P3-05** Make the kitchen flow work offline through the hub.
- [ ] **P3-06** Add preparation time reports by station and product.

**Inventory items and ledger**
- [ ] **P3-07** Build inventory items, categories, SKU, barcode and storage locations (such as store and kitchen).
- [ ] **P3-08** Build units and conversions, such as purchase in cartons, store in kg and use in grams.
- [ ] **P3-09** Build the append-only stock ledger with movement types: purchase, sale, return, wastage, adjustment, count, production and transfer.
- [ ] **P3-10** Build branch and location stock levels derived from the ledger, with a rebuild tool to verify them.
- [ ] **P3-11** Add weighted average costing, with the unit cost snapshotted on each movement.
- [ ] **P3-12** Add negative stock flags and a review screen for offline sales.

**Recipes and production**
- [ ] **P3-13** Build recipes per product and variant, with quantities, units and yield percentage.
- [ ] **P3-14** Add recipe rules for modifiers, such as extra cheese adding ingredients.
- [ ] **P3-15** Add sub-recipes and semi-finished items, such as sauces and marinated meat.
- [ ] **P3-16** Add production batches that consume ingredients and add finished stock.
- [ ] **P3-17** Auto-deduct stock from synced sales through idempotent outbox processing.
- [ ] **P3-18** Handle voids and refunds: a choice of return to stock or record as wastage, with a reason.
- [ ] **P3-19** Snapshot the recipe version and cost on each sale for accurate food cost history.

**Purchasing and suppliers**
- [ ] **P3-20** Build supplier records, the items each supplies, and price history.
- [ ] **P3-21** Build purchase orders with draft, approval, sent, partly received and closed states.
- [ ] **P3-22** Build goods received notes with partial delivery, price differences and rejected items.
- [ ] **P3-23** Build supplier invoices and three-way matching across order, receipt and invoice.
- [ ] **P3-24** Build purchase returns through compensating stock movements.
- [ ] **P3-25** Build an append-only supplier ledger with payments and outstanding balances.

**Stock control**
- [ ] **P3-26** Build full and cycle stock counts, with blind count entry and offline support.
- [ ] **P3-27** Add variance review and approval before stock is adjusted.
- [ ] **P3-28** Add wastage entry with reason codes and approval limits.
- [ ] **P3-29** Add minimum and par levels with low-stock alerts on the dashboard.
- [ ] **P3-30** Add an inventory audit trail showing the full history behind any stock number.

**Inventory reports**
- [ ] **P3-31** Add stock on hand, stock valuation and stock movement reports.
- [ ] **P3-32** Add theoretical versus actual food cost and variance reports.
- [ ] **P3-33** Add wastage, purchase and supplier reports.

**Platform billing and admin**
- [ ] **P3-34** Build commission entries from paid invoices, with the rate snapshotted and idempotent processing.
- [ ] **P3-35** Add commission reversals when a refund occurs.
- [ ] **P3-36** Add the hybrid fixed + commission plan and configurable billing cycles.
- [ ] **P3-37** Build `CommissionRun` with idempotent runs and a nightly settlement job.
- [ ] **P3-38** Build settlement statements and payment recording.
- [ ] **P3-39** Build Super Admin: restaurant list, status, plans, devices, platform revenue and support tools.
- [ ] **P3-40** Add full audit logging and a clear visible notice whenever Super Admin acts on a restaurant's data.

**Performance**
- [ ] **P3-41** Add database indexes based on real inventory and report queries, and remove unused ones.
- [ ] **P3-42** Use set-based batch processing for stock deductions and commission runs, while keeping them idempotent.
- [ ] **P3-43** Run heavy reports and exports through background jobs with separate BullMQ queues and concurrency limits, so they cannot slow down sales.

**Exit gate:** stock movements reconcile with real sales in the pilot; a ledger rebuild matches stored stock levels; commission matches invoices and refunds; the kitchen works through an internet outage.

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
