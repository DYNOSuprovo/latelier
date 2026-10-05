// One reducer (not four useStates) so every write gets the same unmount guard in useNavigatorTree.
// Map keys here are user-controlled strings — reads go through ownGet, see ownProperty.ts.
import type { CollectionInfo, DbInfo, IpcError } from '@shared/ipc';
import type { ProbeErrorCode } from '@shared/types';
import { ownGet } from '../../utils/ownProperty';

export interface ConnectionCache {
  dbs: DbInfo[] | null;
  colls: Record<string, CollectionInfo[]>;
  err: IpcError | null;
  dbsLoading: boolean;
  collsLoading: Record<string, boolean>;
}

export const emptyCache = (): ConnectionCache => ({
  dbs: null,
  colls: {},
  err: null,
  dbsLoading: false,
  collsLoading: {},
});

export interface ConnectErrorInfo {
  message: string;
  code?: ProbeErrorCode;
}

export interface NavigatorTreeState {
  caches: Record<string, ConnectionCache>;
  connectErrors: Record<string, ConnectErrorInfo>;
  // Accordion: at most one root expanded; null = all collapsed.
  expandedConnId: string | null;
  // Per-connection, not flat: two servers can both have an `admin` db.
  expanded: Record<string, Record<string, boolean>>;
}

export const initialNavigatorTreeState: NavigatorTreeState = {
  caches: {},
  connectErrors: {},
  expandedConnId: null,
  expanded: {},
};

export type NavigatorTreeAction =
  | { type: 'dbsLoadStart'; id: string }
  | { type: 'dbsLoadSuccess'; id: string; dbs: DbInfo[] }
  | { type: 'dbsLoadError'; id: string; err: IpcError }
  | { type: 'collsLoadStart'; id: string; dbName: string }
  | { type: 'collsLoadSuccess'; id: string; dbName: string; colls: CollectionInfo[] }
  | { type: 'collsLoadError'; id: string; dbName: string }
  | { type: 'cacheReset'; id: string }
  | { type: 'connectErrorSet'; id: string; message: string; code?: ProbeErrorCode }
  | { type: 'connectErrorClear'; id: string }
  // Fills a gap only — never overwrites a message the live status stream already delivered.
  | { type: 'connectErrorBackfill'; id: string; message: string; code?: ProbeErrorCode }
  | { type: 'expandedConnSet'; id: string | null }
  | { type: 'expandedConnSetIfNull'; id: string }
  | { type: 'dbExpandedSet'; connectionId: string; dbName: string; value: boolean };

export function navigatorTreeReducer(
  state: NavigatorTreeState,
  action: NavigatorTreeAction,
): NavigatorTreeState {
  switch (action.type) {
    case 'dbsLoadStart': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      return {
        ...state,
        caches: { ...state.caches, [action.id]: { ...c, dbsLoading: true, err: null } },
      };
    }
    case 'dbsLoadSuccess': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      return {
        ...state,
        caches: {
          ...state.caches,
          [action.id]: { ...c, dbs: action.dbs, dbsLoading: false, err: null },
        },
      };
    }
    case 'dbsLoadError': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      return {
        ...state,
        caches: {
          ...state.caches,
          [action.id]: { ...c, dbsLoading: false, err: action.err },
        },
      };
    }
    case 'collsLoadStart': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      if (ownGet(c.collsLoading, action.dbName)) return state;
      return {
        ...state,
        caches: {
          ...state.caches,
          [action.id]: {
            ...c,
            collsLoading: { ...c.collsLoading, [action.dbName]: true },
          },
        },
      };
    }
    case 'collsLoadSuccess': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      return {
        ...state,
        caches: {
          ...state.caches,
          [action.id]: {
            ...c,
            colls: { ...c.colls, [action.dbName]: action.colls },
            collsLoading: { ...c.collsLoading, [action.dbName]: false },
          },
        },
      };
    }
    case 'collsLoadError': {
      const c = ownGet(state.caches, action.id) ?? emptyCache();
      return {
        ...state,
        caches: {
          ...state.caches,
          [action.id]: {
            ...c,
            collsLoading: { ...c.collsLoading, [action.dbName]: false },
          },
        },
      };
    }
    case 'cacheReset':
      return { ...state, caches: { ...state.caches, [action.id]: emptyCache() } };
    case 'connectErrorSet':
      return {
        ...state,
        connectErrors: {
          ...state.connectErrors,
          [action.id]: { message: action.message, code: action.code },
        },
      };
    case 'connectErrorClear': {
      if (ownGet(state.connectErrors, action.id) === undefined) return state;
      const next = { ...state.connectErrors };
      delete next[action.id];
      return { ...state, connectErrors: next };
    }
    case 'connectErrorBackfill': {
      if (ownGet(state.connectErrors, action.id)?.message) return state;
      return {
        ...state,
        connectErrors: {
          ...state.connectErrors,
          [action.id]: { message: action.message, code: action.code },
        },
      };
    }
    case 'expandedConnSet':
      return { ...state, expandedConnId: action.id };
    case 'expandedConnSetIfNull':
      return state.expandedConnId === null
        ? { ...state, expandedConnId: action.id }
        : state;
    case 'dbExpandedSet': {
      const { connectionId, dbName, value } = action;
      const connExpanded = ownGet(state.expanded, connectionId) ?? {};
      if ((ownGet(connExpanded, dbName) ?? false) === value) return state;
      return {
        ...state,
        expanded: {
          ...state.expanded,
          [connectionId]: { ...connExpanded, [dbName]: value },
        },
      };
    }
    default: {
      // Exhaustiveness check at compile time; guards a malformed action at runtime too.
      const _exhaustive: never = action;
      throw new Error(`navigatorTreeReducer: unhandled action type ${JSON.stringify((_exhaustive as NavigatorTreeAction).type)}`);
    }
  }
}
