import type { MongoClient, Db } from 'mongodb';
import { ReadOnlyConnectionError } from '../errors.ts';
import { isWriteStage } from './writeStages.ts';

/**
 * Shared `db` proxy used by both the W11 shell pane (`ShellService`) and the
 * W12 script editor (`ScriptService`). Exposes the live `MongoClient`
 * through a mongosh-flavoured surface:
 *
 *   db                     → the current database name
 *   db.<collName>          → a Collection (with mongosh→driver method aliases)
 *   db.runCommand(...)     → driver `db.command(...)`
 *   db.getSiblingDB(name)  → a new proxy scoped to `name`, current `db` unchanged
 *
 * `ctx.currentDb` is mutable so callers can switch the active database (e.g.
 * `use("foo")`) without rebuilding the proxy. An optional `signal` is
 * auto-threaded into:
 *   - collection ops that accept `Abortable` (find, findOne, aggregate,
 *     update*, delete*, etc.) — missing positionals are padded with
 *     `undefined` so common calls like `find()` still get the signal;
 *   - cursor-returning ops — the cursor is proxied so terminal methods
 *     (`toArray`, `forEach`, `next`, …) inherit the signal too.
 *
 * The user's options object wins: if they passed `{ signal: x }` (even
 * `signal: undefined`), the wrapper steps aside.
 *
 * When `ctx.isReadOnly` is set (script pane only — see ADR 0005 for why the
 * shell pane refuses its whole session instead of relying on this), every
 * collection method not in READ_COLL_METHODS throws, and `aggregate`
 * additionally rejects a pipeline containing `$out`/`$merge`. Every direct
 * `Db` method other than `collection` (`dropDatabase`, `createCollection`,
 * `command`/`runCommand`, `admin`, etc.) throws outright — there's no way to
 * classify an arbitrary `runCommand` payload as read-only-safe, so the
 * default under read-only is deny.
 */
export interface DbProxyCtx {
  currentDb: string;
  client: MongoClient;
  /** Optional AbortSignal auto-threaded into collection ops that accept it. */
  signal?: AbortSignal;
  /**
   * Called fresh immediately before each driver call rather than read once —
   * a script's write surface must track a Connection flipped to read-only
   * mid-run, not just its state at proxy construction. A function, not a
   * getter: `getSiblingDB` builds the sibling proxy via
   * `{ ...ctx, currentDb: name }`, and a spread evaluates a getter once,
   * snapshotting the very value this is meant to keep live. A function
   * reference survives the spread.
   *
   * Checking at property access is not enough, and that is not a theoretical
   * gap: `const insert = db.items.insertOne` hands back a reference that
   * outlives the check. A probe caching the reference while writable, then
   * flipping, completed the insert — and the same held for a cached direct
   * `Db` method, a cached `aggregate` running `$out`, and an `Admin` object
   * captured from `db.admin()`.
   */
  isReadOnly?: () => boolean;
}

/**
 * Throws synchronously, deliberately — NOT a rejected Promise. Several
 * denied methods (`aggregate`, `admin`) return a cursor/object synchronously
 * in the real driver and only go async on what's chained onto that return
 * value (`.toArray()`, `.listDatabases()`); returning a rejected Promise
 * here instead would make that chaining crash with a confusing "not a
 * function" instead of this error. A sync throw inside `await`'d or
 * try/catch-wrapped sandboxed script code is caught identically to a
 * rejected promise either way.
 */
function readOnlyDenied(what: string): never {
  throw new ReadOnlyConnectionError(
    `This connection is read-only — "${what}" is not permitted.`,
  );
}

const DB_ALIASES: Record<string, string> = {
  runCommand: 'command',
};
const COLLECTION_ALIASES: Record<string, string> = {
  count: 'countDocuments',
};

/**
 * Maximum number of non-options positional arguments each signal-aware
 * method accepts. The wrapper pads missing positionals with `undefined`
 * so the options object always lands in the right slot, and merges the
 * `signal` into whatever options the user passed (without overwriting
 * an explicit `signal: x`).
 */
const SIGNAL_AWARE_COLL_METHODS: Record<string, number> = {
  find: 1,
  findOne: 1,
  aggregate: 1,
  countDocuments: 1,
  estimatedDocumentCount: 0,
  distinct: 2,
  updateOne: 2,
  updateMany: 2,
  replaceOne: 2,
  deleteOne: 1,
  deleteMany: 1,
  insertOne: 1,
  insertMany: 1,
  findOneAndUpdate: 2,
  findOneAndReplace: 2,
  findOneAndDelete: 1,
  bulkWrite: 1,
};

