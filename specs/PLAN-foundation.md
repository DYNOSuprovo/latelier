# Implementation plan — Foundation (F01 → F06)

> **Status: SHIPPED.** All six steps merged. Kept as historical reference for the build order, the test scaffolding decisions, and the commit layout. The `_:probe` demo channel referenced in Step 4 was removed in Phase C step 7.

Concrete, ordered build plan for the foundation layer. Each step is a self-contained chunk that can be committed independently and leaves the app in a runnable state. Estimated effort is per-developer working time, not calendar time.

## Guiding principles

- **Vertical slices over horizontal layers.** Each step ends with something you can run (`npm run dev`) or test (`npm test`).
- **Tests land with the code they prove.** No "tests in a follow-up". Integration tests for each repo/service gate the step.
- **No placeholder renderer work.** Foundation steps shouldn't change `src/` beyond removing mock data imports. UI wiring is saved for phase C.
- **Migrations are append-only from step 2 onwards.** Once committed, a migration file is never edited.

## Prerequisites (verify before starting)

- Node 20+ installed.
- `npm install` works against current `package.json`.
- `npm run electron:dev` launches the existing mock UI.
- Python + make + build tools available on the dev machine (for `better-sqlite3` native build).

---

## Step 1 — Project scaffolding & dependencies (F01)

**Goal**: project layout, build pipeline, lint/test config, typecheck passes with new tsconfig layout.

### Changes

1. Add deps:
   ```bash
   npm i better-sqlite3 mongodb bson zod
   npm i -D @types/better-sqlite3 vitest @testing-library/react @testing-library/user-event jsdom playwright @playwright/test mongodb-memory-server @types/bson
   ```
2. Postinstall script for Electron-native-module rebuild:
   ```json
   // package.json
   "scripts": {
     "postinstall": "electron-builder install-app-deps",
     "test:unit":        "vitest run tests/unit",
     "test:integration": "vitest run tests/integration",
     "test:component":   "vitest run tests/component",
     "test":             "vitest run tests/unit tests/integration tests/component",
     "test:e2e":         "playwright test"
   }
   ```
3. Create directory skeleton (empty `.gitkeep` files where needed):
   ```
   electron/{ipc,db/{migrations,repositories},secrets,mongo,services}/
   shared/
   tests/{unit,integration,component,e2e,helpers}/
   ```
4. `shared/types.ts`, `shared/ipc.ts` — empty stubs exporting `export {}`.
5. TypeScript projects:
   - `tsconfig.json` — root references.
   - `tsconfig.app.json` — renderer; add path aliases `@shared/*`, `@/*`.
   - `tsconfig.electron.json` — main; `module: NodeNext`, `moduleResolution: NodeNext`, `noEmit: true`, includes `electron/**`, `shared/**`.
   - All with `strict: true`.
6. Vite aliases in `vite.config.ts` for `@shared` and `@`.
7. Vitest configs:
   - `vitest.config.ts` (default — unit/integration).
   - `vitest.component.config.ts` with `environment: 'jsdom'` + jsdom setup.
8. Playwright config `playwright.config.ts` pointing at `tests/e2e`, with Electron launch helper in `tests/helpers/launchApp.ts` (skeleton; real launch arrives in step 6).
9. Lint update:
   - Disable `no-console` on `electron/**` if using console; prefer our `log` module.
   - Add boundary rule via ESLint's `no-restricted-imports`: renderer files in `src/**` cannot import from `electron/**` or `mongodb`, `better-sqlite3`, `ssh2`, `fs`, `path`, `os`.
10. `electron-builder.yml`:
    ```yaml
    asar: true
    asarUnpack:
      - "**/better-sqlite3/**"
    ```
11. `log.ts` (main): thin wrapper over `console.*` + file sink at `userData/logs/mongolab.log`. Daily rotation via simple date-stamped filenames; retention cleanup on startup (delete files older than 7 days).

### Tests

