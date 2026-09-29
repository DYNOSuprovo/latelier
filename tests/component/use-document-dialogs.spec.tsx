// Direct coverage for `useDocumentDialogs` (R4).
//
// `workspace-delete-modes.spec.tsx` carves out T1.4/T1.5 because result-row
// selection is not reachable from a full-page mount in jsdom, so nothing at
// the component layer ever observes `deleteSelected` being reset. That gap is
// real: deleting `setDeleteSelected(null)` from `closeDeleteDialogs` survives
// the whole unit+component suite. R4 turned this state into a hook, which is
// exactly what makes it reachable — pin it here instead.
//
// The identity assertions pin the dependency arrays. The callbacks depend on
// the stable `run`, not the fresh `{ run, isLoading }` literal `useQueryRunner`
// returns each render; re-introducing the object dependency has no behavioral
// tell, so a two-render identity check is the only thing that catches it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import { fireEvent, renderHook, screen, waitFor } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { useDocumentDialogs } from '../../src/pages/Workspace/useDocumentDialogs';
import type { CollectionTab } from '@shared/types';
import type {
  RunnerTarget,
  UseQueryRunnerResult,
} from '../../src/pages/Workspace/useQueryRunner';

const DOC = { _id: '1', sku: 'widget' };

const NOW = '2026-08-01T12:00:00.000Z';

/** Minimal, fully-typed `CollectionTab` — only the fields `targetOf` reads matter. */
function tab(overrides: Partial<CollectionTab> = {}): CollectionTab {
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
    state: { view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' },
    ...overrides,
  };
}

function runnerTargetOf(t: CollectionTab): RunnerTarget {
  return {
    id: t.id,
    connectionId: t.connectionId,
    dbName: t.dbName,
    collection: t.collection,
    state: t.state,
  };
}

/**
 * Stands in for `useQueryRunner`, faithfully including the part that caused
 * the defect: a fresh result object on every render over a stable `run`.
 *
 * `openTabs` is the live tab list `resolveRunnerTarget` reads — the same
 * lookup `Workspace.tsx` does against `tabsRef`. It is mutable so a test can
 * close a tab (⌘W) or edit a tab's query state while a drawer is open, which
 * is the whole point of resolving at completion time instead of pinning a
 * `RunnerTarget` when the drawer opened.
 */
function mountDialogs(
  run: (
    override?: Partial<CollectionTab['state']>,
    target?: RunnerTarget,
  ) => Promise<void> = () => Promise.resolve(),
  activeTabId: string | null = 't1',
  initialTab: CollectionTab | null = null,
  openTabs: CollectionTab[] = initialTab ? [initialTab] : [],
) {
  const activeCollectionRef = { current: initialTab } as React.RefObject<CollectionTab | null>;
  const tabs = { current: openTabs };
  const resolveRunnerTarget = (tabId: string): RunnerTarget | null => {
    const t = tabs.current.find((x) => x.id === tabId);
    return t ? runnerTargetOf(t) : null;
  };
  let renders = 0;
  const view = renderHook(
    (props: { activeTabId: string | null }) => {
      renders += 1;
      const queryRunner: UseQueryRunnerResult = { run, cancel: () => {}, isLoading: false };
      return useDocumentDialogs({
        activeCollectionRef,
        queryRunner,
        activeTabId: props.activeTabId,
        resolveRunnerTarget,
        readOnly: false,
      });
    },
    { initialProps: { activeTabId } },
  );
  return { ...view, renderCount: () => renders, activeCollectionRef, tabs };
}