/**
 * Collection methods that return cursors (or cursor-like iterables). We
 * wrap their return value so terminal/iterator methods (`.toArray()`,
 * `.forEach()`, `.next()`, `.tryNext()`, `.hasNext()`) inherit the
 * AbortSignal — without this, `db.coll.find().toArray()` would run
 * uncancelable.
 */
const CURSOR_RETURNING_METHODS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'listIndexes',
  'listSearchIndexes',
  'watch',
]);

/**
 * Cursor methods that take an options bag whose `signal` we want to
 * thread through. (`forEach` accepts `(callback, options?)`, the rest
 * take `(options?)`.) We only intercept these when the cursor is
 * returned from a wrapped collection method.
 */
const CURSOR_TERMINAL_METHODS: ReadonlySet<string> = new Set([
  'toArray',
  'forEach',
  'next',
  'tryNext',
  'hasNext',
  'close',
]);

/**
 * Collection methods allowed under a read-only connection. Deny-by-default:
 * anything not in this set throws, including methods this file doesn't
 * otherwise know about (createIndex, drop, bulkWrite builders, etc.) — see
 * ADR 0005 (this replaced an earlier denylist that missed several of them).
 */
const READ_COLL_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
]);

function pipelineHasWriteStage(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some(
    (stage) =>
      stage !== null &&
      typeof stage === 'object' &&
      Object.keys(stage).some((op) => isWriteStage(op)),
  );
}

export function makeDbProxy(ctx: DbProxyCtx): unknown {
  const getDb = (): Db => ctx.client.db(ctx.currentDb);
  return new Proxy(
    function db() {
      return ctx.currentDb;
    },
    {
      get(_target, prop) {
        if (prop === 'getName' || prop === Symbol.toPrimitive || prop === 'toString') {
          return () => ctx.currentDb;
        }
        if (prop === Symbol.for('nodejs.util.inspect.custom')) {
          return () => `Db(${ctx.currentDb})`;
        }
        // mongosh: unlike `use(name)`, does not mutate the current db — it
        // hands back an independent proxy scoped to `name`, leaving `db`
        // pointed at whatever it already was.
        if (prop === 'getSiblingDB') {
          return (name: string) => makeDbProxy({ ...ctx, currentDb: name });
        }
        const db = getDb();
        const propStr = String(prop);
        const resolved = DB_ALIASES[propStr] ?? propStr;
        if (resolved === 'collection') {
          return (name: string) => wrapCollection(db.collection(name), ctx, name);
        }
        const direct = (db as unknown as Record<string, unknown>)[resolved];
        if (typeof direct === 'function') {
          const fn = direct as (...args: unknown[]) => unknown;
          if (ctx.isReadOnly === undefined) return fn.bind(db);
          return (...args: unknown[]) => {
            if (ctx.isReadOnly?.()) readOnlyDenied(resolved);
            return guardCapturedHandle(fn.apply(db, args), ctx, resolved);
          };
        }
        return wrapCollection(db.collection(propStr), ctx, propStr);
      },
    },
  );
}

