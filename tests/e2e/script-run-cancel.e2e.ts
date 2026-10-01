import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';

test.afterAll(stopAllMemoryServers);

/**
 * GAP 10 — `script.run` over the real preload; `script.cancel` and timeouts
 * are covered by the later scenarios in this file.
 *
 * The `ScriptService` is 393 LOC and handler-tested at integration level
 * with a fake pool — the preload contract (Zod `ScriptRunInput`, the cancel
 * token UUID round-trip, the `valueJson` EJSON safe-encode) has never
 * crossed the contextBridge in a test.
 *
 * This scenario: `1 + 2` returns `valueJson: "3"`, and `print()` round-trips.
 */
test('script.run returns valueJson and captures print() over the real preload', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            script: {
              run: (input: {
                connectionId: string;
                dbName?: string;
                source: string;
              }) => Promise<{ valueJson: string | null; printBuffer: string; durationMs: number }>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);

        // (a) Happy path — pure JS, no Mongo.
        const happy = await api.script.run({
          connectionId: created.id,
          source: '1 + 2',
        });

        // Also exercise a print() so printBuffer round-trips.
        const printed = await api.script.run({
          connectionId: created.id,
          source: 'print("hello"); 42',
        });

        return { happy, printed };
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    // Happy path: `1 + 2` → valueJson "3" (canonical EJSON).
    expect(result.happy.valueJson).toBe('3');
    expect(typeof result.happy.durationMs).toBe('number');
    expect(result.happy.printBuffer).toBe('');

    // print() captured.
    expect(result.printed.printBuffer).toContain('hello');
    expect(result.printed.valueJson).toBe('42');
  });
});

/**
 * The database bridge over the real utility process: the runner holds no
 * client, so every call here crosses `process.parentPort` to main and back.
 * The Node-fork integration suite covers the semantics; this is the one place
 * the Electron channel itself (message events carrying `{ data }`) is
 * exercised, and where a read-only connection refuses a write end to end.
 */
test('a script reads and writes through the bridge, and a read-only connection refuses the write', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: {
              create: (input: unknown) => Promise<{ id: string }>;
              update: (id: string, patch: unknown) => Promise<unknown>;
            };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            script: {
              run: (input: { connectionId: string; source: string }) => Promise<{ valueJson: string | null }>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);

        const wrote = await api.script.run({
          connectionId: created.id,
          source:
            'await db.bridge_e2e.deleteMany({}); await db.bridge_e2e.insertOne({ n: 1 }); (await db.bridge_e2e.find().toArray()).length',
        });
        await api.conn.update(created.id, { readOnly: true });
        const refused = await api.script
          .run({ connectionId: created.id, source: 'await db.bridge_e2e.insertOne({ n: 2 })' })
          .then(() => ({ rejected: false as const }))
          .catch((e: { code?: string }) => ({ rejected: true as const, code: e.code }));
        const read = await api.script.run({
          connectionId: created.id,
          source: 'await db.bridge_e2e.countDocuments({})',
        });
        return { wrote: wrote.valueJson, refused, read: read.valueJson };
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    expect(result.wrote).toBe('1');
    expect(result.refused).toEqual({ rejected: true, code: 'READ_ONLY' });
    // The refused insert never landed: still one document.
    expect(result.read).toBe('1');
  });
});

/**
 * A script that only ever awaits resolved promises never lets the event loop
 * turn. Run in the main process it froze every IPC call; the runner is a
 * separate process that main kills on the wall clock, so the app must keep
 * answering and the same connection must run the next script.
 */
test('a microtask-loop script times out, the app keeps answering IPC, and the next run works', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: {
              create: (input: unknown) => Promise<{ id: string }>;
              list: () => Promise<Array<{ id: string }>>;
            };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            script: {
              run: (input: {
                connectionId: string;
                source: string;
                maxTimeMs?: number;
              }) => Promise<{ valueJson: string | null }>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);

        const t0 = performance.now();
        const loop = api.script
          .run({
            connectionId: created.id,
            source: 'while (true) await Promise.resolve()',
            maxTimeMs: 500,
          })
          .then(() => ({ rejected: false as const }))
          .catch((e: { code?: string }) => ({ rejected: true as const, code: e.code }));

        // While the loop spins in its own process, main must keep answering.
        // Wait past the runner's cold start first, so the loop is really
        // spinning (still well inside the 500 ms budget).
        await new Promise((r) => setTimeout(r, 300));
        const listed = await api.conn.list();
        const listedWhileSpinning = listed.some((c) => c.id === created.id);

        const outcome = await loop;
        const elapsedMs = performance.now() - t0;
        const next = await api.script.run({ connectionId: created.id, source: '1 + 1' });
        return { outcome, elapsedMs, listedWhileSpinning, next: next.valueJson };
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    expect(result.listedWhileSpinning).toBe(true);
    expect(result.outcome).toEqual({ rejected: true, code: 'TIMEOUT' });
    expect(result.elapsedMs).toBeLessThan(3000);
    expect(result.next).toBe('2');
  });
});

test('script.cancel kills a script that is awaiting forever, with the cancelled error', async () => {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port, conn }) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            script: {
              run: (input: {
                connectionId: string;
                source: string;
                cancelToken: string;
                maxTimeMs: number;
              }) => Promise<unknown>;
              cancel: (input: { token: string }) => Promise<void>;
            };
          };
        }).atelier;

        const created = await api.conn.create({ ...conn, host, port });
        await api.mongo.connect(created.id);

        const token = crypto.randomUUID();
        const run = api.script
          .run({
            connectionId: created.id,
            // The sandbox has no setTimeout, so a never-settling promise is the
            // way to hold a script open.
            source: 'await new Promise(() => {})',
            cancelToken: token,
            maxTimeMs: 60_000,
          })
          .then(() => ({ rejected: false as const }))
          .catch((e: { code?: string; message?: string }) => ({
            rejected: true as const,
            code: e.code,
            message: e.message,
          }));
        // Well past the runner's cold start, so the cancel kills a live child.
        await new Promise((r) => setTimeout(r, 1500));
        await api.script.cancel({ token });
        return await run;
      },
      { host, port, conn: baseConnInput(host, port) },
    );

    expect(result).toEqual({ rejected: true, code: 'TIMEOUT', message: 'script cancelled' });
  });
});
