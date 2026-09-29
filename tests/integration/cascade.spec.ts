import { describe, it, expect, afterEach } from 'vitest';
import { createTempDb, type TempDb } from '../helpers/db';

describe('FK cascades on connections delete', () => {
  let tmp: TempDb | null = null;

  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  it('deleting a connection removes dependent rows in all child tables', () => {
    tmp = createTempDb();
    const db = tmp.db;

    const id = 'conn-1';
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, 'Conn', 'standard', 'localhost', 27017, 'none', ?, ?)`,
    ).run(id, now, now);

    db.prepare(
      `INSERT INTO connection_secrets (connection_id, field, ciphertext, updated_at)
       VALUES (?, 'password', ?, ?)`,
    ).run(id, Buffer.from('cipher'), now);

    db.prepare(
      `INSERT INTO saved_queries (id, connection_id, db_name, collection, kind, name, payload_json, created_at, updated_at)
       VALUES ('sq1', ?, 'db', 'coll', 'find', 'n', '{}', ?, ?)`,
    ).run(id, now, now);

    db.prepare(
      `INSERT INTO recent_queries (id, connection_id, db_name, collection, kind, payload_json, ran_at, duration_ms)
       VALUES ('rq1', ?, 'db', 'coll', 'find', '{}', ?, 12)`,
    ).run(id, now);

    db.prepare(
      `INSERT INTO workspace_tabs (id, connection_id, kind, db_name, collection, state_json, position, is_active, opened_at)
       VALUES ('tab1', ?, 'collection', 'db', 'coll', '{}', 0, 1, ?)`,
    ).run(id, now);

    // Delete parent; FK cascades wipe dependents.
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);

    const countFor = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE connection_id = ?`).get(id) as { c: number }).c;
    for (const t of [
      'connection_secrets',
      'saved_queries',
      'recent_queries',
      'workspace_tabs',
    ]) {
      expect(countFor(t), `expected ${t} empty`).toBe(0);
    }
  });
});
