import { describe, it, expect, beforeEach } from 'vitest';
import { makeDbProxy, type DbProxyCtx } from '../../electron/mongo/dbProxy';
import { ReadOnlyConnectionError } from '../../electron/errors';

/**
 * Hand-rolled fake MongoClient/Db/Collection/Admin/Cursor. No mongodb driver
 * involved: every call is a synchronous entry pushed onto a shared `calls`
 * log, which lets every refusal test assert the driver was never reached —
 * the thing the real integration suite (tests/integration/db-proxy.spec.ts)
 * can't prove as directly, since a passing real call and a refused one both
 * "look" like nothing happened from outside.
 *
 * What the fake can't plausibly imitate: real driver cursor semantics
 * (`AbortSignal` actually aborting an in-flight query), the real
 * `Object.prototype` alias-map footgun exercised by the integration test's
 * `valueOf` collection-name case, and anything that depends on wire
 * protocol behavior. Those stay covered only by the integration suite.
 */

let calls: string[] = [];

function log(...parts: unknown[]): void {
  calls.push(parts.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' '));
}

class FakeCursor {
  private readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  toArray(...args: unknown[]): Promise<unknown[]> {
    log(this.tag, 'toArray', ...args);
    return Promise.resolve([]);
  }
  forEach(_cb: unknown, ...args: unknown[]): Promise<void> {
    log(this.tag, 'forEach', ...args);
    return Promise.resolve();
  }
  next(...args: unknown[]): Promise<unknown> {
    log(this.tag, 'next', ...args);
    return Promise.resolve(null);
  }
  tryNext(...args: unknown[]): Promise<unknown> {
    log(this.tag, 'tryNext', ...args);
    return Promise.resolve(null);
  }
  hasNext(...args: unknown[]): Promise<boolean> {
    log(this.tag, 'hasNext', ...args);
    return Promise.resolve(false);
  }
  close(...args: unknown[]): Promise<void> {
    log(this.tag, 'close', ...args);
    return Promise.resolve();
  }
  sort(...args: unknown[]): this {
    log(this.tag, 'sort', ...args);
    return this;
  }
  limit(...args: unknown[]): this {
    log(this.tag, 'limit', ...args);
    return this;
  }
  cursorClient = { fake: 'unwrapped-client-handle' };
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    log(this.tag, 'asyncIterator');
    let done = false;
    return {
      next: () => {
        if (done) return Promise.resolve({ value: undefined, done: true });
        done = true;
        return Promise.resolve({ value: { _id: 1 }, done: false });
      },
    };
  }
}

class FakeCollection {
  // Mirrors the real driver: every Collection keeps its owning Db reachable
  // off a plain `s` bag — set by FakeDb.collection() below.
  s: { db: FakeDb } = { db: undefined as unknown as FakeDb };
  collectionName = 'fake';
  // writable:false but configurable:true — distinct from both a plain
  // enumerable field (writable+configurable) and a frozen one
  // (non-writable+non-configurable, via Object.freeze). Nothing else in
  // this fake produces this exact combination, and it's the one shape that
  // distinguishes guardedDescriptor's `d.configurable === false &&
  // d.writable === false` frozen-check from `d.writable === false` alone.
  roConfigurableRef!: { tag: string };

  constructor() {
    const ref = { tag: 'ro-configurable' };
    Object.defineProperty(this, 'roConfigurableRef', {
      value: ref,
      writable: false,
      configurable: true,
      enumerable: true,
    });
  }

  find(...args: unknown[]): FakeCursor {
    log('find', ...args);
    return new FakeCursor('find');
  }
  findOne(...args: unknown[]): Promise<unknown> {
    log('findOne', ...args);
    return Promise.resolve(null);
  }
  aggregate(...args: unknown[]): FakeCursor {
    log('aggregate', ...args);
    return new FakeCursor('aggregate');
  }
  listIndexes(...args: unknown[]): FakeCursor {
    log('listIndexes', ...args);
    return new FakeCursor('listIndexes');
  }
  listSearchIndexes(...args: unknown[]): FakeCursor {
    log('listSearchIndexes', ...args);
    return new FakeCursor('listSearchIndexes');
  }
  watch(...args: unknown[]): FakeCursor {
    log('watch', ...args);
    return new FakeCursor('watch');
  }
  countDocuments(...args: unknown[]): Promise<number> {
    log('countDocuments', ...args);
    return Promise.resolve(0);
  }
  estimatedDocumentCount(...args: unknown[]): Promise<number> {
    log('estimatedDocumentCount', ...args);
    return Promise.resolve(0);
  }
  distinct(...args: unknown[]): Promise<unknown[]> {
    log('distinct', ...args);
    return Promise.resolve([]);
  }
  insertOne(...args: unknown[]): Promise<unknown> {
    log('insertOne', ...args);
    return Promise.resolve({ acknowledged: true });
  }
  insertMany(...args: unknown[]): Promise<unknown> {
    log('insertMany', ...args);
    return Promise.resolve({ acknowledged: true });
  }
  updateOne(...args: unknown[]): Promise<unknown> {
    log('updateOne', ...args);
    return Promise.resolve({ acknowledged: true });
  }
  deleteOne(...args: unknown[]): Promise<unknown> {
    log('deleteOne', ...args);
    return Promise.resolve({ acknowledged: true });
  }
  drop(...args: unknown[]): Promise<boolean> {
    log('drop', ...args);
    return Promise.resolve(true);
  }
  createIndex(...args: unknown[]): Promise<string> {
    log('createIndex', ...args);
    return Promise.resolve('idx_1');
  }
  // mongosh alias target: `count` -> `countDocuments`.
  bulkWrite(...args: unknown[]): Promise<unknown> {
    log('bulkWrite', ...args);
    return Promise.resolve({ acknowledged: true });
  }
  // A builder-style method whose return is the same receiver, chainable —
  // exercises guardCapturedHandle's `out === t` branch.
  initializeUnorderedBulkOp(...args: unknown[]): FakeBulkBuilder {
    log('initializeUnorderedBulkOp', ...args);
    return new FakeBulkBuilder();
  }
}

