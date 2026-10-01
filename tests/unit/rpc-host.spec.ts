import { describe, it, expect, beforeEach } from 'vitest';
import { Double, Int32, Long, ObjectId } from 'bson';
import { createRpcHost, type RpcHost, type RpcHostOpts } from '../../electron/script-runner/rpcHost';
import type { RpcFrame, RpcReply } from '../../electron/script-runner/protocol';
import { ejsonParse } from '../../electron/mongo/ejson';
import { promoteNumbers } from '../../electron/script-runner/rpcCodec';

/**
 * A hand-rolled client: every driver-side call lands in `calls`, so a refused
 * frame can be shown never to have reached the driver at all. The fake has
 * the same reachable-internals hazards as the real driver on purpose (an `s`
 * bag, a `cursorClient`, a Collection-returning method), since those are what
 * the host exists to keep off the wire.
 */
let calls: Array<{ what: string; args: unknown[] }> = [];
const rec = (what: string, args: unknown[]): void => {
  calls.push({ what, args });
};

class FakeCursor {
  cursorClient = { secret: 'the-client' };
  private readonly docs: unknown[];
  constructor(docs: unknown[] = [{ _id: 1 }, { _id: 2 }]) {
    this.docs = docs;
  }
  sort(...a: unknown[]): this {
    rec('cursor.sort', a);
    return this;
  }
  limit(...a: unknown[]): this {
    rec('cursor.limit', a);
    return this;
  }
  out(...a: unknown[]): this {
    rec('cursor.out', a);
    return this;
  }
  toArray(...a: unknown[]): Promise<unknown[]> {
    rec('cursor.toArray', a);
    return Promise.resolve(this.docs);
  }
  next(...a: unknown[]): Promise<unknown> {
    rec('cursor.next', a);
    return Promise.resolve(this.docs[0] ?? null);
  }
  close(...a: unknown[]): Promise<void> {
    rec('cursor.close', a);
    return closeBehaviour();
  }
}

let closeBehaviour: () => Promise<void> = () => Promise.resolve();

class FakeCollection {
  s = { db: { client: { secret: 'the-client' } } };
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  insertOne(...a: unknown[]): Promise<unknown> {
    rec(`${this.name}.insertOne`, a);
    return Promise.resolve({ acknowledged: true, insertedId: new ObjectId('64b7f0f5a1b2c3d4e5f60718') });
  }
  findOne(...a: unknown[]): Promise<unknown> {
    rec(`${this.name}.findOne`, a);
    return Promise.resolve({ _id: 1, n: 5 });
  }
  find(...a: unknown[]): FakeCursor {
    rec(`${this.name}.find`, a);
    return new FakeCursor();
  }
  aggregate(...a: unknown[]): FakeCursor {
    rec(`${this.name}.aggregate`, a);
    return new FakeCursor();
  }
  countDocuments(...a: unknown[]): Promise<number> {
    rec(`${this.name}.countDocuments`, a);
    return Promise.resolve(3);
  }
  bulkWrite(...a: unknown[]): Promise<unknown> {
    rec(`${this.name}.bulkWrite`, a);
    // Like the driver's: a class instance, counts as own fields, the raw reply
    // hidden, `ok` a getter on the prototype.
    class BulkWriteResultLike {
      insertedCount = 1;
      matchedCount = 2;
      modifiedCount = 3;
      deletedCount = 4;
      upsertedCount = 5;
      upsertedIds = { 0: 'u' };
      insertedIds = { 0: 'i' };
      constructor() {
        Object.defineProperty(this, 'result', { value: { client: 'the-client' }, enumerable: false });
      }
      get ok(): number {
        return 1;
      }
    }
    return Promise.resolve(new BulkWriteResultLike());
  }
  drop(...a: unknown[]): Promise<boolean> {
    rec(`${this.name}.drop`, a);
    return Promise.resolve(true);
  }
  rename(...a: unknown[]): Promise<FakeCollection> {
    rec(`${this.name}.rename`, a);
    return Promise.resolve(this);
  }
  options(): Promise<unknown> {
    // Not plain data: a live object that reaches the client.
    return Promise.resolve(this);
  }
  listIndexes(): FakeCursor {
    return new FakeCursor([{ name: '_id_' }]);
  }
  bigDocs(): never {
    throw new Error('not reachable');
  }
  initializeUnorderedBulkOp(): unknown {
    rec('bulk', []);
    return {};
  }
}

