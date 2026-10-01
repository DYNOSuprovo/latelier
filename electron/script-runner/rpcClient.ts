import { SystemError, ValidationError } from '../errors.ts';
import { ejsonParse, ejsonStringify } from '../mongo/ejson.ts';
import { fromWireError, type RpcFrame, type RpcReply } from './protocol.ts';
import { markWideIntegers, promoteNumbers } from './rpcCodec.ts';
import {
  ADMIN_METHODS,
  COLLECTION_CURSOR_METHODS,
  COLLECTION_METHODS,
  CURSOR_SHAPING_METHODS,
  DB_CURSOR_METHODS,
  DB_METHODS,
} from './rpcSurface.ts';

/**
 * The script child's `db`. It looks like the mongosh surface the scripts were
 * written against (`db.items.find().sort().toArray()`, `db.getSiblingDB`,
 * `db.runCommand`), but it holds no client and no connection details: every
 * call that has to reach the server becomes an `RpcFrame` that main answers.
 *
 * This file is convenience, not enforcement. A script can post frames itself,
 * so main's `rpcHost` checks everything again; what this does is make the
 * ordinary calls work and leave the driver's internals (`s`, `cursorClient`)
 * out of the script's reach entirely.
 *
 * Runs under Electron's utilityProcess and under Node's type stripping, so no
 * enums and no parameter properties.
 */

export interface DbCtx {
  /** The database `db.<coll>` and `db.runCommand` address; `use()` changes it. */
  currentDb: string;
}

export interface RpcClient {
  /** A `db` over `ctx`. */
  makeDb(ctx: DbCtx): unknown;
  /** Whether `value` is a cursor this client made (what a script's last expression may be). */
  isCursor(value: unknown): value is RpcCursor;
  /** Feed a message from main; true when it was an RPC reply (answered or stale). */
  handleReply(message: unknown): boolean;
}

/** What a script sees of a cursor. Opaque here; the class is private to `createRpcClient`. */
export interface RpcCursor {
  next(): Promise<unknown>;
  tryNext(): Promise<unknown>;
  close(): Promise<void>;
}

type FrameBase = Omit<RpcFrame, 'type' | 'id' | 'argsEjson'>;

interface CursorState {
  dbName: string;
  open: () => Promise<string>;
  shaping: Array<[string, unknown[]]>;
  mappers: Array<(doc: unknown) => unknown>;
  /** Set on the first terminal call; shaping is refused after it. */
  id?: Promise<string>;
  closed: boolean;
}

