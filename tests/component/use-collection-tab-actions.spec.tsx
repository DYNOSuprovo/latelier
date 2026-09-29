// Direct coverage for `useCollectionTabActions` (ADR-003).
//
// The load-bearing case is the functional-updater invariant documented above
// `handleColumnResize` in the hook: `patchCollectionStateWith` must merge
// against the latest *pending* patch, not a possibly-stale
// `activeCollectionRef.current.state`, or two patches firing in the same
// tick clobber each other. `fakeTabs` below reproduces that pending-merge
// semantic from `state/workspaceTabs.ts:patchCollectionStateWith` closely
// enough to make the hazard observable — see the two-resizes-in-one-tick
// test.
import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '../helpers/render';
import { useCollectionTabActions } from '../../src/pages/Workspace/useCollectionTabActions';
import type { CollectionTab, CollectionTabState, ScriptTab } from '@shared/types';
import type { WorkspaceTabsState } from '../../src/state/workspaceTabs';

const NOW = '2026-08-01T12:00:00.000Z';

const BASE_STATE: CollectionTabState = {
  view: 'Tree',
  builder: { projection: [], sort: '', limit: '' },
  queryRaw: '{}',
  page: 0,
  pageSize: 50,
  activeBuilderTab: 'Builder',
};

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: BASE_STATE,
    ...overrides,
  };
}

function scriptTab(overrides: Partial<ScriptTab> = {}): ScriptTab {
  return {
    id: 's1',
    kind: 'script',
    connectionId: 'c1',
    dbName: '',
    collection: '',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: { title: 'Script 1', source: '' },
    ...overrides,
  };
}

/**
 * Stands in for the collection-tab slice of `useWorkspaceTabs`. Mirrors
 * `patchCollectionStateWith`'s real merge-against-pending semantics closely
 * enough that a hook bug sourcing `prev` from a stale ref instead of the
 * functional updater's own argument is observable here, same as it would be
 * against the real hook.
 */
function fakeTabs(initialState: CollectionTabState) {
  let state = initialState;
  let pending: Partial<CollectionTabState> = {};
  const patchCollectionStateWith = vi.fn(
    (_id: string, fn: (prev: CollectionTabState) => Partial<CollectionTabState>) => {
      const merged = { ...state, ...pending };
      const patch = fn(merged);
      pending = { ...pending, ...patch };
      state = { ...state, ...patch };
    },
  );
  const patchCollectionState = vi.fn((_id: string, patch: Partial<CollectionTabState>) => {
    pending = { ...pending, ...patch };
    state = { ...state, ...patch };
  });
  const patchAggregationState = vi.fn();
  const patchScriptState = vi.fn();
  const setActiveView = vi.fn();
  return {
    patchCollectionState,
    patchCollectionStateWith,
    patchAggregationState,
    patchScriptState,
    setActiveView,
    getState: () => state,
  };
}

function mountActions(
  tab: CollectionTab | null = collectionTab(),
  script: ScriptTab | null = null,
  run: (override?: Partial<CollectionTabState>) => Promise<void> = () => Promise.resolve(),
  cancel: () => void = () => {},
) {
  const activeCollectionRef = { current: tab } as React.RefObject<CollectionTab | null>;
  const activeScriptRef = { current: script } as React.RefObject<ScriptTab | null>;
  const tabs = fakeTabs(tab?.state ?? BASE_STATE);
  const view = renderHook(() =>
    useCollectionTabActions({
      activeCollectionRef,
      activeScriptRef,
      tabs: tabs as unknown as WorkspaceTabsState,
      run,
      cancel,
    }),
  );
  return { ...view, tabs, activeCollectionRef, activeScriptRef };
}

