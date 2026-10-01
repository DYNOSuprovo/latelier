import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { MongoClient } from 'mongodb';
import { createTestSpawner, type TestSpawner } from '../helpers/runnerSpawner';
import { ShellService } from '../../electron/services/ShellService';
import type { MongoPool } from '../../electron/mongo/MongoPool';
import { ReadOnlyConnectionError } from '../../electron/errors';
import type { ShellOutputEvent } from '@shared/types';

/** The pool is an emitter: the service listens for status and read-only flips. */
function poolStub(stub: object): MongoPool {
  return Object.assign(new EventEmitter(), stub) as unknown as MongoPool;
}

/**
 * Fake MongoClient — only the surface the REPL exercises in these tests.
 */
function fakeClient(): MongoClient {
  const adminDb = {
    command: async (cmd: { listDatabases?: number }) => {
      if (cmd.listDatabases) {
        return {
          databases: [
            { name: 'a', sizeOnDisk: 1 },
            { name: 'b', sizeOnDisk: 2 },
          ],
        };
      }
      return { ok: 1 };
    },
  };
  return {
    db(name?: string) {
      if (name === 'admin') return adminDb as unknown;
      return {
        collection: (cn: string) => ({
          findOne: async () => ({ _id: 'x', name: cn, value: 42 }),
          countDocuments: async () => 7,
        }),
        listCollections: () => ({
          toArray: async () => [{ name: 'orders' }, { name: 'users' }],
        }),
        runCommand: async () => ({ ok: 1 }),
      } as unknown;
    },
  } as unknown as MongoClient;
}

function fakePool(client: MongoClient, opts: { readOnly?: boolean } = {}): MongoPool {
  const readOnly = opts.readOnly ?? false;
  return poolStub({
    readClient: async () => client,
    isReadOnly: () => readOnly,
    assertWritable: () => {
      if (readOnly) {
        throw new ReadOnlyConnectionError('Connection "test" is read-only.');
      }
    },
  });
}

/**
 * Like `fakePool`, but the read-only flag can flip after construction — for
 * proving a session started while writable is re-checked, not just gated at
 * start().
 */
function mutableFakePool(client: MongoClient): { pool: MongoPool; setReadOnly: (v: boolean) => void } {
  let readOnly = false;
  const pool = poolStub({
    readClient: async () => client,
    isReadOnly: () => readOnly,
    assertWritable: () => {
      if (readOnly) {
        throw new ReadOnlyConnectionError('Connection "test" is read-only.');
      }
    },
  });
  return { pool, setReadOnly: (v: boolean) => { readOnly = v; } };
}

/**
 * Drive a session by writing input + waiting for the next stdout chunk that
 * contains a marker. Output is accumulated across all `stdout` events on the
 * session.
 */
async function drive(
  svc: ShellService,
  sessionId: string,
  events: ShellOutputEvent[],
  command: string,
  marker: string,
  timeoutMs = 1500,
): Promise<string> {
  const start = events.length;
  svc.write(sessionId, command + '\n');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = events
      .slice(start)
      .filter((e) => e.kind === 'stdout' && e.sessionId === sessionId)
      .map((e) => e.data ?? '')
      .join('');
    if (slice.includes(marker)) return slice;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `timed out waiting for "${marker}" after "${command}". got: ${events
      .slice(start)
      .map((e) => `${e.kind}:${e.data ?? ''}`)
      .join('|')}`,
  );
}

// One runner child per session, forked under Node from the real runner entry.
let spawner: TestSpawner;
beforeEach(() => {
  spawner = createTestSpawner();
});
afterEach(() => {
  spawner.killAll();
});

