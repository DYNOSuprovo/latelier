import * as vm from 'node:vm';
import { Parser, type Node } from 'acorn';
import { AbstractCursor } from 'mongodb';
import {
  ObjectId,
  Decimal128,
  Long,
  Double,
  Int32,
  Binary,
  Code,
  EJSON,
  MaxKey,
  MinKey,
  Timestamp,
  UUID,
} from 'bson';
import type {
  ScriptRunInput,
  ScriptRunResultWire,
} from '@shared/types';
import { ConflictError, SystemError, ValidationError } from '../errors.ts';
import type { MongoPool } from '../mongo/MongoPool.ts';
import { makeDbProxy } from '../mongo/dbProxy.ts';
import { ejsonEncode } from '../mongo/ejson.ts';
import { classifyMongoOpError } from '../mongo/errors.ts';

const DEFAULT_MAX_TIME_MS = 60_000;
const PRINT_BUFFER_CAP = 64 * 1024;
/**
 * Cap for auto-iterating a cursor result. Mirrors mongosh's "first batch"
 * UX so `db.coll.find()` shows documents instead of collapsing to `null`.
 * Users who need the full result still call `.toArray()` explicitly.
 */
const CURSOR_AUTO_ITERATE_LIMIT = 50;
/**
 * The async IIFE wrapper prepends one synthetic line (`(async () => {`),
 * which shifts every subsequent line by 1 in vm-reported errors. We feed
 * this as a negative `lineOffset` to `vm.runInContext` and also subtract
 * it from line numbers we extract from messages/stacks before showing
 * them to the user.
 */
const WRAPPER_LINE_OFFSET = 1;

export interface ScriptServiceOpts {
  pool: MongoPool;
}

/**
 * In-process JS runner for the W12 script editor. Each `run()` allocates a
 * fresh `vm.Context` populated with a Mongo driver-backed `db` proxy,
 * `print` helpers, BSON constructors, and an `AbortSignal` auto-threaded
 * into collection ops. The user's source is wrapped in an async IIFE so
 * top-level `await` works; the last top-level expression (per acorn) is
 * `return`-prefixed so its value flows back as the result.
 *
 * Hard timeouts (`vm` `timeout` option) cap CPU-bound runaways. The
 * AbortController bound to `cancelToken` caps driver-bound waits.
 */
export class ScriptService {
  private readonly pool: MongoPool;
  private readonly active = new Map<string, AbortController>();

  constructor(opts: ScriptServiceOpts) {
    this.pool = opts.pool;
  }

