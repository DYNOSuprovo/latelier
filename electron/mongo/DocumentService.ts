import { createHash, randomUUID } from 'node:crypto';
import { calculateObjectSize } from 'bson';
import type { Document, InsertManyResult } from 'mongodb';
import { DEFAULT_MAX_EJSON_BYTES, ejsonEncode, ejsonStringify, parseEjsonDocument, parseEjsonField } from './ejson.ts';
import { classifyMongoOpError } from './errors.ts';
import { ValidationError } from '../errors.ts';
import type { MongoPool } from './MongoPool.ts';
import type { Logger } from '../log.ts';
import { EXACT_BSON, asStored, attachUndo, boundedCapture, MAX_BULK_CAPTURE_DOCS } from './undo.ts';
import { ADMIN_LONG_TIMEOUT_MS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS } from './timeouts.ts';

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
// updateOne's capture puts the whole Pre-image in the write's filter. Past
// this size the command could outgrow the server's 16 MB limit, so the write
// runs unpinned and without Undo instead.
const MAX_PINNED_PRE_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

interface TokenEntry {
  connectionId: string;
  dbName: string;
  collection: string;
  filterJson: string;
  /**
   * Which confirm flow minted this token. A `confirmDeleteMany` token must
   * never authorize `updateMany` (or vice versa) even when the connection,
   * database, collection and filter all happen to match — the two confirm
   * screens showed the user two different actions.
   */
  op: 'deleteMany' | 'updateMany';
  /** `updateMany` tokens only: sha256 of the exact `updateJson` string the
   *  user reviewed, so an edit to the update body after Review invalidates
   *  the token even though the filter/collection stayed the same. */
  updateHash?: string;
  expiresAt: number;
}

export interface DocumentServiceOpts {
  tokenTtlMs?: number;
  sweepIntervalMs?: number;
  log?: Logger;
}

/**
 * Defense-in-depth guard (N0.1): rejects an empty `{}` filter before it can
 * reach the driver. `deleteOne`/`updateOne` are single-document writes — an
 * empty filter silently touches the first document Mongo happens to return,
 * which is exactly the "wrong document deleted" bug this guards against.
 * Deliberately NOT applied to `deleteMany`/`confirmDeleteMany`, where an
 * empty filter is a legitimate delete-all, gated by the confirmToken flow.
 */
function assertNonEmptyFilter(filter: Record<string, unknown>, fieldName: string): void {
  if (Object.keys(filter).length === 0) {
    throw new ValidationError(`${fieldName} must not be empty`, { field: fieldName });
  }
}

/**
 * `updateMany`'s update document must be operator-only ($set/$unset/$inc/…) —
 * a replacement-style document (`{ name: "x" }` with no `$` keys) would
 * silently overwrite every matched document with the same body, which is a
 * different and far more destructive operation than the "$set across matched
 * documents" this affordance exists for. `parseEjsonDocument` already refused
 * a pipeline (an array) and a bare sentinel before this runs; this only adds
 * the operator-vs-replacement distinction on top of an already-plain document.
 */
function assertUpdateOperatorDocument(update: Record<string, unknown>, fieldName: string): void {
  const keys = Object.keys(update);
  if (keys.length === 0) {
    throw new ValidationError(`${fieldName} must not be empty`, { field: fieldName });
  }
  if (!keys.every((k) => k.startsWith('$'))) {
    throw new ValidationError(
      `${fieldName} must be an update-operator document ($set, $unset, $inc, …) — replacement documents are not allowed for updateMany`,
      { field: fieldName },
    );
  }
}

/** Binds a confirm token to the exact update body the user reviewed. */
function hashUpdateJson(updateJson: string): string {
  return createHash('sha256').update(updateJson).digest('hex');
}

