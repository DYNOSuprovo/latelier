import { randomUUID } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import { AppError, SystemError, ValidationError } from '../errors.ts';
import { makeDbProxy } from '../mongo/dbProxy.ts';
import { ejsonEncodeArrayJson, ejsonStringify, parseEjsonField } from '../mongo/ejson.ts';
import { classifyMongoOpError } from '../mongo/errors.ts';
import { MAX_SCRIPT_RESULT_BYTES } from './encodeResult.ts';
import { markWideIntegers, promoteNumbers } from './rpcCodec.ts';
import { toWireError, type RpcFrame, type RpcReply } from './protocol.ts';
import {
  ADMIN_METHODS,
  COLLECTION_ACK_METHODS,
  COLLECTION_CURSOR_METHODS,
  COLLECTION_METHODS,
  CURSOR_SHAPING_METHODS,
  CURSOR_TERMINAL_METHODS,
  DB_ACK_METHODS,
  DB_CURSOR_METHODS,
  DB_METHODS,
  MAX_RPC_ARGS,
  MAX_RPC_ARGS_CHARS,
  MAX_RPC_IN_FLIGHT,
} from './rpcSurface.ts';

/**
 * Main-side executor for the script child's database calls. This is where a
 * script's read-only guard lives: the child holds no client, so the only way
 * it reaches the database is a frame that comes through `handle`.
 *
 * Everything in a frame is attacker-controlled, because a script can post
 * whatever it wants to the parent port. So a frame never selects *what* runs,
 * only *which of a fixed list of things* runs:
 *  - `target` picks one of four objects, each built here with `makeDbProxy`
 *    over main's own client and a live read-only check, never reached by name;
 *  - `method` must be a member of that object's allowlist (`rpcSurface.ts`);
 *  - a cursor is found in this run's own table by an id main minted.
 * There is no generic "call property X" path, so the driver's internals (a
 * cursor's `cursorClient`, a collection's `s` bag) are not addressable at all.
 *
 * Nothing here holds a credential either: the client comes from the pool, and
 * a result only leaves as EJSON after a check that it is plain data.
 */

/**
 * Cursor handles one run may hold at once. A script that opens more has its
 * oldest handle closed to make room: a long shell session leaves a handle
 * behind for every bare `db.x.find()` it never iterates, so refusing the
 * next one would end the session's usefulness rather than bound anything.
 */
const MAX_OPEN_CURSORS = 256;

type Callable = (...args: unknown[]) => unknown;
type Bag = Record<string, unknown>;

export interface RpcHostOpts {
  /** Main's own client for the run's connection. */
  client: MongoClient;
  /** Read fresh on every call: a flip mid-run must refuse the next write. */
  isReadOnly: () => boolean;
  /** Aborted when the run ends or is killed, so in-flight driver work stops. */
  signal: AbortSignal;
  /** Told about a cursor that failed to close; never throws back at the caller. */
  onCloseError?: (err: unknown) => void;
}

export interface RpcHost {
  /** Answer one frame. Never rejects: a failure is an `rpc-error` reply. */
  handle(frame: RpcFrame): Promise<RpcReply>;
  /** Close every cursor this run opened and refuse any later frame. */
  close(): Promise<void>;
}

export function createRpcHost(opts: RpcHostOpts): RpcHost {
  const cursors = new Map<string, Bag>();
  let closed = false;
  let inFlight = 0;

  const proxyFor = (dbName: string): Bag =>
    makeDbProxy({
      client: opts.client,
      currentDb: dbName,
      signal: opts.signal,
      isReadOnly: opts.isReadOnly,
    }) as Bag;

  async function closeCursor(cursor: Bag): Promise<void> {
    try {
      await member(cursor, 'close')();
    } catch (err) {
      opts.onCloseError?.(err);
    }
  }

  function keepCursor(cursor: unknown): string {
    if (cursors.size >= MAX_OPEN_CURSORS) {
      // A Map iterates in insertion order, so the first entry is the oldest.
      const [oldestId, oldest] = cursors.entries().next().value as [string, Bag];
      cursors.delete(oldestId);
      void closeCursor(oldest);
    }
    const cursorId = randomUUID();
    cursors.set(cursorId, cursor as Bag);
    return cursorId;
  }

  async function dispatch(frame: RpcFrame): Promise<RpcReply> {
    if (closed) throw new SystemError('INTERNAL', 'the script run has ended');
    const { id } = frame;
    const method = requireString(frame.method, 'method');

    switch (frame.target) {
      case 'db': {
        requireMember(DB_METHODS, method, 'db');
        const args = parseArgs(frame.argsEjson);
        const fn = member(proxyFor(requireString(frame.dbName, 'dbName')), method);
        const out = fn(...args);
        if (DB_CURSOR_METHODS.has(method)) return { type: 'rpc-result', id, cursorId: keepCursor(out) };
        if (DB_ACK_METHODS.has(method)) {
          await out;
          return ok(id, { ok: 1 });
        }
        return ok(id, await out);
      }
      case 'admin': {
        requireMember(ADMIN_METHODS, method, 'admin');
        const args = parseArgs(frame.argsEjson);
        // Under read-only this is where it stops: `admin()` itself is refused.
        const admin = (member(proxyFor(requireString(frame.dbName, 'dbName')), 'admin')() as Bag);
        return ok(id, await member(admin, method)(...args));
      }
      case 'collection': {
        requireMember(COLLECTION_METHODS, method, 'collection');
        const args = parseArgs(frame.argsEjson);
        const dbName = requireString(frame.dbName, 'dbName');
        const collName = requireString(frame.coll, 'coll');
        // `collection(name)`, never `proxy[name]`: a collection called `stats`
        // or `admin` must not resolve to the Db method of that name.
        const coll = member(proxyFor(dbName), 'collection')(collName) as Bag;
        const out = member(coll, method)(...args);
        if (COLLECTION_CURSOR_METHODS.has(method)) return { type: 'rpc-result', id, cursorId: keepCursor(out) };
        if (COLLECTION_ACK_METHODS.has(method)) {
          await out;
          return ok(id, { ok: 1 });
        }
        return ok(id, method === 'bulkWrite' ? bulkWriteSummary(await out) : await out);
      }
      case 'cursor': {
        const shaping = CURSOR_SHAPING_METHODS.has(method);
        if (!shaping) requireMember(CURSOR_TERMINAL_METHODS, method, 'cursor');
        const cursorId = requireString(frame.cursorId, 'cursorId');
        const cursor = cursors.get(cursorId);
        if (cursor === undefined) throw new ValidationError('rpc: unknown cursor');
        const args = parseArgs(frame.argsEjson);
        const out = member(cursor, method)(...args);
        if (shaping) return ok(id, undefined);
        const value = await out;
        // Finished cursors give their slot back: toArray exhausts one, close
        // ends one, and a read that finds nothing left means the same.
        if (
          method === 'toArray' ||
          method === 'close' ||
          ((method === 'next' || method === 'tryNext') && value === null) ||
          (method === 'hasNext' && value === false)
        ) {
          cursors.delete(cursorId);
        }
        return ok(id, value);
      }
      default:
        throw new ValidationError('rpc: unknown target');
    }
  }

  return {
    async handle(frame) {
      // An error reply, not a kill: the excess is refused and the run goes on.
      if (inFlight >= MAX_RPC_IN_FLIGHT) {
        return rpcError(frame.id, new ValidationError('rpc: too many calls in flight'));
      }
      inFlight++;
      try {
        return await dispatch(frame);
      } catch (err) {
        return rpcError(frame.id, err);
      } finally {
        inFlight--;
      }
    },
    async close() {
      closed = true;
      const open = [...cursors.values()];
      cursors.clear();
      await Promise.all(open.map(closeCursor));
    },
  };
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`rpc: ${what} must be a non-empty string`);
  }
  return value;
}

