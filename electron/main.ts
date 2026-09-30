import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
} from 'electron';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, closeDatabase, truncateWal } from './db/sqlite.ts';
import { AppStateRepo } from './db/repositories/AppStateRepo.ts';
import { AppStateService } from './services/AppStateService.ts';
import { SecretsVault } from './secrets/SecretsVault.ts';
import { MongoPool } from './mongo/MongoPool.ts';
import { ConnectionRepo } from './db/repositories/ConnectionRepo.ts';
import {
  ConnectionService,
  connectionReader,
} from './mongo/ConnectionService.ts';
import { registerConnChannels } from './ipc/handlers/conn.ts';
import { registerAppChannels, saveFilters } from './ipc/handlers/app.ts';
import { registerMongoChannels } from './ipc/handlers/mongo.ts';
import { registerMetaChannels } from './ipc/handlers/meta.ts';
import { registerIndexChannels } from './ipc/handlers/indexes.ts';
import { registerCollectionAdminChannels } from './ipc/handlers/collectionAdmin.ts';
import { registerUserChannels } from './ipc/handlers/users.ts';
import { registerPrefsChannels } from './ipc/handlers/prefs.ts';
import { registerTabsChannels } from './ipc/handlers/tabs.ts';
import { registerQueryChannels } from './ipc/handlers/query.ts';
import { registerDocChannels } from './ipc/handlers/doc.ts';
import { registerSavedChannels } from './ipc/handlers/saved.ts';
import { registerRecentChannels } from './ipc/handlers/recent.ts';
import { registerAggChannels } from './ipc/handlers/agg.ts';
import { registerShellChannels } from './ipc/handlers/shell.ts';
import { registerMshellChannels, makeMshellEmitter } from './ipc/handlers/mshell.ts';
import { ShellService } from './services/ShellService.ts';
import { registerScriptChannels } from './ipc/handlers/script.ts';
import { ScriptService } from './services/ScriptService.ts';
import { DiagnosticService } from './services/DiagnosticService.ts';
import { vaultSafeStorage, selectedBackend } from './secrets/keychainAvailability.ts';
import { registerRefsChannels } from './ipc/handlers/refs.ts';
import { ReferenceRulesRepo } from './db/repositories/ReferenceRulesRepo.ts';
import { ReferenceRulesService } from './services/ReferenceRulesService.ts';
import { AggregationService } from './mongo/AggregationService.ts';
import { MetaService } from './mongo/MetaService.ts';
import { IndexService } from './mongo/IndexService.ts';
import { CollectionAdminService } from './mongo/CollectionAdminService.ts';
import { UserService } from './mongo/UserService.ts';
import { WorkspaceTabRepo } from './db/repositories/WorkspaceTabRepo.ts';
import { WorkspaceStateService } from './services/WorkspaceStateService.ts';
import { SavedQueryRepo } from './db/repositories/SavedQueryRepo.ts';
import { SavedQueryService } from './services/SavedQueryService.ts';
import { RecentQueryRepo } from './db/repositories/RecentQueryRepo.ts';
import { RecentQueryService } from './services/RecentQueryService.ts';
import { RecentFieldValueRepo } from './db/repositories/RecentFieldValueRepo.ts';
import { RecentFieldValueService } from './services/RecentFieldValueService.ts';
import { MaintenanceService } from './services/MaintenanceService.ts';
import { AuditRepo } from './db/repositories/AuditRepo.ts';
import { AuditService } from './services/AuditService.ts';
import { registerAuditChannels } from './ipc/handlers/audit.ts';
import { registerDataChannels, makeDataEmitter } from './ipc/handlers/data.ts';
import { ImportService } from './mongo/ImportService.ts';
import { DEFAULT_EXPORT_CAP, QueryService } from './mongo/QueryService.ts';
import { DocumentService } from './mongo/DocumentService.ts';
import { createLogger, type Logger } from './log.ts';
import { createRouter } from './ipc/router.ts';
import { senderCheck } from './ipc/senderGuard.ts';
import { makeAppLocationCheck } from './security/appLocation.ts';
import { IPC_CHANNELS } from '@shared/ipc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '..');

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

// The one URL the window is loaded from, and the one every navigation and IPC
// sender is judged against. Built once so the two can never disagree: a guard
// comparing against a separately-assembled path is a guard that silently denies
// everything the day the two expressions drift.
const APP_URL =
  VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const isAppLocation = makeAppLocationCheck(APP_URL);

