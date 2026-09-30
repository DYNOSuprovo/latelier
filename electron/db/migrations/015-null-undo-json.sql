-- Migration 015: Pre-images are no longer written to disk. They were full
-- before/after copies of edited documents in plaintext; undo is now served
-- from main-process memory for the running session only (UndoStore). The
-- column stays (append-only schema) but is always NULL from here on, and any
-- value a previous version left behind is erased now. The audit row itself
-- (what ran, when, how it ended) is untouched.
-- Append-only; never edit after merge. Fixes go in a new migration.

UPDATE audit_log SET undo_json = NULL WHERE undo_json IS NOT NULL;

UPDATE schema_version SET version = 15;
