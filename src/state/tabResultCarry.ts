import type { CollectionTab, ScriptTab, WorkspaceTab } from '@shared/types';

/**
 * Result documents are never persisted (main strips them on every write), so
 * `api.tabs.list()` returns tabs with no `lastRun` / `aggregation.lastRun` /
 * `lastResult` / `lastError`. A refresh that replaced local tabs with that list
 * would blank every other tab's results whenever a tab is opened or closed.
 * This copies those in-memory fields from the previous local tab with the same
 * id onto the freshly listed one. Never mutates its inputs.
 */
export function carryResultFields(
  prev: readonly WorkspaceTab[],
  next: readonly WorkspaceTab[],
): WorkspaceTab[] {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  return next.map((t): WorkspaceTab => {
    const old = prevById.get(t.id);
    if (old?.kind !== t.kind) return t;
    if (t.kind === 'script') {
      const { lastResult, lastError } = (old as ScriptTab).state;
      if (lastResult === undefined && lastError === undefined) return t;
      return {
        ...t,
        state: {
          ...t.state,
          ...(lastResult !== undefined ? { lastResult } : {}),
          ...(lastError !== undefined ? { lastError } : {}),
        },
      };
    }
    const { lastRun, aggregation } = (old as CollectionTab).state;
    const aggLastRun = aggregation?.lastRun;
    if (lastRun === undefined && aggLastRun === undefined) return t;
    const state = { ...t.state, ...(lastRun !== undefined ? { lastRun } : {}) };
    if (aggLastRun !== undefined && t.state.aggregation) {
      state.aggregation = { ...t.state.aggregation, lastRun: aggLastRun };
    }
    return { ...t, state };
  });
}

/**
 * Drops the result-bearing keys from a pending state patch before it is sent
 * to main. Mirrors `stripResultFields` in `electron/services/tabStateResults.ts`
 * (the renderer cannot import from `electron/`); main remains the guarantee.
 */
export function stripResultPatch<P extends object>(patch: P): Partial<P> {
  const out: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  delete out.lastRun;
  delete out.lastResult;
  delete out.lastError;
  const agg = out.aggregation;
  if (typeof agg === 'object' && agg !== null && !Array.isArray(agg) && 'lastRun' in agg) {
    const aggCopy: Record<string, unknown> = { ...agg };
    delete aggCopy.lastRun;
    out.aggregation = aggCopy;
  }
  return out as Partial<P>;
}