- `tests/unit/boundary.spec.ts`: programmatic `eslint --no-eslintrc` against `src/main.tsx` adding a forbidden import — expect failure. Keeps the boundary rule honest.
- `tests/unit/log.spec.ts`: `log.info('tag','msg')` writes to a tmp file passed in config.

### Done when

- `npm run build` succeeds.
- `npm test` runs (likely zero tests for now).
- `npm run electron:dev` still launches the current mock UI unchanged.
- `tsc -b` green.

Effort: ~0.5 day.

---

## Step 2 — SQLite bootstrap + migration 001 (F02)

**Goal**: DB opens at `userData/mongolab.db`, migrations run, all tables present.

### Changes

1. `electron/db/sqlite.ts`:
   - `openDatabase(userDataDir)` — creates file, applies pragmas (WAL, synchronous NORMAL, foreign_keys ON, busy_timeout 5000, secure_delete ON), runs migrations.
   - `withTransaction<T>(db, fn)` helper.
   - `closeDatabase(db)`.
2. `electron/db/migrations/001-init.sql` — the full schema from F02 §3.
3. `electron/db/migrationRunner.ts`:
   - Reads `schema_version`, applies newer files in txn, updates version.
   - Files loaded at build time via `import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default' })` so packaged builds work.
4. Wire boot of DB into `electron/main.ts`: open DB before `createWindow`; show error dialog on failure; stash the `db` on a module-scope singleton for subsequent steps.
5. Add `AppStateRepo` (minimal — just `get`/`set`/`delete` on `app_state`) — used soon by F06's window bounds.

### Tests (integration, against tmp files)

- `tests/integration/sqlite-bootstrap.spec.ts` — open, pragmas active, close, reopen, tables intact.
- `tests/integration/migration-runner.spec.ts`:
  - Empty DB → version 1 after apply.
  - Idempotent second run.
  - Failing migration rolls back + leaves version unchanged.
- `tests/integration/cascade.spec.ts` — seed rows manually; delete a connection; assert dependents gone (this will exercise tables referenced by later steps but not needed for compilation).
- `tests/helpers/db.ts` — factory that creates a temp-file DB + returns cleanup.

### Done when

- `npm run electron:dev` creates `~/Library/Application Support/mongo-lab/mongolab.db` on first launch.
- Deleting the file and relaunching recreates it.
- Integration tests pass.

Effort: ~0.5–1 day.

---

## Step 3 — Secrets vault (F03)

**Goal**: `SecretsVault` wraps `safeStorage`, stores encrypted blobs in `connection_secrets`.

### Changes

1. `electron/secrets/SecretsVault.ts` — full API (set / get / has / delete / deleteAll / assertAvailable), as in F03 §2.
2. `electron/errors.ts` — `AppError`, `ValidationError`, `NotFoundError`, `ConflictError`, `SystemError`. Used across the codebase from here onwards.
3. `tests/helpers/safeStorageMock.ts` — per F03 §6.
4. Inject the mock into integration tests via Node's module resolution (e.g., vitest `resolve.alias` for the `'electron'` import in test runs).

### Tests

- `tests/integration/secrets-vault.spec.ts`:
  - set/get round-trip
  - overwrite
  - delete + has
  - deleteAll
  - decrypt failure → `SECRET_DECRYPT_FAILED`
  - unavailable → `SECRETS_UNAVAILABLE`
  - cascaded delete from parent connection row

### Done when

- Integration tests pass.
- Opening `mongolab.db` in a third-party SQLite viewer shows opaque binary for `connection_secrets.ciphertext` after a seeded test run (manual spot-check ok).

Effort: ~0.5 day.

---

## Step 4 — IPC bridge scaffolding (F04)

**Goal**: `register(channel, schema, handler)` helper, envelope shape, preload exposes typed `window.mongolab` with **zero domain channels** for now (added by later phases). One demo channel proves the plumbing.

### Changes