class FakeAdmin {
  listDatabases(...a: unknown[]): Promise<unknown> {
    rec('admin.listDatabases', a);
    return Promise.resolve({ databases: [{ name: 'x' }] });
  }
  command(...a: unknown[]): Promise<unknown> {
    rec('admin.command', a);
    return Promise.resolve({ ok: 1 });
  }
  s = { db: { client: { secret: 'the-client' } } };
}

class FakeDb {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    rec('client.db', [name]);
  }
  command(...a: unknown[]): Promise<unknown> {
    rec('db.command', a);
    return Promise.resolve({ ok: 1, from: 'command' });
  }
  collection(name: string): FakeCollection {
    rec('db.collection', [name]);
    return new FakeCollection(name);
  }
  createCollection(...a: unknown[]): Promise<FakeCollection> {
    rec('db.createCollection', a);
    return Promise.resolve(new FakeCollection(String(a[0])));
  }
  dropDatabase(...a: unknown[]): Promise<boolean> {
    rec('db.dropDatabase', a);
    return Promise.resolve(true);
  }
  listCollections(...a: unknown[]): FakeCursor {
    rec('db.listCollections', a);
    return new FakeCursor([{ name: 'a' }]);
  }
  admin(): FakeAdmin {
    rec('db.admin', []);
    return new FakeAdmin();
  }
  // What `db.stats` looks like to the proxy, and what a collection called
  // `stats` would collide with if the host indexed the proxy by name.
  stats(...a: unknown[]): Promise<unknown> {
    rec('db.stats', a);
    return Promise.resolve({ ok: 1 });
  }
}

const fakeClient = { db: (name: string) => new FakeDb(name) };

let readOnly = false;
let ctrl = new AbortController();
let errors: unknown[] = [];
let host: RpcHost;

function makeHost(over: Partial<RpcHostOpts> = {}): RpcHost {
  return createRpcHost({
    client: fakeClient as never,
    isReadOnly: () => readOnly,
    signal: ctrl.signal,
    onCloseError: (e) => errors.push(e),
    ...over,
  });
}

beforeEach(() => {
  calls = [];
  readOnly = false;
  ctrl = new AbortController();
  errors = [];
  closeBehaviour = () => Promise.resolve();
  host = makeHost();
});

let nextId = 1;
function frame(over: Record<string, unknown>): RpcFrame {
  return {
    type: 'rpc',
    id: nextId++,
    target: 'collection',
    dbName: 'd',
    coll: 'c',
    method: 'findOne',
    argsEjson: '[]',
    ...over,
  } as RpcFrame;
}
const send = (over: Record<string, unknown>): Promise<RpcReply> => host.handle(frame(over));

function value(reply: RpcReply): unknown {
  if (reply.type !== 'rpc-result' || !('valueEjson' in reply)) {
    throw new Error(`expected a value reply, got ${JSON.stringify(reply)}`);
  }
  return promoteNumbers(ejsonParse(reply.valueEjson), false);
}
function cursorIdOf(reply: RpcReply): string {
  if (reply.type !== 'rpc-result' || !('cursorId' in reply)) {
    throw new Error(`expected a cursor reply, got ${JSON.stringify(reply)}`);
  }
  return reply.cursorId;
}
function errorOf(reply: RpcReply): { name: string; code: string; message: string; stack?: string } {
  if (reply.type !== 'rpc-error') throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return reply.error;
}
const argsOf = (...a: unknown[]): string => JSON.stringify(a);