// Brand identity -------------------------------------------------------------
// Override the app name early so it shows as "L'Atelier" in the macOS menu
// bar / About dialog and in the dock tooltip. By default Electron reads
// package.json `name` ("latelier") which would surface as "Latelier".
//
// In packaged builds, electron-builder's `productName` overrides this and
// the embedded `.icns`/`.ico` is the dock/window icon source; the `build/`
// folder only exists in the dev tree, so we skip the runtime setIcon
// fallback when not present.
app.setName("L'Atelier");
const APP_ICON_PATH = path.join(process.env.APP_ROOT, 'build', 'icon.png');
const APP_ICON_AVAILABLE = fs.existsSync(APP_ICON_PATH);
if (APP_ICON_AVAILABLE && process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(APP_ICON_PATH);
}

// Single-instance guard ------------------------------------------------------
//
// The lock is per-app (by bundle id on macOS), not per-userData. When a
// developer has `npm run electron:dev` running and runs `npm run test:e2e`
// in parallel, the test instance loses the lock and calls `app.quit()`,
// which Playwright surfaces as "Target page, context or browser has been
// closed" before any window appears. Skip the lock under the test harness
// — each e2e instance has its own throwaway userData dir, so the data
// isolation the lock normally protects is already guaranteed.
const isTestInstance =
  process.env.NODE_ENV === 'test' && !!process.env.ATELIER_USER_DATA_DIR;
if (!isTestInstance) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

// E2E runs headless-style. macOS has no xvfb-equivalent (Electron renders via
// Quartz, not X11), so "headless" here means: never show the window (see
// createWindow) and keep the app out of the Dock so it never steals foreground
// focus while the suite runs. A hidden BrowserWindow still renders and is fully
// Playwright-controllable (Playwright drives the renderer through webContents).
if (isTestInstance && process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

// Services (initialized in app.whenReady) ------------------------------------

let win: BrowserWindow | null = null;
let db: Database | null = null;
let appState: AppStateService | null = null;
let vault: SecretsVault | null = null;
let pool: MongoPool | null = null;
let docSvc: DocumentService | null = null;
let mshellSvc: ShellService | null = null;
let scriptSvc: ScriptService | null = null;
let log: Logger | null = null;
let renderCrashesInWindow = 0;
let firstCrashAt = 0;

function resolveUserDataDir(): string {
  return process.env.ATELIER_USER_DATA_DIR ?? app.getPath('userData');
}

// Window bounds persistence --------------------------------------------------

interface StoredBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_BOUNDS: StoredBounds = { x: -1, y: -1, width: 1280, height: 800 };

function boundsAreOnScreen(b: StoredBounds): boolean {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    // Accept if the top-left corner lies on any display.
    if (
      b.x >= wa.x - 80 &&
      b.x <= wa.x + wa.width - 80 &&
      b.y >= wa.y - 80 &&
      b.y <= wa.y + wa.height - 80
    ) {
      return true;
    }
  }
  return false;
}

let pendingBoundsWrite: NodeJS.Timeout | null = null;
function scheduleBoundsWrite(): void {
  if (pendingBoundsWrite) clearTimeout(pendingBoundsWrite);
  pendingBoundsWrite = setTimeout(persistBoundsNow, 400);
}
function persistBoundsNow(): void {
  if (!win || win.isDestroyed() || !appState) return;
  const maximized = win.isMaximized();
  appState.set('window.maximized', maximized);
  if (!maximized) {
    const b = win.getBounds();
    appState.set<StoredBounds>('window.bounds', {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    });
  }
}

// Window creation ------------------------------------------------------------

function backgroundForTheme(): string {
  const themeMode = appState?.get<string>('theme.mode') ?? 'system';
  const dark =
    themeMode === 'dark' || (themeMode === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0F0F12' : '#FAF8F2';
}

// Renderer hardening ---------------------------------------------------------
//
// The renderer's whole job is displaying documents from whatever cluster the
// user connects to, so its input is attacker-influenceable by construction.
// `nodeIntegration: false` + `contextIsolation: true` on the BrowserWindow are
// the two protections that matter most; these are the layers underneath.

/**
 * Content-Security-Policy for the renderer. Every relaxation below is one the
 * app actually needs — none is a placeholder.
 *
 * The dev policy is looser than the shipped one on purpose. Vite's dev server
 * injects an inline module preamble for React Fast Refresh and talks to itself
 * over a websocket for HMR; neither exists in a build, so the shipped policy
 * keeps `script-src` and `connect-src` closed.
 */
function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    dev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
    // `'unsafe-inline'` here is not laziness and a nonce would not replace it:
    // CSP nonces exempt <style> elements, never `style=""` attributes, and this
    // renderer writes inline style attributes throughout. Mantine also appends
    // a <style> element on every colour-scheme change.
    "style-src 'self' 'unsafe-inline'",
    // Self-hosted since the fonts were vendored — no third-party request.
    "font-src 'self'",
    // Vite inlines assets below its 4 KB threshold as data: URIs.
    "img-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function hardenWindow(w: BrowserWindow): void {
  const dev = !!VITE_DEV_SERVER_URL;

  // Serve the policy as a header rather than a <meta> tag: one document, two
  // origins (the dev server over http, the build over file:), and a meta tag
  // would have to carry the looser of the two policies into the shipped app.
  w.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy(dev)],
      },
    });
  });

  // Nothing in this app opens a second window. Denying by default means a
  // window.open or a target=_blank that slipped past review cannot spawn one
  // with this app's privileges. External links go through app:openExternal,
  // which validates the protocol and hands off to the system browser.
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Top-level navigation is likewise never legitimate here — the renderer is a
  // single-page app. Without this, a link click could replace the app with a
  // remote page that still holds the preload bridge.
  w.webContents.on('will-navigate', (event, url) => {
    if (!isAppLocation(url)) {
      event.preventDefault();
      log?.warn('window', 'blocked navigation', { url });
    }
  });
}