class FakeBulkBuilder {
  insert(...args: unknown[]): this {
    log('bulk.insert', ...args);
    return this;
  }
  execute(...args: unknown[]): Promise<unknown> {
    log('bulk.execute', ...args);
    return Promise.resolve({ ok: 1 });
  }
}

/**
 * A synchronous builder-style step reached off a captured Admin handle —
 * mirrors FakeBulkBuilder's role for collections, but for guardCapturedHandle
 * itself (the Admin's own guard implementation), which re-wraps chained
 * results independently of wrapCollection's bulk-builder handling.
 */
class FakeAdminChainStep {
  // Returns a NEW step each call — exercises guardCapturedHandle's
  // `out !== t` branch (recursive re-wrap of a different object).
  next(...args: unknown[]): FakeAdminChainStep {
    log('adminChain.next', ...args);
    return new FakeAdminChainStep();
  }
  // A plain (non-function) nested object property — reaches guardPlainProperty
  // via guardCapturedHandle's own `read`, which builds the `what` string as
  // `${what}.${String(prop)}` (line 369) before guarding it recursively.
  nested = {
    write(...args: unknown[]): unknown {
      log('adminChain.nested.write', ...args);
      return { ok: 1 };
    },
  };
  finish(...args: unknown[]): Promise<unknown> {
    log('adminChain.finish', ...args);
    return Promise.resolve({ ok: 1 });
  }
  // Synchronous, non-promise, non-receiver returns — exercise
  // guardCapturedHandle's own passthrough/wrap checks directly (its `value`
  // parameter is one of these on the recursive `guardCapturedHandle(out, ...)`
  // call, not routed back through guardPlainProperty first).
  returnsNull(...args: unknown[]): null {
    log('adminChain.returnsNull', ...args);
    return null;
  }
  returnsNumber(...args: unknown[]): number {
    log('adminChain.returnsNumber', ...args);
    return 42;
  }
  // A synchronous function-typed return, itself carrying a nested "write"
  // method — distinguishes guardCapturedHandle's own value-type guard from a
  // raw passthrough: if the returned function isn't wrapped, `.grab()` below
  // never re-checks `ctx.isReadOnly`.
  returnsFunction(...args: unknown[]): (() => unknown) & { grab: () => unknown } {
    log('adminChain.returnsFunction', ...args);
    const fn = (() => 'called') as (() => unknown) & { grab: () => unknown };
    fn.grab = () => {
      log('adminChain.returnsFunction.grab');
      return 'grabbed';
    };
    return fn;
  }
}

class FakeAdmin {
  listDatabases(...args: unknown[]): Promise<{ databases: unknown[] }> {
    log('admin.listDatabases', ...args);
    return Promise.resolve({ databases: [] });
  }
  command(...args: unknown[]): Promise<unknown> {
    log('admin.command', ...args);
    return Promise.resolve({ ok: 1 });
  }
  // Returns `this` (the SAME raw receiver) — exercises guardCapturedHandle's
  // `out === t` branch (return the cached `guard`, not a fresh wrapper).
  chainSame(...args: unknown[]): this {
    log('admin.chainSame', ...args);
    return this;
  }
  chainStep(...args: unknown[]): FakeAdminChainStep {
    log('admin.chainStep', ...args);
    return new FakeAdminChainStep();
  }
}

class FakeDb {
  readonly databaseName: string;
  constructor(databaseName: string) {
    this.databaseName = databaseName;
  }
  collections = new Map<string, FakeCollection>();

  collection(name: string): FakeCollection {
    // Not logged: building a Collection handle is local object construction
    // (mirrors the real driver — `db.collection(name)` never talks to the
    // server), and the dbProxy `get` trap calls it on every property access
    // to build `wrapCollection(...)`, even for a read. Logging it would
    // pollute the "zero calls recorded" assertions that the refusal tests
    // rely on to prove the driver's actual read/write methods were never
    // reached.
    let c = this.collections.get(name);
    if (!c) {
      c = new FakeCollection();
      c.s.db = this;
      this.collections.set(name, c);
    }
    return c;
  }
  command(...args: unknown[]): Promise<unknown> {
    log('db.command', ...args);
    return Promise.resolve({ ok: 1 });
  }
  dropDatabase(...args: unknown[]): Promise<boolean> {
    log('db.dropDatabase', ...args);
    return Promise.resolve(true);
  }
  createCollection(...args: unknown[]): Promise<unknown> {
    log('db.createCollection', ...args);
    return Promise.resolve({});
  }
  private cachedAdmin: FakeAdmin | undefined;
  admin(): FakeAdmin {
    log('db.admin');
    // Cached (mirrors nothing in the real driver, which also returns a
    // fresh Admin per call) — this lets a test prove the unguarded fast
    // path (ctx.isReadOnly === undefined) returns the exact same instance
    // rather than a freshly-built guardCapturedHandle Proxy around it.
    this.cachedAdmin ??= new FakeAdmin();
    return this.cachedAdmin;
  }
}

class FakeMongoClient {
  dbs = new Map<string, FakeDb>();
  db(name: string): FakeDb {
    let d = this.dbs.get(name);
    if (!d) {
      d = new FakeDb(name);
      this.dbs.set(name, d);
    }
    return d;
  }
}

function makeCtx(overrides: Partial<DbProxyCtx> = {}): DbProxyCtx {
  const client = new FakeMongoClient();
  return { currentDb: 'testdb', client: client as never, ...overrides };
}

beforeEach(() => {
  calls = [];
});