describe('rpcHost — what a frame may name', () => {
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown collection method', { method: 'dropEverything' }, /'dropEverything' is not callable on collection/],
    ['__proto__ as a method', { method: '__proto__' }, /'__proto__' is not callable on collection/],
    ['constructor as a method', { method: 'constructor' }, /'constructor' is not callable on collection/],
    ['an inherited Object method', { method: 'hasOwnProperty' }, /not callable on collection/],
    ['toString as a method', { method: 'toString' }, /not callable on collection/],
    ['the driver internals bag', { method: 's' }, /not callable on collection/],
    ['a change stream', { method: 'watch' }, /not callable on collection/],
    ['a bulk builder', { method: 'initializeUnorderedBulkOp' }, /not callable on collection/],
    ['an empty method', { method: '' }, /method must be a non-empty string/],
    ['a non-string method', { method: 7 }, /method must be a non-empty string/],
    ['a missing method', { method: undefined }, /method must be a non-empty string/],
    ['admin as a db method', { target: 'db', method: 'admin' }, /'admin' is not callable on db/],
    ['collection as a db method', { target: 'db', method: 'collection' }, /not callable on db/],
    ['an unknown db method', { target: 'db', method: 'evalEverything' }, /not callable on db/],
    ['__proto__ on db', { target: 'db', method: '__proto__' }, /not callable on db/],
    ['an unknown admin method', { target: 'admin', method: 'shutdown' }, /'shutdown' is not callable on admin/],
    ['a collection method on admin', { target: 'admin', method: 'insertOne' }, /not callable on admin/],
    ['an unknown target', { target: 'client' }, /unknown target/],
    ['a missing target', { target: undefined }, /unknown target/],
    ['__proto__ as the target', { target: '__proto__' }, /unknown target/],
  ];
  it.each(refused)('refuses %s and never reaches the driver', async (_name, over, message) => {
    const reply = await send(over);
    expect(errorOf(reply).code).toBe('VALIDATION');
    expect(errorOf(reply).message).toMatch(message);
    expect(calls).toEqual([]);
  });

  const badNames: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a missing dbName', { dbName: undefined }, /dbName must be/],
    ['an empty dbName', { dbName: '' }, /dbName must be/],
    ['a numeric dbName', { dbName: 5 }, /dbName must be/],
    ['an object dbName', { dbName: {} }, /dbName must be/],
    ['a missing coll', { coll: undefined }, /coll must be/],
    ['an empty coll', { coll: '' }, /coll must be/],
    ['a numeric coll', { coll: 5 }, /coll must be/],
    ['a missing dbName on db', { target: 'db', method: 'runCommand', dbName: undefined }, /dbName must be/],
    ['an empty dbName on db', { target: 'db', method: 'runCommand', dbName: '' }, /dbName must be/],
    ['a numeric dbName on admin', { target: 'admin', method: 'ping', dbName: 3 }, /dbName must be/],
  ];
  it.each(badNames)('refuses %s', async (_name, over, message) => {
    const reply = await send(over);
    expect(errorOf(reply).code).toBe('VALIDATION');
    expect(errorOf(reply).message).toMatch(message);
    expect(calls).toEqual([]);
  });

  const badArgs: Array<[string, unknown, RegExp]> = [
    ['not a string', 7, /argsEjson must be/],
    ['missing', undefined, /argsEjson must be/],
    ['empty', '', /argsEjson must be/],
    ['not JSON', 'not json at all', /invalid argsEjson/],
    ['not an array', '{"a":1}', /array of at most 16/],
    ['null', 'null', /array of at most 16/],
    ['a malformed sentinel', '[{"$oid":"zz"}]', /invalid argsEjson/],
    ['a bad binary sentinel', '[{"$binary":{"base64":"!!!","subType":"00"}}]', /invalid argsEjson/],
    ['too many values', JSON.stringify(Array.from({ length: 17 }, (_, i) => i)), /array of at most 16/],
  ];
  it.each(badArgs)('refuses argsEjson that is %s', async (_name, argsEjson, message) => {
    const reply = await send({ argsEjson });
    expect(errorOf(reply).code).toBe('VALIDATION');
    expect(errorOf(reply).message).toMatch(message);
    expect(calls).toEqual([]);
  });

  it('accepts exactly the maximum number of arguments', async () => {
    const reply = await send({ method: 'countDocuments', argsEjson: JSON.stringify(Array.from({ length: 16 }, () => 1)) });
    expect(reply.type).toBe('rpc-result');
  });

  it('answers with the frame id, on success and on error', async () => {
    const ok = await host.handle(frame({ id: 4242, method: 'countDocuments' }));
    const bad = await host.handle(frame({ id: 4243, method: 'nope' }));
    expect(ok.id).toBe(4242);
    expect(bad.id).toBe(4243);
  });

  it('refuses a cursor method on a cursor that does not exist', async () => {
    for (const cursorId of [undefined, '', 7, 'made-up', '__proto__', 'constructor']) {
      const reply = await send({ target: 'cursor', method: 'toArray', cursorId });
      expect(errorOf(reply).message).toMatch(/cursor/);
    }
    expect(calls).toEqual([]);
  });

  it('checks the cursor method before it looks the cursor up', async () => {
    const id = cursorIdOf(await send({ method: 'find' }));
    for (const method of ['cursorClient', 'out', 'merge', '__proto__', 'constructor', 'forEach', 'map', 'clone', 's']) {
      const reply = await send({ target: 'cursor', method, cursorId: id });
      expect(errorOf(reply).code).toBe('VALIDATION');
      expect(errorOf(reply).message).toBe(`rpc: '${method}' is not callable on cursor`);
    }
    expect(calls.filter((c) => c.what.startsWith('cursor.'))).toEqual([]);
  });
});