/*
 * Two parsers, on purpose.
 *
 * Every `filterJson` goes through `parseEjsonDocument`, the same guard
 * `QueryService` uses — so one filter string gets one verdict whichever channel
 * it arrives on. Before this, `doc:*` took a bare BSON sentinel that `query:*`
 * refused, and the user got a raw `MongoServerError` after a pointless round
 * trip instead of a `VALIDATION` naming the field.
 *
 * `docJson` (the single-document write field, on `insert`) is on
 * `parseEjsonDocument` too, for the same reason as `filterJson` — a bug fuzz
 * pass found `docJson: 'null'` and `docJson: '"abc"'` both parsed as valid
 * EJSON and reached the driver, which then threw an internal TypeError
 * (`Cannot read properties of null (reading '_id')`) that surfaced as an
 * unclassified `MONGO_ERROR` instead of a clean `VALIDATION`.
 *
 * `docsJson` and `updateOne`'s `updateJson` stay on `parseEjsonField`, which
 * does not check document-ness: `insertMany` legitimately parses an array, and
 * `updateOne`'s `updateJson` legitimately parses either an update document OR
 * an aggregation-pipeline array — a blanket document check would break both.
 * `updateMany`'s `updateJson` is different: the bulk path refuses pipeline
 * updates, so it goes through `parseEjsonDocument` like a filter, plus
 * `assertUpdateOperatorDocument` on top to also refuse a replacement-style
 * document.
 *
 * `assertNonEmptyFilter` is not redundant with either. It answers a different
 * question — "does this filter match everything" — and `{}` is a perfectly good
 * document, so the document guard cannot catch it. It only looked like a
 * non-document guard by accident, and only for one BSON type:
 * `Object.keys(new Date())` is `[]` so a bare `$date` tripped it, while
 * `Object.keys(new ObjectId())` is `['buffer']` so a bare `$oid` walked past.
 */

export class DocumentService {
  private pool: MongoPool;
  private tokens = new Map<string, TokenEntry>();
  private tokenTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private log: Logger | undefined;

  constructor(pool: MongoPool, opts: DocumentServiceOpts = {}) {
    this.pool = pool;
    this.log = opts.log;
    this.tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    // Don't keep the event loop alive solely for the sweeper.
    this.sweepTimer.unref?.();
  }