1. `shared/ipc.ts` — `Envelope<T>`, `IpcError`, `IpcErrorCode` exact from F04 §1.
2. `electron/ipc/envelope.ts` — `toIpcError(err)`, `success(data)`, `failure(code, message, details?)`.
3. `electron/ipc/router.ts` — `register` helper; also a `createRouter(ipcMain)` factory for test injection.
4. `electron/ipc/validators.ts` — shared Zod utilities (UUID, ISO date, port). No domain schemas yet.
5. `electron/preload.ts` — rewrite to expose `contextBridge.exposeInMainWorld('mongolab', { app: {...}, __probe: (x) => invoke('_:probe', x) })` where `_:probe` is a demo channel that just echoes validated input. Mark with a comment "TODO remove when real channels are added".
6. `src/api/mongolab.ts` — typed client wrapper with `unwrap(env)`; autogenerate types from `@shared/ipc`'s `IpcApi` (stubbed minimal for now).
7. CI grep hook: `npm run audit:ipc` — shell script that greps `SECRET_INPUT` in `electron/` and fails if channels outside an allow-list use it. Allow-list lives at `scripts/ipc-secret-allowlist.txt`; empty in this step.
8. Enforce window security options (verify/update `main.ts`): `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `sandbox: true`, plus the CSP, navigation and sender guards in [X17](./X17-renderer-hardening.md).

### Tests

- `tests/unit/envelope.spec.ts` — toIpcError mapping for each error subclass.
- `tests/integration/router-dispatch.spec.ts` — register + invoke a demo channel via a lightweight `ipcMain` shim (or electron's test harness). Asserts:
  - success shape
  - validation failure shape
  - thrown domain error → correct code
  - internal error preserves message but not stack.
- `tests/e2e/no-leakage.e2e.ts` — launch electron with Playwright, evaluate `Object.keys(window)` → does not include `ipcRenderer`, `require`, `process`. First real Playwright test; requires §9 of step 1 to actually launch the app.

### Done when

- Calling `window.mongolab.__probe({x:1})` from the renderer DevTools returns `{ok:true, data:{x:1}}`.
- `npm run audit:ipc` passes (empty allow-list, zero matches).
- E2E no-leakage test passes.

Effort: ~0.5–1 day.

---

## Step 5 — Mongo client pool (F05)

**Goal**: `MongoPool` + URI builder + error classifier. No connections yet — this is infrastructure. Exercise via integration tests against `mongodb-memory-server`.

### Changes

1. `electron/mongo/uri.ts` — `buildUri(c, password)` + `buildOptions(c)` pure functions.
2. `electron/mongo/errors.ts` — `classifyMongoError(err)` (the F05 §6 table).
3. `electron/mongo/MongoPool.ts` — full API per F05 §2. Uses `connRepo` for config lookup and `vault` for password decrypt. `probe(input)` is a standalone path that takes a transient input (used by C04 later).
4. `electron/mongo/ejson.ts` — `ejsonParse`, `ejsonEncode`, `ejsonEncodeArray` wrappers around the `bson` package's EJSON module.
5. `tests/helpers/mongo.ts` — spins up/tears down a `mongodb-memory-server` instance; returns a `MongoClient` fixture + the URI for pool tests.
6. `tests/helpers/db.ts` update — helper to seed a `connections` row so `MongoPool.getClient` works in tests (the test doesn't need `ConnectionService`; it uses `ConnectionRepo` directly — but C02 is a later phase, so for these tests we'll insert with a minimal raw `INSERT` statement kept in `tests/helpers/seed.ts`).

### Tests

- `tests/unit/uri-builder.spec.ts` — fixtures from F05 §10 test list.
- `tests/unit/error-classifier.spec.ts` — fixture errors → codes.
- `tests/integration/mongo-pool.spec.ts`:
  - `getClient` twice concurrently → single construction (spy on `MongoClient` constructor).
  - Reconnect after initial-error.
  - `probe` happy path + wrong password (AUTH).
  - `ping` round-trip.
  - `serverInfo` shape smoke test.
  - `disconnectAll` respects a 5-second budget (hang a fake client close).

### Done when

- Integration tests pass.
- No `MongoPool` IPC channels are registered yet (they land when phase C wires them).

Effort: ~1 day.

---

## Step 6 — App lifecycle wiring (F06)

**Goal**: boot sequence as F06 §1 — DB → repos → vault → pool → services (placeholders) → IPC register (empty) → window. Shutdown as F06 §4. Single-instance lock. Window bounds persist.

### Changes

1. `electron/main.ts` rewrite:
   - Insert each step in F06's order.
   - Stub placeholder services for not-yet-built domains (`connSvc`, `querySvc`, etc.) so the call order is frozen; they're left as `null`/commented for later phases.
   - Only register a single demo IPC channel for now (from step 4). No domain channels.
2. Single-instance lock + `second-instance` handler → focus main window.
3. `createWindow(appStateSvc)`:
   - Reads `window.bounds` + `window.maximized` from `AppStateRepo`.
   - Multi-display safety: discard bounds if they don't overlap any live display.
   - `show: false` + `ready-to-show` → `show()`.
   - Binds `resize`, `move`, `maximize`, `unmaximize` events to debounced writes (400 ms).
4. Shutdown:
   - `before-quit`: 8-second budget race around pool disconnect + DB close.
5. Crash handling: renderer `render-process-gone` → reload once; second crash within 10 s → quit.
6. DevTools: open when `VITE_DEV_SERVER_URL` set.
7. Background color from current theme (read from `AppStateRepo` if present; default light).
8. `devReset` global shortcut (macOS `⌘⇧⌥R`): delete DB, re-migrate, reload. Dev-only — gated on **`!app.isPackaged`**, not `NODE_ENV`. Nothing in this build sets `NODE_ENV` and Electron does not set it for a packaged app, so a `NODE_ENV` test leaves this destructive shortcut bound in every shipped build.

### Tests

- `tests/integration/boot-order.spec.ts` — spin up `main.ts` with stubbed Electron `app`/`BrowserWindow`; assert services register in order and IPC handlers are in place before window creation.
- `tests/integration/single-instance.spec.ts` — second `requestSingleInstanceLock` → app quits.
- `tests/integration/shutdown-budget.spec.ts` — stub `pool.disconnectAll` to hang → total shutdown ≤ 8 s.
- `tests/e2e/first-run.e2e.ts` — delete tmp userData, launch, assert connections page renders, DB file exists.
- `tests/e2e/window-bounds.e2e.ts` — resize + close + relaunch → same bounds.

### Done when

- App cold-starts cleanly with a blank DB.
- Relaunching restores window bounds.
- Two launches in parallel → second quits; first gains focus.
- `npm test && npm run test:e2e` green.

Effort: ~1 day.

---

## Total foundation effort

~4–5 engineer-days including tests. Output: a running Electron app wired to SQLite + secrets + Mongo infrastructure + IPC plumbing, but with no domain features yet. The existing mock UI still renders because we haven't changed `src/`.

## Commit layout (one per step)

1. `feat(scaffold): tsconfig projects, tooling, deps, log`
2. `feat(db): sqlite bootstrap + migration 001`
3. `feat(secrets): safeStorage-backed vault`
4. `feat(ipc): envelope, router, preload contract`
5. `feat(mongo): client pool, URI builder, error classifier`
6. `feat(lifecycle): boot/shutdown wiring, window state`

After merging all six, the foundation acceptance criteria in F01 §8 through F06 §9 should be demonstrably met, and phase C (connections) can start on a stable base.

## Open items to confirm before starting

- **Log framework choice**: rolling your own over `console` is fine for iteration 1 (zero deps). If you'd prefer `pino` / `winston`, let me know before step 1.
- **electron-builder vs. electron-forge**: current `package.json` uses builder. Keep builder unless you want to migrate.
- **Commit policy**: the steps are sized as reviewable units. If you'd prefer a single foundation PR instead of six, say the word.

Once you sign off on this plan, I'll start with Step 1.