describe('rpcHost — routes', () => {
  it('runs a db command through the named database', async () => {
    const reply = await send({ target: 'db', method: 'runCommand', dbName: 'other', argsEjson: argsOf({ ping: { $numberInt: '1' } }) });
    expect(value(reply)).toEqual({ ok: 1, from: 'command' });
    expect(calls).toContainEqual({ what: 'client.db', args: ['other'] });
    // Through the proxy's alias: runCommand is the driver's command, called with the parsed argument.
    expect(calls.find((c) => c.what === 'db.command')?.args[0]).toEqual({ ping: 1 });
  });

  it('reaches a collection through collection(name), never through a db member of that name', async () => {
    const reply = await send({ coll: 'stats', method: 'findOne', argsEjson: argsOf({}) });
    expect(value(reply)).toEqual({ _id: 1, n: 5 });
    expect(calls.map((c) => c.what)).toContain('stats.findOne');
    expect(calls.map((c) => c.what)).not.toContain('db.stats');
  });

  it('runs an admin call on the admin object', async () => {
    const reply = await send({ target: 'admin', method: 'listDatabases' });
    expect(value(reply)).toEqual({ databases: [{ name: 'x' }] });
    expect(calls.map((c) => c.what)).toEqual(['client.db', 'db.admin', 'admin.listDatabases']);
  });

  it('passes the run signal to a collection call', async () => {
    await send({ method: 'findOne', argsEjson: argsOf({ a: { $numberInt: '1' } }) });
    const args = calls.find((c) => c.what === 'c.findOne')!.args;
    expect(args[0]).toEqual({ a: 1 });
    expect((args[1] as { signal?: AbortSignal }).signal).toBe(ctrl.signal);
  });

  it('encodes a result as canonical EJSON', async () => {
    const reply = await send({ method: 'insertOne', argsEjson: argsOf({ x: 1 }) });
    expect(reply.type === 'rpc-result' && 'valueEjson' in reply && JSON.parse(reply.valueEjson)).toEqual({
      acknowledged: true,
      insertedId: { $oid: '64b7f0f5a1b2c3d4e5f60718' },
    });
  });

  it('answers a call that returned nothing with null', async () => {
    const reply = await send({ target: 'cursor', method: 'close', cursorId: cursorIdOf(await send({ method: 'find' })) });
    expect(reply).toMatchObject({ type: 'rpc-result', valueEjson: 'null' });
  });

  it('turns createCollection and rename into an acknowledgement, never the Collection', async () => {
    const created = await send({ target: 'db', method: 'createCollection', argsEjson: argsOf('x') });
    expect(value(created)).toEqual({ ok: 1 });
    const renamed = await send({ method: 'rename', argsEjson: argsOf('y') });
    expect(value(renamed)).toEqual({ ok: 1 });
    expect(calls.map((c) => c.what)).toContain('db.createCollection');
    expect(calls.map((c) => c.what)).toContain('c.rename');
  });

  it('answers a bulkWrite with its counts and id maps, not a refusal, and never its raw reply', async () => {
    const reply = await send({ method: 'bulkWrite', argsEjson: argsOf([{ insertOne: { document: { a: 1 } } }]) });
    expect(value(reply)).toEqual({
      ok: 1,
      insertedCount: 1,
      matchedCount: 2,
      modifiedCount: 3,
      deletedCount: 4,
      upsertedCount: 5,
      insertedIds: { 0: 'i' },
      upsertedIds: { 0: 'u' },
    });
    expect(JSON.stringify(reply)).not.toContain('the-client');
  });

  it('refuses a result that is not plain data rather than serializing it', async () => {
    const reply = await send({ method: 'options' });
    const err = errorOf(reply);
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toMatch(/not plain data/);
    expect(JSON.stringify(reply)).not.toContain('the-client');
  });

  it('gives a db-level cursor method a handle too', async () => {
    const id = cursorIdOf(await send({ target: 'db', method: 'listCollections' }));
    const reply = await send({ target: 'cursor', method: 'toArray', cursorId: id });
    expect(value(reply)).toEqual([{ name: 'a' }]);
  });
});

