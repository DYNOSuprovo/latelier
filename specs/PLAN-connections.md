# Implementation plan — Connections (C01 → C08)

> **Status: SHIPPED.** All seven steps merged. Indexes and Users tabs shipped as intentional stubs (per C08) at the end of this phase — they were later built out with real CRUD in post-iteration-1 specs [C09](./C09-indexes-tab.md) and [C10](./C10-users-tab.md); they are not stubs anymore. Open items resolved as built: route renamed to `/connections/new` + `/connections/:id/edit`; Aggregation folded into a Workspace tab kind in Phase A; `$collStats` fallback handled by `MetaService` (tested in `meta-service.spec.ts`); theme migration (X01) deferred and shipped in Phase W step 9; index-count heuristic kept as spec'd. C09 is itself amended by W16 Tier 1 (ADR 0003): the Indexes tab's DB/collection picker moved out of the component and into `DetailPanel.tsx`'s `IndexesHost`, and then W16 Tier 2 removed the Connection Manager's Indexes tab entirely — index management now lives in the collection tab's Structure sub-view.

Phase C builds on the finished foundation (F01→F06). It turns the mocked ConnectionManager + NewConnection pages into a real CRUD surface backed by SQLite + safeStorage + the live Mongo pool.

## Guiding principles

- **Backend before UI.** Channels, services, repos, and their integration tests land first. Component tests mock the bridge; E2E exercises end-to-end flow.
- **No more mock data imports.** By the end of phase C, `src/data.ts` is deleted; every connection/collection piece on screen comes from IPC. Workspace + Aggregation pages still read mocks — they're phase W/A's to remove.
- **Migrations stay append-only.** Step 1 adds migration `002-connections-unique-name.sql`; further schema changes go in higher-numbered files.
- **Theme bridge defers.** The existing `localStorage['ml-theme']` stays for now. X01 migration happens as a small trailing step (or can roll into phase W) so it doesn't block phase C. Flagged below.

## Prerequisites

- Foundation merged. `F01–F06` acceptance criteria demonstrably met.
- `npm test && npm run test:e2e` both green.
- `better-sqlite3` rebuilds are working via the scripts from Step 6.

## Open items to confirm before starting

1. **Route rename**: spec C03 moves NewConnection from `/new-connection` → `/connections/new` (plus `/connections/:id/edit`). Do you want me to land the rename or keep the legacy path? (Cleanest: land the rename — HashRouter + internal links; no external bookmarks to worry about.)
2. **Aggregation page**: A01 later folds `/aggregation` into a tab inside `/workspace`. Until then the existing route keeps working. Confirm this is OK — it means the `CmdKOverlay`'s "Open aggregation" action still navigates to the standalone route during phase C.
3. **`$collStats` fallback**: C07 spec already describes the fallback to `estimatedDocumentCount` + `indexes().length`. OK to rely on detecting `Unauthorized` or missing-priv errors?
4. **Theme migration timing**: land X01 at the end of phase C, or defer to phase W? (Recommendation: keep localStorage during phase C so nothing regresses, then do X01 as a standalone pass.)
5. **Index count heuristic**: spec C06 skips the per-collection index scan when `databaseCount > 50`. Good as-is?

Once those are confirmed I'll execute Step 1.

---

## Step 1 — Connection model + URI parser + validation (C01)

**Goal**: pure data layer — every piece of Connection type, Zod schema, and URI parsing that later steps depend on. No SQL, no IPC, no UI yet.

### Changes

