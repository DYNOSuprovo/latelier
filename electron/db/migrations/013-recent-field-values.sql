-- Migration 013: per-field value history for the builder's value-suggestion
-- popover (X02 "Value suggestions"). Scoped to
-- (connection, db, collection, field) rather than cross-connection — a
-- dev/prod pair on the same cluster type must not leak values between them.
-- Append-only; never edit after merge. Fixes go in a new migration.

CREATE TABLE recent_field_values (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  db_name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field TEXT NOT NULL,                 -- dotted path, same shape as CondNode.field
  value TEXT NOT NULL,                 -- display-string form the user typed/selected
  val_type TEXT NOT NULL,              -- mirrors CondNode.valType
  last_used_at TEXT NOT NULL,          -- ISO-8601
  use_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX recent_field_values_uniq
  ON recent_field_values(connection_id, db_name, collection, field, value);

CREATE INDEX recent_field_values_lookup
  ON recent_field_values(connection_id, db_name, collection, field, last_used_at DESC);

UPDATE schema_version SET version = 13;