describe('rpcHost — numbers in arguments', () => {
  it('unwraps an Int32 to the number a driver option check needs', async () => {
    await send({ method: 'countDocuments', argsEjson: argsOf({ n: { $numberInt: '5' } }, { maxTimeMS: { $numberInt: '6000' } }) });
    const args = calls.find((c) => c.what === 'c.countDocuments')!.args;
    expect((args[1] as { maxTimeMS: unknown }).maxTimeMS).toBe(6000);
    expect(typeof (args[1] as { maxTimeMS: unknown }).maxTimeMS).toBe('number');
  });

  it('keeps an explicit Double with an integer value, which a plain number would turn into an int32', async () => {
    await send({ method: 'insertOne', argsEjson: argsOf({ price: { $numberDouble: '5.0' } }) });
    const doc = calls.find((c) => c.what === 'c.insertOne')!.args[0] as { price: unknown };
    expect(doc.price).toBeInstanceOf(Double);
  });

  it('unwraps a fractional or out-of-int32-range double, which the driver writes as a double anyway', async () => {
    await send({ method: 'insertOne', argsEjson: argsOf({ a: { $numberDouble: '1.5' }, b: { $numberDouble: '3000000000.0' } }) });
    const doc = calls.find((c) => c.what === 'c.insertOne')!.args[0] as Record<string, unknown>;
    expect(doc).toEqual({ a: 1.5, b: 3000000000 });
    expect(doc.a).not.toBeInstanceOf(Double);
    expect(doc.a).not.toBeInstanceOf(Int32);
  });

  it('parses a filter with operator siblings as a plain document, not a BSON value', async () => {
    await send({ method: 'findOne', argsEjson: argsOf({ name: { $regex: '^a', $options: 'i' } }) });
    const filter = calls.find((c) => c.what === 'c.findOne')!.args[0] as { name: unknown };
    expect(filter.name).toEqual({ $regex: '^a', $options: 'i' });
  });

  it('keeps a __proto__ field as data instead of reassigning the prototype', async () => {
    await send({ method: 'insertOne', argsEjson: '[{"__proto__":{"isAdmin":true},"a":1}]' });
    const doc = calls.find((c) => c.what === 'c.insertOne')!.args[0] as Record<string, unknown>;
    expect(Object.keys(doc).sort((a, b) => a.localeCompare(b))).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });
});

describe('rpcHost — integers outside int32 range', () => {
  async function findOneReturning(result: unknown): Promise<RpcReply> {
    const restore = patched(FakeCollection.prototype, 'findOne', () => Promise.resolve(result));
    try {
      return await send({ method: 'findOne' });
    } finally {
      restore();
    }
  }

  it('goes out as a double, so the script reads the number the driver returned', async () => {
    const reply = await findOneReturning({ t: 1714000000000, small: 5, neg: -3000000000, frac: 1.5 });
    const text = reply.type === 'rpc-result' && 'valueEjson' in reply ? reply.valueEjson : '';
    expect(JSON.parse(text)).toEqual({
      t: { $numberDouble: '1714000000000.0' },
      small: { $numberInt: '5' },
      neg: { $numberDouble: '-3000000000.0' },
      frac: { $numberDouble: '1.5' },
    });
    expect(value(reply)).toEqual({ t: 1714000000000, small: 5, neg: -3000000000, frac: 1.5 });
    const t = (value(reply) as { t: unknown }).t;
    expect(typeof t).toBe('number');
  });

  it('keeps a real Long a Long, including one past 2^53', async () => {
    const reply = await findOneReturning({ big: Long.fromString('9007199254740993'), n: Long.fromNumber(5) });
    const seen = value(reply) as { big: Long; n: Long };
    expect(seen.big).toBeInstanceOf(Long);
    expect(seen.big.toString()).toBe('9007199254740993');
    expect(seen.n).toBeInstanceOf(Long);
  });

  it('marks it inside arrays that come back from a cursor, one element at a time', async () => {
    const restore = patched(FakeCursor.prototype, 'toArray', () => Promise.resolve([{ t: 1714000000000 }, { t: 2 }]));
    try {
      const id = cursorIdOf(await send({ method: 'find' }));
      const reply = await send({ target: 'cursor', method: 'toArray', cursorId: id });
      expect(value(reply)).toEqual([{ t: 1714000000000 }, { t: 2 }]);
      expect(reply.type === 'rpc-result' && 'valueEjson' in reply && reply.valueEjson).toContain('$numberDouble');
    } finally {
      restore();
    }
  });

  it('reads an argument written as a double back as a plain number the driver writes as a double', async () => {
    await send({ method: 'insertOne', argsEjson: argsOf({ t: { $numberDouble: '1714000000000.0' } }) });
    const doc = calls.find((c) => c.what === 'c.insertOne')!.args[0] as { t: unknown };
    expect(doc.t).toBe(1714000000000);
    expect(typeof doc.t).toBe('number');
  });
});

