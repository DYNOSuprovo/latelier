import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, type Migration } from '../../electron/db/migrationRunner';

function loadMigrationsFromDisk(): Migration[] {
  const dir = path.resolve(__dirname, '..', '..', 'electron', 'db', 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => ({
      version: Number(/^(\d+)-/.exec(name)![1]),
      name,
      sql: fs.readFileSync(path.join(dir, name), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
}

describe('migration 014 — strip persisted results', () => {
  let db: BetterSqlite3.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  function seedTab(d: BetterSqlite3.Database, id: string, kind: string, stateJson: string): void {
    d.prepare(
      `INSERT INTO workspace_tabs
         (id, connection_id, kind, db_name, collection, state_json, position, is_active, opened_at)
       VALUES (?, 'c1', ?, 'db', 'coll', ?, 0, 0, ?)`,
    ).run(id, kind, stateJson, new Date().toISOString());
  }

  function stateOf(d: BetterSqlite3.Database, id: string): string {
    return (d.prepare('SELECT state_json FROM workspace_tabs WHERE id = ?').get(id) as {
      state_json: string;
    }).state_json;
  }

  it('removes result fields from existing rows, keeps everything else, and leaves malformed rows byte-identical', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig14-'));
    db = new BetterSqlite3(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    const all = loadMigrationsFromDisk();
    runMigrations(db, all.filter((m) => m.version < 14));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES ('c1', 'c1', 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(now, now);

    seedTab(
      db,
      'coll',
      'collection',
      JSON.stringify({
        queryRaw: '{"a":1}',
        page: 2,
        lastRunHasMore: true,
        columns: { a: { width: 90 } },
        lastRun: { documents: [{ secret: 'pii' }], durationMs: 1, ranAt: now },
        aggregation: {
          outputHeight: 200,
          lastRun: { rows: [{ secret: 'pii' }], stageSamples: { 0: [{ secret: 'pii' }] } },
        },
      }),
    );
    seedTab(
      db,
      'script',
      'script',
      JSON.stringify({ title: 'T', source: 'db.a.find()', lastResult: { value: [{ secret: 'pii' }] } }),
    );
    seedTab(db, 'script-err', 'script', JSON.stringify({ title: 'T', lastError: { code: 'X', message: 'm' } }));
    seedTab(db, 'agg-string', 'collection', JSON.stringify({ aggregation: 'oops', lastRun: { documents: [] } }));
    const malformed = '{not json "lastRun": 1';
    seedTab(db, 'bad', 'collection', malformed);
    const array = '[{"lastRun":1}]';
    seedTab(db, 'arr', 'collection', array);

    runMigrations(db, all.filter((m) => m.version <= 14));

    expect(JSON.parse(stateOf(db, 'coll'))).toEqual({
      queryRaw: '{"a":1}',
      page: 2,
      lastRunHasMore: true,
      columns: { a: { width: 90 } },
      aggregation: { outputHeight: 200 },
    });
    expect(JSON.parse(stateOf(db, 'script'))).toEqual({ title: 'T', source: 'db.a.find()' });
    expect(JSON.parse(stateOf(db, 'script-err'))).toEqual({ title: 'T' });
    expect(JSON.parse(stateOf(db, 'agg-string'))).toEqual({ aggregation: 'oops' });
    expect(stateOf(db, 'bad')).toBe(malformed);
    expect(stateOf(db, 'arr')).toBe(array);
    expect(stateOf(db, 'coll')).not.toContain('pii');
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(14);
  });
});
