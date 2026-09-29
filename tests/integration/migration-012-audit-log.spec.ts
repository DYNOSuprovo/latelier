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

describe('migration 012 — audit log', () => {
  let db: BetterSqlite3.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  function version(d: BetterSqlite3.Database): number {
    return (d.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  it('applies to a database that predates it, and re-running the runner changes nothing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig12-'));
    db = new BetterSqlite3(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    const all = loadMigrationsFromDisk();
    runMigrations(db, all.filter((m) => m.version < 12));
    expect(version(db)).toBeLessThan(12);
    const hasTable = () =>
      db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get() !== undefined;
    expect(hasTable()).toBe(false);

    runMigrations(db, all);
    expect(hasTable()).toBe(true);
    const applied = version(db);
    expect(applied).toBeGreaterThanOrEqual(12);

    expect(() => runMigrations(db!, all)).not.toThrow();
    expect(version(db)).toBe(applied);
  });

  it('rejects an op outside the frozen set', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-mig12-'));
    db = new BetterSqlite3(path.join(dir, 'test.db'));
    runMigrations(db, loadMigrationsFromDisk());
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES ('c', 'c', 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(now, now);
    const insert = (op: string) =>
      db!.prepare(
        `INSERT INTO audit_log (id, connection_id, db_name, op, summary_json, outcome, ran_at, duration_ms)
         VALUES (?, 'c', 'd', ?, '{}', 'ok', ?, 0)`,
      ).run(op, op, now);
    expect(() => insert('import')).not.toThrow();
    expect(() => insert('replace')).toThrow(/CHECK constraint/);
  });
});