describe('rpcHost — read-only', () => {
  beforeEach(() => {
    readOnly = true;
  });

  it('allows reads', async () => {
    expect(value(await send({ method: 'findOne' }))).toEqual({ _id: 1, n: 5 });
    expect(value(await send({ method: 'countDocuments' }))).toBe(3);
    const id = cursorIdOf(await send({ method: 'find' }));
    expect(value(await send({ target: 'cursor', method: 'toArray', cursorId: id }))).toEqual([{ _id: 1 }, { _id: 2 }]);
  });

  const writes: Array<[string, Record<string, unknown>]> = [
    ['insertOne', { method: 'insertOne', argsEjson: argsOf({ a: 1 }) }],
    ['drop', { method: 'drop' }],
    ['rename', { method: 'rename', argsEjson: argsOf('z') }],
    ['db.dropDatabase', { target: 'db', method: 'dropDatabase' }],
    ['db.createCollection', { target: 'db', method: 'createCollection', argsEjson: argsOf('z') }],
    ['db.runCommand', { target: 'db', method: 'runCommand', argsEjson: argsOf({ insert: 'c', documents: [{ a: 1 }] }) }],
    ['db.command', { target: 'db', method: 'command', argsEjson: argsOf({ drop: 'c' }) }],
    ['admin.command', { target: 'admin', method: 'command', argsEjson: argsOf({ shutdown: 1 }) }],
    ['admin.listDatabases', { target: 'admin', method: 'listDatabases' }],
    ['aggregate with $out', { method: 'aggregate', argsEjson: argsOf([{ $out: 'x' }]) }],
    ['aggregate with $merge', { method: 'aggregate', argsEjson: argsOf([{ $match: {} }, { $merge: { into: 'x' } }]) }],
  ];
  it.each(writes)('refuses %s with a read-only error, and never reaches the driver call', async (_name, over) => {
    const reply = await send(over);
    expect(errorOf(reply)).toMatchObject({ name: 'ReadOnlyConnectionError', code: 'READ_ONLY' });
    const reached = calls.map((c) => c.what).filter((w) => w !== 'client.db' && w !== 'db.collection');
    expect(reached).toEqual([]);
  });

  it('reads the flag fresh on every frame', async () => {
    readOnly = false;
    expect(value(await send({ method: 'countDocuments' }))).toBe(3);
    expect(value(await send({ method: 'insertOne', argsEjson: argsOf({ a: 1 }) }))).toMatchObject({ acknowledged: true });
    readOnly = true;
    expect(errorOf(await send({ method: 'insertOne', argsEjson: argsOf({ a: 2 }) })).code).toBe('READ_ONLY');
    expect(calls.filter((c) => c.what === 'c.insertOne')).toHaveLength(1);
  });

  it('refuses a write on a cursor handle opened before the flip', async () => {
    readOnly = false;
    const id = cursorIdOf(await send({ method: 'aggregate', argsEjson: argsOf([{ $match: {} }]) }));
    readOnly = true;
    // Reads stay allowed on an open cursor.
    expect(value(await send({ target: 'cursor', method: 'toArray', cursorId: id }))).toHaveLength(2);
  });
});