function wrapCollection<T extends object>(coll: T, ctx: DbProxyCtx, name: string): T {
  const read = (target: object, prop: string | symbol): unknown => {
      const propStr = String(prop);
      const resolved = COLLECTION_ALIASES[propStr] ?? propStr;
      const v = (target as unknown as Record<string, unknown>)[resolved];
      if (typeof v !== 'function') return guardPlainProperty(v, ctx, resolved);
      const fn = v as (...args: unknown[]) => unknown;

      const positional = SIGNAL_AWARE_COLL_METHODS[resolved];
      const returnsCursor = CURSOR_RETURNING_METHODS.has(resolved);
      const guarded = ctx.isReadOnly !== undefined;

      // The fast paths are only safe on an unguarded ctx (the shell pane,
      // which refuses its whole session instead — ADR 0005). A guarded ctx
      // always gets the wrapper, because the check has to run at call time
      // rather than here: a bound method handed out now can be called after
      // the Connection flips.
      // Stryker disable next-line ConditionalExpression,BlockStatement: this whole block is a
      // performance shortcut for the unguarded (shell) path only — the slow path below is
      // behaviorally identical for every (signal, positional, returnsCursor) combination when
      // `!guarded`, since ctx.isReadOnly is undefined there so the wrapper's own checks are all
      // no-ops. Verified exhaustively (8 input combinations) with a node probe reimplementing
      // both branches and diffing observable output; zero differences found.
      if (!guarded) {
        // Stryker disable next-line ConditionalExpression: subsumed by the outer block's
        // equivalence proof above — forcing this branch off still falls through to the
        // behaviorally identical slow path. Probe-verified.
        if (!ctx.signal) return fn.bind(target);
        // Stryker disable next-line ConditionalExpression,LogicalOperator: same reasoning —
        // probe-verified equivalent to the slow path for every relevant input combination.
        if (positional === undefined && !returnsCursor) return fn.bind(target);
      }

      return (...args: unknown[]) => {
        if (ctx.isReadOnly?.()) {
          if (!READ_COLL_METHODS.has(resolved)) readOnlyDenied(resolved);
          if (resolved === 'aggregate' && pipelineHasWriteStage(args[0])) {
            throw new ReadOnlyConnectionError(
              'This connection is read-only — the pipeline contains a write stage ($out/$merge).',
            );
          }
        }
        const callArgs =
          ctx.signal && positional !== undefined
            ? mergeSignalOptions(args, positional, ctx.signal)
            : args;
        const out = fn.call(target, ...callArgs);
        // A write method's return is a handle that can outlive the flip —
        // `initializeUnorderedBulkOp()` hands back a builder whose `execute()`
        // is the thing that actually writes. The read methods return cursors
        // and promises, which stay allowed.
        if (guarded && !READ_COLL_METHODS.has(resolved)) {
          return guardCapturedHandle(out, ctx, resolved);
        }
        return returnsCursor ? wrapCursor(out, ctx) : out;
      };
  };
  return new Proxy(coll, {
    get: (target, prop) => read(target, prop),
    getOwnPropertyDescriptor: guardedDescriptor(read, name),
  }) as T;
}

/**
 * `get` is not the only way to read a property, and a proxy that traps only
 * `get` leaves the other way open. `Object.getOwnPropertyDescriptor` goes
 * through `[[GetOwnProperty]]`, which falls straight through to the raw
 * target, so a script reads the descriptor and lifts the unguarded value out
 * of it. Confirmed by probe on a Connection that was read-only the whole
 * time: a descriptor read of `s` on a collection, and of `cursorClient` on a
 * cursor, each produced a real write. The script VM exposes the standard
 * `Object` intrinsic, so this is ordinary reachable script code.
 *
 * Returning the same value `get` would return closes it. An accessor
 * descriptor carries no `value` to guard and passes through; the driver keeps
 * none of its state that way.
 *
 * Non-configurable is where this gets sharp, because a script chooses it:
 * `Object.seal`/`Object.freeze` on a guarded handle forward to the target
 * through the default integrity traps and make the driver's own `s` bag
 * non-configurable. Bailing out on `configurable === false` — which this did —
 * then handed back the raw value on request. Probed against a real server with
 * `isReadOnly()` true throughout: `Object.seal(db.items)` followed by a
 * descriptor read of `s` returned the live `Db` and the insert came back
 * `acknowledged`.
 *
 * The invariant is narrower than that bail-out assumed. [[GetOwnProperty]]
 * only pins the value when the target property is non-configurable **and**
 * non-writable; `seal` leaves `writable` alone, so a sealed property can still
 * be reported guarded. `freeze` clears it, and then no guarded value can be
 * reported at all — returning one makes the engine throw `TypeError`. That
 * case refuses explicitly instead: an opaque engine error and a leaked write
 * surface are both worse than saying which rule stopped the script.
 */
function guardedDescriptor(
  read: (target: object, prop: string | symbol) => unknown,
  what: string,
): (target: object, prop: string | symbol) => PropertyDescriptor | undefined {
  return (target, prop) => {
    const d = Reflect.getOwnPropertyDescriptor(target, prop);
    if (d === undefined || !('value' in d)) return d;
    const guarded = read(target, prop);
    // Nothing was substituted, so the descriptor is already safe to report as
    // it stands — and reporting it verbatim keeps every frozen primitive
    // (`collectionName`, `dbName`) readable.
    if (Object.is(guarded, d.value)) return d;
    if (d.configurable === false && d.writable === false) {
      readOnlyDenied(`${what}.${String(prop)} (frozen)`);
    }
    return { ...d, value: guarded };
  };
}

