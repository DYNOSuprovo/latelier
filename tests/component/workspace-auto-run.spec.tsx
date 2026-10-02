// Opening a collection tab auto-runs the base query so results render
// without a manual Run click — but only when the tab has never run
// (`lastRun == null`) and its filter/sort/limit/projection is still at the
// default (no saved query loaded in ahead of activation).
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';

const now = '2026-06-01T12:00:00.000Z';

function makeCollectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: {
        projection: [],
        sort: '',
        limit: '',
      },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

const connections = [
  {
    id: 'c1',
    name: 'Local',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard' as const,
    readOnly: false,
    status: 'connected' as const,
  },
];

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function mountWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

describe('Workspace — auto-run on open', () => {
  it('AC1: a brand-new default-state tab auto-runs the base find without a manual Run click', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 12,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const { container } = mountWorkspace();

    // No fireEvent.click anywhere — the find must fire on its own.
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.filter).toBe('{}');

    // Results render (Tree view flattens `field:"value"` into one text node,
    // so match on the raw text content rather than an exact node).
    await waitFor(() => expect(container.textContent).toContain('Alice'));
  });

  it('AC2: switching between tabs that already have lastRun does not re-run any queries', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));
    const lastRun = { documents: [], durationMs: 5, ranAt: now };

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            id: 't1',
            isActive: true,
            position: 0,
            state: { ...makeCollectionTab().state, lastRun },
          }),
          makeCollectionTab({
            id: 't2',
            collection: 'orders',
            isActive: false,
            position: 1,
            state: { ...makeCollectionTab().state, lastRun },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const { container } = mountWorkspace();

    await screen.findByTestId('query-run-btn');
    // Give any stray effect a chance to fire before we assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();

    const tab2 = container.querySelector('[data-tab-id="t2"]');
    expect(tab2).toBeTruthy();
    fireEvent.click(tab2 as Element);

    await waitFor(() => expect(screen.getByTestId('query-run-btn')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('AC3: a tab that already holds results in memory does not auto-run', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              ...makeCollectionTab().state,
              lastRun: {
                documents: [{ _id: { $oid: 'a'.repeat(24) }, name: 'Restored' }],
                durationMs: 9,
                ranAt: now,
              },
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    const { container } = mountWorkspace();

    await waitFor(() => expect(container.textContent).toContain('Restored'));
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('AC4: a tab with a non-default loaded query does not auto-run', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
              // W13 — the filter is text-only now, so "a non-default loaded
              // query" is a non-default `queryRaw`, not a builder condition.
              queryRaw: '{"status":{"$eq":"active"}}',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const { container } = mountWorkspace();

    await screen.findByTestId('query-run-btn');
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();
    // Results are never persisted, so a restored custom-query tab has not run
    // yet: it must say so rather than claim the query matched nothing.
    expect(container.textContent).toContain('Run the query to see results');
    expect(container.textContent).not.toContain('No matching documents');
  });

  it('AC4b: editing a loaded non-default query down to default does not trigger a silent auto-run', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: {
              view: 'Tree',
              builder: { projection: [], sort: '', limit: '' },
              // W13 — the Filter drawer is a view of `queryRaw` (§5): seeding
              // it here is what makes the drawer render the "status" row this
              // test clicks "Remove condition" on.
              queryRaw: '{"status":{"$eq":"active"}}',
              page: 0,
              pageSize: 50,
              activeBuilderTab: 'Builder',
            },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    const { container } = mountWorkspace();

    await screen.findByTestId('query-run-btn');
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();

    // User deletes the loaded condition themselves — the filter collapses
    // to the default shape (no filter/sort/limit/projection), same shape a
    // brand-new tab would have. This must NOT be mistaken for "tab just
    // landed on Documents with nothing to show yet": the user is actively
    // editing, not opening the tab, so no background find should fire
    // behind their back.
    const removeBtn = await screen.findByLabelText('Remove condition status');
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Remove condition status"]')).toBeNull();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('does not auto-run a tab opened directly into the Aggregation sub-view', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 0,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [
          makeCollectionTab({
            state: { ...makeCollectionTab().state, activeView: 'aggregation' },
          }),
        ],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 0 }) },
    });

    mountWorkspace();

    // Aggregation's own run button, not the Documents "query-run-btn".
    await waitFor(() => expect(screen.queryByTestId('query-run-btn')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('AC5: the Run button still works on demand after the auto-run settles', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }],
      durationMs: 12,
      hasMore: false,
    }));

    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab()],
        setActive: async (id) => ({ id }),
        update: async () => makeCollectionTab(),
      },
      conn: { list: async () => connections },
      query: { find: findSpy, count: async () => ({ count: 1 }) },
    });

    mountWorkspace();

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));

    const runBtn = await screen.findByTestId('query-run-btn');
    fireEvent.click(runBtn);

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(2));
  });
});
