import * as vm from 'node:vm';
import { AbstractCursor, MongoClient } from 'mongodb';
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
import { SystemError, ValidationError } from '../errors.ts';
import { makeDbProxy } from '../mongo/dbProxy.ts';
import { classifyMongoOpError } from '../mongo/errors.ts';
import { encodeResultJson } from './encodeResult.ts';
import { toWireError, type RunRequest, type RunnerMessage } from './protocol.ts';
import { shiftLineNumbers, wrapSource, WRAPPER_LINE_OFFSET } from './scriptSource.ts';

/**
 * Script-runner child. One process per run: main forks it, posts a single
 * `RunRequest`, and kills the process on timeout or cancel. Because nothing
 * here shares memory with main, a script that never yields (a sync loop, or
 * `while (true) await Promise.resolve()`) can only ever stall this process.
 *
 * Runs both as a bundled `.cjs` inside Electron's utilityProcess and as plain
 * `.ts` under Node's type stripping (the integration tests). That rules out
 * top-level await, `import.meta` and runtime path aliases in this graph.
 *
 * Read-only is still the in-process proxy guard here, because this child owns
 * its own MongoClient: a UI safety guard, not a security boundary.
 */

const PRINT_BUFFER_CAP = 64 * 1024;
/**
 * Cap for auto-iterating a cursor result. Mirrors mongosh's "first batch"
 * UX so `db.coll.find()` shows documents instead of collapsing to `null`.
 * Users who need the full result still call `.toArray()` explicitly.
 */
const CURSOR_AUTO_ITERATE_LIMIT = 50;
/** Bound on closing the client after the result is posted, so exit is prompt. */
const CLOSE_BUDGET_MS = 1_000;

// ─── Message channel ────────────────────────────────────────────────────────

interface Channel {
  post(message: RunnerMessage): void;
  onRequest(listener: (message: unknown) => void): void;
}

/** Electron utilityProcess exposes `process.parentPort`; a Node fork uses IPC. */
function openChannel(): Channel {
  const proc = process as NodeJS.Process & {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: 'message', listener: (e: { data: unknown }) => void): void;
    };
  };
  if (proc.parentPort) {
    const port = proc.parentPort;
    return {
      post: (m) => port.postMessage(m),
      onRequest: (listener) => port.on('message', (e) => listener(e.data)),
    };
  }
  if (typeof proc.send !== 'function') {
    throw new Error('script runner started without a parent channel');
  }
  const send = proc.send.bind(proc);
  return {
    post: (m) => {
      send(m);
    },
    onRequest: (listener) => proc.on('message', listener),
  };
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function execute(req: RunRequest, appendPrint: (chunk: string) => void): Promise<RunnerMessage> {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const client = new MongoClient(req.uri, req.options);
  try {
    await client.connect();

    const dbCtx = {
      currentDb: req.dbName,
      client,
      signal: ctrl.signal,
      isReadOnly: () => req.readOnly,
    };

    const sandbox: Record<string, unknown> = {
      db: makeDbProxy(dbCtx),
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
        log: (...args: unknown[]) => appendPrint(args.map(stringifyForPrint).join(' ') + '\n'),
        error: (...args: unknown[]) =>
          appendPrint('ERROR: ' + args.map(stringifyForPrint).join(' ') + '\n'),
        warn: (...args: unknown[]) =>
          appendPrint('WARN: ' + args.map(stringifyForPrint).join(' ') + '\n'),
      },
    };

    // No vm `timeout`: main owns the wall clock and kills this process, which
    // bounds sync loops, microtask loops and awaited promises alike.
    const value = await (vm.runInContext(wrapSource(req.source), vm.createContext(sandbox), {
      breakOnSigint: false,
      filename: 'script.js',
      // The wrapper IIFE adds one synthetic line at the top; subtract it so
      // SyntaxErrors and stack traces show line numbers that match the
      // user's editor.
      lineOffset: -WRAPPER_LINE_OFFSET,
    }) as Promise<unknown>);

    // If the script returned a live cursor (e.g. `db.coll.find()`),
    // auto-iterate the first batch so it renders as an array instead of
    // collapsing to `null` via the non-serializable fallback.
    const materialized = await materializeIfCursor(value, CURSOR_AUTO_ITERATE_LIMIT);
    if (materialized.truncated) {
      appendPrint(
        `[cursor truncated to first ${CURSOR_AUTO_ITERATE_LIMIT} documents — call .toArray() for the full result]\n`,
      );
    }
    const finalValue = materialized.value;
    const valueJson =
      finalValue === undefined ? null : encodeResultJson(finalValue, req.ejsonRelaxed);
    return { type: 'result', valueJson, printBuffer: '', durationMs: Date.now() - t0 };
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS)),
    ]);
  }
}

