import type { Database, Statement } from 'better-sqlite3';
import type { AuditOp, AuditOutcome } from '@shared/types';

/**
 * Every column except `undo_json`, which never leaves the main process. On a
 * listed row `reversible` is whether Undo is still on offer; on disk it is
 * whether a Pre-image was ever captured (see `assertUndoable`).
 */
export interface AuditRow {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string | null;
  op: AuditOp;
  summary_json: string;
  outcome: AuditOutcome;
  error_code: string | null;
  ran_at: string;
  duration_ms: number;
  reversible: number;
  undone_at: string | null;
}

/** What `audit:undo` needs of an entry, Pre-image included. */
export interface AuditUndoRow {
  connection_id: string;
  db_name: string;
  collection: string | null;
  op: AuditOp;
  reversible: number;
  undo_json: string | null;
  undone_at: string | null;
}

export interface AuditListFilter {
  connectionId: string;
  dbName?: string;
  collection?: string;
  before?: string;
  limit: number;
}

const LISTED_COLUMNS = `id, connection_id, db_name, collection, op, summary_json, outcome,
  error_code, ran_at, duration_ms,
  (reversible = 1 AND undo_json IS NOT NULL AND undone_at IS NULL) AS reversible, undone_at`;

export class AuditRepo {
  private db: Database;
  private insertStmt: Statement;
  private deleteOlderThanStmt: Statement<[number]>;
  private findForUndoStmt: Statement<[string]>;
  private markUndoneStmt: Statement<[string, string]>;
  private expirePreImagesStmt: Statement<{ days: number; keep: number }>;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log
        (id, connection_id, db_name, collection, op, summary_json, outcome,
         error_code, ran_at, duration_ms, reversible, undo_json, undone_at)
      VALUES
        (@id, @connection_id, @db_name, @collection, @op, @summary_json, @outcome,
         @error_code, @ran_at, @duration_ms, @reversible, @undo_json, @undone_at)
    `);
    // julianday rather than a text comparison: `ran_at` is ISO-8601 with a `T`
    // separator, `datetime('now', ...)` is not (see RecentQueryRepo).
    this.deleteOlderThanStmt = db.prepare(
      "DELETE FROM audit_log WHERE julianday(ran_at) < julianday('now', '-' || ? || ' days')",
    );
    this.findForUndoStmt = db.prepare(
      'SELECT connection_id, db_name, collection, op, reversible, undo_json, undone_at FROM audit_log WHERE id = ?',
    );
    // The Pre-image goes with the undo: it has done its job, and holding it
    // would count a spent entry against the newest-200 allowance.
    this.markUndoneStmt = db.prepare(
      'UPDATE audit_log SET undone_at = ?, undo_json = NULL WHERE id = ? AND undone_at IS NULL',
    );
    this.expirePreImagesStmt = db.prepare(`
      UPDATE audit_log SET undo_json = NULL
      WHERE undo_json IS NOT NULL
        AND (julianday(ran_at) < julianday('now', '-' || @days || ' days')
             OR id IN (SELECT id FROM (
                  SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY connection_id ORDER BY ran_at DESC, rowid DESC) AS n
                  FROM audit_log WHERE undo_json IS NOT NULL)
                WHERE n > @keep))
    `);
  }

  insert(row: AuditRow, undoJson: string | null = null): void {
    this.insertStmt.run({ ...row, undo_json: undoJson });
  }

  findForUndo(id: string): AuditUndoRow | undefined {
    return this.findForUndoStmt.get(id) as AuditUndoRow | undefined;
  }

  markUndone(id: string, at: string): void {
    this.markUndoneStmt.run(at, id);
  }

  /**
   * Drops Pre-images past `days` days, or beyond the newest `keep` still held
   * per Connection — whichever bites first. The rows themselves stay: the
   * record outlives the ability to undo it. Returns the rows affected.
   */
  expirePreImages(days: number, keep: number): number {
    return this.expirePreImagesStmt.run({ days, keep }).changes;
  }

  /**
   * Newest first. `before` is an exclusive `ran_at` cursor. Operations started
   * in the same millisecond fall back to rowid — the order they were recorded.
   */
  list(filter: AuditListFilter): AuditRow[] {
    const conditions = ['connection_id = ?'];
    const params: unknown[] = [filter.connectionId];
    if (filter.dbName !== undefined) {
      conditions.push('db_name = ?');
      params.push(filter.dbName);
    }
    if (filter.collection !== undefined) {
      conditions.push('collection = ?');
      params.push(filter.collection);
    }
    if (filter.before !== undefined) {
      conditions.push('ran_at < ?');
      params.push(filter.before);
    }
    return this.db
      .prepare(
        `SELECT ${LISTED_COLUMNS} FROM audit_log WHERE ${conditions.join(' AND ')}
         ORDER BY ran_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as AuditRow[];
  }

  /** Delete audit rows older than `days` days. Returns the rows affected. */
  deleteOlderThan(days: number): number {
    return this.deleteOlderThanStmt.run(days).changes;
  }
}
