-- Migration 011: drop the preview_fields table.
-- Preview-field prefs (PreviewPicker, prefs:get/setPreviewFields) are gone —
-- the Tree view's collapsed-row preview now reads the Fields control's
-- per-tab columnConfig (workspace_tabs.state_json) instead of a persisted
-- per-collection setting.
-- Append-only; never edit after merge. Fixes go in a new migration.

DROP TABLE preview_fields;

UPDATE schema_version SET version = 11;
