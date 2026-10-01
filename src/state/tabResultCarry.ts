import type { AggregationTabState, CollectionTab, ScriptTab, WorkspaceTab } from '@shared/types';

// Main reseeds `aggregation` (new stages, name, savedId) when a saved pipeline
// is loaded into an already-open tab; the old output must not follow along.
// The seed only ever changes these three, so they define "same pipeline".
function samePipeline(a: AggregationTabState, b: AggregationTabState): boolean {
  return (
    a.name === b.name &&
    a.savedId === b.savedId &&
    JSON.stringify(a.stages) === JSON.stringify(b.stages)
  );
}

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
    if (
      aggLastRun !== undefined &&
      t.state.aggregation &&
      aggregation &&
      samePipeline(aggregation, t.state.aggregation)
    ) {
      state.aggregation = { ...t.state.aggregation, lastRun: aggLastRun };
    }
    return { ...t, state };
  });
}

/**
 * A tab patch lands in local state at once but reaches main only after the
 * debounce, so a list fetched in that window is stale for every field the
 * patch touched (page, query text, aggregation stages ...). Layering the
 * still-pending patches over the listed tabs makes the list agree with local
 * state again; `carryResultFields` then runs against the same pipeline, not a
 * stale one. Never mutates its inputs.
 */
export function applyPendingPatches(
  list: readonly WorkspaceTab[],
  pending: ReadonlyMap<string, object>,
): WorkspaceTab[] {
  return list.map((t): WorkspaceTab => {
    const patch = pending.get(t.id);
    return patch ? ({ ...t, state: { ...t.state, ...patch } } as WorkspaceTab) : t;
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
