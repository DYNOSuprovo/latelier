import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, closeDatabase, withTransaction } from '../../electron/db/sqlite';
import { createTempDb, type TempDb } from '../helpers/db';

describe('sqlite bootstrap', () => {
  let tmp: TempDb | null = null;

  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  it('creates the DB file at userDataDir/<filename>', () => {
    tmp = createTempDb();
    expect(fs.existsSync(path.join(tmp.dir, 'mongolab.db'))).toBe(true);
  });

  it('applies pragmas', () => {
    tmp = createTempDb();
    expect(tmp.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(tmp.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates all expected tables', () => {
    tmp = createTempDb();
    const names = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      'schema_version',
      'connections',
      'connection_secrets',
      'saved_queries',
      'recent_queries',
      'workspace_tabs',
      'app_state',
      'audit_log',
      'recent_field_values',
    ]) {
      expect(names, `expected table ${expected}`).toContain(expected);
    }
  });

  it('drops preview_fields (migration 011) and lands on schema_version 13', () => {
    tmp = createTempDb();
    const names = tmp.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).not.toContain('preview_fields');
    const version = tmp.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(13);
  });

  it('reopening an existing DB does not re-run migrations', () => {
    tmp = createTempDb();
    const v1 = tmp.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    closeDatabase(tmp.db);
    // Reopen directly with a non-existent migration that would fail if re-run:
    const migrations = [
      {
        version: 1,
        name: '001-init.sql',
        sql: 'SELECT RAISE(FAIL, "should not run");',
      },
    ];
    const db2 = openDatabase({ userDataDir: tmp.dir, migrations });
    expect(() => db2.prepare('SELECT 1 FROM connections').get()).not.toThrow();
    const v2 = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v2.version).toBe(v1.version);
    closeDatabase(db2);
  });

  it('withTransaction commits on success and rolls back on throw', () => {
    tmp = createTempDb();
    const db = tmp.db;

    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO app_state (key, value_json, updated_at) VALUES ('k1','"v"', '2024-01-01T00:00:00Z')`,
      ).run();
    });
    expect(db.prepare('SELECT key FROM app_state WHERE key = ?').get('k1')).toBeDefined();

    expect(() =>
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO app_state (key, value_json, updated_at) VALUES ('k2','"v"', '2024-01-01T00:00:00Z')`,
        ).run();
        throw new Error('boom');
      }),
    ).toThrow(/boom/);
    expect(db.prepare('SELECT key FROM app_state WHERE key = ?').get('k2')).toBeUndefined();
  });
});