function createWindow(): void {
  const saved = appState?.get<StoredBounds>('window.bounds') ?? null;
  const savedMaximized = appState?.get<boolean>('window.maximized') ?? false;

  const bounds =
    saved && boundsAreOnScreen(saved)
      ? saved
      : DEFAULT_BOUNDS;

  win = new BrowserWindow({
    x: bounds.x >= 0 ? bounds.x : undefined,
    y: bounds.y >= 0 ? bounds.y : undefined,
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: backgroundForTheme(),
    icon: APP_ICON_AVAILABLE ? APP_ICON_PATH : undefined,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The preload only reaches for `contextBridge` and `ipcRenderer`, both of
      // which a sandboxed preload still gets, so this costs nothing here. Keep
      // it that way: a preload that needs `fs` or `path` would have to give
      // this up, and the OS-level sandbox is worth more than the convenience.
      sandbox: true,
      webSecurity: true,
      preload: path.join(MAIN_DIST, 'preload.cjs'),
    },
  });

  hardenWindow(win);

  win.once('ready-to-show', () => {
    const w = win;
    if (!w) return;
    if (savedMaximized) w.maximize();
    // Headless-style under the e2e harness: keep the window hidden. It still
    // renders and stays Playwright-controllable; this just avoids a window
    // popping up / stealing focus on macOS during the suite.
    if (!isTestInstance) w.show();
    if (VITE_DEV_SERVER_URL) w.webContents.openDevTools({ mode: 'detach' });
  });

  // Null it on close. Without this, `win` stays a non-null but *destroyed*
  // BrowserWindow, and reading `.webContents` off one throws rather than
  // returning null — so every `win?.webContents` below is a null check that
  // cannot fire. On macOS the app outlives its window, and `nativeTheme`
  // emits on its own when the OS switches to dark mode at sunset; that read
  // became an uncaughtException, an error dialog, and `app.exit(1)`.
  win.on('closed', () => {
    win = null;
  });

  win.on('resize', scheduleBoundsWrite);
  win.on('move', scheduleBoundsWrite);
  win.on('maximize', persistBoundsNow);
  win.on('unmaximize', persistBoundsNow);

  win.webContents.on('render-process-gone', (_evt, details) => {
    const now = Date.now();
    log?.error('window', 'render-process-gone', { reason: details.reason });
    if (firstCrashAt === 0 || now - firstCrashAt > 10_000) {
      firstCrashAt = now;
      renderCrashesInWindow = 1;
      win?.reload();
    } else {
      renderCrashesInWindow++;
      if (renderCrashesInWindow >= 2) {
        log?.error('window', 'repeated crashes — quitting');
        app.quit();
      } else {
        win?.reload();
      }
    }
  });

  // `loadURL(APP_URL)` in both cases rather than `loadFile`, so the URL the
  // window actually holds is the same string the guards compare against. With
  // `loadFile` the expected value would be re-derived, and a difference in
  // percent-encoding or path normalisation would deny every navigation.
  win.loadURL(APP_URL);
}

// Platform events ------------------------------------------------------------

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && db) createWindow();
});

// Graceful shutdown ----------------------------------------------------------

