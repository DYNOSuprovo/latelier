# F06 — App startup & shutdown

## Purpose

Choreograph the bring-up and teardown sequence so every other spec's assumptions hold: the DB is open and migrated before any IPC is registered; the window only appears after services are ready; secrets, mongo clients, and logs flush cleanly on quit.

## Scope

- **In**: `main.ts` top-level boot sequence, service construction order, shutdown hooks, window creation, reload/dev behavior.
- **Out**: Per-service internals (those live in F02–F05). Renderer-side startup (covered per-page).

## Dependencies

- F01–F05.

## 1. Startup sequence

```ts
// electron/main.ts (conceptual)
app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  const log = createLogger(userDataDir);
  log.info('boot', 'starting');

  // 1. DB + migrations (blocks window creation)
  const db = openDatabase(userDataDir);                 // F02

  // 2. Repositories
  const connRepo   = new ConnectionRepo(db);
  const savedRepo  = new SavedQueryRepo(db);
  const recentRepo = new RecentQueryRepo(db);
  const tabsRepo   = new WorkspaceTabRepo(db);
  const prefsRepo  = new PreviewFieldsRepo(db);
  const stateRepo  = new AppStateRepo(db);

  // 3. Secrets
  const vault = new SecretsVault(db);                   // F03

  // 4. Mongo pool
  const pool = new MongoPool(connRepo, vault, log);     // F05

  // 5. Domain services
  const connSvc   = new ConnectionService(connRepo, vault, pool);
  const querySvc  = new QueryService(pool);
  const aggSvc    = new AggregationService(pool);
  const docSvc    = new DocumentService(pool);
  const savedSvc  = new SavedQueryService(savedRepo, connRepo);
  const recentSvc = new RecentQueryService(recentRepo);
  const tabsSvc   = new WorkspaceStateService(tabsRepo);
  const prefsSvc  = new PreviewFieldsService(prefsRepo);
  const appSvc    = new AppStateService(stateRepo);

  // 6. Register IPC channels
  registerConnChannels(connSvc);                        // F04 helpers
  registerMongoChannels(pool);
  registerMetaChannels(pool);
  registerQueryChannels(querySvc, recentSvc);
  registerAggChannels(aggSvc, recentSvc);
  registerDocChannels(docSvc);
  registerSavedChannels(savedSvc);
  registerRecentChannels(recentSvc);
  registerTabsChannels(tabsSvc);
  registerPrefsChannels(prefsSvc, appSvc);
  registerAppChannels(appSvc);

  // 7. Create window
  await createWindow(appSvc);                           // X01 restores bounds

  log.info('boot', 'ready');
});
```

If any of steps 1–6 throws, the app shows an error dialog via `dialog.showErrorBox` and quits with exit code 1. Step 7 failures are logged but the app keeps running (the `activate` handler will retry).

## 2. Window creation

- Restore bounds and maximize state from `app_state['window.bounds']` (X01).
- Default: 1280×800, centered. Minimum: 900×600.
- `titleBarStyle: 'hiddenInset'` (already set — keeps native macOS traffic lights).
- `backgroundColor` matches current theme (`LIGHT.bg` or `DARK.bg`) so the first paint isn't white-on-dark.
- `show: false` at creation; wait for `ready-to-show` before `show()`.
- DevTools opens automatically when `VITE_DEV_SERVER_URL` is set.

## 3. Single-instance lock

`app.requestSingleInstanceLock()`. If this returns `false`, call `app.quit()` immediately. The primary instance listens for `second-instance` and focuses the existing window. Prevents two copies stepping on the same SQLite file.

## 4. Shutdown sequence

```ts
app.on('before-quit', async (e) => {
  e.preventDefault();
  log.info('shutdown', 'begin');
  await Promise.race([
    (async () => {
      await tabsSvc.persistCurrent();      // renderer hands off a final snapshot via IPC if needed
      await pool.disconnectAll();
      db.close();
    })(),
    new Promise(r => setTimeout(r, 8000)),
  ]);
  log.info('shutdown', 'end');
  app.exit(0);
});
```

- 8-second hard budget. Anything still pending is abandoned.
- `db.close()` is last — once it returns, no more writes are possible.
- On macOS, closing the last window does NOT quit (`window-all-closed` unless `process.platform !== 'darwin'`) — existing behavior.

## 5. Restore on activate

- `app.on('activate', ...)` (macOS dock icon click): if no window, recreate using the same service instances. Do NOT re-open the DB or reconstruct services.

## 6. Reload / devtools

- In dev (`VITE_DEV_SERVER_URL` set), HMR reloads the renderer but keeps the main process — services remain alive.
- A "hard reload" (⌘⇧R) reloads the window without restarting main. Tab state is persisted on every change (W01), so the renderer can restore.
- A `devReset` developer shortcut (⌘⇧⌥R) is registered that: closes the DB, deletes `mongolab.db`, reopens, re-runs migrations, then reloads the window. Disabled in packaged builds.

## 7. Crash handling

- Main-process uncaught exceptions: logged, `dialog.showErrorBox`, then `app.exit(1)`. The user relaunches manually.
- Renderer crashes (`render-process-gone`): log, reload the window once. If it crashes again within 10 seconds, quit.

## 8. Logs

- Rotating file at `userData/logs/mongolab.<date>.log`. Daily rotation, 7-day retention.
- On POSIX the `logs/` dir is `0700` and log files are `0600`; existing files are tightened at startup, and one that cannot be is reported as a `warn` line. No-op on Windows.
- Log levels: `debug` (dev only), `info`, `warn`, `error`.
- `log.info(tag, msg, data?)` — `tag` is a short namespace (`'boot'`, `'mongo'`, `'db'`, `'ipc'`).
- Renderer never writes to this log directly; it calls `app:log` IPC which the main side filters and forwards.

## 9. Acceptance criteria

- [ ] With a clean userData dir, first launch: DB created, migrations run, window appears with no error dialogs.
- [ ] Second instance quits silently and focuses the primary.
- [ ] On quit with a live MongoClient, the app exits within 8 seconds.
- [ ] A DB file that fails to open (corrupt) produces an error dialog naming the file path and tells the user how to reset.
- [ ] `app:log` IPC entries appear in the log file with the correct process tag.

## 10. Test cases

### Integration
- **boot-order.spec.ts** (with stubbed Electron `app`/`BrowserWindow`): assert registration order is DB → services → IPC → window.
- **single-instance.spec.ts**: second `app.requestSingleInstanceLock` returns false → the test harness observes a quit call and a `second-instance` event emission on the first.
- **shutdown-budget.spec.ts**: stub `pool.disconnectAll` to hang; total shutdown time is ≤ 8s.

### E2E
- **first-run.e2e.ts**: delete the userData dir; launch; assert the connections page renders empty state and the DB file exists on disk.
- **crash-reload.e2e.ts**: force a renderer crash via `window.location = 'about:crash'`; assert the window reloads once.
