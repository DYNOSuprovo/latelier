import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * W11 — Mongo shell (REPL in a runner child). Start the REPL through the IPC bridge,
 * connect via the existing pool, and drive a real `db.runCommand({ ping: 1 })`
 * round-trip end-to-end. No external `mongosh` required.
 */
test('mshell REPL in a runner child pings the server through the existing pool', async () => {
  const mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  const m = uri.match(/mongodb:\/\/([^:/]+):(\d+)/);
  if (!m) throw new Error('cannot parse memory mongo uri');
  const host = m[1]!;
  const port = Number(m[2]!);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));
  const app = await electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: {
      ...process.env,
      ATELIER_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'test',
    },
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(
      async ({ host, port }) => {
        const api = (window as unknown as {
          atelier: {
            conn: { create: (input: unknown) => Promise<{ id: string }> };
            mongo: { connect: (id: string) => Promise<{ status: string }> };
            mshell: {
              start: (input: { connectionId: string }) => Promise<{ sessionId: string }>;
              write: (input: { sessionId: string; data: string }) => Promise<void>;
              stop: (input: { sessionId: string }) => Promise<void>;
              onOutput: (
                cb: (evt: { sessionId: string; kind: string; data?: string }) => void,
              ) => () => void;
            };
          };
        }).atelier;

        const conn = await api.conn.create({
          name: 'Shell Target',
          color: '#1A6835',
          connectionType: 'standard',
          host,
          port,
          authMech: 'none',
          tls: { enabled: false, verify: true },
          advanced: {
            connectTimeoutMs: 3000,
            socketTimeoutMs: 3000,
            serverSelectionTimeoutMs: 3000,
            readPreference: 'primary',
            maxPoolSize: 1,
            directConnection: true,
          },
        });

        const r = await api.mongo.connect(conn.id);
        if (r.status !== 'connected') throw new Error(`unexpected status ${r.status}`);

        const session = await api.mshell.start({ connectionId: conn.id });

        const seen: string[] = [];
        const collected = new Promise<void>((resolve) => {
          const stop = api.mshell.onOutput((evt) => {
            if (evt.sessionId !== session.sessionId) return;
            if (evt.kind === 'stdout' && evt.data) {
              seen.push(evt.data);
              if (seen.join('').includes('"ok": 1')) {
                stop();
                resolve();
              }
            }
          });
          setTimeout(() => {
            stop();
            resolve();
          }, 8000);
        });

        await api.mshell.write({
          sessionId: session.sessionId,
          data: 'await db.runCommand({ ping: 1 })\n',
        });
        await collected;
        await api.mshell.stop({ sessionId: session.sessionId });
        return { joined: seen.join('') };
      },
      { host, port },
    );

    expect(result.joined).toContain('"ok": 1');
  } finally {
    await app.close();
    await mongoServer.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
