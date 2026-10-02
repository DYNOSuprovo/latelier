import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Contract tests that catch regressions only the packaged app can surface:
 *   - GAP 1: EJSON sentinels (ObjectId / Date / Decimal128) survive
 *     `query.find` round-trip via the preload boundary.
 *   - GAP 2: Errors thrown main-side cross the preload as `IpcError` with the
 *     correct `code` (renderer code switches on this).
 *   - GAP 4: `confirmDeleteMany` → `deleteMany` two-call sequence (token held
 *     in main-side Map) survives the IPC boundary.
 *   - GAP 5: Fresh userData boots without error and migrations 001–N apply.
 *
 * All tests bypass the UI and drive `window.atelier` directly — the value is
 * in exercising the preload contract under real Electron, not in clicking
 * buttons.
 */

const MEMORY_SERVERS: MongoMemoryServer[] = [];

test.afterAll(async () => {
  await Promise.all(MEMORY_SERVERS.map((m) => m.stop()));
});

async function startMemoryServer(): Promise<{ host: string; port: number }> {
  const ms = await MongoMemoryServer.create();
  MEMORY_SERVERS.push(ms);
  const m = ms.getUri().match(/mongodb:\/\/([^:/]+):(\d+)/);
  if (!m) throw new Error('cannot parse memory mongo uri');
  return { host: m[1]!, port: Number(m[2]!) };
}

function freshUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: {
      ...process.env,
      ATELIER_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'test',
    },
  });
}

/**
 * Run a test body with an Electron app + isolated userData dir, guaranteeing
 * cleanup even if `launchApp` throws or the body's first `await` rejects.
 * Mirrors the pattern Playwright would use if `test.use({ fixtures })` were
 * available for Electron-launched apps.
 */
