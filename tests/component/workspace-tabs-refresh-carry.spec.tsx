import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '../helpers/render';
import { useWorkspaceTabs } from '../../src/state/workspaceTabs';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab, ScriptTab } from '@shared/types';

const now = '2026-04-21T12:00:00.000Z';

function collectionTab(id: string): CollectionTab {
  return {
    id,
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'db',
    collection: id,
    position: 0,
    isActive: false,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
  };
}

function scriptTab(id: string): ScriptTab {
  return {
    id,
    kind: 'script',
    connectionId: 'c1',
    dbName: '',
    collection: '',
    position: 1,
    isActive: false,
    openedAt: now,
    pinned: false,
    state: { title: 'S', source: '' },
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWorkspaceTabs — results survive a refresh', () => {
  it('opening or closing another tab keeps every other tab\'s in-memory results', async () => {
    // Main never persists results, so every listing comes back without them.
    const listed = () => [collectionTab('a'), scriptTab('s')];
    installAtelierMock({
      tabs: {
        list: async () => listed(),
        openCollection: async () => collectionTab('b'),
        close: async () => ({ newActiveId: null }),
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const run = { documents: [{ _id: 1 }], durationMs: 1, ranAt: now };
    act(() => {
      result.current.patchCollectionState('a', { lastRun: run });
      result.current.patchScriptState('s', {
        lastResult: { valueJson: '[1]', printBuffer: '', durationMs: 1 },
      });
    });

    await act(async () => {
      await result.current.openCollection({ connectionId: 'c1', dbName: 'db', collection: 'b' });
    });
    await act(async () => {
      await result.current.close('b');
    });

    const a = result.current.tabs.find((t) => t.id === 'a') as CollectionTab;
    const s = result.current.tabs.find((t) => t.id === 's') as ScriptTab;
    expect(a.state.lastRun).toEqual(run);
    expect(s.state.lastResult?.valueJson).toBe('[1]');
  });

  it('never sends result documents to main, and skips an update that carries nothing else', async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => collectionTab('a'));
    installAtelierMock({
      tabs: {
        list: async () => [collectionTab('a')],
        update: update as unknown as import('@shared/ipc').IpcApi['tabs']['update'],
      },
    });
    const { result } = renderHook(() => useWorkspaceTabs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loading).toBe(false);

    act(() => {
      result.current.patchCollectionState('a', {
        lastRun: { documents: [{ _id: 1 }], durationMs: 1, ranAt: now },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).not.toHaveBeenCalled();

    act(() => {
      result.current.patchCollectionState('a', {
        page: 2,
        lastRun: { documents: [{ _id: 2 }], durationMs: 1, ranAt: now },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('a', { state: { page: 2 } });
  });
});