describe('makeDbProxy — read-only: allowed vs denied collection methods', () => {
  function roProxy(): {
    things: Record<string, (...a: unknown[]) => unknown>;
  } {
    return makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: Record<string, (...a: unknown[]) => unknown>;
    };
  }

  it.each(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct'])(
    'allows %s under read-only',
    (method) => {
      const proxy = roProxy();
      expect(() => proxy.things[method]!()).not.toThrow();
    },
  );

  it.each(['insertOne', 'insertMany', 'updateOne', 'deleteOne', 'drop', 'createIndex', 'bulkWrite'])(
    'denies %s under read-only, before the fake records any call',
    (method) => {
      const proxy = roProxy();
      expect(() => proxy.things[method]!()).toThrow(ReadOnlyConnectionError);
      expect(calls).toEqual([]);
    },
  );

  it('denies a method the wrapper does not otherwise know about (deny-by-default)', () => {
    const proxy = roProxy();
    expect(() => proxy.things.initializeUnorderedBulkOp!()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('allows every read method while writable (no ctx.isReadOnly at all)', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as {
      things: Record<string, (...a: unknown[]) => unknown>;
    };
    expect(() => proxy.things.insertOne!()).not.toThrow();
    expect(calls).toEqual(['insertOne']);
  });
});

describe('makeDbProxy — mid-run flip reaches references already captured while writable', () => {
  it('a collection method cached while writable refuses after the flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      things: { insertOne: (...a: unknown[]) => unknown };
    };
    const insert = proxy.things.insertOne;
    readOnly = true;
    expect(() => insert()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('a cached direct Db method refuses after the flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      command: (...a: unknown[]) => unknown;
    };
    const command = proxy.command;
    readOnly = true;
    expect(() => command()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('a cached aggregate refuses a write-stage pipeline after the flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    const aggregate = proxy.things.aggregate;
    readOnly = true;
    expect(() => aggregate([{ $out: 'x' }])).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('an Admin object captured while writable refuses after the flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { command: (...a: unknown[]) => unknown };
    };
    const admin = proxy.admin();
    readOnly = true;
    expect(() => admin.command()).toThrow(ReadOnlyConnectionError);
    // `db.admin` itself was allowed to run while writable (it's the capture
    // step) — the guard only bites on the method called after the flip.
    expect(calls).toEqual(['db.admin']);
  });
});

describe('makeDbProxy — getSiblingDB', () => {
  it('spreads ctx, tracks the live isReadOnly, and leaves the current db unchanged', () => {
    let readOnly = false;
    const client = new FakeMongoClient();
    const ctx: DbProxyCtx = { currentDb: 'db1', client: client as never, isReadOnly: () => readOnly };
    const proxy = makeDbProxy(ctx) as unknown as {
      getSiblingDB: (name: string) => { things: { insertOne: (...a: unknown[]) => unknown } };
      getName: () => string;
    };

    const sibling = proxy.getSiblingDB('db2');
    expect(proxy.getName()).toBe('db1');

    // The sibling picks up a flip to the SAME live isReadOnly function.
    readOnly = true;
    expect(() => sibling.things.insertOne()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);

    readOnly = false;
    expect(() => sibling.things.insertOne()).not.toThrow();
  });
});

describe('makeDbProxy — aggregate write-stage detection', () => {
  it.each([[{ $out: 'x' }], [{ $merge: { into: 'x' } }]])(
    'refuses a pipeline containing %o under read-only',
    (writeStage) => {
      const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
        things: { aggregate: (...a: unknown[]) => unknown };
      };
      expect(() => proxy.things.aggregate([{ $match: {} }, writeStage])).toThrow(
        ReadOnlyConnectionError,
      );
      expect(calls).toEqual([]);
    },
  );

  it('allows a pipeline without a write stage under read-only', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.aggregate([{ $match: {} }, { $project: { a: 1 } }])).not.toThrow();
  });

  it('allows a pipeline containing a write stage while writable', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.aggregate([{ $out: 'x' }])).not.toThrow();
    expect(calls).toEqual(['aggregate [{"$out":"x"}]']);
  });

  it('a non-array pipeline argument is not treated as containing a write stage', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.aggregate(undefined)).not.toThrow();
  });
});

describe('makeDbProxy — every direct Db method other than collection is denied under read-only', () => {
  it.each(['dropDatabase', 'createCollection', 'command'])('denies db.%s', (method) => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    expect(() => proxy[method]!()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('denies db.admin() itself under read-only', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      admin: (...a: unknown[]) => unknown;
    };
    expect(() => proxy.admin()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('runCommand (the mongosh alias for command) is denied too, under the resolved name', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      runCommand: (...a: unknown[]) => unknown;
    };
    expect(() => proxy.runCommand({ ping: 1 })).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('collection() itself stays allowed under read-only (only the methods on it are gated)', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      collection: (name: string) => { find: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.collection('things').find()).not.toThrow();
  });
});

describe('makeDbProxy — mongosh to driver method aliases', () => {
  it('db.runCommand(...) calls the underlying db.command(...)', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as {
      runCommand: (...a: unknown[]) => unknown;
    };
    proxy.runCommand({ ping: 1 });
    expect(calls).toEqual(['db.command {"ping":1}']);
  });

  it('collection.count(...) calls the underlying countDocuments(...)', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as {
      things: { count: (...a: unknown[]) => unknown };
    };
    proxy.things.count({ a: 1 });
    expect(calls).toEqual(['countDocuments {"a":1}']);
  });
});

