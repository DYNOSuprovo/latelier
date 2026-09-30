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

describe('migration 015 — null undo_json', () => {
  let db: BetterSqlite3.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  function seedAudit(d: BetterSqlite3.Database, id: string, undoJson: string | null): void {
    d.prepare(
      `INSERT INTO audit_log
         (id, connection_id, db_name, collection, op, summary_json, outcome, ran_at, duration_ms, reversible, undo_json)
       VALUES (?, 'c1', 'db', 'coll', 'deleteOne', '{"op":"deleteOne"}', 'ok', ?, 1, ?, ?)`,
    ).run(id, new Date().toISOString(), undoJson === null ? 0 : 1, undoJson);
  }

  it('erases every stored Pre-image, keeps the audit rows and their flags, and lands on version 15', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig15-'));
    db = new BetterSqlite3(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    const all = loadMigrationsFromDisk();
    runMigrations(db, all.filter((m) => m.version < 15));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES ('c1', 'c1', 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(now, now);
    seedAudit(db, 'with-image', '{"preImage":{"_id":1,"secret":"legacy-body"}}');
    seedAudit(db, 'without-image', null);

    runMigrations(db, all.filter((m) => m.version <= 15));

    const rows = db.prepare('SELECT id, reversible, undo_json, summary_json FROM audit_log ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'with-image', reversible: 1, undo_json: null, summary_json: '{"op":"deleteOne"}' },
      { id: 'without-image', reversible: 0, undo_json: null, summary_json: '{"op":"deleteOne"}' },
    ]);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(15);
  });
});
