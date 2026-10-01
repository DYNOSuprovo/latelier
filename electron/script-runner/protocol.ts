import {
  AppError,
  ConflictError,
  MongoOpError,
  NotFoundError,
  ReadOnlyConnectionError,
  SystemError,
  ValidationError,
  type AppErrorCode,
} from '../errors.ts';
import type { RpcTarget } from './rpcSurface.ts';

/**
 * Wire protocol between main and the script-runner child. Every message is a
 * plain structured-cloneable object; no Error instances, no class instances.
 */

/**
 * main -> child: run one script, then the child exits. It carries no
 * connection string, credentials or driver options: the child has no database
 * client, and every call it makes goes back to main as an `RpcFrame`.
 */
export interface RunRequest {
  type: 'run';
  source: string;
  dbName: string;
  ejsonRelaxed: boolean;
}

/**
 * child -> main: one database call. Arguments and results cross as canonical
 * EJSON strings. Only `type` and `id` are checked when the frame arrives (see
 * `isRunnerMessage`); every other field is untrusted input to the host, which
 * answers a bad one with an `rpc-error` instead of ending the run.
 */
export interface RpcFrame {
  type: 'rpc';
  id: number;
  target: RpcTarget;
  dbName: string;
  coll?: string;
  cursorId?: string;
  method: string;
  argsEjson: string;
}

/** main -> child: the answer to one `RpcFrame`. */
export type RpcReply =
  | { type: 'rpc-result'; id: number; valueEjson: string }
  | { type: 'rpc-result'; id: number; cursorId: string }
  | { type: 'rpc-error'; id: number; error: WireError };

export interface WireError {
  name: string;
  code: AppErrorCode;
  message: string;
  details?: unknown;
  stack?: string;
}

export type RunnerMessage =
  | RpcFrame
  | { type: 'result'; valueJson: string | null; printBuffer: string; durationMs: number }
  | { type: 'error'; error: WireError };

/**
 * Flatten an error for the port. Anything that is not an `AppError` becomes an
 * `INTERNAL` one rather than crossing as an opaque object. `details` is
 * dropped when it cannot be structured-cloned: a message that fails to post
 * would leave main waiting for its timeout instead of reporting the error.
 */
export function toWireError(err: unknown): WireError {
  if (err instanceof AppError) {
    const wire: WireError = {
      name: err.name,
      code: err.code,
      message: err.message,
      stack: err.stack,
    };
    if (err.details !== undefined && isCloneable(err.details)) wire.details = err.details;
    return wire;
  }
  const e = err as { message?: unknown; stack?: unknown } | null;
  return {
    name: 'AppError',
    code: 'INTERNAL',
    message: typeof e?.message === 'string' ? e.message : String(err),
    stack: typeof e?.stack === 'string' ? e.stack : undefined,
  };
}

// Stryker disable BlockStatement: emptying the catch makes `isCloneable` return undefined instead of false, and its one caller (`toWireError`) only tests the result for truthiness, so the two are indistinguishable.
function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}
// Stryker restore BlockStatement

/** Rebuild the `AppError` subclass a caller may `instanceof` on. */
export function fromWireError(wire: WireError): AppError {
  const err = buildError(wire);
  if (typeof wire.stack === 'string') err.stack = wire.stack;
  return err;
}

function buildError(wire: WireError): AppError {
  switch (wire.name) {
    case 'ValidationError':
      return new ValidationError(wire.message, wire.details);
    case 'NotFoundError':
      return new NotFoundError(wire.message, wire.details);
    case 'ConflictError':
      return new ConflictError(wire.message, wire.details);
    case 'ReadOnlyConnectionError':
      return new ReadOnlyConnectionError(wire.message, wire.details);
    case 'SystemError':
      return new SystemError(wire.code, wire.message, wire.details);
    case 'MongoOpError':
      return new MongoOpError(wire.code, wire.message, wire.details);
    default:
      return new AppError(wire.code, wire.message, wire.details);
  }
}

/** Shape check for a message arriving from the child; a script can post to the port too. */
export function isRunnerMessage(value: unknown): value is RunnerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  // An `id` is all a frame needs to be answerable; the rest is the host's to judge.
  if (m.type === 'rpc') return Number.isSafeInteger(m.id);
  if (m.type === 'result') {
    return (
      (m.valueJson === null || typeof m.valueJson === 'string') &&
      typeof m.printBuffer === 'string' &&
      typeof m.durationMs === 'number'
    );
  }
  if (m.type === 'error') {
    const e = m.error as Record<string, unknown> | null;
    return (
      typeof e === 'object' &&
      e !== null &&
      typeof e.name === 'string' &&
      typeof e.code === 'string' &&
      typeof e.message === 'string'
    );
  }
  return false;
}
