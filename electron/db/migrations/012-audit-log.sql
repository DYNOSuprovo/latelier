-- 012-audit-log.sql
-- Operation audit log (X13): one row per audited Operation, succeeded or
-- failed. `summary_json` is the durable record; `undo_json` holds the
-- Pre-image and is nulled long before the row itself is swept.
-- The `op` set is frozen here because SQLite cannot alter a CHECK in place.
-- Append-only; never edit after merge.

CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  db_name        TEXT NOT NULL,
  collection     TEXT,
  op             TEXT NOT NULL CHECK(op IN (
                   'insertMany','updateOne','updateMany','deleteOne','deleteMany',
                   'collectionDrop','collectionRename','databaseDrop','import')),
  summary_json   TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK(outcome IN ('ok','error','partial')),
  error_code     TEXT,
  ran_at         TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  reversible     INTEGER NOT NULL DEFAULT 0,
  undo_json      TEXT,
  undone_at      TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_by_conn_time ON audit_log(connection_id, ran_at DESC);

UPDATE schema_version SET version = 12;
