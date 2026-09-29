import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { NotFoundError } from '../../electron/errors';
import { createTempDb, type TempDb } from '../helpers/db';
import type { CollectionTab, WorkspaceTab } from '../../shared/types';

// The service returns the `WorkspaceTab` union; the fields these tests read
// (view, pageSize, activeView, aggregation) only exist on the collection variant.
function asCollectionTab(tab: WorkspaceTab): CollectionTab {
  if (tab.kind !== 'collection') throw new Error(`expected a collection tab, got ${tab.kind}`);
  return tab;
}

function seedConnection(tmp: TempDb, id: string): void {
  const now = new Date().toISOString();
  tmp.db
    .prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, 'c-' || ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
    )
    .run(id, id, now, now);
}

describe('WorkspaceStateService', () => {
  let tmp: TempDb;
  let svc: WorkspaceStateService;
  let repo: WorkspaceTabRepo;

  beforeEach(() => {
    tmp = createTempDb();
    repo = new WorkspaceTabRepo(tmp.db);
    svc = new WorkspaceStateService(repo);
    seedConnection(tmp, 'conn');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('openCollection with reuseExisting=true (default) does not duplicate', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    expect(a.id).toBe(b.id);
    expect(svc.list().length).toBe(1);
  });

  it('openCollection with reuseExisting=false creates a new tab', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const b = svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      reuseExisting: false,
    });
    expect(a.id).not.toBe(b.id);
    expect(svc.list().length).toBe(2);
  });

  it('is_active is exclusive', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const list = svc.list();
    const active = list.filter((t) => t.isActive);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(b.id);
    expect(list.find((t) => t.id === a.id)!.isActive).toBe(false);
  });

  it('openAggregation reuses the matching collection tab and flips activeView', () => {
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(a.id).toBe(c.id);
    expect(a.kind).toBe('collection');
    expect(a.state.activeView).toBe('aggregation');
    expect(a.state.aggregation).toBeDefined();
    // No second tab spawned.
    expect(svc.list().length).toBe(1);
  });

  it('openAggregation creates a fresh tab when no matching collection tab exists', () => {
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(a.kind).toBe('collection');
    expect(a.state.activeView).toBe('aggregation');
  });

  it('openAggregation preserves existing aggregation state across re-opens', () => {
    const a = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    svc.update(a.id, {
      state: {
        aggregation: {
          ...a.state.aggregation!,
          stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
        },
      },
    });
    const b = asCollectionTab(svc.openAggregation({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(b.id).toBe(a.id);
    expect(b.state.aggregation?.stages.length).toBe(1);
  });

  it('update merges patch into state', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    const updated = asCollectionTab(svc.update(tab.id, {
      state: { view: 'JSON' },
    }));
    expect(updated.kind).toBe('collection');
    expect(updated.state.view).toBe('JSON');
    // default field still present
    expect(updated.state.pageSize).toBe(50);
  });

  it('update round-trips activeView:"structure" and a second field in the same patch', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.update(tab.id, { state: { activeView: 'structure', page: 2 } });
    const reread = asCollectionTab(svc.get(tab.id));
    expect(reread.state.activeView).toBe('structure');
    expect(reread.state.page).toBe(2);
  });

  it('close returns newActiveId = left neighbour when active closed', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.setActive(b.id);
    const r = svc.close(b.id);
    expect(r.newActiveId).toBe(a.id);
    expect(svc.list().find((t) => t.isActive)!.id).toBe(a.id);
    expect(c).toBeDefined();
  });

  it('close of non-active returns newActiveId null', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    // b is now active
    const r = svc.close(a.id);
    expect(r.newActiveId).toBeNull();
    expect(svc.list().find((t) => t.isActive)!.id).toBe(b.id);
  });

  it('close of last tab returns newActiveId null', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const r = svc.close(a.id);
    expect(r.newActiveId).toBeNull();
    expect(svc.list().length).toBe(0);
  });

  it('reorder persists a new ordering', () => {
    const a = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'a' });
    const b = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'b' });
    const c = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' });
    svc.reorder([c.id, a.id, b.id]);
    expect(svc.list().map((t) => t.collection)).toEqual(['c', 'a', 'b']);
  });

  it('get throws NotFoundError for unknown id', () => {
    expect(() => svc.get('missing')).toThrow(NotFoundError);
  });

  // ─── N0.5: renameCollectionTabs — keep open tabs pointed at reality ────
  describe('renameCollectionTabs', () => {
    it('retargets the matching tab in place, preserving its state', () => {
      const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      svc.update(tab.id, { state: { page: 3, pageSize: 100 } });

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: true, closed: false });
      const updated = svc.get(tab.id);
      expect(updated.collection).toBe('orders2');
      expect(updated.dbName).toBe('d');
      // Non-namespace state survives the retarget.
      expect((updated as CollectionTab).state.page).toBe(3);
      expect((updated as CollectionTab).state.pageSize).toBe(100);
      expect(svc.list().length).toBe(1);
    });

    it('is a no-op when no tab is open on the old namespace', () => {
      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'ghost',
        newCollection: 'ghost2',
      });
      expect(result).toEqual({ retargeted: false, closed: false });
      expect(svc.list().length).toBe(0);
    });

    it('is a no-op when oldCollection === newCollection', () => {
      svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders',
      });
      expect(result).toEqual({ retargeted: false, closed: false });
    });

    it('closes the stale tab instead of duplicating when a tab already targets the new name', () => {
      const stale = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const already = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders2' });

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: false, closed: true });
      expect(() => svc.get(stale.id)).toThrow(NotFoundError);
      expect(svc.get(already.id).collection).toBe('orders2');
      expect(svc.list().length).toBe(1);
    });

    it('activates the surviving tab when the closed stale tab was active (collision)', () => {
      const already = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders2' });
      const stale = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      svc.setActive(stale.id); // focus the tab that will be closed on rename

      const result = svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(result).toEqual({ retargeted: false, closed: true });
      const survivors = svc.list();
      expect(survivors.length).toBe(1);
      expect(survivors[0]!.id).toBe(already.id);
      // Focus lands on the surviving same-namespace tab, not an arbitrary neighbour.
      expect(survivors[0]!.isActive).toBe(true);
    });

    it('only retargets the tab on the matching connectionId', () => {
      seedConnection(tmp, 'other');
      const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'orders' });
      const otherConn = svc.openCollection({ connectionId: 'other', dbName: 'd', collection: 'orders' });

      svc.renameCollectionTabs({
        connectionId: 'conn',
        dbName: 'd',
        oldCollection: 'orders',
        newCollection: 'orders2',
      });

      expect(svc.get(tab.id).collection).toBe('orders2');
      expect(svc.get(otherConn.id).collection).toBe('orders');
    });
  });

  // ─── T0.5 / W07: sticky page-size default seeding ──────────────────────
  //
  // The renderer's `useWorkspaceTabs().openCollection` reads a global prefs
  // key before calling `tabs:openCollection` and forwards it as
  // `initialState.pageSize` when set, or omits `initialState` entirely on a
  // never-set (null) pref. These two integration tests exercise the service
  // side of both branches directly (no prefs repo involved at this layer).
  it('openCollection seeds pageSize from a caller-supplied initialState on a brand-new tab', () => {
    const tab = asCollectionTab(svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 250 },
    }));
    expect(tab.kind).toBe('collection');
    expect(tab.state.pageSize).toBe(250);
  });

  it('openCollection falls back to the default pageSize (50) when no initialState is supplied (null-pref branch)', () => {
    // Mirrors the renderer omitting `initialState` entirely when
    // `api.prefs.get('ui.workspace.defaultPageSize')` resolves to `null` —
    // this is what keeps W07 AC1 ("default page size is 50") true for a
    // genuinely first-time user.
    const tab = asCollectionTab(svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'c' }));
    expect(tab.state.pageSize).toBe(50);
  });

  it('openCollection reuse path ignores initialState.pageSize — an already-open tab keeps its own persisted size', () => {
    const first = svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 100 },
    });
    svc.update(first.id, { state: { pageSize: 500 } });
    // Re-open with a different sticky-default seed — the reuse branch must
    // not clobber the tab's own persisted pageSize.
    const reopened = asCollectionTab(svc.openCollection({
      connectionId: 'conn',
      dbName: 'd',
      collection: 'c',
      initialState: { pageSize: 10 },
    }));
    expect(reopened.id).toBe(first.id);
    expect(reopened.state.pageSize).toBe(500);
  });

  // ─── Performance regression guard ───────────────────────────────────────
  //
  // Every keystroke in a builder cell, query bar, or script editor lands
  // here via a 250 ms debounce on `api.tabs.update`. The handler accepts
  // `state: z.record(z.string(), z.unknown())` with no size validation, so
  // a giant pasted aggregation pipeline can balloon `state_json` to
  // hundreds of KB. The call does a `findById` SELECT * + synchronous
  // JSON merge + UPDATE on the main thread; if it ever blows past tens
  // of ms, IPC queues stack behind it. 200 ms is loose enough not to
  // flake in CI but strict enough to catch a 5-10× regression.
  it('update with a 500KB state payload stays inside a wall-clock budget', () => {
    const tab = svc.openCollection({ connectionId: 'conn', dbName: 'd', collection: 'big' });
    const fat: Record<string, unknown> = { queryRaw: 'x'.repeat(500 * 1024) };
    const t0 = Date.now();
    svc.update(tab.id, { state: fat });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
    // Sanity: the blob actually round-trips through the SQLite write.
    const refetched = svc.get(tab.id);
    const stored = (refetched as { state: { queryRaw?: string } }).state.queryRaw;
    expect(stored?.length).toBe(500 * 1024);
  });

  // ─── W13 — legacy state_json hydration ───────────────────────────
  //
  // A tab persisted before W13 has `state_json` shaped like the pre-#277
  // world: `queryDirty` present, `builder` carrying `conditions`/`logic`,
  // and no `queryRaw` key at all. `CollectionTabState.queryRaw` is required
  // now — if `{...DEFAULT_COLLECTION_TAB_STATE, ...parsed}` ever stopped
  // filling that gap, every renderer call site that does `state.queryRaw
  // .trim()` (`currentFilterJson`, `isDefaultQueryState`) would throw a
  // TypeError on launch instead of falling back to `'{}'`. This is §8's
  // "stale keys in persisted state are ignored" made checkable — every other
  // test in this file writes through `svc.update`, whose payload always
  // carries a fresh `queryRaw`, so none of them would catch a regression
  // here.
  it('hydrates a pre-W13 legacy state_json without a queryRaw key to the required default, keeping sort/limit/projection', () => {
    const legacyStateJson = JSON.stringify({
      view: 'Tree',
      builder: {
        conditions: [
          { id: 1, field: 'status', op: '$eq', valType: 'string', value: 'active' },
        ],
        logic: 'AND',
        projection: ['name'],
        sort: '{"age":1}',
        limit: '10',
      },
      queryDirty: true,
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      // No `queryRaw` — the pre-`queryRaw` shape this migration accepts.
    });
    const id = 'legacy-tab-1';
    repo.insert({
      id,
      connection_id: 'conn',
      kind: 'collection',
      db_name: 'd',
      collection: 'legacy',
      state_json: legacyStateJson,
      position: repo.nextPosition(),
      is_active: 0,
      opened_at: new Date().toISOString(),
      pinned: 0,
    });

    const tab = asCollectionTab(svc.get(id));
    expect(tab.state.queryRaw).toBe('{}');
    expect(tab.state.builder.sort).toBe('{"age":1}');
    expect(tab.state.builder.limit).toBe('10');
    expect(tab.state.builder.projection).toEqual(['name']);

    // Same hydration path via list(), not just get().
    const listed = asCollectionTab(svc.list().find((t) => t.id === id)!);
    expect(listed.state.queryRaw).toBe('{}');
  });

  // ─── 'schema' → 'structure' migration on read ──────────────────────────
  describe('activeView migration on read', () => {
    function seedWithActiveView(activeView: unknown): string {
      const id = `view-tab-${String(activeView)}`;
      repo.insert({
        id,
        connection_id: 'conn',
        kind: 'collection',
        db_name: 'd',
        collection: 'c',
        state_json: JSON.stringify(
          activeView === undefined ? {} : { activeView },
        ),
        position: repo.nextPosition(),
        is_active: 0,
        opened_at: new Date().toISOString(),
        pinned: 0,
      });
      return id;
    }

    it('migrates a persisted schema view to structure', () => {
      const id = seedWithActiveView('schema');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('structure');
    });

    it('leaves a persisted structure view as structure', () => {
      const id = seedWithActiveView('structure');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('structure');
    });

    it('leaves documents and aggregation unchanged', () => {
      const docsId = seedWithActiveView('documents');
      const aggId = seedWithActiveView('aggregation');
      expect(asCollectionTab(svc.get(docsId)).state.activeView).toBe('documents');
      expect(asCollectionTab(svc.get(aggId)).state.activeView).toBe('aggregation');
    });

    it('falls back to documents for a garbage value', () => {
      const id = seedWithActiveView('not-a-real-view');
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });

    it('falls back to documents when activeView is absent', () => {
      const id = seedWithActiveView(undefined);
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });

    it('falls back to documents for unparseable state_json', () => {
      const id = 'view-tab-corrupt';
      repo.insert({
        id,
        connection_id: 'conn',
        kind: 'collection',
        db_name: 'd',
        collection: 'c',
        state_json: '{not json',
        position: repo.nextPosition(),
        is_active: 0,
        opened_at: new Date().toISOString(),
        pinned: 0,
      });
      expect(asCollectionTab(svc.get(id)).state.activeView).toBe('documents');
    });
  });
});