/**
 * Guard a plain (non-function) property read off a guarded object.
 *
 * A property that is not a function is not therefore inert. Every class in
 * the driver keeps its internals in a plain `s` bag — `Collection`'s and
 * `Admin`'s both hold the real `Db` — and it is an ordinary enumerable
 * instance property, not a private field. Handing one back untouched returns
 * an unguarded write surface for the whole database: `db.<coll>.s.db` then
 * inserts, against a Connection that has been read-only the entire time.
 * Confirmed by probe, and it needs no method call and no state change, only
 * one property read.
 *
 * Primitives cannot carry a write surface, so they pass through. Objects are
 * guarded, which makes every function eventually reachable from one check at
 * the moment it is called.
 */
function guardPlainProperty(value: unknown, ctx: DbProxyCtx, what: string): unknown {
  if (ctx.isReadOnly === undefined) return value;
  // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: redundant
  // with guardCapturedHandle's own `!value || (typeof value!=='object' && typeof value!=='function')`
  // early-return, and guardPlainProperty is only ever called with non-function values (its call
  // sites already checked `typeof v !== 'function'`), so for every value that can reach here the
  // two checks agree on every branch. Verified with a node probe over null/undefined/primitives/
  // objects/arrays comparing the original two-check path against always falling through to
  // guardCapturedHandle: zero observable differences.
  if (value === null || typeof value !== 'object') return value;
  return guardCapturedHandle(value, ctx, what);
}

/**
 * Guard a driver object handed back by a call that a read-only Connection
 * would have refused — `db.admin()`, a `listCollections` cursor, a bulk
 * builder. Denying the call itself is not enough on its own: a script can
 * capture the return while the Connection is still writable and use it after
 * the flip, and a probe confirmed `db.admin()` captured that way still
 * completed an insert. Every function on the returned object re-checks.
 *
 * Nothing here is a new restriction — each of these came from a call that is
 * denied outright under read-only, so the guard only makes a captured handle
 * behave the way a fresh one already does.
 *
 * Promises pass through: the call that produced one has already run, so
 * denying `.then` would strand a result rather than prevent a write.
 */
function guardCapturedHandle(value: unknown, ctx: DbProxyCtx, what: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (typeof (value as { then?: unknown }).then === 'function') return value;
  const target = value as object;
  const read = (t: object, prop: string | symbol): unknown => {
      const v = (t as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof v !== 'function') return guardPlainProperty(v, ctx, `${what}.${String(prop)}`);
      return (...args: unknown[]) => {
        if (ctx.isReadOnly?.()) readOnlyDenied(`${what}().${String(prop)}`);
        const out = (v as (...a: unknown[]) => unknown).apply(t, args);
        // A builder method returns its own receiver so calls chain —
        // `bulk.insert({…}).insert({…}).execute()` is the driver's own
        // documented idiom. Handing back the raw receiver would drop the
        // guard for every call made on the chained reference, which is the
        // escape this function exists to close. Anything else a guarded call
        // produces is guarded in turn, for the same reason the handle was.
        return out === t ? guard : guardCapturedHandle(out, ctx, what);
      };
  };
  const guard: object = new Proxy(target, {
    get: (t, prop) => read(t, prop),
    getOwnPropertyDescriptor: guardedDescriptor(read, what),
  });
  return guard;
}

/**
 * Pad missing positionals with `undefined` and merge `{ signal }` into
 * the trailing options object. Preserves user-supplied options (an
 * explicit `signal: x` wins, including `signal: undefined` to opt out).
 *
 * Examples (positional = 1, signal = S):
 *   []                       → [undefined, { signal: S }]
 *   [{ a: 1 }]               → [{ a: 1 }, { signal: S }]
 *   [{ a: 1 }, { proj: 1 }]  → [{ a: 1 }, { proj: 1, signal: S }]
 *   [{ a: 1 }, { signal: X }]→ [{ a: 1 }, { signal: X }] (user wins)
 */
function mergeSignalOptions(
  args: unknown[],
  positional: number,
  signal: AbortSignal,
): unknown[] {
  // Stryker disable next-line MethodExpression: every call site in this file passes a fresh
  // rest-param array and never reads the original `args` reference again afterward — only the
  // returned value is ever observed, never whether `out` aliases `args`. Verified with a node
  // probe across 6 representative (args, positional) combinations: dropping `.slice()` produces
  // byte-identical returned output in every case.
  const out = args.slice();
  // Pad with undefined up to `positional` so the options slot is at index `positional`.
  while (out.length < positional) out.push(undefined);
  if (out.length === positional) {
    out.push({ signal });
    return out;
  }
  // User passed options — merge without clobbering an explicit `signal`.
  const userOpts = out[positional];
  // Something non-object in the options slot is left alone; the driver will validate.
  if (userOpts && typeof userOpts === 'object') {
    const userObj = userOpts as Record<string, unknown>;
    out[positional] = 'signal' in userObj ? userObj : { ...userObj, signal };
  }
  return out;
}