describe('makeDbProxy — signal threading', () => {
  it('find() with no args still gets the signal (missing positionals padded)', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find();
    expect(calls).toEqual(['find undefined {"signal":{}}']);
  });

  it('find(filter) merges the signal into a fresh options object', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find({ a: 1 });
    expect(calls).toEqual(['find {"a":1} {"signal":{}}']);
  });

  /** Builds a proxy over a FakeCollection whose `find` records the exact options object it received. */
  function proxyCapturingFindOpts(signal: AbortSignal): {
    proxy: { things: { find: (filter: unknown, opts?: { signal?: AbortSignal }) => unknown } };
    getCaptured: () => { signal?: AbortSignal } | undefined;
  } {
    let captured: { signal?: AbortSignal } | undefined;
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things');
    coll.find = (...args: unknown[]) => {
      captured = args[1] as { signal?: AbortSignal } | undefined;
      return new FakeCursor('find');
    };
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, signal }) as unknown as {
      things: { find: (filter: unknown, opts?: { signal?: AbortSignal }) => unknown };
    };
    return { proxy, getCaptured: () => captured };
  }

  it('an explicit signal in user options wins over the ctx signal', () => {
    const controller = new AbortController();
    const userSignal = new AbortController().signal;
    const { proxy, getCaptured } = proxyCapturingFindOpts(controller.signal);
    proxy.things.find({ a: 1 }, { signal: userSignal });
    expect(getCaptured()).toEqual({ signal: userSignal });
    expect(getCaptured()?.signal).not.toBe(controller.signal);
  });

  it('an explicit `signal: undefined` in user options is honored as an opt-out (still wins)', () => {
    const controller = new AbortController();
    const { proxy, getCaptured } = proxyCapturingFindOpts(controller.signal);
    proxy.things.find({}, { signal: undefined });
    expect(getCaptured()).toEqual({ signal: undefined });
    expect('signal' in (getCaptured() ?? {})).toBe(true);
  });

  it('estimatedDocumentCount (0 positionals) still gets the signal as its only argument', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { estimatedDocumentCount: (...a: unknown[]) => unknown };
    };
    proxy.things.estimatedDocumentCount();
    expect(calls).toEqual(['estimatedDocumentCount {"signal":{}}']);
  });

  it('a cursor-returning method (find) is wrapped so its terminal methods inherit the signal', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown } };
    };
    calls = [];
    proxy.things.find().toArray();
    // find (with padded signal) + toArray (with its own merged signal options)
    expect(calls).toEqual(['find undefined {"signal":{}}', 'find toArray {"signal":{}}']);
  });

  it('forEach threads the signal into its options slot (index 1, after the callback)', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => { forEach: (cb: unknown, ...a: unknown[]) => unknown } };
    };
    calls = [];
    const cb = () => {};
    proxy.things.find().forEach(cb);
    expect(calls).toEqual(['find undefined {"signal":{}}', 'find forEach {"signal":{}}']);
  });

  it('without ctx.signal, a cursor is returned unwrapped and terminal methods take no signal', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as {
      things: { find: (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown } };
    };
    calls = [];
    proxy.things.find().toArray();
    expect(calls).toEqual(['find', 'find toArray']);
  });
});

describe('makeDbProxy — guarded captured handles (read-only)', () => {
  it('a plain (non-function) property off a guarded object is itself guarded', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { s: { db: { collection: (n: string) => { insertOne: (...a: unknown[]) => unknown } } } };
    };
    expect(() => proxy.things.s.db.collection('x').insertOne()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('a bulk builder chain stays guarded across chained calls returning the same receiver', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { initializeUnorderedBulkOp: () => never };
    };
    // initializeUnorderedBulkOp itself is denied outright under read-only
    // (it's not in READ_COLL_METHODS) — the builder chain never gets built.
    expect(() => proxy.things.initializeUnorderedBulkOp()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('a promise returned from a guarded call passes through unguarded (denying .then would strand it)', async () => {
    const client = new FakeMongoClient();
    const admin = client.db('testdb').admin();
    void admin;
    let readOnly = false;
    const proxy = makeDbProxy(
      Object.assign(makeCtx({}), { isReadOnly: () => readOnly, client: client as never }),
    ) as unknown as { admin: () => { command: (...a: unknown[]) => Promise<unknown> } };
    const captured = proxy.admin();
    readOnly = true;
    // command() itself is denied synchronously before any promise is created —
    // there is nothing to strand here since the call never runs.
    expect(() => captured.command()).toThrow(ReadOnlyConnectionError);
  });
});

describe('makeDbProxy — getOwnPropertyDescriptor guard', () => {
  it('a descriptor read of a guarded plain property does not leak the raw value', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: object;
    };
    const desc = Object.getOwnPropertyDescriptor(proxy.things, 's') as
      | { value: { db: { collection: (n: string) => { insertOne: (...a: unknown[]) => unknown } } } }
      | undefined;
    expect(desc).toBeDefined();
    expect(() => desc!.value.db.collection('x').insertOne()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('a descriptor for a value untouched by the guard (e.g. collectionName) passes through verbatim', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: object;
    };
    const desc = Object.getOwnPropertyDescriptor(proxy.things, 'collectionName');
    expect(desc?.value).toBe('fake');
  });

  it('Object.seal on a guarded handle still reports the guarded value (writable stays true)', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { s: { db: { collection: (n: string) => { insertOne: (...a: unknown[]) => unknown } } } };
    };
    Object.seal(proxy.things);
    const desc = Object.getOwnPropertyDescriptor(proxy.things, 's') as
      | { value: { db: { collection: (n: string) => { insertOne: (...a: unknown[]) => unknown } } } }
      | undefined;
    expect(() => desc!.value.db.collection('x').insertOne()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('Object.freeze on a guarded handle refuses the descriptor read explicitly instead of leaking', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as { things: object };
    Object.freeze(proxy.things);
    expect(() => Object.getOwnPropertyDescriptor(proxy.things, 's')).toThrow(
      ReadOnlyConnectionError,
    );
  });

  it('Object.freeze does NOT deny a descriptor read for an untouched (non-substituted) property', () => {
    // `collectionName` is a primitive the guard never substitutes (guarded
    // === d.value), so the early `Object.is` return at line 300 should fire
    // before the frozen-check at line 301 is ever reached — freezing the
    // handle must not turn every descriptor read into a denial, only the
    // ones that actually needed a substituted (guarded) value.
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { collectionName: string };
    };
    Object.freeze(proxy.things);
    expect(() => Object.getOwnPropertyDescriptor(proxy.things, 'collectionName')).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(proxy.things, 'collectionName')?.value).toBe('fake');
  });

  it('a writable:false, configurable:true property (readonly but not frozen) is reported with its guarded value, not denied', () => {
    // Distinguishes the frozen-check's `d.configurable === false &&
    // d.writable === false` from `d.writable === false` alone: this
    // property is only non-writable, not non-configurable, so it is not
    // "frozen" in the sense the guard cares about (Object.freeze always
    // sets configurable:false too — this shape can't arise from seal or
    // freeze, only from defineProperty directly).
    const client = new FakeMongoClient();
    const rawColl = client.db('testdb').collection('things');
    const rawRef = rawColl.roConfigurableRef;
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, isReadOnly: () => true }) as unknown as {
      things: { roConfigurableRef: { tag: string } };
    };
    let desc: PropertyDescriptor | undefined;
    expect(() => {
      desc = Object.getOwnPropertyDescriptor(proxy.things, 'roConfigurableRef');
    }).not.toThrow();
    expect(desc).toBeDefined();
    expect((desc!.value as { tag: string }).tag).toBe('ro-configurable');
    // The value is guarded (substituted with a wrapper), not the raw ref —
    // confirms we actually reached the substitution path (guarded !==
    // d.value), not an early untouched-value passthrough that would have
    // skipped the frozen-check entirely regardless of this test's point.
    expect(desc!.value).not.toBe(rawRef);
  });
});

