/**
 * Result-bearing fields of a tab's `state_json`. They hold real documents from
 * the user's databases, so they live in renderer memory only and are removed
 * before any write to SQLite.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a copy of `state` without `lastRun`, `aggregation.lastRun`,
 * `lastResult` and `lastError`. Everything else (including `lastRunHasMore`
 * and `totalCount`) is kept. Never mutates its input.
 */
export function stripResultFields(state: Record<string, unknown>): Record<string, unknown> {
  const out = { ...state };
  delete out.lastRun;
  delete out.lastResult;
  delete out.lastError;
  const agg = out.aggregation;
  if (isPlainObject(agg) && 'lastRun' in agg) {
    const aggCopy = { ...agg };
    delete aggCopy.lastRun;
    out.aggregation = aggCopy;
  }
  return out;
}

/** Single serialization point for every `state_json` write. */
export function serializeTabState(state: Record<string, unknown>): string {
  return JSON.stringify(stripResultFields(state));
}
