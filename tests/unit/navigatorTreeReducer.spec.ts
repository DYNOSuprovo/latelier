import { describe, it, expect } from 'vitest';
import {
  navigatorTreeReducer,
  initialNavigatorTreeState,
  emptyCache,
  type NavigatorTreeState,
  type NavigatorTreeAction,
} from '../../src/pages/Workspace/navigatorTreeReducer';
import type { CollectionInfo, DbInfo, IpcError } from '@shared/ipc';

const DBS: DbInfo[] = [{ name: 'admin', sizeOnDisk: 0, empty: false }];
const COLLS: CollectionInfo[] = [
  { name: 'users', type: 'collection', documentCount: 0, sizeBytes: 0, indexCount: 1, capped: false },
];
const ERR: IpcError = { code: 'INTERNAL', message: 'boom' };

// Pins emptyCache's own shape independent of the reducer, so a mutation to
// one of its fields can't hide behind a `{ ...emptyCache(), ... }` spread in
// an assertion below that never independently re-asserts that field.
describe('emptyCache', () => {
  it('is the all-empty starting shape', () => {
    expect(emptyCache()).toEqual({
      dbs: null,
      colls: {},
      err: null,
      dbsLoading: false,
      collsLoading: {},
    });
  });
});

describe('dbsLoadStart / dbsLoadSuccess / dbsLoadError', () => {
  it('starting a load sets dbsLoading and clears a prior error, for a connection with no prior cache', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'dbsLoadStart',
      id: 'c1',
    });
    expect(next.caches.c1).toEqual({ ...emptyCache(), dbsLoading: true });
  });

  it('a success stores the rows and clears dbsLoading, leaving other connections untouched', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), dbsLoading: true }, c2: emptyCache() },
    };
    const next = navigatorTreeReducer(start, { type: 'dbsLoadSuccess', id: 'c1', dbs: DBS });
    expect(next.caches.c1).toEqual({ ...emptyCache(), dbs: DBS });
    expect(next.caches.c2).toEqual(emptyCache());
  });

  // The mutant this pins: `state.caches[id] ?? emptyCache()` flipped to
  // `state.caches[id] && emptyCache()`. dbsLoadSuccess only overwrites dbs /
  // dbsLoading / err, so colls and collsLoading are the two fields that only
  // ever survive via the `??` read of the *existing* cache — a prior cache
  // whose collsLoading/colls already happen to equal emptyCache()'s can't
  // tell the two operators apart, which is why the connection-with-no-prior-
  // cache case above doesn't kill this on its own.
  it('a success on a connection with cached collections preserves them, not just the new db list', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: {
        c1: { ...emptyCache(), colls: { admin: COLLS }, collsLoading: { test: true } },
      },
    };
    const next = navigatorTreeReducer(start, { type: 'dbsLoadSuccess', id: 'c1', dbs: DBS });
    expect(next.caches.c1).toEqual({
      ...emptyCache(),
      dbs: DBS,
      colls: { admin: COLLS },
      collsLoading: { test: true },
    });
  });

  it('an error stores the error and clears dbsLoading without touching dbs', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), dbsLoading: true, dbs: DBS } },
    };
    const next = navigatorTreeReducer(start, { type: 'dbsLoadError', id: 'c1', err: ERR });
    expect(next.caches.c1).toEqual({ ...emptyCache(), dbs: DBS, err: ERR });
  });
});