  async run(input: ScriptRunInput): Promise<ScriptRunResultWire> {
    if (typeof input.source !== 'string') {
      throw new ValidationError('source must be a string', { field: 'source' });
    }
    if (input.source.length > 1_000_000) {
      throw new ValidationError('source exceeds 1 MB', { field: 'source' });
    }

    const maxTimeMs = clampTimeout(input.maxTimeMs ?? DEFAULT_MAX_TIME_MS);

    // Register the cancel token BEFORE awaiting the pool — otherwise a hung
    // connect would be uncancelable because the controller isn't in `active`
    // yet when `cancel(token)` looks it up.
    //
    // A token is meant to name one cancelable run (the renderer mints a
    // fresh `crypto.randomUUID()` per Run click — see ScriptTab.tsx). If a
    // caller reuses a token that's still in flight, `active.set` would
    // silently clobber the earlier AbortController and `cancel(token)`
    // would only ever reach the newer run, orphaning the first one for up
    // to the 24h maxTimeMs ceiling. Reject the duplicate up front instead —
    // cheaper and more honest than tracking multiple controllers per token.
    //
    // The entry stays in `active` until ITS OWN run's cleanup removes it —
    // `cancel(token)` only aborts, it does not delete. Deleting on cancel
    // would let a same-token run() fired immediately after reuse the token
    // while the cancelled run is still unwinding; that run's own `finally`
    // would then delete the new run's controller out from under it,
    // silently uncancelable — the exact bug this comment used to fix,
    // reappearing via a different path. `releaseToken` below only deletes
    // when the map still holds this run's own controller.
    const ctrl = new AbortController();
    if (input.cancelToken) {
      if (this.active.has(input.cancelToken)) {
        throw new ConflictError(
          `cancelToken '${input.cancelToken}' is already in use by an in-flight script`,
          { field: 'cancelToken' },
        );
      }
      this.active.set(input.cancelToken, ctrl);
    }

    let client;
    try {
      // Force a connect upfront so connect failures surface as clean errors
      // before any vm allocation. If the user cancels during this phase, the
      // controller is already wired and `ctrl.signal.aborted` is checked in
      // the catch.
      client = await this.pool.readClient(input.connectionId);
    } catch (err) {
      if (input.cancelToken) this.releaseToken(input.cancelToken, ctrl);
      if (ctrl.signal.aborted) {
        throw new SystemError('TIMEOUT', 'script cancelled');
      }
      throw err;
    }
    if (ctrl.signal.aborted) {
      if (input.cancelToken) this.releaseToken(input.cancelToken, ctrl);
      throw new SystemError('TIMEOUT', 'script cancelled');
    }

    const dbCtx = {
      currentDb: input.dbName ?? 'test',
      client,
      signal: ctrl.signal,
      isReadOnly: () => this.pool.isReadOnly(input.connectionId),
    };
    const dbProxy = makeDbProxy(dbCtx);

    let printBuffer = '';
    const appendPrint = (chunk: string): void => {
      if (printBuffer.length >= PRINT_BUFFER_CAP) return;
      const remaining = PRINT_BUFFER_CAP - printBuffer.length;
      printBuffer += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    };

    const sandbox: Record<string, unknown> = {
      db: dbProxy,
      use: (name: string): string => {
        if (typeof name !== 'string' || name.length === 0) {
          throw new ValidationError('use(name): name must be a non-empty string');
        }
        dbCtx.currentDb = name;
        return `switched to db ${name}`;
      },
      print: (...args: unknown[]): void => {
        appendPrint(args.map(stringifyForPrint).join(' ') + '\n');
      },
      printjson: (value: unknown): void => {
        appendPrint(stringifyForPrint(value) + '\n');
      },
      signal: ctrl.signal,
      EJSON,
      ObjectId,
      Decimal128,
      Long,
      Double,
      Int32,
      Binary,
      Code,
      MaxKey,
      MinKey,
      Timestamp,
      UUID,
      // mongosh aliases
      ISODate: (s?: string): Date => (s ? new Date(s) : new Date()),
      NumberLong: (v: string | number): Long => Long.fromString(String(v)),
      NumberDecimal: (v: string): Decimal128 => Decimal128.fromString(String(v)),
      NumberInt: (v: string | number): Int32 => new Int32(Number(v)),
      // Console-ish surface so users can debug. Maps to print buffer too.
      console: {
        log: (...args: unknown[]) =>
          appendPrint(args.map(stringifyForPrint).join(' ') + '\n'),
        error: (...args: unknown[]) =>
          appendPrint('ERROR: ' + args.map(stringifyForPrint).join(' ') + '\n'),
        warn: (...args: unknown[]) =>
          appendPrint('WARN: ' + args.map(stringifyForPrint).join(' ') + '\n'),
      },
    };

    const wrapped = wrapSource(input.source);
    const ctx = vm.createContext(sandbox);
    const t0 = Date.now();

    let wallClockTimer: NodeJS.Timeout | undefined;

    try {
      const result = vm.runInContext(wrapped, ctx, {
        timeout: maxTimeMs,
        breakOnSigint: false,
        filename: 'script.js',
        // The wrapper IIFE adds one synthetic line at the top; subtract it
        // so SyntaxErrors and stack traces show line numbers that match the
        // user's editor.
        lineOffset: -WRAPPER_LINE_OFFSET,
      }) as Promise<unknown>;
      // Suppress unhandled-rejection when the wall-clock wins the race;
      // the user script is aborted via ctrl.signal but its promise may
      // still reject later with the resulting AbortError.
      result.catch(() => {});
      // The IIFE always returns a Promise; await it so user `await`s
      // resolve before we serialize the value. `vm` `timeout` only fires
      // for synchronous CPU-bound code — an `async` runaway like
      // `while (true) await Promise.resolve()` would hang here forever.
      // Race against a wall-clock timer that aborts the controller and
      // surfaces a TIMEOUT error.
      const wallClock = new Promise<never>((_, reject) => {
        wallClockTimer = setTimeout(() => {
          ctrl.abort();
          reject(
            new SystemError(
              'TIMEOUT',
              `script exceeded ${maxTimeMs}ms (cancel and rerun, or raise the limit)`,
            ),
          );
        }, maxTimeMs);
      });
      const value = await Promise.race([result, wallClock]);

      // If the script returned a live cursor (e.g. `db.coll.find()`),
      // auto-iterate the first batch so it renders as an array instead
      // of collapsing to `null` via the non-serializable fallback.
      const materialized = await materializeIfCursor(value, CURSOR_AUTO_ITERATE_LIMIT);
      if (materialized.truncated) {
        appendPrint(
          `[cursor truncated to first ${CURSOR_AUTO_ITERATE_LIMIT} documents — call .toArray() for the full result]\n`,
        );
      }

      const durationMs = Date.now() - t0;
      const finalValue = materialized.value;

      const valueJson =
        finalValue === undefined
          ? null
          : await safeEjsonEncodeJson(
              finalValue,
              input.ejsonRelaxed ?? false,
              ctrl.signal,
              t0 + maxTimeMs,
              maxTimeMs,
            );

      return { valueJson, printBuffer, durationMs };
    } catch (err) {
      // Wall-clock TIMEOUT (and any other AppError we already classified)
      // already carries the right code and message; pass it through.
      if (err instanceof SystemError) throw err;
      if (err instanceof ValidationError) throw err;
      // vm `timeout` throws an Error with code 'ERR_SCRIPT_EXECUTION_TIMEOUT'.
      const e = err as { code?: string; message?: string; name?: string; stack?: string };
      if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new SystemError(
          'TIMEOUT',
          `script exceeded ${maxTimeMs}ms (cancel and rerun, or raise the limit)`,
        );
      }
      // SyntaxError from the wrapped source — surface as ValidationError so
      // the renderer paints it as a user-fixable error, not a crash.
      if (e.name === 'SyntaxError') {
        throw new ValidationError(
          `syntax error: ${shiftLineNumbers(e.message ?? '')}`,
          { field: 'source' },
        );
      }
      // AbortError from the driver during cancel — surface clearly.
      if (e.name === 'AbortError' || ctrl.signal.aborted) {
        throw new SystemError('TIMEOUT', 'script cancelled');
      }
      // Anything else: classify Mongo errors, otherwise wrap as MONGO_ERROR.
      // Shift line numbers in the message/stack so they match the user's
      // editor before letting classifyMongoOpError wrap it.
      if (typeof e.message === 'string') e.message = shiftLineNumbers(e.message);
      if (typeof e.stack === 'string') e.stack = shiftLineNumbers(e.stack);
      throw classifyMongoOpError(err);
    } finally {
      if (wallClockTimer) clearTimeout(wallClockTimer);
      if (input.cancelToken) this.releaseToken(input.cancelToken, ctrl);
    }
  }

  cancel(token: string): void {
    this.active.get(token)?.abort();
  }

  /**
   * Remove `token` from `active` only if it still maps to `ctrl` — i.e.
   * only if this run is still the token's owner. A cancelled run's cleanup
   * must not delete a different run's controller that reused the same
   * token while the cancelled run was unwinding.
   */
  private releaseToken(token: string, ctrl: AbortController): void {
    if (this.active.get(token) === ctrl) this.active.delete(token);
  }

  /** Abort all in-flight scripts. Wired to `app.before-quit`. */
  cancelAll(): void {
    for (const ctrl of this.active.values()) ctrl.abort();
    this.active.clear();
  }
}