describe('makeDbProxy — the proxy target itself (db-name identity)', () => {
  it('getName() returns the current db name', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as { getName: () => string };
    expect(proxy.getName()).toBe('testdb');
  });

  it('toString() returns the current db name', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as { toString: () => string };
    expect(proxy.toString()).toBe('testdb');
  });

  it('coerces to its db name via Symbol.toPrimitive (String() / template literal)', () => {
    const proxy = makeDbProxy(makeCtx());
    expect(String(proxy)).toBe('testdb');
    expect(`${proxy}`).toBe('testdb');
  });

  it('exposes a Node inspect-custom formatting as `Db(<name>)`', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as Record<symbol, () => string>;
    const inspect = proxy[Symbol.for('nodejs.util.inspect.custom')];
    expect(inspect!()).toBe('Db(testdb)');
  });

  it('calling the underlying function target directly returns the current db name', () => {
    const proxy = makeDbProxy(makeCtx()) as unknown as () => string;
    expect(proxy()).toBe('testdb');
  });
});

describe('pipelineHasWriteStage — via aggregate under read-only', () => {
  function aggProxy(): { things: { aggregate: (...a: unknown[]) => unknown } } {
    return makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
  }

  it('a non-array pipeline is treated as having no write stage', () => {
    expect(() => aggProxy().things.aggregate('not-an-array')).not.toThrow();
  });

  it('an empty pipeline is allowed', () => {
    expect(() => aggProxy().things.aggregate([])).not.toThrow();
  });

  it('a null stage in the pipeline is skipped rather than crashing', () => {
    expect(() => aggProxy().things.aggregate([null])).not.toThrow();
  });

  it('a non-object (string) stage in the pipeline is skipped rather than crashing', () => {
    expect(() => aggProxy().things.aggregate(['not-a-stage'])).not.toThrow();
  });

  it('a stage with several keys where only one is a write op is still caught (some, not every)', () => {
    // Object.keys(stage).some(isWriteStage) must catch this; .every would require
    // ALL of the stage's keys to be write ops and would wrongly allow it through.
    expect(() =>
      aggProxy().things.aggregate([{ $addFields: { a: 1 }, $out: 'x' }]),
    ).toThrow(ReadOnlyConnectionError);
  });

  it('a stage with no write-op keys at all is allowed', () => {
    expect(() =>
      aggProxy().things.aggregate([{ $match: {}, $project: { a: 1 } }]),
    ).not.toThrow();
  });
});

describe('makeDbProxy — unguarded fast paths (no isReadOnly on ctx)', () => {
  it('a method that is neither signal-aware nor cursor-returning is bound raw even with a signal set', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { drop: (...a: unknown[]) => unknown };
    };
    proxy.things.drop();
    // No signal merged in — logged with no trailing options object, proving
    // the fast (unwrapped) path was taken rather than mergeSignalOptions.
    expect(calls).toEqual(['drop']);
  });

  it('a signal-aware method (find) still gets wrapped and merged even on the unguarded path', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find();
    expect(calls).toEqual(['find undefined {"signal":{}}']);
  });
});

describe('makeDbProxy — ctx.isReadOnly mutated to undefined after capture (optional chaining)', () => {
  it('a cached direct Db method does not crash if ctx.isReadOnly is later cleared', () => {
    const ctx: DbProxyCtx = { currentDb: 'testdb', client: new FakeMongoClient() as never, isReadOnly: () => true };
    const proxy = makeDbProxy(ctx) as unknown as { command: (...a: unknown[]) => unknown };
    const command = proxy.command;
    ctx.isReadOnly = undefined;
    expect(() => command()).not.toThrow(TypeError);
  });
});

describe('makeDbProxy — getOwnPropertyDescriptor guard: passthrough cases', () => {
  it('returns undefined for a property that does not exist at all', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as { things: object };
    expect(Object.getOwnPropertyDescriptor(proxy.things, 'nonexistent')).toBeUndefined();
  });

  it('passes an accessor descriptor (no `value`) through unguarded', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things');
    Object.defineProperty(coll, 'computed', { get: () => 'derived', enumerable: true, configurable: true });
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, isReadOnly: () => true }) as unknown as {
      things: { computed: string };
    };
    const desc = Object.getOwnPropertyDescriptor(proxy.things, 'computed');
    expect(desc).toBeDefined();
    expect('value' in (desc ?? {})).toBe(false);
    expect(proxy.things.computed).toBe('derived');
  });
});

describe('makeDbProxy — guardPlainProperty / guardCapturedHandle passthrough cases', () => {
  it('a primitive value off a guarded collection passes through unguarded', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { collectionName: string };
    };
    expect(proxy.things.collectionName).toBe('fake');
  });

  it('a null value off a guarded collection passes through unguarded', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as Record<string, unknown>;
    coll.nullish = null;
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, isReadOnly: () => true }) as unknown as {
      things: { nullish: unknown };
    };
    expect(proxy.things.nullish).toBeNull();
  });

  it('a promise returned by a guarded call passes through unwrapped, so awaiting it later still resolves after a flip', async () => {
    // dropDatabase() is a direct Db method, gated through guardCapturedHandle.
    // Call it while writable (isReadOnly() false) so it's allowed to run and
    // hand back a real Promise, then flip to read-only before awaiting. If
    // guardCapturedHandle wrapped the promise instead of passing it through,
    // `await` calling `.then` on it would route through the guarded `read`
    // trap and throw ReadOnlyConnectionError instead of resolving.
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      dropDatabase: () => Promise<boolean>;
    };
    const pending = proxy.dropDatabase();
    readOnly = true;
    await expect(pending).resolves.toBe(true);
  });
});