let shuttingDown = false;
app.on('before-quit', async (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  e.preventDefault();
  log?.info('shutdown', 'begin');

  const timeoutMs = 8_000;
  const work = (async () => {
    try {
      persistBoundsNow();
      docSvc?.dispose();
      if (mshellSvc) await mshellSvc.disposeAll();
      scriptSvc?.cancelAll();
      if (pool) await pool.disconnectAll();
    } catch (err) {
      log?.warn('shutdown', 'error during pool close', { err: String(err) });
    }
    try {
      if (db) closeDatabase(db);
    } catch (err) {
      log?.warn('shutdown', 'error closing db', { err: String(err) });
    }
  })();

  await Promise.race([work, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  log?.info('shutdown', 'end');
  app.exit(0);
});

// Nothing-happened safety: if something kept the promise pending forever,
// the exit timeout above still fires.

// Dev reset shortcut: Cmd/Ctrl+Shift+Alt+R (dev only) ------------------------

function registerDevResetShortcut(): void {
  // Same reason as the logger level: a NODE_ENV check never fires in a shipped
  // build, so this destructive shortcut — it deletes the database — was live
  // for every user. `app.isPackaged` is the signal that is actually set.
  if (app.isPackaged) return;
  const accelerator =
    process.platform === 'darwin' ? 'Command+Shift+Alt+R' : 'Control+Shift+Alt+R';
  globalShortcut.register(accelerator, () => {
    if (!win || !db) return;
    try {
      closeDatabase(db);
    } catch {
      // ignore
    }
    const userDataDir = resolveUserDataDir();
    fs.rmSync(path.join(userDataDir, 'mongolab.db'), { force: true });
    fs.rmSync(path.join(userDataDir, 'mongolab.db-wal'), { force: true });
    fs.rmSync(path.join(userDataDir, 'mongolab.db-shm'), { force: true });
    db = openDatabase({ userDataDir, log: log ?? undefined });
    appState = new AppStateService(new AppStateRepo(db));
    if (pool) {
      void pool.disconnectAll();
    }
    win.reload();
    log?.info('dev', 'DB reset');
  });
}

// Last-resort crash guards --------------------------------------------------
//
// A synchronous throw inside the whenReady().then() boot body — e.g. a prepared
// statement failing against a corrupt-but-openable DB (schema_version intact but
// data tables dropped) — becomes an unhandled rejection. Under Node's default
// policy that kills the process with exit code 1 and NO dialog, strictly worse
// than the guarded DB-open path which shows a helpful message. Registering these
// handlers both stops the silent death and surfaces a dialog before exiting.
function reportFatalAndExit(kind: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log?.error('fatal', kind, { message });
  try {
    dialog.showErrorBox("L'Atelier encountered a fatal error", `${kind}\n\n${message}`);
  } catch {
    // dialog can be unavailable before the app is ready; the log line is the
    // durable record either way.
  }
  app.exit(1);
}

process.on('uncaughtException', (err) => reportFatalAndExit('Uncaught exception', err));
process.on('unhandledRejection', (reason) => reportFatalAndExit('Unhandled rejection', reason));

// Boot sequence --------------------------------------------------------------

app.whenReady().then(() => {
  const userDataDir = resolveUserDataDir();
  // `app.isPackaged` rather than NODE_ENV: nothing in the build sets NODE_ENV,
  // and Electron does not set it for a packaged app, so a NODE_ENV test reads
  // as "development" in every shipped build. `isPackaged` cannot be omitted.
  log = createLogger(userDataDir, { level: app.isPackaged ? 'info' : 'debug' });
  log.info('boot', 'starting', { userDataDir, platform: process.platform });

  // 1. DB + migrations
  try {
    db = openDatabase({ userDataDir, log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('boot', 'db open failed', { message });
    dialog.showErrorBox(
      "L'Atelier failed to start",
      `Could not open the database.\n\n${message}\n\nYou may need to delete:\n${userDataDir}/mongolab.db`,
    );
    app.exit(1);
    return;
  }

  // 2. Repos
  appState = new AppStateService(new AppStateRepo(db));

  // Re-broadcast theme on OS theme change so 'system' mode tracks live.
  nativeTheme.on('updated', () => {
    if (!appState) return;
    const mode = appState.get<'light' | 'dark' | 'system'>('theme.mode') ?? 'system';
    if (mode !== 'system') return;
    const wc = win?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC_CHANNELS.prefsThemeEvent, mode);
    }
  });

  // 3. Secrets
  const appStateRef = appState;
  const vaultCrypto = vaultSafeStorage(safeStorage, process.platform);
  vault = new SecretsVault(
    db,
    vaultCrypto,
    {
      getAllowPlaintext: () =>
        appStateRef.get<boolean>('secrets.allowPlaintextFallback') === true,
    },
  );

  // 4. Connection repo + Mongo pool
  const connRepo = new ConnectionRepo(db);
  pool = new MongoPool({
    repo: connectionReader(connRepo, vault),
    vault,
    log,
    debugDriverEvents: process.env.ATELIER_DEBUG_DRIVER === '1',
  });
  const connSvc = new ConnectionService({ repo: connRepo, vault, pool });

  // 5. IPC router + channels
  // Every channel goes through the sender guard. The window is created after
  // this point, so the trusted frame is read through a closure rather than
  // captured — and it is re-read per message, which is what keeps it correct
  // across a reload.
  const auditRepo = new AuditRepo(db);
  const auditSvc = new AuditService(auditRepo, pool, log);
  const router = createRouter(
    ipcMain,
    senderCheck(() => win?.webContents.mainFrame ?? null, isAppLocation),
    log,
    auditSvc,
  );
  // Workspace tabs
  const tabsRepo = new WorkspaceTabRepo(db);
  const tabsSvc = new WorkspaceStateService(tabsRepo);

  const savedRepo = new SavedQueryRepo(db);
  const savedSvc = new SavedQueryService(savedRepo);
  const recentRepo = new RecentQueryRepo(db);
  const recentSvc = new RecentQueryService(recentRepo);
  const recentFieldValueRepo = new RecentFieldValueRepo(db);
  const recentFieldValueSvc = new RecentFieldValueService(recentFieldValueRepo);
  const querySvc = new QueryService(pool, recentSvc, DEFAULT_EXPORT_CAP, log);
  docSvc = new DocumentService(pool, { log });
  const aggSvc = new AggregationService(pool, recentSvc);
  const metaSvc = new MetaService(pool);
  const indexSvc = new IndexService(pool);
  const collectionAdminSvc = new CollectionAdminService(pool);
  const userSvc = new UserService(pool);
  const checkpointDb = db;
  const checkpointLog = log;
  const maintenance = new MaintenanceService({
    recentRepo,
    recentFieldValueRepo,
    auditRepo,
    checkpoint: () => {
      if (!truncateWal(checkpointDb)) checkpointLog.warn('maintenance', 'wal checkpoint was blocked');
    },
  });
  maintenance.runIfNeeded(appState);

  const diagnostic = new DiagnosticService({
    userDataDir,
    connRepo,
    secretsStatus: () => ({
      encryptionAvailable: vaultCrypto.isEncryptionAvailable(),
      backend: selectedBackend(safeStorage, process.platform),
    }),
  });

  registerConnChannels(router, connSvc);
  // Filled by the open dialog, read by the data channels: the only files an
  // import may read are ones the user picked in main's own dialog.
  const pickedImports = new Set<string>();
  registerAppChannels(router, () => win, pickedImports, diagnostic);
  registerMongoChannels(router, pool, () => win?.webContents ?? null);
  registerMetaChannels(router, metaSvc);
  registerIndexChannels(router, indexSvc);
  registerCollectionAdminChannels(router, collectionAdminSvc);
  registerUserChannels(router, userSvc);
  registerPrefsChannels(router, appState, () => win?.webContents ?? null);
  registerTabsChannels(router, tabsSvc);
  // Same window-lookup + `saveFilters` pattern as `app.ts`'s `saveFile`,
  // kept as a closure here rather than an import into query.ts so that file
  // never needs `electron` itself (mirrors app.ts's own `dialog` usage).
  registerQueryChannels(router, querySvc, async (defaultName) => {
    const result = await (win
      ? dialog.showSaveDialog(win, { defaultPath: defaultName, filters: saveFilters(defaultName) })
      : dialog.showSaveDialog({ defaultPath: defaultName, filters: saveFilters(defaultName) }));
    return result.canceled || !result.filePath ? null : result.filePath;
  });
  registerDocChannels(router, docSvc);
  registerSavedChannels(router, savedSvc);
  registerRecentChannels(router, recentSvc, recentFieldValueSvc);
  registerAuditChannels(router, auditSvc);
  registerDataChannels(
    router,
    new ImportService(pool, { emit: makeDataEmitter(() => win?.webContents ?? null) }),
    pickedImports,
  );
  registerAggChannels(router, aggSvc);
  registerShellChannels(router);

  mshellSvc = new ShellService({
    pool,
    emit: makeMshellEmitter(() => win?.webContents ?? null),
    log,
  });
  registerMshellChannels(router, mshellSvc);

  scriptSvc = new ScriptService({ pool });
  registerScriptChannels(router, scriptSvc);

  const refsRepo = new ReferenceRulesRepo(db);
  const refsSvc = new ReferenceRulesService(refsRepo, pool);
  registerRefsChannels(router, refsSvc);

  // 6. Window
  createWindow();

  // 7. Dev niceties
  registerDevResetShortcut();

  log.info('boot', 'ready');
});
