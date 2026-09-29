import { createContext, use, useCallback, useMemo, useState } from 'react';

// Shared stable "no documents yet" reference. Every call site that derives
// `documents` from `state.lastRun?.documents` and feeds it into
// `useResultSelection`/`useRowSelection` MUST fall back to this constant
// rather than a fresh `?? []` literal — a new array on every render looks
// like a *changed* resetKey to the "adjust state during render" reset
// pattern below, triggering `setState` on every single render (infinite
// render loop) instead of only when the result set actually changes.
export const EMPTY_DOCUMENTS: unknown[] = [];

/**
 * Bulk-selection surface (T0.4) scoped to one `<ResultViewer>` subtree.
 * Selection is a `Set<number>` of indices into the active `documents` array
 * — the common denominator across Table/Tree/JSON so a selection made in
 * one view mode survives switching to another (spec AC5). This is ephemeral
 * UI state; it deliberately never reaches `workspace_tabs.state_json`.
 */
export interface ResultSelectionValue {
  indices: Set<number>;
  /** Toggle a single index in/out of the selection (⌘/Ctrl+click). */
  toggle: (index: number) => void;
  /** Replace the selection with just this index, or clear if it's already
   *  the sole selected row (Table's keyboard Enter/Space activation — the
   *  mouse path is the checkbox/⌘/Ctrl+click `toggle` above). */
  selectOnly: (index: number) => void;
  clear: () => void;
}

export const ResultSelectionContext = createContext<ResultSelectionValue | null>(null);

/**
 * Owns the selection `Set<number>`, resetting whenever `resetKey` changes
 * identity — a new query run, page change, tab switch, or post-delete
 * re-run all produce a new `documents` array reference (spec AC6). Uses the
 * "adjust state during render" pattern (same as TreeView's `deepPaths`
 * reset): `setIndices`/`setPrevKey` calls only take effect on React's next
 * render, so this render's *return value* is explicitly overridden to the
 * post-reset Set (`activeIndices`) rather than the not-yet-updated `indices`
 * state, keeping every render's output consistent with the key it was
 * computed against instead of via a `useEffect`.
 */
export function useRowSelection(resetKey: unknown): ResultSelectionValue {
  const [indices, setIndices] = useState<Set<number>>(() => new Set());
  const [prevKey, setPrevKey] = useState<unknown>(resetKey);

  // Return `activeIndices` (not `indices`) below — the `setIndices` call
  // above only takes effect on React's next render. Overriding the local
  // value here keeps every render's *return* internally consistent with the
  // key it was computed against, rather than relying on the "adjust state
  // during render" discard-and-retry to paper over the mismatch.
  let activeIndices = indices;
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    if (indices.size > 0) {
      setIndices(new Set());
      activeIndices = new Set();
    }
  }

  const toggle = useCallback((index: number) => {
    setIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const selectOnly = useCallback((index: number) => {
    setIndices((prev) => (prev.size === 1 && prev.has(index) ? new Set() : new Set([index])));
  }, []);

  const clear = useCallback(() => setIndices((prev) => (prev.size === 0 ? prev : new Set())), []);

  return useMemo<ResultSelectionValue>(
    () => ({ indices: activeIndices, toggle, selectOnly, clear }),
    [activeIndices, toggle, selectOnly, clear],
  );
}

/**
 * Consumer hook for the three result views and the action bar. Reads the
 * shared context when a `<ResultSelectionProvider>` is mounted above (the
 * normal case — `ResultViewer` wraps its children in one); otherwise falls
 * back to hook-local state keyed on `documents` so standalone renders
 * (component/unit tests, any future ad-hoc composition) keep working
 * without requiring the provider.
 */
export function useResultSelection(documents: unknown[]): ResultSelectionValue {
  const ctx = use(ResultSelectionContext);
  const local = useRowSelection(documents);
  return ctx ?? local;
}