describe('collsLoadStart / collsLoadSuccess / collsLoadError', () => {
  it('starting a load sets collsLoading for that db only', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'collsLoadStart',
      id: 'c1',
      dbName: 'admin',
    });
    expect(next.caches.c1.collsLoading).toEqual({ admin: true });
  });

  // The dedup this pins (the navigator's own retry, and refreshDb's rapid-double-click
  // guard both lean on this staying a no-op): a second start while one is
  // already in flight for the same db must not touch state.
  it('starting a load that is already in flight for that db is a no-op — same state reference back', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), collsLoading: { admin: true } } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'collsLoadStart',
      id: 'c1',
      dbName: 'admin',
    });
    expect(next).toBe(start);
  });

  it('a second db starting to load does not clobber the first db already loading', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), collsLoading: { admin: true } } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'collsLoadStart',
      id: 'c1',
      dbName: 'test',
    });
    expect(next.caches.c1.collsLoading).toEqual({ admin: true, test: true });
  });

  it('a success stores the collections for that db and clears its loading flag, leaving other dbs alone', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: {
        c1: { ...emptyCache(), collsLoading: { admin: true, test: true }, colls: { test: [] } },
      },
    };
    const next = navigatorTreeReducer(start, {
      type: 'collsLoadSuccess',
      id: 'c1',
      dbName: 'admin',
      colls: COLLS,
    });
    expect(next.caches.c1.colls).toEqual({ test: [], admin: COLLS });
    expect(next.caches.c1.collsLoading).toEqual({ admin: false, test: true });
  });

  it('an error clears the loading flag for that db without touching colls', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), collsLoading: { admin: true }, colls: { admin: COLLS } } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'collsLoadError',
      id: 'c1',
      dbName: 'admin',
    });
    expect(next.caches.c1).toEqual({
      ...emptyCache(),
      collsLoading: { admin: false },
      colls: { admin: COLLS },
    });
  });
});

describe('cacheReset', () => {
  it('replaces the named connection cache with a fresh empty one, leaving others untouched', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      caches: { c1: { ...emptyCache(), dbs: DBS }, c2: { ...emptyCache(), dbs: DBS } },
    };
    const next = navigatorTreeReducer(start, { type: 'cacheReset', id: 'c1' });
    expect(next.caches.c1).toEqual(emptyCache());
    expect(next.caches.c2).toEqual({ ...emptyCache(), dbs: DBS });
  });
});

describe('connectErrorSet / connectErrorClear / connectErrorBackfill', () => {
  it('sets the message for an id', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'connectErrorSet',
      id: 'c1',
      message: 'nope',
    });
    expect(next.connectErrors).toEqual({ c1: { message: 'nope', code: undefined } });
  });

  it('keeps the error code beside the message, so the row can offer a code-specific action', () => {
    const set = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'connectErrorSet',
      id: 'c1',
      message: 'unreadable',
      code: 'SECRET_UNREADABLE',
    });
    expect(set.connectErrors['c1']).toEqual({ message: 'unreadable', code: 'SECRET_UNREADABLE' });
    const filled = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'connectErrorBackfill',
      id: 'c1',
      message: 'unreadable',
      code: 'SECRET_UNREADABLE',
    });
    expect(filled.connectErrors['c1']).toEqual({ message: 'unreadable', code: 'SECRET_UNREADABLE' });
  });

  it('clears an id that has a message', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      connectErrors: { c1: { message: 'nope' }, c2: { message: 'also nope' } },
    };
    const next = navigatorTreeReducer(start, { type: 'connectErrorClear', id: 'c1' });
    expect(next.connectErrors).toEqual({ c2: { message: 'also nope' } });
  });

  it('clearing an id with no message is a no-op — same state reference back', () => {
    const start = initialNavigatorTreeState;
    const next = navigatorTreeReducer(start, { type: 'connectErrorClear', id: 'c1' });
    expect(next).toBe(start);
  });

  it('backfill fills a gap', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'connectErrorBackfill',
      id: 'c1',
      message: 'backfilled',
    });
    expect(next.connectErrors).toEqual({ c1: { message: 'backfilled', code: undefined } });
  });

  // The invariant this pins: the live status stream always wins over a
  // backfill read that was in flight when it landed.
  it('backfill never overwrites a message already set — same state reference back', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      connectErrors: { c1: { message: 'live-stream message' } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'connectErrorBackfill',
      id: 'c1',
      message: 'stale backfill',
    });
    expect(next).toBe(start);
  });
});