1. `shared/types.ts` — expand with `ConnectionSummary`, `ConnectionUpdate` (foundation already has `Connection` and `ConnectionInput`; add the extras). Lock down enums with `as const` unions.
2. `shared/ipc.ts` — add the channel string constants for `conn:list|get|create|update|delete|touchUsed|parseUri|test`. No types yet for the IpcApi (that comes with step 2).
3. `electron/mongo/uri-parse.ts` — `parseConnectionUri(uri): Partial<ConnectionInput>` using `mongodb-connection-string-url` (already in the `mongodb` dep tree).
4. `electron/ipc/schemas/connection.ts` — Zod schemas:
   - `ConnectionInputSchema` with cross-field `superRefine` rules (SCRAM + username/password, X.509 + TLS, port range, timeouts, `maxPoolSize`, absolute paths, color regex, name length).
   - `ConnectionUpdateSchema` — partial input plus `clearPassword`/`clearSshPassword`/`clearSshPassphrase` booleans.
   - `ConnectionInputSchema.safeParseStrict` helper that returns structured `ValidationError` with the offending path.
5. `electron/mongo/normalize.ts` — the trim/collapse/lowercase rules from C01 §4. Applied before repo insert/update.

### Tests

- `tests/unit/uri-parser.spec.ts` — fixture-driven per C01 §7, including URL-encoded passwords, SRV, multi-host (take first), `tls=false`, `directConnection`, read preferences. Malformed URIs throw `ValidationError`.
- `tests/unit/connection-schema.spec.ts` — one test per cross-field rule. Each asserts the failing path is named in `details.issues`.
- `tests/unit/normalize.spec.ts` — trim/collapse/lowercase identities.

### Done when

- All unit tests green.
- `ConnectionInputSchema.parse(validInput)` round-trips.
- `parseConnectionUri` round-trip test: URI → partial input → rebuild URI via F05's `buildUri` → re-parse → structurally equal (minus presence-only differences).

**Effort**: ~0.5 day.

---

## Step 2 — ConnectionRepo + ConnectionService + `conn:*` channels (C02)

**Goal**: full server-side CRUD and IPC plumbing. Renderer-less; integration-tested via a mock IPC shim.

### Changes

1. Migration `electron/db/migrations/002-connections-unique-name.sql` — `CREATE UNIQUE INDEX uq_connections_name ON connections(name); UPDATE schema_version SET version = 2;`
2. `electron/db/repositories/ConnectionRepo.ts` — prepared statements for insert/update/delete/findById/findByName/list/touchLastUsed. Row ↔ object mappers.
3. `electron/mongo/ConnectionService.ts` — wraps repo + vault + pool. Implements `list / get / create / update / delete / touchUsed / status` per C02 §2. Per-id mutex (`Map<string, Promise<void>>`) around update/delete.
4. `electron/ipc/handlers/conn.ts` — registers all `conn:*` channels on the Router from F04, using schemas from Step 1. Annotates `conn:create`, `conn:update`, `conn:test` with `SECRET_INPUT` comments so `audit:ipc` checks them.
5. Wire the handler module into `electron/main.ts` — replace the demo probe channel registration with `registerConnChannels(router, connSvc)` plus retain a way to smoke-test the bridge (maybe keep `_:probe` one more step, then delete).
6. `shared/ipc.ts` — start populating `IpcApi.conn` methods (`list`, `get`, `create`, `update`, `delete`, `parseUri`, `touchUsed`). Preload wires them.

### Tests

- `tests/integration/connection-repo.spec.ts` — insert/update/delete; uniqueness constraint via 002 migration; `UNIQUE` violation translates to `ConflictError`.
- `tests/integration/connection-service.spec.ts`:
  - `create` happy path (ok validation, vault populated, row present).
  - `create` duplicate name → CONFLICT.
  - `create` SCRAM without password → VALIDATION.
  - `update` secret lifecycle (set/replace/clear).
  - `update` with Mongo-relevant field change triggers `pool.disconnect(id)` (spied).
  - `delete` cascades (FK from migration 001) + disconnects pool.
  - `list` order: `last_used_at DESC NULLS LAST, name ASC`.