describe('ShellService (runner child)', () => {
  let events: ShellOutputEvent[];
  let svc: ShellService;

  beforeEach(() => {
    events = [];
    svc = new ShellService({
      spawner,
      pool: fakePool(fakeClient()),
      emit: (e) => events.push(e),
    });
  });

  afterEach(async () => {
    await svc.disposeAll();
  });

  it('greets the user with a banner including the connection id', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    expect(info.connectionId).toBe('conn-1');
    // The child writes the banner once it has booted.
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const banner = events.map((e) => e.data ?? '').join('');
    expect(banner).toMatch(/L'Atelier shell/);
    expect(banner).toMatch(/conn-1/);
  });

  it('reuses the live session for the same connection', async () => {
    const a = await svc.start({ connectionId: 'conn-1' });
    const b = await svc.start({ connectionId: 'conn-1' });
    expect(b.sessionId).toBe(a.sessionId);
  });

  it('evaluates a JS expression', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(svc, info.sessionId, events, '1 + 2', '3');
    expect(out).toContain('3');
  });

  it('runs db.<coll>.findOne against the fake client and pretty-prints', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(
      svc,
      info.sessionId,
      events,
      'await db.orders.findOne()',
      'value',
    );
    expect(out).toContain('"value": 42');
    expect(out).toContain('"name": "orders"');
  });

  it('handles `show dbs` mongosh sugar', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(svc, info.sessionId, events, 'show dbs', 'a\t1');
    expect(out).toContain('a\t1');
    expect(out).toContain('b\t2');
  });

  it('handles `show collections` against the current db', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(svc, info.sessionId, events, 'show collections', 'orders');
    expect(out).toContain('orders');
    expect(out).toContain('users');
  });

  it('switches db with `use <name>` and updates the prompt', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(svc, info.sessionId, events, 'use mydb', 'switched to db mydb');
    expect(out).toContain('switched to db mydb');
    // Subsequent prompt reflects the new db.
    const next = await drive(svc, info.sessionId, events, '1', 'mydb>');
    expect(next).toContain('mydb>');
  });

  it('tolerates quoted db names and trailing semicolons in `use`', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    const a = await drive(svc, info.sessionId, events, 'use "my-db"', 'switched to db my-db');
    expect(a).toContain('switched to db my-db');
    const b = await drive(svc, info.sessionId, events, "use 'other';", 'switched to db other');
    expect(b).toContain('switched to db other');
  });

  it('prints something when the user types `db` (regression: EJSON returns undefined for proxies)', async () => {
    // Before the fix, EJSON.stringify returned undefined on the `db` Proxy
    // and Node's REPL silently dropped it — typing `db` produced no output.
    // The writer now falls back to util.inspect, which prints at least
    // `[Function: db]`.
    const info = await svc.start({ connectionId: 'conn-1' });
    const out = await drive(svc, info.sessionId, events, 'db', '[Function: db]');
    expect(out).toContain('[Function: db]');
  });

  it('write throws after the session has exited', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    await svc.stop(info.sessionId);
    expect(() => svc.write(info.sessionId, 'x')).toThrow();
  });

  it('stop is idempotent', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    await svc.stop(info.sessionId);
    await svc.stop(info.sessionId); // must not throw
    expect(svc.list()).toHaveLength(0);
  });

  it('list reflects live sessions only', async () => {
    const info = await svc.start({ connectionId: 'conn-1' });
    expect(svc.list()).toHaveLength(1);
    await svc.stop(info.sessionId);
    expect(svc.list()).toHaveLength(0);
  });
});

// ── Read-only connection guard (ADR 0005 Bucket C) ────────────────────────
// The shell's REPL context has direct `require`/`process` access, so a
// per-write-call guard inside the db proxy would be decorative — the whole
// session is refused instead of relying on one.
describe('ShellService — read-only connection', () => {
  let events: ShellOutputEvent[];

  beforeEach(() => {
    events = [];
  });

  it('start() refuses outright with ReadOnlyConnectionError', async () => {
    const svc = new ShellService({
      spawner,
      pool: fakePool(fakeClient(), { readOnly: true }),
      emit: (e) => events.push(e),
    });
    await expect(svc.start({ connectionId: 'ro-conn' })).rejects.toBeInstanceOf(
      ReadOnlyConnectionError,
    );
    expect(svc.list()).toHaveLength(0);
    await svc.disposeAll();
  });

  it('the identical start() succeeds on a non-read-only connection (regression)', async () => {
    const svc = new ShellService({
      spawner,
      pool: fakePool(fakeClient(), { readOnly: false }),
      emit: (e) => events.push(e),
    });
    const info = await svc.start({ connectionId: 'rw-conn' });
    expect(info.connectionId).toBe('rw-conn');
    await svc.disposeAll();
  });

  // A session started while the connection was writable must not keep its
  // require/process escape hatch once the connection flips to read-only —
  // start()'s guard alone only gates NEW sessions.
  it('write() is re-checked: a session opened writable is cut off once the connection flips read-only', async () => {
    const { pool, setReadOnly } = mutableFakePool(fakeClient());
    const svc = new ShellService({ pool, spawner, emit: (e) => events.push(e) });

    const info = await svc.start({ connectionId: 'conn-1' });
    // Works fine while still writable.
    expect(() => svc.write(info.sessionId, '1 + 1\n')).not.toThrow();

    setReadOnly(true);
    expect(() => svc.write(info.sessionId, 'db.orders.deleteMany({})\n')).toThrow(
      ReadOnlyConnectionError,
    );

    await svc.disposeAll();
  });
});
