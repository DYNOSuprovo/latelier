import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { AuditRepo } from '../../electron/db/repositories/AuditRepo';
import { MaintenanceService } from '../../electron/services/MaintenanceService';
import { truncateWal } from '../../electron/db/sqlite';
import { createTempDb, type TempDb } from '../helpers/db';

const MARKER = 'SECRET-MARKER-7f3a9c1e-do-not-keep';

describe('secure_delete and WAL truncation', () => {
  let tmp: TempDb;
  beforeEach(() => {
    tmp = createTempDb();
  });
  afterEach(() => tmp.cleanup());

  it('opens the database with secure_delete on', () => {
    expect(tmp.db.pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('leaves no trace of an expired row in the .db or -wal bytes after the maintenance pass', () => {
    // The row under test needs no parent connection.
    tmp.db.pragma('foreign_keys = OFF');
    tmp.db
      .prepare(
        `INSERT INTO recent_queries (
           id, connection_id, db_name, collection, kind, payload_json,
           ran_at, duration_ms, result_count, error_code
         ) VALUES ('old', 'c', 'mydb', 'items', 'find', ?, ?, 5, 1, NULL)`,
      )
      .run(JSON.stringify({ filter: MARKER }), new Date(Date.now() - 60 * 86_400_000).toISOString());
    // Put the marker in the main file, so the purge has to erase it there.
    expect(truncateWal(tmp.db)).toBe(true);
    const dbPath = path.join(tmp.dir, 'mongolab.db');
    expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(true);

    const store = new Map<string, unknown>();
    new MaintenanceService({
      recentRepo: new RecentQueryRepo(tmp.db),
      auditRepo: new AuditRepo(tmp.db),
      checkpoint: () => void truncateWal(tmp.db),
    }).runIfNeeded({
      get: <T>(key: string) => (store.get(key) ?? null) as T | null,
      set: <T>(key: string, value: T) => void store.set(key, value),
    });

    expect(tmp.db.prepare("SELECT 1 FROM recent_queries WHERE id = 'old'").get()).toBeUndefined();
    expect(fs.readFileSync(dbPath).includes(MARKER)).toBe(false);
    expect(fs.readFileSync(`${dbPath}-wal`).includes(MARKER)).toBe(false);
  });

  it('truncateWal reports false while another connection holds a read transaction', () => {
    tmp.db.exec('CREATE TABLE probe (x)');
    tmp.db.prepare('INSERT INTO probe VALUES (1)').run();
    const reader = new BetterSqlite3(path.join(tmp.dir, 'mongolab.db'));
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM probe').all();
      tmp.db.prepare('INSERT INTO probe VALUES (2)').run();
      tmp.db.pragma('busy_timeout = 0');
      expect(truncateWal(tmp.db)).toBe(false);
    } finally {
      reader.close();
    }
  });
});