describe('useDocumentDialogs', () => {
  it('handleDeleted clears all three delete atoms and re-runs the query', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountDialogs(run);

    act(() => {
      result.current.setDeleteDoc(DOC);
      result.current.setDeleteSelected([DOC]);
    });
    expect(result.current.deleteDoc).toEqual(DOC);
    expect(result.current.deleteSelected).toEqual([DOC]);

    act(() => result.current.handleDeleted(undefined, 'Document deleted'));

    expect(result.current.deleteDoc).toBeNull();
    expect(result.current.deleteAllOpen).toBe(false);
    expect(result.current.deleteSelected).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('closeDeleteDialogs clears the same three atoms without re-running', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountDialogs(run);

    act(() => {
      result.current.setDeleteDoc(DOC);
      result.current.setDeleteSelected([DOC]);
    });
    act(() => result.current.closeDeleteDialogs());

    expect(result.current.deleteDoc).toBeNull();
    expect(result.current.deleteAllOpen).toBe(false);
    expect(result.current.deleteSelected).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  // a delete confirm is opened against one Focused Tab's collection,
  // but reads that collection live at render. Any route that moves the
  // Focused Tab elsewhere (⌘1..9, ⌘W, ⌘⌥Arrow, the command palette's
  // `tab.open:<db>:<coll>`) retargets the still-open confirm instead of
  // closing it, so a click on Delete lands on the newly focused collection.
  // All of those routes funnel through the same `activeTabId` change, so
  // closing here — instead of guarding each shortcut — covers every one.
  it('closes every delete dialog when the Focused Tab changes, without re-running', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result, rerender } = mountDialogs(run, 't1');

    act(() => {
      result.current.setDeleteDoc(DOC);
      result.current.setDeleteSelected([DOC]);
    });
    expect(result.current.deleteDoc).toEqual(DOC);
    expect(result.current.deleteSelected).toEqual([DOC]);

    rerender({ activeTabId: 't2' });

    expect(result.current.deleteDoc).toBeNull();
    expect(result.current.deleteAllOpen).toBe(false);
    expect(result.current.deleteSelected).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  // Update-all mirrors delete-all's atom (`useDocumentDialogs` reads its
  // target the same way DeleteConfirm does — live off the Focused Tab), so it
  // gets the same three behaviors: opened/closed via its own toggle,
  // re-running on completion, and closing (not surviving) a tab switch.
  it('handleUpdatedAll closes update-all and re-runs the query', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountDialogs(run, 't1', tab());

    act(() => result.current.openUpdateAllModal());
    expect(result.current.updateAllOpen).toBe(true);

    act(() => result.current.handleUpdatedAll(undefined, '2 matched, 2 modified'));

    expect(result.current.updateAllOpen).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('closeUpdateAllModal closes update-all without re-running', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountDialogs(run, 't1', tab());

    act(() => result.current.openUpdateAllModal());
    act(() => result.current.closeUpdateAllModal());

    expect(result.current.updateAllOpen).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('openUpdateAllModal is a no-op when there is no active collection', () => {
    const { result } = mountDialogs(undefined, 't1', null);

    act(() => result.current.openUpdateAllModal());

    expect(result.current.updateAllOpen).toBe(false);
  });

  it('closes update-all when the Focused Tab changes, without re-running', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result, rerender } = mountDialogs(run, 't1', tab());

    act(() => result.current.openUpdateAllModal());
    expect(result.current.updateAllOpen).toBe(true);

    rerender({ activeTabId: 't2' });

    expect(result.current.updateAllOpen).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('handleInserted closes the drawer, drops the duplicate payload and re-runs', () => {
    const run = vi.fn(() => Promise.resolve());
    const { result } = mountDialogs(run, 't1', tab());

    act(() => result.current.openDuplicate(DOC));
    expect(result.current.inserting).not.toBeNull();
    expect(result.current.inserting?.duplicateDocJson).toContain('widget');
    expect(result.current.inserting?.duplicateDocJson).not.toContain('_id');

    act(() => result.current.handleInserted());

    expect(result.current.inserting).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The Document Editor's edit and insert modes both carry the same
  // live-target hazard `DeleteConfirm` had before its own fix, but closing
  // them on a tab change would silently discard unsaved input. ADR-001's
  // remedy is to pin the target captured at open time instead, so these two
  // assert the pin survives a tab change rather than asserting a close.
  it('openEdit pins the target captured at open time; a later activeTabId change does not retarget or discard the draft', () => {
    const { result, rerender, activeCollectionRef } = mountDialogs(undefined, 't1', tab());

    act(() => result.current.openEdit(DOC));
    expect(result.current.editing).toEqual({
      doc: DOC,
      target: { tabId: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders' },
    });

    // Simulate the Focused Tab moving to a different collection — the ref
    // updates the way `useLatest(activeCollection)` would, and the hook
    // re-renders with a new `activeTabId`.
    activeCollectionRef.current = tab({ id: 't2', collection: 'users' });
    rerender({ activeTabId: 't2' });

    expect(result.current.editing).toEqual({
      doc: DOC,
      target: { tabId: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders' },
    });
  });

  it('openInsertModal pins the target captured at open time; a later activeTabId change does not retarget the draft', () => {
    const { result, rerender, activeCollectionRef } = mountDialogs(undefined, 't1', tab());

    act(() => result.current.openInsertModal());
    expect(result.current.inserting).toEqual({
      target: { tabId: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders' },
      duplicateDocJson: null,
    });

    activeCollectionRef.current = tab({ id: 't2', collection: 'users' });
    rerender({ activeTabId: 't2' });

    expect(result.current.inserting).toEqual({
      target: { tabId: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders' },
      duplicateDocJson: null,
    });
  });

  // Consequence (1) of ADR-001: the `activeCollection &&` guard drops out of
  // both drawer render sites, so a drawer opened on a collection tab must
  // survive a switch to a tab with no active collection (e.g. a Script tab,
  // where `activeCollectionRef.current` goes to `null`) instead of losing
  // its state the way it would if the drawer were still gated on
  // `activeCollection`.
  it('editing survives a tab change to a tab with no active collection', () => {
    const { result, rerender, activeCollectionRef } = mountDialogs(undefined, 't1', tab());

    act(() => result.current.openEdit(DOC));
    expect(result.current.editing).not.toBeNull();

    activeCollectionRef.current = null; // e.g. focus moved to a Script tab
    rerender({ activeTabId: 't2' });

    expect(result.current.editing).toEqual({
      doc: DOC,
      target: { tabId: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders' },
    });
  });

  it('openEdit and openInsertModal are no-ops when there is no active collection', () => {
    const { result } = mountDialogs(undefined, 't1', null);

    act(() => result.current.openEdit(DOC));
    expect(result.current.editing).toBeNull();

    act(() => result.current.openInsertModal());
    expect(result.current.inserting).toBeNull();
  });

  // The other half of ADR-001's pin. An earlier fix addressed *where the write lands* and
  // left the *refresh* reading the runner's live `active`, so a save on a
  // drawer pinned to t1 while t2 is focused re-queried t2 and left t1 — the
  // tab whose documents just changed — showing pre-write data.
  //
  // These assert the argument `run` receives, not that it was called: the
  // bug's whole tell is *which* tab is refreshed, and a call-count assertion
  // is green either way.
  describe('the post-write refresh follows the pinned tab, not the Focused Tab', () => {
    const t1 = tab();
    const t2 = tab({ id: 't2', collection: 'users' });

    function openOnT1AndFocusT2(
      run: (override?: Partial<CollectionTab['state']>, target?: RunnerTarget) => Promise<void>,
      open: 'edit' | 'insert',
    ) {
      const view = mountDialogs(run, 't1', t1, [t1, t2]);
      act(() =>
        open === 'edit' ? view.result.current.openEdit(DOC) : view.result.current.openInsertModal(),
      );
      view.activeCollectionRef.current = t2;
      view.rerender({ activeTabId: 't2' });
      return view;
    }

    it('handleDocSaved re-runs the pinned tab', () => {
      const run = vi.fn(() => Promise.resolve());
      const { result } = openOnT1AndFocusT2(run, 'edit');

      act(() => result.current.handleDocSaved());

      expect(run).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: 't1' }));
    });

    it('handleInserted re-runs the pinned tab', () => {
      const run = vi.fn(() => Promise.resolve());
      const { result } = openOnT1AndFocusT2(run, 'insert');

      act(() => result.current.handleInserted());

      expect(run).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: 't1' }));
    });

    // Fires with the drawer still open, so it is the instance most likely to
    // be left on the old code path.
    it('handlePartialInsert re-runs the pinned tab', () => {
      const run = vi.fn(() => Promise.resolve());
      const { result } = openOnT1AndFocusT2(run, 'insert');

      act(() => result.current.handlePartialInsert());

      expect(run).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: 't1' }));
    });

    // Resolved at completion time, not snapshotted at open time: t1's filter
    // can change (another surface patching its state) while the drawer is
    // open, and the refresh must use the current one or it re-runs a query
    // the tab no longer shows.
    it('resolves the pinned tab state live rather than snapshotting it at open time', () => {
      const run = vi.fn(() => Promise.resolve());
      const { result, tabs } = openOnT1AndFocusT2(run, 'edit');

      tabs.current = [
        { ...t1, state: { ...t1.state, queryRaw: '{"sku":"widget"}' } },
        t2,
      ];
      act(() => result.current.handleDocSaved());

      expect(run).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          id: 't1',
          state: expect.objectContaining({ queryRaw: '{"sku":"widget"}' }),
        }),
      );
    });

    // ⌘W on the source tab with the drawer still open. The write already
    // succeeded; there is no tab left to refresh, and falling back to the
    // Focused Tab would re-run an unrelated query.
    it('does not run at all when the pinned tab has been closed', () => {
      const run = vi.fn(() => Promise.resolve());
      const { result, tabs } = openOnT1AndFocusT2(run, 'edit');

      tabs.current = [t2];
      act(() => result.current.handleDocSaved());

      expect(run).not.toHaveBeenCalled();
      expect(result.current.editing).toBeNull();
    });
  });

  it('the query-running callbacks keep their identity across an unrelated re-render', () => {
    const { result, rerender, renderCount } = mountDialogs();
    const before = {
      handleInserted: result.current.handleInserted,
      handlePartialInsert: result.current.handlePartialInsert,
      handleDocSaved: result.current.handleDocSaved,
      handleDeleted: result.current.handleDeleted,
    };

    // Same activeTabId as mountDialogs' default — an "unrelated" re-render,
    // not a tab change, so the close-on-tab-change effect must not fire.
    rerender({ activeTabId: 't1' });
    expect(renderCount()).toBeGreaterThan(1);

    expect(result.current.handleInserted).toBe(before.handleInserted);
    expect(result.current.handlePartialInsert).toBe(before.handlePartialInsert);
    expect(result.current.handleDocSaved).toBe(before.handleDocSaved);
    expect(result.current.handleDeleted).toBe(before.handleDeleted);
  });

  describe('Undo toast', () => {
    afterEach(() => {
      notifications.clean();
      uninstallAtelierMock();
    });

    it('a Reversible delete offers Undo that re-runs the tab it came from, even after focus moved', async () => {
      const undo = vi.fn(async () => ({ restored: 1, skipped: 0 }));
      installAtelierMock({ audit: { undo } });
      const run = vi.fn(() => Promise.resolve());
      const t1 = tab();
      const t2 = tab({ id: 't2', collection: 'users' });
      const { result, activeCollectionRef } = mountDialogs(run, 't1', t1, [t1, t2]);

      act(() => result.current.handleDeleted('a1', 'Document deleted'));
      activeCollectionRef.current = t2;
      fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(undo).toHaveBeenCalledWith({ entryId: 'a1' });
      expect(run).toHaveBeenLastCalledWith(undefined, runnerTargetOf(t1));
    });

    it('a delete-all over the undo ceiling still shows the deleted-count toast, with no Undo button', async () => {
      const t1 = tab();
      const { result } = mountDialogs(() => Promise.resolve(), 't1', t1);

      act(() => result.current.handleDeleted(undefined, '1,001 documents deleted'));

      await waitFor(() => expect(screen.getByText('1,001 documents deleted')).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('a Reversible edit offers Undo that re-runs the pinned tab', async () => {
      installAtelierMock({ audit: { undo: async () => ({ restored: 1, skipped: 0 }) } });
      const run = vi.fn(() => Promise.resolve());
      const t1 = tab();
      const { result } = mountDialogs(run, 't1', t1);
      act(() => result.current.openEdit(DOC));

      act(() => result.current.handleDocSaved('a2'));
      expect(await screen.findByText('Document updated')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(run).toHaveBeenLastCalledWith(undefined, runnerTargetOf(t1));
    });

    it('a Reversible update-all offers Undo that re-runs the tab it came from, even after focus moved', async () => {
      const undo = vi.fn(async () => ({ restored: 2, skipped: 0 }));
      installAtelierMock({ audit: { undo } });
      const run = vi.fn(() => Promise.resolve());
      const t1 = tab();
      const t2 = tab({ id: 't2', collection: 'users' });
      const { result, activeCollectionRef } = mountDialogs(run, 't1', t1, [t1, t2]);

      act(() => result.current.handleUpdatedAll('a3', '2 matched, 2 modified'));
      activeCollectionRef.current = t2;
      fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(undo).toHaveBeenCalledWith({ entryId: 'a3' });
      expect(run).toHaveBeenLastCalledWith(undefined, runnerTargetOf(t1));
    });

    it('an update-all with no Reversible entry still shows the matched/modified count, with no Undo button', async () => {
      const t1 = tab();
      const { result } = mountDialogs(() => Promise.resolve(), 't1', t1);

      act(() => result.current.handleUpdatedAll(undefined, '5 matched, 5 modified'));

      await waitFor(() => expect(screen.getByText('5 matched, 5 modified')).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });
  });
});