/** Map whatever the script or driver threw onto the error the UI expects. */
function classifyRunError(err: unknown): ReturnType<typeof classifyMongoOpError> {
  if (err instanceof SystemError || err instanceof ValidationError) return err;
  const e = err as { message?: string; name?: string; stack?: string };
  // SyntaxError from the wrapped source — surface as ValidationError so the
  // renderer paints it as a user-fixable error, not a crash.
  if (e.name === 'SyntaxError') {
    return new ValidationError(`syntax error: ${shiftLineNumbers(e.message ?? '')}`, {
      field: 'source',
    });
  }
  // Shift line numbers in the message/stack so they match the user's editor
  // before letting classifyMongoOpError wrap it.
  if (typeof e.message === 'string') e.message = shiftLineNumbers(e.message);
  if (typeof e.stack === 'string') e.stack = shiftLineNumbers(e.stack);
  const classified = classifyMongoOpError(err);
  // `classifyMongoOpError` mints a fresh error whose stack points at this file;
  // the script's own (shifted) stack is what the user can act on.
  if (classified !== err && typeof e.stack === 'string') classified.stack = e.stack;
  return classified;
}

/**
 * If `value` is a live Mongo cursor (FindCursor, AggregationCursor, …), pull
 * up to `limit` documents into an array and report whether more remained. The
 * cursor is closed before returning so we don't leak a server-side resource.
 * Non-cursor values pass through unchanged.
 *
 * `instanceof AbstractCursor` works through our `wrapCursor` Proxy because the
 * proxy doesn't override `getPrototypeOf`.
 */
async function materializeIfCursor(
  value: unknown,
  limit: number,
): Promise<{ value: unknown; truncated: boolean }> {
  if (!(value instanceof AbstractCursor)) return { value, truncated: false };
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
    // Close on every path so a throwing next()/tryNext() doesn't leak the
    // server-side cursor.
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

// ─── Entry ──────────────────────────────────────────────────────────────────

function isRunRequest(m: unknown): m is RunRequest {
  return typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'run';
}

function main(): void {
  const channel = openChannel();
  let printBuffer = '';
  const appendPrint = (chunk: string): void => {
    if (printBuffer.length >= PRINT_BUFFER_CAP) return;
    const remaining = PRINT_BUFFER_CAP - printBuffer.length;
    printBuffer += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
  };
  // A script's own un-awaited rejection must not take the process down before
  // its result is posted; surface it in the print buffer instead.
  process.on('unhandledRejection', (reason) => {
    // An Error from the script's realm is not `instanceof Error` here and
    // stringifies to `{}`, so read its message directly.
    const message = (reason as { message?: unknown } | null)?.message;
    const text = typeof message === 'string' ? message : stringifyForPrint(reason);
    appendPrint(`ERROR: unhandled rejection: ${text}\n`);
  });

  let started = false;
  channel.onRequest((message) => {
    if (!isRunRequest(message) || started) return;
    started = true;
    void execute(message, appendPrint)
      .then((msg): RunnerMessage => (msg.type === 'result' ? { ...msg, printBuffer } : msg))
      .catch((err): RunnerMessage => ({ type: 'error', error: toWireError(classifyRunError(err)) }))
      // Single-use process: main kills it once it has the message, so there is
      // no exit here that could race the post.
      .then((msg) => channel.post(msg));
  });
}

main();