async function withApp<T>(
  fn: (app: ElectronApplication, userDataDir: string) => Promise<T>,
): Promise<T> {
  const userDataDir = freshUserData();
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    return await fn(app, userDataDir);
  } finally {
    if (app) await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

const baseConnInput = (host: string, port: number) => ({
  name: 'IPC Contract Target',
  color: '#1A6835',
  connectionType: 'standard' as const,
  host,
  port,
  authMech: 'none' as const,
  tls: { enabled: false, verify: true },
  advanced: {
    connectTimeoutMs: 3000,
    socketTimeoutMs: 3000,
    serverSelectionTimeoutMs: 3000,
    readPreference: 'primary' as const,
    maxPoolSize: 5,
    directConnection: true,
  },
});

// ---------------------------------------------------------------------------
// GAP 5 — first-launch clean boot.
// ---------------------------------------------------------------------------
test('first launch on fresh userData boots, applies migrations, exposes empty conn list', async () => {
  await withApp(async (app, userDataDir) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          conn: { list: () => Promise<unknown[]> };
          tabs: { list: () => Promise<unknown[]> };
        };
      }).atelier;
      return {
        conns: await api.conn.list(),
        tabs: await api.tabs.list(),
      };
    });

    expect(Array.isArray(result.conns)).toBe(true);
    expect(result.conns).toHaveLength(0);
    expect(Array.isArray(result.tabs)).toBe(true);
    expect(result.tabs).toHaveLength(0);

    // Migration runner created the SQLite file with at least the schema rows.
    const dbPath = path.join(userDataDir, 'mongolab.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GAP 2 — error envelope shape across the preload boundary.
// ---------------------------------------------------------------------------
test('main-side errors arrive in renderer as IpcError with correct code', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          conn: { get: (id: string) => Promise<unknown> };
          doc: {
            insert: (input: {
              connectionId: string;
              dbName: string;
              collection: string;
              docJson: string;
            }) => Promise<unknown>;
          };
        };
      }).atelier;

      // (a) Zod validation error — empty connectionId fails the handler schema.
      let zodErr: { code?: string; message?: string } | null = null;
      try {
        await api.doc.insert({
          connectionId: '',
          dbName: 'db',
          collection: 'c',
          docJson: '{}',
        });
      } catch (err) {
        zodErr = err as { code?: string; message?: string };
      }

      // (b) ValidationError thrown service-side from invalid EJSON.
      let serviceValidationErr: { code?: string; message?: string } | null = null;
      try {
        await api.doc.insert({
          connectionId: 'no-such-conn',
          dbName: 'db',
          collection: 'c',
          docJson: 'not-json',
        });
      } catch (err) {
        serviceValidationErr = err as { code?: string; message?: string };
      }

      // (c) NotFoundError — looking up an unknown connection id.
      let notFoundErr: { code?: string; message?: string } | null = null;
      try {
        await api.conn.get('00000000-0000-0000-0000-000000000000');
      } catch (err) {
        notFoundErr = err as { code?: string; message?: string };
      }

      return { zodErr, serviceValidationErr, notFoundErr };
    });

    // Each error must be a structured IpcError with both `code` and `message`.
    // Renderer-side error switches branch on `code` — a regression that
    // collapses everything into INTERNAL or strips the code would break the
    // entire app's error UX.
    expect(result.zodErr).not.toBeNull();
    expect(result.zodErr?.code).toBe('VALIDATION');
    expect(typeof result.zodErr?.message).toBe('string');

    expect(result.serviceValidationErr).not.toBeNull();
    expect(result.serviceValidationErr?.code).toBe('VALIDATION');
    expect(typeof result.serviceValidationErr?.message).toBe('string');

    expect(result.notFoundErr).not.toBeNull();
    expect(result.notFoundErr?.code).toBe('NOT_FOUND');
    expect(typeof result.notFoundErr?.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// GAP 1 — EJSON sentinels survive the find round-trip via the preload.
// GAP 4 — confirmDeleteMany → deleteMany two-call sequence preserves the
//          confirmToken across IPC. (Bundled with GAP 1 because both share
//          the same insert + memory-server setup.)
// ---------------------------------------------------------------------------
test('EJSON round-trip + confirmToken delete flow via preload', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port, conn }) => {
        type Probe = { ok: boolean; errorCode?: string; errorMessage?: string };
        const api = (window as unknown as {
          atelier: {
            conn: {
              create: (input: unknown) => Promise<{ id: string }>;
              test: (input: unknown) => Promise<Probe>;
            };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            doc: {
              insert: (input: {
                connectionId: string;
                dbName: string;
                collection: string;
                docJson: string;
              }) => Promise<{ insertedId: unknown }>;
              confirmDeleteMany: (input: {
                connectionId: string;
                dbName: string;
                collection: string;
                filterJson: string;
              }) => Promise<{ count: number; confirmToken: string }>;
              deleteMany: (input: {
                connectionId: string;
                dbName: string;
                collection: string;
                filterJson: string;
                confirmToken: string;
              }) => Promise<{ deletedCount: number }>;
            };
            query: {
              find: (input: {
                connectionId: string;
                dbName: string;
                collection: string;
                filter: string;
                limit: number;
                skip: number;
              }) => Promise<{ documents: unknown[]; durationMs: number; hasMore: boolean }>;
              count: (input: {
                connectionId: string;
                dbName: string;
                collection: string;
                filter: string;
              }) => Promise<{ count: number }>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        const status = await api.mongo.connect(created.id);
        if (status.status !== 'connected') {
          throw new Error(`unexpected mongo status ${status.status}`);
        }

        const dbName = 'ipc_contract';
        const collection = 'docs';

        // --- GAP 1: insert with EJSON sentinels, then read them back. -------
        const docJson = JSON.stringify({
          _id: { $oid: '507f1f77bcf86cd799439011' },
          createdAt: { $date: '2024-01-15T10:30:00.000Z' },
          amount: { $numberDecimal: '3.14159' },
          name: 'sentinel-doc',
        });
        await api.doc.insert({
          connectionId: created.id,
          dbName,
          collection,
          docJson,
        });

        const found = await api.query.find({
          connectionId: created.id,
          dbName,
          collection,
          filter: '{}',
          limit: 10,
          skip: 0,
        });

        // --- GAP 4: confirmDeleteMany → deleteMany. -------------------------
        const insertedExtra = await api.doc.insert({
          connectionId: created.id,
          dbName,
          collection,
          docJson: JSON.stringify({ name: 'extra-doc' }),
        });
        const countBefore = await api.query.count({
          connectionId: created.id,
          dbName,
          collection,
          filter: '{}',
        });
        const confirm = await api.doc.confirmDeleteMany({
          connectionId: created.id,
          dbName,
          collection,
          filterJson: '{}',
        });
        const deleted = await api.doc.deleteMany({
          connectionId: created.id,
          dbName,
          collection,
          filterJson: '{}',
          confirmToken: confirm.confirmToken,
        });
        const countAfter = await api.query.count({
          connectionId: created.id,
          dbName,
          collection,
          filter: '{}',
        });

        return {
          found,
          confirm,
          deleted,
          countBefore: countBefore.count,
          countAfter: countAfter.count,
          insertedExtra,
        };
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    // GAP 1 assertions — preload's JSON.parse path preserves the EJSON
    // sentinels exactly. If `bson` versions drift between main and preload
    // bundles, or if `ejsonEncodeArrayJson` regresses, the sentinel keys or
    // values change shape and these assertions fail.
    // Find runs before the second insert; only the sentinel doc is back.
    expect(result.found.documents).toHaveLength(1);
    const sentinelDoc = (result.found.documents as Array<Record<string, unknown>>).find(
      (d) => d.name === 'sentinel-doc',
    );
    expect(sentinelDoc).toBeTruthy();
    expect(sentinelDoc?._id).toEqual({ $oid: '507f1f77bcf86cd799439011' });
    // Canonical EJSON re-encodes Date as {$date:{$numberLong:"<ms>"}}.
    expect(sentinelDoc?.createdAt).toEqual({
      $date: { $numberLong: String(Date.parse('2024-01-15T10:30:00.000Z')) },
    });
    expect(sentinelDoc?.amount).toEqual({ $numberDecimal: '3.14159' });
    expect(typeof result.found.durationMs).toBe('number');
    expect(result.found.hasMore).toBe(false);

    // GAP 4 assertions — confirmToken survives the IPC round-trip and unlocks
    // the delete on the second call.
    expect(result.countBefore).toBe(2);
    expect(result.confirm.count).toBe(2);
    expect(typeof result.confirm.confirmToken).toBe('string');
    expect(result.confirm.confirmToken.length).toBeGreaterThan(8);
    expect(result.deleted.deletedCount).toBe(2);
    expect(result.countAfter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GAP 4b — `deleteMany` rejects an unknown / forged confirmToken.
// ---------------------------------------------------------------------------
test('deleteMany without a valid confirmToken throws VALIDATION', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const err = await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            doc: {
              insert: (input: unknown) => Promise<unknown>;
              deleteMany: (input: unknown) => Promise<unknown>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);
        await api.doc.insert({
          connectionId: created.id,
          dbName: 'token_test',
          collection: 'docs',
          docJson: '{"x":1}',
        });

        try {
          await api.doc.deleteMany({
            connectionId: created.id,
            dbName: 'token_test',
            collection: 'docs',
            filterJson: '{}',
            confirmToken: 'not-a-real-token-' + Math.random(),
          });
          return null;
        } catch (caught) {
          return caught as { code?: string; message?: string };
        }
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    expect(err).not.toBeNull();
    expect(err?.code).toBe('VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// Chromium profile isolation — userData path is redirected to throwaway dir
// for test instances, keeping ~/.../L'Atelier clean.
// ---------------------------------------------------------------------------
test('test instance keeps Chromium profile in throwaway userData dir', async () => {
  await withApp(async (app, userDataDir) => {
    const pathFromApp = await app.evaluate(({ app }) => app.getPath('userData'));
    expect(pathFromApp).toBe(userDataDir);
  });
});
