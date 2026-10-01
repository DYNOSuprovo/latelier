import * as vm from 'node:vm';
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
import { classifyMongoOpError } from '../mongo/errors.ts';
import { encodeResultJson } from './encodeResult.ts';
import { openChannel } from './channel.ts';
import { toWireError, type RunRequest, type RunnerMessage } from './protocol.ts';
import { createRpcClient, type RpcClient, type RpcCursor } from './rpcClient.ts';
import { isShellStartRequest } from './shellProtocol.ts';
import { startShellSession } from './shellSession.ts';
import { shiftLineNumbers, wrapSource, WRAPPER_LINE_OFFSET } from './scriptSource.ts';

/**
 * Script-runner child. One process per run: main forks it, posts a single
 * `RunRequest`, and kills the process on timeout or cancel. The same entry
 * also serves one Mongo shell session (`shellSession.ts`), when the first
 * message is a `shell-start` request: a long-lived REPL, ended by main.
 * Because nothing here shares memory with main, a script that never yields (a sync loop, or
 * `while (true) await Promise.resolve()`) can only ever stall this process.
 *
 * Runs both as a bundled `.cjs` inside Electron's utilityProcess and as plain
 * `.ts` under Node's type stripping (the integration tests). That rules out
 * top-level await, `import.meta` and runtime path aliases in this graph.
 *
 * This process has no MongoClient, connection string or credentials. `db` is a
 * facade (`rpcClient.ts`) whose calls go back to main as RPC frames, and main
 * enforces read-only on them (`rpcHost.ts`). What a script that escapes this
 * process keeps is the OS user's own reach (files, processes, the network); it
 * does not hold the means to open a connection to the deployment.
 */

const PRINT_BUFFER_CAP = 64 * 1024;
/**
 * Cap for auto-iterating a cursor result. Mirrors mongosh's "first batch"
 * UX so `db.coll.find()` shows documents instead of collapsing to `null`.
 * Users who need the full result still call `.toArray()` explicitly.
 */
const CURSOR_AUTO_ITERATE_LIMIT = 50;

// ─── Run ────────────────────────────────────────────────────────────────────

async function execute(
  req: RunRequest,
  appendPrint: (chunk: string) => void,
  rpc: RpcClient,
): Promise<RunnerMessage> {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const dbCtx = { currentDb: req.dbName };

  const sandbox: Record<string, unknown> = {
    db: rpc.makeDb(dbCtx),
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
  const materialized = await materializeIfCursor(rpc, value, CURSOR_AUTO_ITERATE_LIMIT, (err) =>
    appendPrint(`ERROR: cursor close failed: ${(err as { message?: unknown }).message}\n`),
  );
  if (materialized.truncated) {
    appendPrint(
      `[cursor truncated to first ${CURSOR_AUTO_ITERATE_LIMIT} documents — call .toArray() for the full result]\n`,
    );
  }
  const finalValue = materialized.value;
  const valueJson =
    finalValue === undefined ? null : encodeResultJson(finalValue, req.ejsonRelaxed);
  return { type: 'result', valueJson, printBuffer: '', durationMs: Date.now() - t0 };
}

/** Map whatever the script or driver threw onto the error the UI expects. */
function classifyRunError(err: unknown): ReturnType<typeof classifyMongoOpError> {
  if (err instanceof SystemError || err instanceof ValidationError) return err;
  const e = err as { message?: string; name?: string; stack?: string };
  // SyntaxError from the wrapped source — surface as ValidationError so the
  // renderer paints it as a user-fixable error, not a crash.
  if (e.name === 'SyntaxError') {
    let errorMsg = `syntax error: ${shiftLineNumbers(e.message ?? '')}`;
    const details: { field: string; line?: number } = { field: 'source' };
    // Extract line number from the first line of the stack (e.g. "script.js:2").
    // V8 keeps the position in the stack, not in the message. The lineOffset
    // parameter to vm.runInContext already adjusts the line numbers.
    if (typeof e.stack === 'string') {
      const match = /^script\.js:(\d+)/.exec(e.stack);
      if (match) {
        const userLine = Number.parseInt(match[1], 10);
        if (userLine >= 1) {
          errorMsg = `syntax error (line ${userLine}): ${shiftLineNumbers(e.message ?? '')}`;
          details.line = userLine;
        }
      }
    }
    return new ValidationError(errorMsg, details);
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
 * If `value` is a cursor (what `db.coll.find()` returns), pull up to `limit`
 * documents into an array and report whether more remained. The cursor is
 * closed before returning so main does not keep a server-side resource open.
 * Non-cursor values pass through unchanged.
 */
async function materializeIfCursor(
  rpc: RpcClient,
  value: unknown,
  limit: number,
  onCloseError: (err: unknown) => void,
): Promise<{ value: unknown; truncated: boolean }> {
  if (!rpc.isCursor(value)) return { value, truncated: false };
  const cursor: RpcCursor = value;
  try {
    const docs: unknown[] = [];
    while (docs.length < limit) {
      const doc = await cursor.next();
      // Cursor exhausted inside the cap — definitively not truncated.
      if (doc === null) return { value: docs, truncated: false };
      docs.push(doc);
    }
    // Hit the cap. Peek once to decide whether more remained.
    const peek = await cursor.tryNext();
    return { value: docs, truncated: peek !== null };
  } finally {
    // Close on every path so a throwing next()/tryNext() doesn't leak the
    // server-side cursor. A failed close must not replace the documents
    // already read, but it is not silent either: it goes to the print buffer.
    await cursor.close().catch(onCloseError);
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

  const rpc = createRpcClient((frame) => channel.post(frame));
  let started = false;
  channel.onMessage((message) => {
    if (rpc.handleReply(message)) return;
    if (started) return;
    // The first request picks what this process is for: one script, or one
    // shell session. Either way it is the only one it will ever serve.
    if (isShellStartRequest(message)) {
      started = true;
      startShellSession(channel, rpc, message);
      return;
    }
    if (!isRunRequest(message)) return;
    started = true;
    void execute(message, appendPrint, rpc)
      .then((msg): RunnerMessage => (msg.type === 'result' ? { ...msg, printBuffer } : msg))
      .catch((err): RunnerMessage => ({ type: 'error', error: toWireError(classifyRunError(err)) }))
      // Single-use process: main kills it once it has the message, so there is
      // no exit here that could race the post.
      .then((msg) => channel.post(msg));
  });
}

main();