function requireMember(allowed: ReadonlySet<string>, method: string, on: string): void {
  if (!allowed.has(method)) throw new ValidationError(`rpc: '${method}' is not callable on ${on}`);
}

/** A function off `obj`, looked up by a name already checked against an allowlist. */
function member(obj: Bag, name: string): Callable {
  const fn = obj[name];
  if (typeof fn !== 'function') throw new SystemError('INTERNAL', `rpc: '${name}' is not available`);
  return fn as Callable;
}

function parseArgs(argsEjson: unknown): unknown[] {
  const text = requireString(argsEjson, 'argsEjson');
  // Before the parse: the point is that an oversized text is never walked.
  if (text.length > MAX_RPC_ARGS_CHARS) {
    throw new ValidationError(`rpc: argsEjson is longer than ${MAX_RPC_ARGS_CHARS} characters`);
  }
  const args = promoteNumbers(parseEjsonField<unknown>(text, 'argsEjson'), true);
  if (!Array.isArray(args) || args.length > MAX_RPC_ARGS) {
    throw new ValidationError(`rpc: argsEjson must be an array of at most ${MAX_RPC_ARGS} values`);
  }
  return args;
}

/**
 * `bulkWrite` resolves to a `BulkWriteResult`, a class instance, so it would be
 * refused as not plain data after the write had already happened. What a
 * script reads off it is these counts and id maps (the raw server reply is
 * not enumerable on it), so those are what crosses.
 */
function bulkWriteSummary(result: unknown): unknown {
  const r = result as Record<string, unknown>;
  return {
    ok: r.ok,
    insertedCount: r.insertedCount,
    matchedCount: r.matchedCount,
    modifiedCount: r.modifiedCount,
    deletedCount: r.deletedCount,
    upsertedCount: r.upsertedCount,
    insertedIds: r.insertedIds,
    upsertedIds: r.upsertedIds,
  };
}

function ok(id: number, value: unknown): RpcReply {
  return { type: 'rpc-result', id, valueEjson: encodeData(value) };
}

function rpcError(id: number, err: unknown): RpcReply {
  const wire = toWireError(err instanceof AppError ? err : classifyMongoOpError(err));
  // The stack is main's own: paths and frames the script has no use for.
  delete wire.stack;
  return { type: 'rpc-error', id, error: wire };
}

/** A value is data when it is a primitive, an array, a plain document or a BSON/Date value. */
function isPlainData(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (Array.isArray(value)) return true;
  if (value instanceof Date) return true;
  if ('_bsontype' in value) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize a driver result for the child (`undefined` comes out as `null`,
 * which is what EJSON makes of it). A result that is not plain data (a
 * `Collection`, a change stream, an `Admin`) is refused rather than encoded:
 * those objects reach the client, and through it the connection options.
 */
function encodeData(value: unknown): string {
  if (!isPlainData(value) || (Array.isArray(value) && !value.every(isPlainData))) {
    throw new SystemError('INTERNAL', 'rpc: the call returned something that is not plain data');
  }
  // Marked per element for an array, so a result over the cap stops at the
  // element that breaches it instead of after the whole array has been walked.
  if (Array.isArray(value)) {
    return ejsonEncodeArrayJson(value, { maxBytes: MAX_SCRIPT_RESULT_BYTES, prepare: markWideIntegers });
  }
  const json = ejsonStringify(markWideIntegers(value));
  if (json.length > MAX_SCRIPT_RESULT_BYTES) {
    throw new SystemError('INTERNAL', `result size exceeds ${MAX_SCRIPT_RESULT_BYTES} byte cap`);
  }
  return json;
}