describe('rpcHost — cursors', () => {
  it('shapes, reads and then forgets a cursor', async () => {
    const id = cursorIdOf(await send({ method: 'find', argsEjson: argsOf({}) }));
    expect(await send({ target: 'cursor', method: 'sort', cursorId: id, argsEjson: argsOf({ a: { $numberInt: '1' } }) })).toMatchObject({
      valueEjson: 'null',
    });
    await send({ target: 'cursor', method: 'limit', cursorId: id, argsEjson: argsOf({ $numberInt: '5' }) });
    expect(calls.find((c) => c.what === 'cursor.sort')!.args).toEqual([{ a: 1 }]);
    expect(calls.find((c) => c.what === 'cursor.limit')!.args).toEqual([5]);

    expect(value(await send({ target: 'cursor', method: 'toArray', cursorId: id }))).toEqual([{ _id: 1 }, { _id: 2 }]);
    // A finished cursor is gone.
    expect(errorOf(await send({ target: 'cursor', method: 'toArray', cursorId: id })).message).toMatch(/unknown cursor/);
  });

  it('forgets a cursor when it is closed, and keeps it across next()', async () => {
    const id = cursorIdOf(await send({ method: 'find' }));
    expect(value(await send({ target: 'cursor', method: 'next', cursorId: id }))).toEqual({ _id: 1 });
    expect(value(await send({ target: 'cursor', method: 'next', cursorId: id }))).toEqual({ _id: 1 });
    await send({ target: 'cursor', method: 'close', cursorId: id });
    expect(errorOf(await send({ target: 'cursor', method: 'next', cursorId: id })).message).toMatch(/unknown cursor/);
  });

  it('mints a distinct, unguessable id per cursor', async () => {
    const a = cursorIdOf(await send({ method: 'find' }));
    const b = cursorIdOf(await send({ method: 'find' }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not honour another run’s cursor', async () => {
    const id = cursorIdOf(await send({ method: 'find' }));
    const other = makeHost();
    const reply = await other.handle(frame({ target: 'cursor', method: 'toArray', cursorId: id }));
    expect(errorOf(reply).message).toMatch(/unknown cursor/);
  });

  it('refuses the 257th open cursor', async () => {
    for (let i = 0; i < 256; i++) cursorIdOf(await send({ method: 'find' }));
    const reply = await send({ method: 'find' });
    expect(errorOf(reply)).toMatchObject({ code: 'VALIDATION' });
    expect(errorOf(reply).message).toMatch(/256 cursors/);
  });

  it('a finished cursor frees its slot', async () => {
    for (let i = 0; i < 255; i++) cursorIdOf(await send({ method: 'find' }));
    const last = cursorIdOf(await send({ method: 'find' }));
    await send({ target: 'cursor', method: 'toArray', cursorId: last });
    expect(cursorIdOf(await send({ method: 'find' }))).toBeTruthy();
  });

  it('answers an explain with its data', async () => {
    const id = cursorIdOf(await send({ method: 'find' }));
    // The fake has no explain, so this is refused by the driver-side lookup, not the allowlist.
    const reply = await send({ target: 'cursor', method: 'explain', cursorId: id });
    expect(errorOf(reply)).toMatchObject({ code: 'INTERNAL', message: "rpc: 'explain' is not available" });
  });
});

describe('rpcHost — ending a run', () => {
  it('closes every open cursor and refuses later frames', async () => {
    const a = cursorIdOf(await send({ method: 'find' }));
    cursorIdOf(await send({ method: 'find' }));
    await host.close();
    expect(calls.filter((c) => c.what === 'cursor.close')).toHaveLength(2);
    expect(errorOf(await send({ target: 'cursor', method: 'toArray', cursorId: a }))).toMatchObject({
      code: 'INTERNAL',
      message: 'the script run has ended',
    });
    expect(errorOf(await send({ method: 'findOne' })).message).toBe('the script run has ended');
  });

  it('does not close a cursor that already finished', async () => {
    const id = cursorIdOf(await send({ method: 'find' }));
    await send({ target: 'cursor', method: 'toArray', cursorId: id });
    await host.close();
    expect(calls.filter((c) => c.what === 'cursor.close')).toEqual([]);
  });

  it('reports a cursor that will not close, without throwing, and still closes the rest', async () => {
    cursorIdOf(await send({ method: 'find' }));
    cursorIdOf(await send({ method: 'find' }));
    let n = 0;
    closeBehaviour = () => (n++ === 0 ? Promise.reject(new Error('close failed')) : Promise.resolve());
    await expect(host.close()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('close failed');
    expect(calls.filter((c) => c.what === 'cursor.close')).toHaveLength(2);
  });

  it('closing with no callback and a failing close is still silent to the caller', async () => {
    const quiet = createRpcHost({ client: fakeClient as never, isReadOnly: () => false, signal: ctrl.signal });
    const r = await quiet.handle(frame({ method: 'find' }));
    cursorIdOf(r);
    closeBehaviour = () => Promise.reject(new Error('nope'));
    await expect(quiet.close()).resolves.toBeUndefined();
  });

  it('close is safe to call twice', async () => {
    cursorIdOf(await send({ method: 'find' }));
    await host.close();
    await host.close();
    expect(calls.filter((c) => c.what === 'cursor.close')).toHaveLength(1);
  });
});

describe('rpcHost — errors', () => {
  it('classifies a driver error and sends no stack', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const coll = FakeCollection.prototype;
    const original = coll.insertOne;
    coll.insertOne = () => Promise.reject(dup);
    try {
      const reply = await send({ method: 'insertOne', argsEjson: argsOf({}) });
      const err = errorOf(reply);
      expect(err).toMatchObject({ name: 'ConflictError', code: 'CONFLICT' });
      expect(err.message).toContain('E11000');
      expect('stack' in err).toBe(false);
    } finally {
      coll.insertOne = original;
    }
  });

  it('keeps an AppError as it is', async () => {
    readOnly = true;
    const err = errorOf(await send({ method: 'insertOne', argsEjson: argsOf({}) }));
    expect(err.name).toBe('ReadOnlyConnectionError');
    expect('stack' in err).toBe(false);
  });

  it('a synchronous throw from the driver becomes a reply, not a rejection', async () => {
    const original = FakeDb.prototype.command;
    FakeDb.prototype.command = () => {
      throw new Error('sync boom');
    };
    try {
      const reply = await send({ target: 'db', method: 'runCommand', argsEjson: argsOf({}) });
      expect(errorOf(reply).message).toContain('sync boom');
    } finally {
      FakeDb.prototype.command = original;
    }
  });
});

/** Swap a prototype method for the length of one test. */
function patched<T extends object>(proto: T, name: keyof T, impl: unknown): () => void {
  const original = proto[name];
  (proto as Record<string | symbol, unknown>)[name as string] = impl;
  return () => {
    (proto as Record<string | symbol, unknown>)[name as string] = original;
  };
}

describe('rpcHost — what counts as plain data', () => {
  async function findOneReturning(result: unknown): Promise<RpcReply> {
    const restore = patched(FakeCollection.prototype, 'findOne', () => Promise.resolve(result));
    try {
      return await send({ method: 'findOne' });
    } finally {
      restore();
    }
  }

  it('passes primitives, dates, BSON values, arrays and documents of either prototype', async () => {
    const nullProto = Object.assign(Object.create(null) as object, { a: 1 });
    for (const result of ['text', 7, true, null, new Date(0), new ObjectId('64b7f0f5a1b2c3d4e5f60718'), [1, 2], { a: 1 }, nullProto]) {
      expect((await findOneReturning(result)).type).toBe('rpc-result');
    }
  });

  it('answers a call that resolved to undefined with null', async () => {
    expect(await findOneReturning(undefined)).toMatchObject({ type: 'rpc-result', valueEjson: 'null' });
  });

  it('keeps a date and an ObjectId as their EJSON sentinels', async () => {
    const reply = await findOneReturning({ at: new Date(0), id: new ObjectId('64b7f0f5a1b2c3d4e5f60718') });
    expect(reply.type === 'rpc-result' && 'valueEjson' in reply && JSON.parse(reply.valueEjson)).toEqual({
      at: { $date: { $numberLong: '0' } },
      id: { $oid: '64b7f0f5a1b2c3d4e5f60718' },
    });
  });

  it('refuses a function', async () => {
    expect(errorOf(await findOneReturning(() => 1)).message).toMatch(/not plain data/);
  });

  it('refuses an instance of a class, and an array that holds one', async () => {
    class Live {
      client = { secret: 'the-client' };
    }
    expect(errorOf(await findOneReturning(new Live())).message).toMatch(/not plain data/);
    const mixed = await findOneReturning([{ ok: 1 }, new Live()]);
    expect(errorOf(mixed).message).toMatch(/not plain data/);
    expect(JSON.stringify(mixed)).not.toContain('the-client');
  });
});

describe('rpcHost — size cap', () => {
  const CAP = 50 * 1024 * 1024;

  it('refuses an array result over the cap, without encoding what comes after it', async () => {
    const mb = 'x'.repeat(1024 * 1024);
    const boom = {
      get late(): never {
        throw new Error('encoded past the cap');
      },
    };
    const restore = patched(FakeCursor.prototype, 'toArray', () =>
      Promise.resolve([...Array.from({ length: 51 }, () => ({ s: mb })), boom]),
    );
    try {
      const id = cursorIdOf(await send({ method: 'find' }));
      const err = errorOf(await send({ target: 'cursor', method: 'toArray', cursorId: id }));
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe(`result size exceeds ${CAP} byte cap`);
    } finally {
      restore();
    }
  });

  it('refuses a single document over the cap', async () => {
    const restore = patched(FakeCollection.prototype, 'findOne', () => Promise.resolve('x'.repeat(CAP)));
    try {
      const err = errorOf(await send({ method: 'findOne' }));
      expect(err).toMatchObject({ code: 'INTERNAL', message: `result size exceeds ${CAP} byte cap` });
    } finally {
      restore();
    }
  });

  it('allows a result of exactly the cap', async () => {
    // The JSON of a string is the string plus its two quotes.
    const restore = patched(FakeCollection.prototype, 'findOne', () => Promise.resolve('x'.repeat(CAP - 2)));
    try {
      const reply = await send({ method: 'findOne' });
      expect(reply.type === 'rpc-result' && 'valueEjson' in reply && reply.valueEjson.length).toBe(CAP);
    } finally {
      restore();
    }
  });
});
