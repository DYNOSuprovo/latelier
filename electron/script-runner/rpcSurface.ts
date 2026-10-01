/**
 * The script bridge's whole callable surface, as data. Both ends read it: the
 * child's facade only builds a function for a name listed here, and main's
 * `rpcHost` refuses any name that is not. Main is the one that matters; the
 * child side is a convenience, since a script can post whatever it likes.
 *
 * Every entry is a `Set` and every check is `.has()`. A plain object or an `in`
 * test would answer `true` for `constructor`, `toString` and `__proto__`.
 *
 * What is deliberately absent, and why:
 *  - `watch`, `initializeOrderedBulkOp`, `initializeUnorderedBulkOp`: they
 *    return live driver objects (a change stream, a builder) rather than data
 *    or a cursor, so there is nothing safe to hand across.
 *  - `db.collections`, `db.aggregate`, `db.watch`: same reason.
 *  - the aggregation-cursor builders `out`, `merge`, `group`, `match`, ...:
 *    `out()`/`merge()` append a write stage *after* the read-only pipeline
 *    check has looked at the pipeline.
 *  - `admin` as a Db method: it is its own target (`admin`), see below.
 */

/** What a frame addresses. `admin` is `db.admin()`'s object, created on demand in main. */
export type RpcTarget = 'db' | 'admin' | 'collection' | 'cursor';

export const DB_METHODS: ReadonlySet<string> = new Set([
  'runCommand',
  'command',
  'listCollections',
  'runCursorCommand',
  'createCollection',
  'dropCollection',
  'dropDatabase',
  'renameCollection',
  'createIndex',
  'indexInformation',
  'stats',
  'setProfilingLevel',
  'profilingLevel',
]);

export const ADMIN_METHODS: ReadonlySet<string> = new Set([
  'command',
  'buildInfo',
  'serverInfo',
  'serverStatus',
  'ping',
  'validateCollection',
  'listDatabases',
  'replSetGetStatus',
]);

export const COLLECTION_METHODS: ReadonlySet<string> = new Set([
  'insertOne',
  'insertMany',
  'bulkWrite',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOne',
  'find',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'aggregate',
  'countDocuments',
  'count',
  'estimatedDocumentCount',
  'distinct',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'listIndexes',
  'indexExists',
  'indexInformation',
  'indexes',
  'options',
  'isCapped',
  'drop',
  'rename',
  'listSearchIndexes',
  'createSearchIndex',
  'createSearchIndexes',
  'dropSearchIndex',
  'updateSearchIndex',
]);

/** Cursor methods that queue a setting and hand the cursor back. */
export const CURSOR_SHAPING_METHODS: ReadonlySet<string> = new Set([
  'sort',
  'limit',
  'skip',
  'project',
  'filter',
  'hint',
  'min',
  'max',
  'maxTimeMS',
  'batchSize',
  'collation',
  'comment',
  'allowDiskUse',
  'returnKey',
  'showRecordId',
]);

/** Cursor methods that talk to the server and produce data. */
export const CURSOR_TERMINAL_METHODS: ReadonlySet<string> = new Set([
  'toArray',
  'next',
  'tryNext',
  'hasNext',
  'close',
  'explain',
  'count',
]);

/** Methods whose result is a cursor, kept in main as a handle. */
export const DB_CURSOR_METHODS: ReadonlySet<string> = new Set(['listCollections', 'runCursorCommand']);
export const COLLECTION_CURSOR_METHODS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'listIndexes',
  'listSearchIndexes',
]);

/**
 * Methods whose driver result is a `Collection`. That object reaches the
 * client (and through it the connection options), so it must never be
 * serialized; the caller gets an acknowledgement instead.
 */
export const DB_ACK_METHODS: ReadonlySet<string> = new Set(['createCollection', 'renameCollection']);
export const COLLECTION_ACK_METHODS: ReadonlySet<string> = new Set(['rename']);

/** Longest `argsEjson` array a frame may carry. */
export const MAX_RPC_ARGS = 16;

/** Longest `argsEjson` text a frame may carry, in characters, checked before it is parsed. */
export const MAX_RPC_ARGS_CHARS = 16 * 1024 * 1024;

/**
 * Calls one run may have outstanding at once. A script that posts more is
 * answered with an error for the excess, so it cannot queue unbounded work on
 * main's shared pool client.
 */
export const MAX_RPC_IN_FLIGHT = 64;
