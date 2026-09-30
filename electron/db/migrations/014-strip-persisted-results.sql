-- Migration 014: stop keeping query / aggregation / script result documents in
-- workspace_tabs.state_json. Results are a side effect of persisting UI state,
-- not something a tab needs on relaunch, and they can hold production data.
-- Existing rows are scrubbed here; new writes are stripped in
-- WorkspaceStateService. Rows whose state_json is not valid JSON are left
-- untouched rather than failing the migration.
-- Append-only; never edit after merge. Fixes go in a new migration.

UPDATE workspace_tabs
SET state_json = json_remove(
  state_json,
  '$.lastRun',
  '$.aggregation.lastRun',
  '$.lastResult',
  '$.lastError'
)
WHERE json_valid(state_json);

UPDATE schema_version SET version = 14;
