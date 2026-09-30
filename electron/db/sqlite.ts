import path from 'node:path';
import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { loadMigrations, runMigrations, type Migration } from './migrationRunner.ts';
import type { Logger } from '../log.ts';

export interface OpenDatabaseOptions {
  /** Absolute path to the userData directory. */
  userDataDir: string;
  /** Override migrations (tests inject their own). */
  migrations?: Migration[];
  /** Override the filename (default 'mongolab.db'). */
  filename?: string;
  /** Receives a warning when the post-migration WAL checkpoint could not finish. */
  log?: Pick<Logger, 'warn'>;
}

/**
 * Folds the WAL into the main file and truncates it, so pages freed under
 * `secure_delete` (zeroed) are the only copy left on disk. Returns false when
 * SQLite reports the checkpoint was blocked by another connection.
 */
export function truncateWal(db: Database): boolean {
  const [row] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  return row?.busy === 0;
}

export function openDatabase(opts: OpenDatabaseOptions): Database {
  const filename = opts.filename ?? 'mongolab.db';
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  const dbPath = path.join(opts.userDataDir, filename);

  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Per-connection, and on before migrations so a migration that scrubs data
  // zeroes the bytes it frees instead of leaving them in a free page.
  db.pragma('secure_delete = ON');

  const migrations = opts.migrations ?? loadMigrations();
  runMigrations(db, migrations);
  if (!truncateWal(db)) opts.log?.warn('db', 'wal checkpoint after migrations was blocked');

  return db;
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // ignore double-close
  }
}

export function withTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}