describe('makeDbProxy — wrapCursor edge cases', () => {
  it('a non-object/function cursor return value passes through unwrapped', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as { find: () => unknown };
    coll.find = () => 'not-a-cursor';
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, signal: new AbortController().signal }) as unknown as {
      things: { find: () => unknown };
    };
    expect(proxy.things.find()).toBe('not-a-cursor');
  });

  it('a guarded ctx (isReadOnly set, no signal) still wraps the cursor', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { find: (...a: unknown[]) => { toArray: () => Promise<unknown[]> } };
    };
    expect(() => proxy.things.find().toArray()).not.toThrow();
  });

  it('a cursor-shaping method (sort) that returns a NEW object gets independently wrapped', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as {
      find: () => { sort: (...a: unknown[]) => FakeCursor; toArray: () => Promise<unknown[]> };
    };
    coll.find = () => {
      const inner = new FakeCursor('inner');
      return {
        sort: () => new FakeCursor('sorted'),
        toArray: inner.toArray.bind(inner),
      } as unknown as { sort: (...a: unknown[]) => FakeCursor; toArray: () => Promise<unknown[]> };
    };
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never, signal: new AbortController().signal }) as unknown as {
      things: { find: () => { sort: (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown } } };
    };
    const sorted = proxy.things.find().sort({ a: 1 });
    // The sorted cursor is a genuinely different object, so it must be
    // (re-)wrapped independently — its own toArray still merges the signal.
    calls = [];
    sorted.toArray();
    expect(calls).toEqual(['sorted toArray {"signal":{}}']);
  });
});

describe('makeDbProxy — exact error messages', () => {
  it('readOnlyDenied names the exact method in its message', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { insertOne: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.insertOne()).toThrow(
      'This connection is read-only — "insertOne" is not permitted.',
    );
  });

  it('the aggregate write-stage refusal names the pipeline in its message', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.aggregate([{ $out: 'x' }])).toThrow(
      'This connection is read-only — the pipeline contains a write stage ($out/$merge).',
    );
  });

  it('a frozen guarded descriptor read names the property and "(frozen)" in its message', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as { things: object };
    Object.freeze(proxy.things);
    expect(() => Object.getOwnPropertyDescriptor(proxy.things, 's')).toThrow(
      'This connection is read-only — "things.s (frozen)" is not permitted.',
    );
  });

  it('a captured-handle method call names the nested path (what().prop) in its message', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { command: (...a: unknown[]) => unknown };
    };
    const admin = proxy.admin();
    readOnly = true;
    expect(() => admin.command()).toThrow('This connection is read-only — "admin().command" is not permitted.');
  });

  it('a captured-handle plain property read names the nested path in guardPlainProperty', () => {
    // `things.s` is a plain property guarded via guardPlainProperty; its
    // guarded child (`s.db`) is itself a captured handle whose own property
    // reads carry the accumulated `what` path.
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { s: { db: { collection: (n: string) => { insertOne: (...a: unknown[]) => unknown } } } };
    };
    expect(() => proxy.things.s.db.collection('x').insertOne()).toThrow(ReadOnlyConnectionError);
  });
});

describe('makeDbProxy — CURSOR_RETURNING_METHODS beyond find/aggregate', () => {
  it.each(['listIndexes', 'listSearchIndexes', 'watch'])(
    '%s is wrapped so its terminal methods inherit the signal',
    (method) => {
      const controller = new AbortController();
      const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
        things: Record<string, (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown }>;
      };
      calls = [];
      proxy.things[method]!().toArray();
      expect(calls).toEqual([`${method}`, `${method} toArray {"signal":{}}`]);
    },
  );
});

describe('makeDbProxy — CURSOR_TERMINAL_METHODS beyond toArray/forEach', () => {
  it.each(['next', 'tryNext', 'hasNext', 'close'])('%s inherits the signal', (method) => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown> };
    };
    calls = [];
    proxy.things.find()[method]!();
    expect(calls).toEqual(['find undefined {"signal":{}}', `find ${method} {"signal":{}}`]);
  });

  it('a cursor-shaping method not in CURSOR_TERMINAL_METHODS (limit) does not get a signal merged', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => { limit: (...a: unknown[]) => unknown } };
    };
    calls = [];
    proxy.things.find().limit(10);
    expect(calls).toEqual(['find undefined {"signal":{}}', 'find limit 10']);
  });
});

describe('makeDbProxy — pipelineHasWriteStage: undefined array element', () => {
  it('an `undefined` pipeline stage is skipped rather than crashing (typeof undefined !== object)', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { aggregate: (...a: unknown[]) => unknown };
    };
    // `Object.keys(undefined)` throws — if the `typeof stage === 'object'`
    // guard were forced true, this call would crash with a TypeError
    // instead of resolving to "not a write stage".
    expect(() => proxy.things.aggregate([undefined])).not.toThrow();
  });
});

describe('makeDbProxy — unguarded direct Db method returns the raw value unwrapped', () => {
  it('proxy.admin() with no ctx.isReadOnly returns the exact same Admin instance the driver hands back', () => {
    const client = new FakeMongoClient();
    const rawAdmin = client.db('testdb').admin();
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never }) as unknown as {
      admin: () => unknown;
    };
    // The fast (unguarded) path returns `fn.bind(db)`'s result directly; a
    // guarded/wrapped path would hand back a fresh guardCapturedHandle Proxy
    // around it instead, which would fail a strict identity check.
    expect(proxy.admin()).toBe(rawAdmin);
  });
});

describe('makeDbProxy — guardCapturedHandle: guarded-but-currently-writable and cleared isReadOnly', () => {
  it('a captured Admin method does NOT throw while the connection is still writable (guarded but not read-only)', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      admin: () => { command: (...a: unknown[]) => unknown };
    };
    const admin = proxy.admin();
    expect(() => admin.command()).not.toThrow();
  });

  it('a captured Admin method does not crash with a TypeError if ctx.isReadOnly is later cleared to undefined', () => {
    let readOnly = false;
    const ctx: DbProxyCtx = { currentDb: 'testdb', client: new FakeMongoClient() as never, isReadOnly: () => readOnly };
    const proxy = makeDbProxy(ctx) as unknown as { admin: () => { command: (...a: unknown[]) => unknown } };
    const admin = proxy.admin(); // captured while writable
    readOnly = true;
    ctx.isReadOnly = undefined;
    expect(() => admin.command()).not.toThrow(TypeError);
  });
});