// ─── Source rewrite ─────────────────────────────────────────────────────────

/**
 * Wrap the user's source so it runs as an async IIFE. If the final
 * top-level statement is an ExpressionStatement (per acorn), prefix it
 * with `return ` so the IIFE's resolved value carries it back to the
 * caller — mirroring how Node's REPL surfaces the value of the last
 * expression. If parsing fails, fall through with the source unmodified
 * so the vm reports the user's syntax error verbatim.
 */
export function wrapSource(source: string): string {
  const rewritten = tryRewriteLastExpression(source);
  return `(async () => {\n${rewritten}\n})()`;
}

function tryRewriteLastExpression(source: string): string {
  let ast: { body: Node[] };
  try {
    ast = Parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Node[] };
  } catch {
    return source;
  }
  const body = ast.body;
  if (body.length === 0) return source;
  const last = body[body.length - 1] as Node & { type: string; start: number; end: number };
  if (last.type !== 'ExpressionStatement') return source;
  // Splice `return ` in front of the last expression. Use the AST `start`
  // offset so leading whitespace / comments stay intact.
  return source.slice(0, last.start) + 'return ' + source.slice(last.start);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * If `value` is a live Mongo cursor (FindCursor, AggregationCursor, …),
 * pull up to `limit` documents into an array and report whether more
 * remained. The cursor is closed before returning so we don't leak a
 * server-side resource. Non-cursor values pass through unchanged.
 *
 * `instanceof AbstractCursor` works through our `wrapCursor` Proxy
 * because the proxy doesn't override `getPrototypeOf`. The proxy's
 * `get` trap forwards string-keyed methods like `next`/`tryNext`/`close`
 * to the underlying cursor with the AbortSignal threaded in.
 */