- `tests/integration/conn-channels.spec.ts` — wire the real handlers to the in-memory `ipcMain` shim (reusing the pattern from Step 4's router test); exercise each channel end-to-end including envelope failure paths.

### Done when

- `scripts/audit-ipc.mjs` still passes with `conn:create`, `conn:update`, `conn:test` marked.
- Migration 002 applies cleanly on top of an existing 001-only DB.
- All integration tests green.

**Effort**: ~1 day.

---

## Step 3 — Test connection action (C04)

**Goal**: `conn:test` fully wired, including the 10-second budget and the "SSH not supported in iteration 1" short-circuit.

### Changes

1. `ConnectionService.test(input)` — implemented per C04 §2. Wraps `pool.probe` with a hard timeout.
2. Register `conn:test` on the router with `ConnectionInputSchema` but relaxed SCRAM-password-required rule (probe may test credentials that don't yet exist in the vault).
3. Add `withTimeout<T>(p, ms, fallback)` utility in `electron/utils/withTimeout.ts` (pure unit-testable).

### Tests

- `tests/unit/withTimeout.spec.ts` — resolves before timeout; returns fallback after timeout; cleans up pending work.
- `tests/integration/conn-test.spec.ts` (against `mongodb-memory-server`):
  - happy path → `ok: true`.
  - wrong password → `AUTH`.
  - unreachable host → `NETWORK` or `TIMEOUT` (accept either).
  - explicit SSH enabled → refusal message, no network call.
  - No row in `connections` / `connection_secrets` after test.

### Done when

- Channel returns within 10s worst case on a bad host.
- Probe never leaks a MongoClient.

**Effort**: ~0.5 day.

---

## Step 4 — ConnectionManager shell + list sidebar (C05)

**Goal**: real `/connections` page backed by `conn:list` and `mongo:status` push updates. Empty state, filter, keyboard nav, just-created pulse.

### Changes

1. `src/api/mongolab.ts` — expand the typed wrapper to cover `conn.*` methods added in step 2. Provide an `unwrap` helper that throws `IpcError`.
2. `src/state/connections.ts` — React hook `useConnections()` — on mount calls `api.conn.list`, listens for `api.mongo.onStatus` (preload exposes a subscription stub — add this now with a noop on backend until C06 step registers the real event emitter forwarding).
3. `src/pages/ConnectionManager.tsx` — rewrite the sidebar + title bar to use the hook. Remove imports from `src/data.ts`. Empty state + "Create first connection" CTA.
4. `src/pages/ConnectionManager.tsx` — filter by name/host substring, `⌘F` to focus, `↑/↓` keyboard nav, row context menu (Edit / Duplicate-stub / Delete).
5. Update `src/App.tsx` — add routes `/connections/:id`, `/connections/new`, `/connections/:id/edit`; redirect `/new-connection` → `/connections/new` for continuity.
6. Detail panel stays largely empty for this step (wired in steps 5–6). Show a "Select a connection" placeholder.

### Tests

- `tests/component/conn-list.spec.tsx` — render list; filter narrows; selecting updates URL; empty state shows CTA; just-created pulse.
- `tests/component/conn-keyboard.spec.tsx` — `↑/↓` moves selection; `⌘F` focuses filter; `⌘N` navigates.
- No E2E added yet — the page isn't functional enough until step 5.

### Done when

- Launching Electron with an empty DB shows the empty state + CTA.
- Creating a connection (manually via IPC or shell) and reloading shows the row.
- `src/data.ts` no longer imported by `ConnectionManager.tsx`.

**Effort**: ~1 day.

---

## Step 5 — NewConnection page wired end-to-end (C03 + C04 UI)

**Goal**: real create + edit + test flow. URI paste works. File pickers work. Dirty guard works.

### Changes

1. IPC: add `app:pickFile({ purpose })` → returns path | null. Allow-list of purposes (`tls-ca`, `tls-client-cert`, `ssh-key`) determines the file-dialog filter.
2. `src/pages/NewConnection.tsx`:
   - Route-driven mode (`create` vs `edit`). Load via `api.conn.get(id)` in edit mode.
   - All five tabs wired to real state. URI paste calls `api.conn.parseUri`.
   - Test button → `api.conn.test`, spinner/ok/fail pill mapping per C03 §10.
   - Save → `api.conn.create` / `api.conn.update`; on VALIDATION, map `error.details.issues` to `fieldErrors` keyed by path. On CONFLICT → banner. On SECRETS_UNAVAILABLE → banner.
   - Dirty guard via `useBeforeUnload`-style react-router `useBlocker`.
   - Edit-mode password UX: placeholder "Stored — enter new to replace"; "Remove stored password" sets `clearPassword: true`.
3. Route: `/connections/:id/edit`.

### Tests

- `tests/component/new-connection-render.spec.tsx` — fresh form, required fields.
- `tests/component/new-connection-paste-uri.spec.tsx` — mock `parseUri`; fields populated; dropped-params toast visible.
- `tests/component/new-connection-validation.spec.tsx` — SCRAM without password → inline error on Auth tab.
- `tests/component/new-connection-save.spec.tsx` — happy path; CONFLICT banner; SECRETS_UNAVAILABLE banner.
- `tests/component/new-connection-edit-mode.spec.tsx` — loads from `conn.get`; placeholder for stored password; "Remove stored" sets `clearPassword`.
- `tests/e2e/create-conn.e2e.ts` — full flow from empty DB → open NewConnection → fill form against memory Mongo → Test shows OK → Save → lands on list with new connection highlighted. Assert DB row + secret row present.

### Done when

- E2E covers empty → create → list.
- URI paste roundtrips.
- `src/data.ts` no longer imported by `NewConnection.tsx`.

**Effort**: ~1–1.5 days.

---

## Step 6 — Detail area: Overview + Collections tabs + stubs (C06 + C07 + C08 partial)

**Goal**: selecting a connection loads real Overview stats and a real Collections listing. Stub Indexes/Users tabs render placeholder cards.

### Changes

1. `mongo:serverInfo`, `mongo:ping`, `mongo:connect`, `mongo:disconnect`, `mongo:status` handlers wired to F05's `MongoPool` (schema already defined there).
2. `mongo:onStatus` push from main via an event bridge: main emits `mongo:status` event with `ConnectionRuntime`; preload exposes `onStatus(cb)` → unsubscribe function.
3. `meta:listDatabases` + `meta:listCollections` in `electron/ipc/handlers/meta.ts` using `MongoPool.getClient` + `admin.listDatabases` + per-db `$collStats` with `estimatedDocumentCount` fallback.
4. `src/pages/ConnectionManager.tsx` — `DetailPanel` implementation:
   - Tab bar with Overview | Collections | Indexes | Users.
   - Overview: three cards powered by `api.mongo.serverInfo`; skeleton loading; disconnected/Connect; refresh button; 15-second interval tied to `document.visibilityState`; stale-pill on refresh failure.
   - Collections: two-phase load (DBs then per-db collections), virtualized beyond 200 rows, filter, system-DB toggle (persisted via `api.prefs.get/set` — add minimal `prefs:*` channels now even if full X01 migration comes later).
   - Indexes + Users: static placeholder card per C08 §2 with an external-link helper (add `app:openExternal` IPC with `https:`-only guard).
5. CmdK stub per C08 §3 — overlay with actions + top-10 connections; no collections search yet.

### Tests

- `tests/integration/meta-service.spec.ts` — seeded memory Mongo: 2 DBs × 3 colls, default excludes admin/local/config, toggling `showSystemDbs` includes them; `$collStats` returns counts/sizes; stubbed Unauthorized → fallback count path. (Was spec'd as `meta-handlers.spec.ts`; that file drove the raw driver through the pool and never reached `MetaService`, duplicating two of these cases vacuously and covering the fallback not at all. Deleted, and the fallback case written here, where the other three already lived.)
- `tests/integration/mongo-handlers.spec.ts` — `mongo:serverInfo` round-trip; `onStatus` event delivered on connect/disconnect.
- `tests/component/overview.spec.tsx` — skeleton; disconnected Connect; refresh stops when hidden; stale pill.
- `tests/component/collections.spec.tsx` — list grouped by DB when >1, virtualized beyond 200, filter.
- `tests/component/cmdk-stub.spec.tsx` — `⌘K` toggles; Esc closes; "New connection" action navigates.
- `tests/e2e/detail-area.e2e.ts` — create conn → Overview populates with real version/db count → Collections lists seeded collections → click row navigates (link to workspace stub, A01 fills it later).

### Done when

- All tests pass.
- `src/data.ts` is deleted (or becomes empty — we can physically remove it since only ConnectionManager/NewConnection relied on it for phase C scope). Workspace + Aggregation still import mocks but from their own local fallbacks; those go away in phase W/A.

**Effort**: ~1.5 days.

---

## Step 7 — Edit, Delete, CmdK wrap-up, polish (C08 completion)

**Goal**: finish the remaining detail-header actions and polish.

### Changes

1. Edit button in detail header → `navigate('/connections/:id/edit')`.
2. Delete confirm dialog (per C05 §9) wired to `api.conn.delete`. Success updates list + adjusts selection; `NOT_FOUND` silently refreshes.
3. `Open workspace` button: add minimal `tabs:openDefault({connectionId})` stub that just records `touchUsed` and navigates (full W01 `workspace_tabs` semantics ship in phase W).
4. `app:openExternal` finalized with `https:`-only guard; `tests/integration/open-external.spec.ts`.
5. Context menu on list rows (Edit / Duplicate-stub / Delete).
6. Cleanup pass: remove the `_:probe` demo channel and its tests (foundation is verified; we have real channels now). Remove `src/data.ts`. Verify `scripts/audit-ipc.mjs` allow-list is still accurate (`conn:create`, `conn:update`, `conn:test` only).

### Tests

- `tests/component/edit-delete.spec.tsx` — Edit navigates; Delete confirm → `api.conn.delete`; cancel leaves state.
- `tests/integration/open-external.spec.ts` — `file://` → VALIDATION; `https://` → `shell.openExternal` called.
- `tests/e2e/delete-flow.e2e.ts` — create → delete → list empty again.

### Done when

- Phase C acceptance criteria from C01–C08 all check.
- No mock-data imports remain in `src/pages/ConnectionManager.tsx` / `src/pages/NewConnection.tsx`.
- `_:probe` channel and its tests removed.

**Effort**: ~0.5–1 day.

---

## Total phase C effort

~5–6 engineer-days including tests. At the end:

- A user can create, test, list, inspect, edit, and delete connections backed by real SQLite + safeStorage.
- Overview + Collections show live Mongo data.
- The app no longer depends on `src/data.ts` for connection / collection / saved-query mocks (Workspace + Aggregation still do until phase W/A).
- Phase W can start assuming a connection exists.

## Commit layout

One commit per step:

1. `feat(c): connection model, URI parser, Zod validation`
2. `feat(c): ConnectionRepo + Service + conn:* channels + migration 002`
3. `feat(c): conn:test action with timeout budget`
4. `feat(c): ConnectionManager shell + list sidebar (real data)`
5. `feat(c): NewConnection create/edit/test wired end-to-end`
6. `feat(c): detail Overview + Collections + CmdK stub + meta:* channels`
7. `feat(c): edit/delete actions, cleanup, drop _:probe`

## Risks and mitigations

- **`$collStats` unavailable on Atlas free tiers**: handled via fallback path in meta handler; tested explicitly.
- **`mongo:status` event bridge**: push-style IPC; pattern already sketched in F04 §6. Make sure the preload wrapper returns a working unsubscribe function (test covers it).
- **`useBlocker` behavior**: react-router v7 `useBlocker` handles this; no heavy lifting needed.
- **Test-ABI flip**: every step keeps passing `npm test` + `npm run test:e2e`; `pretest:e2e` already re-flips.

## When you're ready

Just say go and I'll start with Step 1. If any of the five open items at the top change my approach, flag them first.