describe('makeDbProxy — guardCapturedHandle chains a builder-style captured handle (line 361)', () => {
  it('a method returning the same receiver (out === t) hands back the identical cached guard', () => {
    const readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { chainSame: (...a: unknown[]) => unknown; command: (...a: unknown[]) => unknown };
    };
    const admin = proxy.admin();
    const chained = admin.chainSame();
    // Reference equality: guardCapturedHandle's `out === t ? guard : ...`
    // returns the SAME Proxy object when the method returns its own
    // receiver, rather than building a fresh wrapper around it.
    expect(chained).toBe(admin);
  });

  it('a method returning a NEW object (out !== t) is independently wrapped, not the same guard', () => {
    const readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { chainStep: (...a: unknown[]) => unknown };
    };
    const admin = proxy.admin();
    const step = admin.chainStep();
    expect(step).not.toBe(admin);
  });

  it('chaining works normally while writable: a multi-step chain resolves without throwing', async () => {
    const readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { chainStep: (...a: unknown[]) => { next: (...a: unknown[]) => { finish: (...a: unknown[]) => Promise<unknown> } } };
    };
    const admin = proxy.admin();
    await expect(admin.chainStep().next().finish()).resolves.toEqual({ ok: 1 });
  });

  it('the out === t branch stays guarded after a flip: a write method on the chained same-receiver still refuses, zero calls', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => { chainSame: (...a: unknown[]) => { command: (...a: unknown[]) => unknown } };
    };
    const admin = proxy.admin();
    const chainedSame = admin.chainSame(); // captured while writable
    readOnly = true;
    calls = [];
    expect(() => chainedSame.command()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });

  it('the out !== t branch stays guarded after a flip: the recursively-wrapped step still refuses, zero calls', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => {
        chainStep: (...a: unknown[]) => {
          finish: (...a: unknown[]) => unknown;
          next: (...a: unknown[]) => unknown;
        };
      };
    };
    const admin = proxy.admin();
    const step = admin.chainStep(); // captured while writable — a genuinely different, recursively-wrapped object
    readOnly = true;
    calls = [];
    expect(() => step.finish()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
    expect(() => step.next()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });
});

describe('makeDbProxy — aggregate is itself a CURSOR_RETURNING_METHOD', () => {
  it('aggregate() is wrapped so its terminal methods inherit the signal too', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { aggregate: (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown } };
    };
    calls = [];
    proxy.things.aggregate([{ $match: {} }]).toArray();
    expect(calls).toEqual([
      'aggregate [{"$match":{}}] {"signal":{}}',
      'aggregate toArray {"signal":{}}',
    ]);
  });
});

describe('mergeSignalOptions — explicit non-object value at the options slot', () => {
  it('an explicit `undefined` argument at the options slot is left alone (signal not merged, driver validates)', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find({ a: 1 }, undefined);
    expect(calls).toEqual(['find {"a":1} undefined']);
  });

  it('a non-object truthy value at the options slot (a stray string) is left alone too', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find({ a: 1 }, 'not-an-options-object' as unknown as object);
    expect(calls).toEqual(['find {"a":1} not-an-options-object']);
  });
});

describe('makeDbProxy — aggregate write-stage check does not misfire for a non-aggregate method (line 231)', () => {
  it('find() with an array-shaped first arg containing a write-stage-looking object is not treated as an aggregate pipeline', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    expect(() => proxy.things.find([{ $out: 'x' }])).not.toThrow();
  });
});

describe('makeDbProxy — callArgs signal-merge condition (line 238)', () => {
  it('a guarded-but-writable ctx with no ctx.signal calls the driver with the caller-supplied args unchanged, even though positional is defined', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    calls = [];
    proxy.things.find();
    // Original: `ctx.signal && positional !== undefined` is falsy (no ctx.signal) → callArgs=args=[].
    // Forcing the whole condition to `true`, or `&&`→`||`, both make positional!==undefined (true
    // for find, positional=1) win the merge, padding a `{signal: undefined}` onto the call —
    // observably different from the plain 'find' call below.
    expect(calls).toEqual(['find']);
  });
});

describe('makeDbProxy — guardCapturedHandle wraps a non-promise write-method return (line 246)', () => {
  it('a captured bulk builder (synchronous, non-promise return) stays guarded after a flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      things: {
        initializeUnorderedBulkOp: (...a: unknown[]) => { insert: (...a: unknown[]) => unknown };
      };
    };
    const builder = proxy.things.initializeUnorderedBulkOp();
    readOnly = true;
    calls = [];
    expect(() => builder.insert({ a: 1 })).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });
});

describe('guardPlainProperty — unguarded ctx never wraps a plain object property (line 325)', () => {
  it('an unguarded ctx (ctx.isReadOnly entirely undefined) returns the raw object, not a guarded copy', () => {
    const client = new FakeMongoClient();
    const rawColl = client.db('testdb').collection('things');
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never }) as unknown as {
      things: { s: unknown };
    };
    expect(proxy.things.s).toBe(rawColl.s);
  });
});

describe('guardCapturedHandle — its own value-type guard (line ~364)', () => {
  it('a chained method returning null passes straight through without throwing', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      admin: () => { chainStep: (...a: unknown[]) => { returnsNull: (...a: unknown[]) => unknown } };
    };
    expect(proxy.admin().chainStep().returnsNull()).toBeNull();
  });

  it('a chained method returning a truthy primitive (a number) passes straight through without throwing', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      admin: () => { chainStep: (...a: unknown[]) => { returnsNumber: (...a: unknown[]) => unknown } };
    };
    expect(proxy.admin().chainStep().returnsNumber()).toBe(42);
  });
});