  /**
   * Stop the background sweeper so the process can exit cleanly. Safe to call
   * multiple times.
   */
  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }

  async insert(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    docJson: string;
  }): Promise<{ insertedId: unknown }> {
    const w = this.pool.write(input.connectionId);
    const doc = parseEjsonDocument<Record<string, unknown>>(input.docJson, 'docJson');
    const db = await w.db(input.dbName);
    try {
      const result = await db
        .collection(input.collection)
        .insertOne(doc, { maxTimeMS: QUERY_TIMEOUT_MS });
      return { insertedId: ejsonEncode(result.insertedId) };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async insertMany(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    docsJson: string;
  }): Promise<{ insertedCount: number; insertedIds: unknown[] }> {
    const w = this.pool.write(input.connectionId);
    // Same maxBytes cap QueryService.find/AggregationService apply to a read
    // result — checked on the raw string, before parsing, so one fat payload
    // can't freeze the main process either walking JSON.parse or the EJSON walk.
    const byteLength = Buffer.byteLength(input.docsJson, 'utf8');
    if (byteLength > DEFAULT_MAX_EJSON_BYTES) {
      throw new ValidationError(
        `docsJson exceeds ${DEFAULT_MAX_EJSON_BYTES} byte cap — insert fewer documents at once`,
        { field: 'docsJson', byteLength, maxBytes: DEFAULT_MAX_EJSON_BYTES },
      );
    }
    const docs = parseEjsonField<unknown[]>(input.docsJson, 'docsJson');
    if (!Array.isArray(docs) || docs.length === 0) {
      throw new ValidationError('docsJson must be a non-empty array', { field: 'docsJson' });
    }
    if (!docs.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d))) {
      throw new ValidationError('docsJson must be an array of documents', { field: 'docsJson' });
    }
    const db = await w.db(input.dbName);
    let result: InsertManyResult;
    try {
      result = await db
        .collection(input.collection)
        .insertMany(docs as Record<string, unknown>[], { ordered: true, maxTimeMS: QUERY_TIMEOUT_MS });
    } catch (err) {
      // `ordered:true` stops at the first write error, so a bulk-write
      // failure can still carry a nonzero prefix of documents that landed —
      // fold that into the classified error's details so the renderer can
      // surface an honest partial-insert message instead of implying the
      // whole batch failed.
      const insertedCount = (err as { result?: { insertedCount?: number } })?.result
        ?.insertedCount;
      throw classifyMongoOpError(
        err,
        insertedCount !== undefined ? { insertedCount } : undefined,
      );
    }
    const response = {
      insertedCount: result.insertedCount,
      insertedIds: Object.values(result.insertedIds).map((id) => ejsonEncode(id)),
    };
    // Outside the insert's `try`: the write has landed, so nothing from here
    // on may turn it into an error — a capture that fails costs the Undo.
    // The driver mutated `docs` in place, setting `_id` on each document
    // that lacked one — the same array now holds exactly what was inserted,
    // no second read needed. Bounded the same way as deleteMany/updateMany's
    // Pre-images (X13 §5), with the count checked before any document is
    // converted, and kept in stored form (`asStored`): the input's JS numbers
    // are not what Undo reads back.
    let insertedDocs: Document[] | null;
    try {
      insertedDocs =
        docs.length > MAX_BULK_CAPTURE_DOCS
          ? null
          : boundedCapture((docs as Record<string, unknown>[]).map(asStored));
    } catch (err) {
      insertedDocs = this.captureFailed(err);
    }
    return insertedDocs ? attachUndo(response, { insertedDocs }) : response;
  }

  async updateOne(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
    updateJson: string;
  }): Promise<{ matchedCount: number; modifiedCount: number }> {
    const w = this.pool.write(input.connectionId);
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    const update = parseEjsonField<Record<string, unknown>>(input.updateJson, 'updateJson');
    assertNonEmptyFilter(filter, 'filterJson');
    const coll = (await w.db(input.dbName)).collection(input.collection);
    // A Pre-image read that fails costs the Operation its Undo, never its
    // result (ADR 0002).
    const preImage = await coll
      .findOne(filter, { maxTimeMS: QUERY_TIMEOUT_MS, ...EXACT_BSON })
      .catch((err: unknown) => this.captureFailed(err));
    try {
      if (preImage && calculateObjectSize(preImage) <= MAX_PINNED_PRE_IMAGE_BYTES) {
        // Both images are exact only if nothing else writes the document
        // between them, so the write itself guarantees it: it applies only
        // while the document still equals the Pre-image, and hands back what
        // it left behind in the same atomic step. Undo's own compare-and-set
        // against that post-image then refuses any later write rather than
        // overwriting it.
        const postImage = await coll.findOneAndUpdate(
          { $and: [filter, { _id: preImage._id, $expr: { $eq: ['$$ROOT', { $literal: preImage }] } }] },
          update,
          { returnDocument: 'after', maxTimeMS: QUERY_TIMEOUT_MS, ...EXACT_BSON },
        );
        if (postImage) {
          const modifiedCount = ejsonStringify(postImage) === ejsonStringify(preImage) ? 0 : 1;
          return attachUndo({ matchedCount: 1, modifiedCount }, { preImage, postImage });
        }
        // The document changed after the Pre-image was read. Fall through to
        // the write the caller asked for; the caller's filter decides whether
        // it still applies, and there is no honest Pre-image to offer Undo on.
        this.log?.warn('audit.capture', 'Document changed during capture; this Operation cannot be undone');
      } else if (preImage) {
        this.captureFailed(new Error('Pre-image too large to pin the write to'));
      }
      const result = await coll.updateOne(filter, update, { maxTimeMS: QUERY_TIMEOUT_MS });
      return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  private captureFailed(err: unknown): null {
    this.log?.warn('audit.capture', 'Pre-image not captured; this Operation cannot be undone', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  async deleteOne(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
  }): Promise<{ deletedCount: number }> {
    const w = this.pool.write(input.connectionId);
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    assertNonEmptyFilter(filter, 'filterJson');
    const db = await w.db(input.dbName);
    let preImage;
    try {
      // Rather than deleteOne: it hands back the document it removed, in the
      // same atomic step, and that document is the Pre-image Undo puts back.
      preImage = await db
        .collection(input.collection)
        .findOneAndDelete(filter, { maxTimeMS: QUERY_TIMEOUT_MS, ...EXACT_BSON });
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    return preImage ? attachUndo({ deletedCount: 1 }, { preImage }) : { deletedCount: 0 };
  }

  async confirmDeleteMany(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
  }): Promise<{ count: number; confirmToken: string }> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    const db = await this.pool.readDb(input.connectionId, input.dbName);
    let count: number;
    try {
      count = await db
        .collection(input.collection)
        .countDocuments(filter, { maxTimeMS: PROBE_TIMEOUT_MS });
    } catch (err) {
      throw classifyMongoOpError(err);
    }

    const confirmToken = randomUUID();
    this.tokens.set(confirmToken, {
      connectionId: input.connectionId,
      dbName: input.dbName,
      collection: input.collection,
      filterJson: input.filterJson,
      op: 'deleteMany',
      expiresAt: Date.now() + this.tokenTtlMs,
    });

    return { count, confirmToken };
  }

  async deleteMany(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
    confirmToken: string;
  }): Promise<{ deletedCount: number }> {
    const entry = this.tokens.get(input.confirmToken);
    if (!entry || Date.now() > entry.expiresAt) {
      this.tokens.delete(input.confirmToken);
      throw new ValidationError('confirmToken is invalid or expired', { field: 'confirmToken' });
    }

    // Verify the filter matches what was confirmed, and that this token was
    // minted for a delete — a confirmUpdateMany token must never authorize a
    // deleteMany even if the filter/collection happen to match.
    if (
      entry.op !== 'deleteMany' ||
      entry.connectionId !== input.connectionId ||
      entry.dbName !== input.dbName ||
      entry.collection !== input.collection ||
      entry.filterJson !== input.filterJson
    ) {
      throw new ValidationError('confirmToken does not match the provided filter/collection', {
        field: 'confirmToken',
      });
    }

    this.tokens.delete(input.confirmToken);
    const w = this.pool.write(input.connectionId);

    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    const db = await w.db(input.dbName);
    const coll = db.collection(input.collection);
    // Pre-image capture, bounded twice (X13 §5). Read-before-write, and a read
    // that fails or breaches a ceiling costs the Operation its Undo, not its
    // result (ADR 0002) — the delete below always runs regardless.
    const preImages = await coll
      .find(filter, { ...EXACT_BSON, maxTimeMS: PROBE_TIMEOUT_MS })
      .limit(MAX_BULK_CAPTURE_DOCS + 1)
      .toArray()
      .then(boundedCapture)
      .catch((err: unknown) => this.captureFailed(err));
    try {
      // The admin budget, not the interactive one: this is the confirm-gated
      // bulk delete, the same class of structural operation as dropping a
      // collection. It is also not atomic, so a bound that fires mid-run
      // leaves documents already deleted and reports only a timeout.
      const result = await coll.deleteMany(filter, { maxTimeMS: ADMIN_LONG_TIMEOUT_MS });
      const response = { deletedCount: result.deletedCount };
      return preImages ? attachUndo(response, { preImages }) : response;
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  /**
   * A read, like `confirmDeleteMany` — counts matches and mints a token, no
   * write grant. The update shape (operator-only, non-empty, not a pipeline)
   * is validated here rather than left to `updateMany`, so a bad update
   * document is refused before the user ever gets to the type-the-collection
   * step.
   */
  async confirmUpdateMany(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
    updateJson: string;
  }): Promise<{ count: number; confirmToken: string }> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    const update = parseEjsonDocument<Record<string, unknown>>(input.updateJson, 'updateJson');
    assertUpdateOperatorDocument(update, 'updateJson');

    const db = await this.pool.readDb(input.connectionId, input.dbName);
    let count: number;
    try {
      count = await db
        .collection(input.collection)
        .countDocuments(filter, { maxTimeMS: PROBE_TIMEOUT_MS });
    } catch (err) {
      throw classifyMongoOpError(err);
    }

    const confirmToken = randomUUID();
    this.tokens.set(confirmToken, {
      connectionId: input.connectionId,
      dbName: input.dbName,
      collection: input.collection,
      filterJson: input.filterJson,
      op: 'updateMany',
      updateHash: hashUpdateJson(input.updateJson),
      expiresAt: Date.now() + this.tokenTtlMs,
    });

    return { count, confirmToken };
  }

  async updateMany(input: {
    connectionId: string;
    dbName: string;
    collection: string;
    filterJson: string;
    updateJson: string;
    confirmToken: string;
  }): Promise<{ matchedCount: number; modifiedCount: number }> {
    // Write grant first, unlike deleteMany's token-then-grant order: refusal
    // outranks validation (MongoPool.write's own contract), so a read-only
    // connection reports READ_ONLY even against a bogus or mismatched token
    // rather than a VALIDATION that reveals nothing about why the token failed.
    const w = this.pool.write(input.connectionId);

    const entry = this.tokens.get(input.confirmToken);
    if (!entry || Date.now() > entry.expiresAt) {
      this.tokens.delete(input.confirmToken);
      throw new ValidationError('confirmToken is invalid or expired', { field: 'confirmToken' });
    }

    // Verify the filter/update match what was confirmed, and that this token
    // was minted for an update — a confirmDeleteMany token must never
    // authorize an updateMany even if the filter/collection happen to match.
    // `updateHash` re-derives from the exact `updateJson` string being sent
    // now: an edit to the update body after Review must invalidate the token
    // even though the filter/collection stayed the same.
    if (
      entry.op !== 'updateMany' ||
      entry.connectionId !== input.connectionId ||
      entry.dbName !== input.dbName ||
      entry.collection !== input.collection ||
      entry.filterJson !== input.filterJson ||
      entry.updateHash !== hashUpdateJson(input.updateJson)
    ) {
      throw new ValidationError('confirmToken does not match the provided filter/update/collection', {
        field: 'confirmToken',
      });
    }

    this.tokens.delete(input.confirmToken);

    const filter = parseEjsonDocument<Record<string, unknown>>(input.filterJson, 'filterJson');
    const update = parseEjsonDocument<Record<string, unknown>>(input.updateJson, 'updateJson');
    assertUpdateOperatorDocument(update, 'updateJson');

    const db = await w.db(input.dbName);
    const coll = db.collection(input.collection);
    // Same bounded Pre-image capture as deleteMany (X13 §5); a read failure
    // or a breached ceiling only costs the Undo, never the write.
    const preImages = await coll
      .find(filter, { ...EXACT_BSON, maxTimeMS: PROBE_TIMEOUT_MS })
      .limit(MAX_BULK_CAPTURE_DOCS + 1)
      .toArray()
      .then(boundedCapture)
      .catch((err: unknown) => this.captureFailed(err));
    let counts: { matchedCount: number; modifiedCount: number };
    try {
      // Same admin budget as deleteMany — the confirm-gated bulk write, not
      // atomic, so a bound firing mid-run leaves some documents already
      // updated.
      const result = await coll.updateMany(filter, update, { maxTimeMS: ADMIN_LONG_TIMEOUT_MS });
      counts = { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    if (!preImages || preImages.length === 0) return counts;
    // What the update left behind, so Undo can refuse per-document once
    // anything changes it again — same check `updateOne` makes (X13 §5, §6).
    // A read-back that fails, or a document missing from it, drops the whole
    // capture rather than storing a partial one the ceiling was meant to
    // prevent.
    const ids = preImages.map((d) => d._id);
    const postByFound = await coll
      .find({ _id: { $in: ids } }, { ...EXACT_BSON, maxTimeMS: PROBE_TIMEOUT_MS })
      .toArray()
      .catch((err: unknown) => this.captureFailed(err));
    if (!postByFound) return counts;
    // `_id` is immutable, so pre- and post-image carry the exact same stored
    // bytes — a type-exact key, not `String(_id)`, which collides a
    // subdocument `_id` to `"[object Object]"` and `1`/`"1"` to the same
    // string.
    const postById = new Map(postByFound.map((d) => [ejsonStringify(d._id), d]));
    const postImages = preImages.map((d) => postById.get(ejsonStringify(d._id)));
    if (postImages.some((p) => p === undefined)) return counts;
    return attachUndo(counts, { preImages, postImages: postImages as Record<string, unknown>[] });
  }
}