/**
 * Wrap a cursor (or cursor-like) so its terminal methods inherit the
 * AbortSignal. Some terminal methods take an options bag (`forEach`
 * takes `(cb, options?)`, the rest take `(options?)`); we merge into
 * the right slot. Methods that don't appear in `CURSOR_TERMINAL_METHODS`
 * pass through unchanged so cursor-shaping (`.sort`, `.limit`, `.skip`,
 * `.project`, `.map`, etc.) continues to chain.
 *
 * If the value isn't actually a cursor (typeof !== object), pass it
 * through — `find` returns a cursor but other paths might not.
 *
 * A cursor is also a read-only concern, not only a cancellation one.
 * `AbstractCursor` keeps the live `MongoClient` on `cursorClient`, a plain
 * own property, so an unwrapped cursor is an unrestricted write surface
 * reached from `db.<coll>.find()` — the most ordinary thing a script does,
 * always allowed, on a Connection that was never writable. Hence a guarded
 * ctx gets the proxy whether or not there is a signal to thread.
 */
function wrapCursor(cursor: unknown, ctx: DbProxyCtx): unknown {
  if (!cursor || (typeof cursor !== 'object' && typeof cursor !== 'function')) {
    return cursor;
  }
  // Stryker disable next-line ConditionalExpression: dead code, not merely equivalent — wrapCursor
  // has exactly 3 call sites (grepped): the slow closure in wrapCollection, reached only when the
  // `!guarded` fast path above did NOT return early, which requires `ctx.signal` truthy or
  // `guarded` (ctx.isReadOnly !== undefined); and this function's own recursive call, which reuses
  // the same ctx. Every path that reaches this line therefore already has `ctx.signal` truthy or
  // `ctx.isReadOnly !== undefined`, so this condition is always false and the early return never
  // fires for any real input. Forcing it to `if (false)` changes nothing.
  if (!ctx.signal && ctx.isReadOnly === undefined) return cursor;
  const signal = ctx.signal;
  const read = (target: object, prop: string | symbol): unknown => {
      const propStr = String(prop);
      // Index with `prop`, not its string form: stringifying turns
      // `Symbol.asyncIterator` into the key `"Symbol(Symbol.asyncIterator)"`,
      // which no cursor has, so the proxy exposed no async iterator at all
      // and `for await (const doc of db.items.find())` threw. `propStr`
      // stays for the string-keyed lookups below.
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof v !== 'function') return guardPlainProperty(v, ctx, propStr);
      const fn = v as (...args: unknown[]) => unknown;
      // The symbol-keyed members are the iteration protocol, and it needs the
      // real generator: a proxy between `next()` and its `{value, done}`
      // would have to be unwrapped by the protocol, which cannot. Nothing is
      // given away — the generator holds no driver handle of its own, the
      // documents it yields are plain data, and iterating is a read, which a
      // read-only Connection allows. The signal still applies: it was merged
      // into the `find`/`aggregate` options, so the cursor itself carries it.
      if (typeof prop === 'symbol') return fn.bind(target);
      if (signal !== undefined && CURSOR_TERMINAL_METHODS.has(propStr)) {
        // forEach takes (callback, options?) — options at slot 1.
        // Everything else takes (options?) — options at slot 0.
        const optionsSlot = propStr === 'forEach' ? 1 : 0;
        return (...args: unknown[]) => {
          const merged = mergeSignalOptions(args, optionsSlot, signal);
          return fn.call(target, ...merged);
        };
      }
      // Cursor-shaping methods (`.sort`, `.limit`, etc.) return the
      // same cursor (chainable). Hand back the wrapper, not the raw
      // receiver, or the chain drops both the signal and the guard — which
      // is what returning the bare cursor here used to do.
      return (...args: unknown[]) => {
        const out = fn.call(target, ...args);
        return out === target ? wrapped : wrapCursor(out, ctx);
      };
  };
  const wrapped: object = new Proxy(cursor as object, {
    get: (target, prop) => read(target, prop),
    getOwnPropertyDescriptor: guardedDescriptor(read, 'cursor'),
  });
  return wrapped;
}