describe('expandedConnSet / expandedConnSetIfNull', () => {
  it('sets the expanded connection unconditionally, including collapsing to null', () => {
    const start: NavigatorTreeState = { ...initialNavigatorTreeState, expandedConnId: 'c1' };
    expect(navigatorTreeReducer(start, { type: 'expandedConnSet', id: null }).expandedConnId).toBeNull();
    expect(
      navigatorTreeReducer(initialNavigatorTreeState, { type: 'expandedConnSet', id: 'c2' })
        .expandedConnId,
    ).toBe('c2');
  });

  it('setIfNull fills an unset accordion', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'expandedConnSetIfNull',
      id: 'c1',
    });
    expect(next.expandedConnId).toBe('c1');
  });

  // The invariant this pins: a root the user is reading is never closed by
  // someone else's connection completing.
  it('setIfNull never stomps a root already expanded — same state reference back', () => {
    const start: NavigatorTreeState = { ...initialNavigatorTreeState, expandedConnId: 'c1' };
    const next = navigatorTreeReducer(start, { type: 'expandedConnSetIfNull', id: 'c2' });
    expect(next).toBe(start);
  });
});

describe('dbExpandedSet', () => {
  it('sets a db expanded for a connection with no prior map', () => {
    const next = navigatorTreeReducer(initialNavigatorTreeState, {
      type: 'dbExpandedSet',
      connectionId: 'c1',
      dbName: 'admin',
      value: true,
    });
    expect(next.expanded).toEqual({ c1: { admin: true } });
  });

  it('two databases on the same connection do not clobber each other', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      expanded: { c1: { admin: true } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'dbExpandedSet',
      connectionId: 'c1',
      dbName: 'test',
      value: true,
    });
    expect(next.expanded).toEqual({ c1: { admin: true, test: true } });
  });

  // The invariant this pins: two servers with an identically-named database
  // (e.g. both have `admin`) keep independent open/closed flags.
  it('the same db name on a different connection is independent', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      expanded: { c1: { admin: true } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'dbExpandedSet',
      connectionId: 'c2',
      dbName: 'admin',
      value: true,
    });
    expect(next.expanded).toEqual({ c1: { admin: true }, c2: { admin: true } });
  });

  it('setting to the value already stored is a no-op — same state reference back', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      expanded: { c1: { admin: true } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'dbExpandedSet',
      connectionId: 'c1',
      dbName: 'admin',
      value: true,
    });
    expect(next).toBe(start);
  });

  it('collapsing (value: false) clears the flag', () => {
    const start: NavigatorTreeState = {
      ...initialNavigatorTreeState,
      expanded: { c1: { admin: true } },
    };
    const next = navigatorTreeReducer(start, {
      type: 'dbExpandedSet',
      connectionId: 'c1',
      dbName: 'admin',
      value: false,
    });
    expect(next.expanded).toEqual({ c1: { admin: false } });
  });
});

// The `default` arm is unreachable through the typed action-creator surface
// (TS's exhaustiveness check on `never` is what actually enforces that), but
// it is NOT unreachable at runtime — nothing stops a malformed object from
// reaching this reducer past the type system (a stale build, a bug in a
// caller). Propagating that object as the next state would make `caches`
// undefined on it, crashing far from the dispatch that caused it — so this
// exercises the fallback for real and pins that it fails loudly, on the
// spot, instead.
describe('an action type outside the known union (defensive fallback)', () => {
  it('throws naming the unrecognized type, rather than returning the action object as state', () => {
    const bogusAction = { type: 'not-a-real-action' } as unknown as NavigatorTreeAction;
    expect(() => navigatorTreeReducer(initialNavigatorTreeState, bogusAction)).toThrow(
      'navigatorTreeReducer: unhandled action type "not-a-real-action"',
    );
  });
});