async function materializeIfCursor(
  value: unknown,
  limit: number,
): Promise<{ value: unknown; truncated: boolean }> {
  if (!(value instanceof AbstractCursor)) {
    return { value, truncated: false };
  }
  try {
    const docs: unknown[] = [];
    while (docs.length < limit) {
      const doc = await value.next();
      // Cursor exhausted inside the cap — definitively not truncated.
      if (doc === null) return { value: docs, truncated: false };
      docs.push(doc);
    }
    // Hit the cap. Peek once to decide whether more remained.
    const peek = await value.tryNext();
    return { value: docs, truncated: peek !== null };
  } finally {
    // Close on every path so a throwing next()/tryNext() doesn't leak
    // the server-side cursor.
    await value.close().catch(() => {});
  }
}

function stringifyForPrint(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return EJSON.stringify(value as object, undefined, 2, { relaxed: true });
  } catch {
    return String(value);
  }
}

// Soft cap on the synchronous EJSON encode of a script result. An explicit
// `.toArray()` on a large collection materializes everything and is encoded on
// the main event loop; without a cap, 200k docs → 95MB / 778ms block plus an
// unbounded blob sent over IPC and held in renderer memory. Matches the find cap (50 MB).
const MAX_SCRIPT_RESULT_BYTES = 50 * 1024 * 1024;

/**
 * Batch size for incremental array encoding — see `encodeArrayIncrementally`.
 * Small enough to keep the deadline/cancel checks fine-grained; large enough
 * that per-batch `setImmediate` yield overhead stays negligible next to the
 * encode work itself.
 */
const ENCODE_BATCH_SIZE = 5000;

async function safeEjsonEncodeJson(
  value: unknown,
  relaxed: boolean,
  signal: AbortSignal,
  deadlineAt: number,
  maxTimeMs: number,
): Promise<string> {
  // Plain primitives bypass EJSON.serialize (which expects objects).
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    // Still cap-check: a multi-MB primitive string (e.g. a doc dumped to text)
    // would otherwise sail past the limit the object path enforces below.
    return capOrThrow(JSON.stringify(value));
  }
  // Arrays are the shape that actually grows large — `.toArray()`,
  // aggregation results, the auto-iterated cursor cap, etc. Encode those
  // incrementally so a big-but-under-cap result can't hold the single-
  // threaded main process hostage: encoding runs outside `vm`'s own
  // `timeout` and the cancel race, so without this it was bounded by
  // neither maxTimeMs nor cancel(). `encodeArrayIncrementally` checks the
  // same deadline/AbortSignal every batch and yields to the event loop
  // between batches so other IPC can interleave.
  if (Array.isArray(value)) {
    try {
      return await encodeArrayIncrementally(value, relaxed, signal, deadlineAt, maxTimeMs);
    } catch (err) {
      // Preserve the pre-existing contract for non-serialisable content:
      // any element that can't be EJSON-encoded collapses the whole result
      // to 'null' (matches the object-path catch below). A deliberate
      // cap/deadline/cancel SystemError is not that — let it propagate.
      if (err instanceof SystemError) throw err;
      return 'null';
    }
  }
  let json: string;
  try {
    json = JSON.stringify(ejsonEncode(value, relaxed));
  } catch {
    // Non-serialisable (e.g. raw functions, the db proxy itself) → null.
    return 'null';
  }
  // Cap-check outside the try so the SystemError is not swallowed to 'null'.
  return capOrThrow(json);
}