export function createRpcClient(send: (frame: RpcFrame) => void): RpcClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: RpcReply) => void; reject: (e: unknown) => void }>();

  function roundTrip(base: FrameBase, args: unknown[]): Promise<RpcReply> {
    const id = nextId++;
    return new Promise<RpcReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        send({ type: 'rpc', id, ...base, argsEjson: encodeArgs(args) });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  async function callValue(base: FrameBase, args: unknown[]): Promise<unknown> {
    const reply = await roundTrip(base, args);
    if (reply.type !== 'rpc-result' || !('valueEjson' in reply)) {
      throw new SystemError('INTERNAL', 'rpc: the host answered with a cursor where a value was expected');
    }
    return decodeValue(reply.valueEjson);
  }

  async function callCursor(base: FrameBase, args: unknown[]): Promise<string> {
    const reply = await roundTrip(base, args);
    if (reply.type !== 'rpc-result' || !('cursorId' in reply)) {
      throw new SystemError('INTERNAL', 'rpc: the host answered with a value where a cursor was expected');
    }
    return reply.cursorId;
  }

  const cursorState = new WeakMap<object, CursorState>();

  function stateOf(cursor: object): CursorState {
    const st = cursorState.get(cursor);
    if (st === undefined) throw new ValidationError('not a cursor');
    return st;
  }

  /** Create the cursor in main, then replay what was queued on it. Once. */
  function started(st: CursorState): Promise<string> {
    st.id ??= (async () => {
      const cursorId = await st.open();
      for (const [method, args] of st.shaping) {
        await callValue({ target: 'cursor', dbName: st.dbName, cursorId, method }, args);
      }
      return cursorId;
    })();
    return st.id;
  }

  async function terminal(cursor: object, method: string, args: unknown[]): Promise<unknown> {
    const st = stateOf(cursor);
    const cursorId = await started(st);
    return callValue({ target: 'cursor', dbName: st.dbName, cursorId, method }, args);
  }

  const applyMappers = (st: CursorState, doc: unknown): unknown =>
    st.mappers.reduce((acc, fn) => fn(acc), doc);

  class FacadeCursor {
    constructor(dbName: string, open: () => Promise<string>) {
      cursorState.set(this, { dbName, open, shaping: [], mappers: [], closed: false });
    }

    map(fn: (doc: unknown) => unknown): this {
      stateOf(this).mappers.push(fn);
      return this;
    }

    async toArray(): Promise<unknown[]> {
      const st = stateOf(this);
      const docs = (await terminal(this, 'toArray', [])) as unknown[];
      return st.mappers.length === 0 ? docs : docs.map((d) => applyMappers(st, d));
    }

    async next(): Promise<unknown> {
      const doc = await terminal(this, 'next', []);
      return doc === null ? null : applyMappers(stateOf(this), doc);
    }

    async tryNext(): Promise<unknown> {
      const doc = await terminal(this, 'tryNext', []);
      return doc === null ? null : applyMappers(stateOf(this), doc);
    }

    hasNext(): Promise<boolean> {
      return terminal(this, 'hasNext', []) as Promise<boolean>;
    }

    count(): Promise<number> {
      return terminal(this, 'count', []) as Promise<number>;
    }

    explain(verbosity?: unknown): Promise<unknown> {
      return terminal(this, 'explain', [verbosity]);
    }

    async close(): Promise<void> {
      const st = stateOf(this);
      if (st.closed) return;
      st.closed = true;
      // Never started means nothing exists in main to close.
      if (st.id !== undefined) await terminal(this, 'close', []);
    }

    /** The callback runs here, in the script's process; returning `false` stops early. */
    async forEach(fn: (doc: unknown) => unknown): Promise<void> {
      for (;;) {
        const doc = await this.next();
        if (doc === null) return;
        if ((await fn(doc)) === false) return;
      }
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, undefined> {
      try {
        for (;;) {
          const doc = await this.next();
          if (doc === null) return;
          yield doc;
        }
      } finally {
        await this.close();
      }
    }
  }

  // The shaping methods only queue: `find()` is synchronous in the driver, so
  // nothing can cross to main until a terminal call needs a real cursor.
  for (const method of CURSOR_SHAPING_METHODS) {
    Object.defineProperty(FacadeCursor.prototype, method, {
      configurable: true,
      writable: true,
      value(this: FacadeCursor, ...args: unknown[]): FacadeCursor {
        const st = stateOf(this);
        if (st.id !== undefined) {
          throw new ValidationError(`cursor.${method}(): the cursor has already started`);
        }
        st.shaping.push([method, args]);
        return this;
      },
    });
  }

  function makeCursor(dbName: string, open: () => Promise<string>): FacadeCursor {
    return new FacadeCursor(dbName, open);
  }

  function makeCollection(dbName: string, coll: string): unknown {
    const base: FrameBase = { target: 'collection', dbName, coll, method: '' };
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => `Collection(${dbName}.${coll})`;
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'collectionName') return coll;
          if (prop === 'dbName') return dbName;
          if (prop === 'namespace') return `${dbName}.${coll}`;
          // Not on the list: undefined, so `await coll` is not a thenable and
          // a typo reads as "not a function" like any other missing method.
          if (!COLLECTION_METHODS.has(prop)) return undefined;
          if (COLLECTION_CURSOR_METHODS.has(prop)) {
            return (...args: unknown[]) =>
              makeCursor(dbName, () => callCursor({ ...base, method: prop }, args));
          }
          return (...args: unknown[]) => callValue({ ...base, method: prop }, args);
        },
      },
    );
  }

  function makeAdmin(dbName: string): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol' || !ADMIN_METHODS.has(prop)) return undefined;
          return (...args: unknown[]) => callValue({ target: 'admin', dbName, method: prop }, args);
        },
      },
    );
  }

  function makeDb(ctx: DbCtx): unknown {
    return new Proxy(
      function db() {
        return ctx.currentDb;
      },
      {
        get(_target, prop) {
          if (prop === 'getName' || prop === Symbol.toPrimitive || prop === 'toString') {
            return () => ctx.currentDb;
          }
          if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => `Db(${ctx.currentDb})`;
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          // Read once, at access: `const c = db.items; use('x'); c.find()` stays on the old db.
          const dbName = ctx.currentDb;
          if (prop === 'getSiblingDB') return (name: string) => makeDb({ currentDb: name });
          if (prop === 'getCollection' || prop === 'collection') {
            return (name: string) => makeCollection(dbName, name);
          }
          if (prop === 'admin') return () => makeAdmin(dbName);
          if (DB_METHODS.has(prop)) {
            if (DB_CURSOR_METHODS.has(prop)) {
              return (...args: unknown[]) =>
                makeCursor(dbName, () => callCursor({ target: 'db', dbName, method: prop }, args));
            }
            return (...args: unknown[]) => callValue({ target: 'db', dbName, method: prop }, args);
          }
          return makeCollection(dbName, prop);
        },
      },
    );
  }

  return {
    makeDb,
    isCursor: (value): value is RpcCursor => value instanceof FacadeCursor,
    handleReply(message) {
      if (typeof message !== 'object' || message === null) return false;
      const m = message as { type?: unknown; id?: unknown };
      if (m.type !== 'rpc-result' && m.type !== 'rpc-error') return false;
      // A reply to an id nobody here is waiting on (a frame the script posted
      // by hand) is consumed, not fed to the run request handler.
      const waiter = typeof m.id === 'number' ? pending.get(m.id) : undefined;
      if (waiter === undefined) return true;
      pending.delete(m.id as number);
      const reply = message as RpcReply;
      if (reply.type === 'rpc-error') waiter.reject(fromWireError(reply.error));
      else waiter.resolve(reply);
      return true;
    },
  };
}

/**
 * Arguments as canonical EJSON (a wide integer is marked as a double first,
 * see `markWideIntegers`). Trailing `undefined`s are dropped (an EJSON
 * array would turn them into `null`, and `findOne(f, null)` is not
 * `findOne(f)`), and a `signal` option is dropped because the `signal` global
 * is an AbortSignal, which has no EJSON form: main threads its own.
 */
function encodeArgs(args: unknown[]): string {
  const out = args.map(withoutSignal);
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return ejsonStringify(markWideIntegers(out));
}

function withoutSignal(arg: unknown): unknown {
  if (arg === null || typeof arg !== 'object' || !('signal' in arg)) return arg;
  const { signal, ...rest } = arg as { signal: unknown };
  return signal instanceof AbortSignal ? rest : arg;
}

/** A result off the wire, as the driver would have handed it over (see `promoteNumbers`). */
function decodeValue(valueEjson: string): unknown {
  return promoteNumbers(ejsonParse(valueEjson), false);
}