describe('guardCapturedHandle — property-path `what` string carries the property name (line 369)', () => {
  it('a denied method reached through a nested guarded plain property names that property in the error, not an empty string', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => {
        chainStep: (...a: unknown[]) => { nested: { write: (...a: unknown[]) => unknown } };
      };
    };
    const nested = proxy.admin().chainStep().nested;
    readOnly = true;
    expect(() => nested.write()).toThrowError(/nested/);
  });
});

describe('wrapCursor — value-type guard mirrors guardCapturedHandle (line 444)', () => {
  it('a function-typed cursor return value is still wrapped, not passed through raw', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as { find: () => unknown };
    const rawFn = () => 'called';
    coll.find = () => rawFn;
    const proxy = makeDbProxy({
      currentDb: 'testdb',
      client: client as never,
      isReadOnly: () => false,
    }) as unknown as { things: { find: () => unknown } };
    const result = proxy.things.find();
    expect(result).not.toBe(rawFn);
    expect(typeof result).toBe('function');
  });
});

describe('wrapCursor — a plain (non-function) property is guarded, not treated as callable (line 457)', () => {
  it('cursorClient stays an object through the wrapper, not converted into a function', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      things: { find: (...a: unknown[]) => { cursorClient: unknown } };
    };
    const client = proxy.things.find().cursorClient;
    expect(typeof client).toBe('object');
    expect(client).not.toBeNull();
  });
});

describe('mergeSignalOptions — the object-options merge branch actually runs (line 414 if-block)', () => {
  it('a plain options object without an explicit signal key gets the ctx signal merged in', () => {
    const controller = new AbortController();
    const proxy = makeDbProxy(makeCtx({ signal: controller.signal })) as unknown as {
      things: { find: (...a: unknown[]) => unknown };
    };
    proxy.things.find({ a: 1 }, { extra: 1 });
    expect(calls).toEqual(['find {"a":1} {"extra":1,"signal":{}}']);
  });
});

describe('wrapCursor — chained cursor-shaping call returns the SAME wrapper when out === target (line 482)', () => {
  it('a chaining method that returns the receiver itself hands back the cached wrapper, not a fresh one', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as {
      find: () => { sort: (...a: unknown[]) => unknown; toArray: () => Promise<unknown[]> };
    };
    coll.find = () => {
      const inner = new FakeCursor('self-chain');
      const self: { sort: (...a: unknown[]) => unknown; toArray: () => Promise<unknown[]> } = {
        sort: () => self,
        toArray: inner.toArray.bind(inner),
      };
      return self;
    };
    const proxy = makeDbProxy({
      currentDb: 'testdb',
      client: client as never,
      isReadOnly: () => false,
    }) as unknown as {
      things: { find: () => { sort: (...a: unknown[]) => { sort: (...a: unknown[]) => unknown } } };
    };
    const cursor = proxy.things.find();
    const sorted = cursor.sort({ a: 1 });
    expect(sorted).toBe(cursor);
  });
});

describe('guardCapturedHandle — a function-typed captured return is still wrapped (line 364, function branch)', () => {
  it('a nested method on a captured function-typed return stays guarded after a flip', () => {
    let readOnly = false;
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => readOnly })) as unknown as {
      admin: () => {
        chainStep: (...a: unknown[]) => { returnsFunction: (...a: unknown[]) => { grab: () => unknown } };
      };
    };
    const resultFn = proxy.admin().chainStep().returnsFunction();
    readOnly = true;
    calls = [];
    expect(() => resultFn.grab()).toThrow(ReadOnlyConnectionError);
    expect(calls).toEqual([]);
  });
});

describe('wrapCursor — an unguarded ctx (no signal, no isReadOnly) never wraps the cursor (line 455)', () => {
  it('the raw cursor reference is returned unchanged', () => {
    const client = new FakeMongoClient();
    const coll = client.db('testdb').collection('things') as unknown as { find: () => unknown };
    const rawCursor = new FakeCursor('raw');
    coll.find = () => rawCursor;
    const proxy = makeDbProxy({ currentDb: 'testdb', client: client as never }) as unknown as {
      things: { find: () => unknown };
    };
    expect(proxy.things.find()).toBe(rawCursor);
  });
});

describe('wrapCursor — the async-iterator symbol key is bound and returned raw, not re-wrapped (lines 474-475)', () => {
  it('Symbol.asyncIterator produces the exact raw iterator object, not a re-wrapped Proxy of it', () => {
    const client = new FakeMongoClient();
    const rawIter = { next: () => Promise.resolve({ done: true, value: undefined }) };
    const coll = client.db('testdb').collection('things') as unknown as { find: () => unknown };
    coll.find = () => ({
      [Symbol.asyncIterator]: () => rawIter,
    });
    const proxy = makeDbProxy(
      makeCtx({ isReadOnly: () => false, currentDb: 'testdb', client: client as never }),
    ) as unknown as { things: { find: () => { [Symbol.asyncIterator]: () => unknown } } };
    const cursor = proxy.things.find();
    const iter = cursor[Symbol.asyncIterator]();
    expect(iter).toBe(rawIter);
  });
});

describe('wrapCursor — guardedDescriptor is tagged "cursor", not an empty string (line 495)', () => {
  it('a frozen guarded cursor descriptor read names "cursor" in its error message', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => true })) as unknown as {
      things: { find: (...a: unknown[]) => object };
    };
    const cursor = proxy.things.find();
    Object.freeze(cursor);
    expect(() => Object.getOwnPropertyDescriptor(cursor, 'cursorClient')).toThrow(
      'This connection is read-only — "cursor.cursorClient (frozen)" is not permitted.',
    );
  });
});

describe('wrapCursor — the signal check on line 476 gates the merge branch, not just membership', () => {
  it('a guarded-but-signal-less ctx calls a terminal method with the caller-supplied args unchanged (no signal merged)', () => {
    const proxy = makeDbProxy(makeCtx({ isReadOnly: () => false })) as unknown as {
      things: { find: (...a: unknown[]) => { toArray: (...a: unknown[]) => unknown } };
    };
    calls = [];
    proxy.things.find().toArray();
    expect(calls).toEqual(['find', 'find toArray']);
  });
});