describe('useCollectionTabActions', () => {
  // The required test (ADR-003): two column resizes on different
  // fields fired synchronously must both land. A hook that sources `prev`
  // from `activeCollectionRef.current.state` instead of the functional
  // updater's argument reintroduces the staleness bug the comment warns
  // about — the second call would overwrite the first because both would
  // merge against the same pre-tick snapshot.
  it('two column resizes on different fields in the same tick both survive', () => {
    const { result, tabs } = mountActions();

    act(() => {
      result.current.handleColumnResize('sku', 100);
      result.current.handleColumnResize('qty', 200);
    });

    expect(tabs.getState().columns).toEqual({
      sku: { width: 100 },
      qty: { width: 200 },
    });
  });

  it('a row expand and a column resize in the same tick both survive', () => {
    const { result, tabs } = mountActions();

    act(() => {
      result.current.handleColumnResize('sku', 50);
      result.current.handleRowExpand('doc1', true);
    });

    expect(tabs.getState().columns).toEqual({ sku: { width: 50 } });
    expect(tabs.getState().expandedRows).toEqual({ doc1: true });
  });

  it('clearActiveFilter resets queryRaw to the empty-filter constant', () => {
    const { result, tabs } = mountActions(
      collectionTab({ state: { ...BASE_STATE, queryRaw: '{"status":"pending"}' } }),
    );

    act(() => result.current.clearActiveFilter());

    expect(tabs.getState().queryRaw).toBe('{}');
  });

  it('handleSortField patches the sort and re-runs with the same patch as an override', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result, tabs } = mountActions(collectionTab(), null, run);

    act(() => result.current.handleSortField('sku'));

    expect(tabs.getState().builder.sort).toBe('{"sku":1}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ builder: expect.any(Object) }));
  });

  it('patchActiveScript forwards to tabs.patchScriptState for the active script tab', () => {
    const script = scriptTab();
    const { result, tabs } = mountActions(null, script);

    act(() => result.current.patchActiveScript({ source: 'db.orders.find()' }));

    expect(tabs.patchScriptState).toHaveBeenCalledWith('s1', { source: 'db.orders.find()' });
  });

  it('selectActiveView forwards to tabs.setActiveView for the active collection tab', () => {
    const { result, tabs } = mountActions();

    act(() => result.current.selectActiveView('aggregation'));

    expect(tabs.setActiveView).toHaveBeenCalledWith('t1', 'aggregation');
  });

  it('patchAggregation forwards to tabs.patchAggregationState', () => {
    const { result, tabs } = mountActions();

    act(() => result.current.patchAggregation({ outputHeight: 200 }));

    expect(tabs.patchAggregationState).toHaveBeenCalledWith('t1', { outputHeight: 200 });
  });

  it('runActiveCollection fires the stable run with an optional override', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountActions(collectionTab(), null, run);

    act(() => result.current.runActiveCollection({ page: 1 }));

    expect(run).toHaveBeenCalledWith({ page: 1 });
  });

  it('cancelActiveCollection forwards to the stable cancel', () => {
    const cancel = vi.fn();
    const { result } = mountActions(collectionTab(), null, () => Promise.resolve(), cancel);

    act(() => result.current.cancelActiveCollection());

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('patchActiveCollectionWith forwards the raw updater to tabs.patchCollectionStateWith', () => {
    const { result, tabs } = mountActions();
    const updater = (s: CollectionTabState) => ({ pageSize: s.pageSize + 1 });

    act(() => result.current.patchActiveCollectionWith(updater));

    expect(tabs.getState().pageSize).toBe(51);
  });

  // Every callback reads the active tab from a ref rather than closing over
  // a snapshot; with no active tab (e.g. Focused Tab moved to a Script tab)
  // the collection-scoped callbacks must no-op rather than throw.
  it('collection-scoped callbacks no-op when there is no active collection', () => {
    const { result, tabs } = mountActions(null);

    act(() => {
      result.current.handleColumnResize('sku', 100);
      result.current.handleRowExpand('doc1', true);
      result.current.patchSchema({ sampleSize: 5 });
      result.current.clearActiveFilter();
      result.current.handleSortField('sku');
      result.current.patchAggregation({ outputHeight: 1 });
      result.current.selectActiveView('documents');
      result.current.patchActiveCollection({ page: 2 });
      result.current.patchActiveCollectionWith((s) => ({ page: s.page + 1 }));
    });

    expect(tabs.patchCollectionState).not.toHaveBeenCalled();
    expect(tabs.patchCollectionStateWith).not.toHaveBeenCalled();
    expect(tabs.patchAggregationState).not.toHaveBeenCalled();
    expect(tabs.setActiveView).not.toHaveBeenCalled();
  });
});