/**
 * Encode a top-level array one element at a time, checking the deadline and
 * AbortSignal every `ENCODE_BATCH_SIZE` elements and yielding to the event
 * loop between batches via `setImmediate`. Bails out with a `SystemError` as
 * soon as the byte cap, wall-clock deadline, or cancel() fires — never
 * finishes building the full string past that point. ponytail: single
 * top-level array pass, not a general streaming encoder — a script whose
 * result is one huge non-array object still encodes synchronously via the
 * object path above; upgrade if that shape shows up in practice.
 */
async function encodeArrayIncrementally(
  arr: unknown[],
  relaxed: boolean,
  signal: AbortSignal,
  deadlineAt: number,
  maxTimeMs: number,
): Promise<string> {
  const pieces: string[] = new Array(arr.length);
  let bytes = 2; // '[' + ']'
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && i % ENCODE_BATCH_SIZE === 0) {
      checkEncodeDeadline(signal, deadlineAt, maxTimeMs);
      await yieldToEventLoop();
    }
    const piece = JSON.stringify(ejsonEncode(arr[i], relaxed));
    bytes += piece.length + (i > 0 ? 1 : 0); // +1 for the joining comma
    if (bytes > MAX_SCRIPT_RESULT_BYTES) {
      throw new SystemError(
        'INTERNAL',
        `script result exceeds ${MAX_SCRIPT_RESULT_BYTES} byte cap — refine your script (e.g. add .limit())`,
      );
    }
    pieces[i] = piece;
  }
  checkEncodeDeadline(signal, deadlineAt, maxTimeMs);
  return '[' + pieces.join(',') + ']';
}

function checkEncodeDeadline(signal: AbortSignal, deadlineAt: number, maxTimeMs: number): void {
  if (signal.aborted) throw new SystemError('TIMEOUT', 'script cancelled');
  if (Date.now() >= deadlineAt) {
    throw new SystemError(
      'TIMEOUT',
      `script exceeded ${maxTimeMs}ms (cancel and rerun, or raise the limit)`,
    );
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Throw a uniform over-cap SystemError, else return the JSON unchanged. */
function capOrThrow(json: string): string {
  if (json.length > MAX_SCRIPT_RESULT_BYTES) {
    throw new SystemError(
      'INTERNAL',
      `script result exceeds ${MAX_SCRIPT_RESULT_BYTES} byte cap — refine your script (e.g. add .limit())`,
    );
  }
  return json;
}

/**
 * Subtract `WRAPPER_LINE_OFFSET` from line numbers that vm reports against
 * `script.js`, so error messages and stack traces show line numbers that
 * match the user's editor. Examples of patterns rewritten:
 *
 *   "script.js:5"            → "script.js:4"
 *   "at script.js:5:12"      → "at script.js:4:12"
 *   "at <anonymous>:5:12"    → "at <anonymous>:4:12"
 *
 * Lines that would land at 0 or below (because they refer to the wrapper
 * itself) are left untouched — they shouldn't appear in user-visible
 * traces in practice.
 */
export function shiftLineNumbers(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(
    /(script\.js|<anonymous>):(\d+)/g,
    (whole, file: string, num: string) => {
      const shifted = Number(num) - WRAPPER_LINE_OFFSET;
      return shifted >= 1 ? `${file}:${shifted}` : whole;
    },
  );
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_MAX_TIME_MS;
  // Hard ceiling at 24 h — the "no limit" knob in the UI maps here.
  return Math.min(Math.max(Math.floor(ms), 100), 24 * 60 * 60 * 1000);
}
