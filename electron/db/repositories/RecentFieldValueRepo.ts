import type { Database, Statement } from 'better-sqlite3';
import type { ValType } from '@shared/types';

export interface RecentFieldValueRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string;
  field: string;
  value: string;
  val_type: ValType;
  last_used_at: string;
  use_count: number;
}

export interface RecentFieldValueUpsert {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  value: string;
  valType: ValType;
  lastUsedAt: string;
}

export interface RecentFieldValueQuery {
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  limit?: number;
}

export interface RecentFieldValueEvict {
  connectionId: string;
  dbName: string;
  collection: string;
  field: string;
  keep: number;
}

const DEFAULT_LIST_LIMIT = 20;

export class RecentFieldValueRepo {
  private db: Database;
  private upsertStmt: Statement;
  private listStmt: Statement<[string, string, string, string, number]>;
  private evictStmt: Statement<[string, string, string, string, string, string, string, string, number]>;
  private deleteByConnectionStmt: Statement<[string]>;
  private clearAllStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    // `id` is inert on the UPDATE branch — a conflict keeps the row's
    // original id and only bumps use_count/last_used_at/val_type.
    this.upsertStmt = db.prepare(`
      INSERT INTO recent_field_values
        (id, connection_id, db_name, collection, field, value, val_type, last_used_at, use_count)
      VALUES
        (@id, @connection_id, @db_name, @collection, @field, @value, @val_type, @last_used_at, 1)
      ON CONFLICT(connection_id, db_name, collection, field, value)
      DO UPDATE SET
        last_used_at = excluded.last_used_at,
        val_type = excluded.val_type,
        use_count = use_count + 1
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM recent_field_values
      WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `);
    this.evictStmt = db.prepare(`
      DELETE FROM recent_field_values
      WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
        AND id NOT IN (
          SELECT id FROM recent_field_values
          WHERE connection_id = ? AND db_name = ? AND collection = ? AND field = ?
          ORDER BY last_used_at DESC
          LIMIT ?
        )
    `);
    this.deleteByConnectionStmt = db.prepare('DELETE FROM recent_field_values WHERE connection_id = ?');
    this.clearAllStmt = db.prepare('DELETE FROM recent_field_values');
  }

  /** Runs `fn` inside a SQLite transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsert(row: RecentFieldValueUpsert): void {
    this.upsertStmt.run({
      id: row.id,
      connection_id: row.connectionId,
      db_name: row.dbName,
      collection: row.collection,
      field: row.field,
      value: row.value,
      val_type: row.valType,
      last_used_at: row.lastUsedAt,
    });
  }

  list(q: RecentFieldValueQuery): RecentFieldValueRow[] {
    return this.listStmt.all(
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.limit ?? DEFAULT_LIST_LIMIT,
    ) as RecentFieldValueRow[];
  }

  /** Trims a `(conn, db, coll, field)` bucket to its `keep` most-recent rows. */
  evictOldest(q: RecentFieldValueEvict): void {
    this.evictStmt.run(
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.connectionId,
      q.dbName,
      q.collection,
      q.field,
      q.keep,
    );
  }

  /** Mirrors other repos' cascade-parity helper — FK handles this too. */
  deleteByConnection(connectionId: string): number {
    return this.deleteByConnectionStmt.run(connectionId).changes;
  }

  /** Full wipe — Settings' "Clear value history" action. */
  clearAll(): number {
    return this.clearAllStmt.run().changes;
  }
}
