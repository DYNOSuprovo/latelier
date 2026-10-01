import { randomUUID } from 'node:crypto';
import type { Envelope } from '@shared/ipc';
import type { AuditEntry, AuditListInput, AuditSummary, UndoResult } from '@shared/types';
import { MongoBulkWriteError, type Collection, type Document } from 'mongodb';
import type { AuditRepo, AuditRow } from '../db/repositories/AuditRepo.ts';
import { auditRecordFor } from '../ipc/auditChannels.ts';
import { AppError, NotFoundError, SystemError } from '../errors.ts';
import type { MongoPool } from '../mongo/MongoPool.ts';
import type { Logger } from '../log.ts';
import { ejsonParse, ejsonStringify } from '../mongo/ejson.ts';
import { classifyMongoOpError } from '../mongo/errors.ts';
import { QUERY_TIMEOUT_MS } from '../mongo/timeouts.ts';
import type { UndoStore } from './UndoStore.ts';
import { asStored, assertUndoable, undoCaptureOf, EXACT_BSON, importDigest, type UndoCapture } from '../mongo/undo.ts';

/** Ids are chunked into reads/deletes this large — matches `insertBatch`'s write-side batch size. */
const UNDO_ID_CHUNK = 1000;

const DEFAULT_LIST_LIMIT = 100;

function toEntry(row: AuditRow, undoable: boolean): AuditEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    dbName: row.db_name,
    collection: row.collection,
    op: row.op,
    summary: JSON.parse(row.summary_json) as AuditSummary,
    outcome: row.outcome,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ranAt: row.ran_at,
    durationMs: row.duration_ms,
    reversible: row.reversible === 1 && undoable,
    ...(row.undone_at !== null ? { undoneAt: row.undone_at } : {}),
  };
}

/**
 * Pre-images are held in `store` (memory) and never written to SQLite, so
 * Undo works for the running session only, and only for recent entries: after a
 * restart, or once the store evicts one, an entry is still listed but no longer
 * Reversible, and `undo` refuses it as expired.
 */
export class AuditService {
  private repo: AuditRepo;
  private pool: MongoPool;
  private store: UndoStore;
  private log: Logger | undefined;
  constructor(repo: AuditRepo, pool: MongoPool, store: UndoStore, log?: Logger) {
    this.repo = repo;
    this.pool = pool;
    this.store = store;
    this.log = log;
  }

  /**
   * The capture as stored, or null when there is none or it would not read
   * back — a document the EJSON reviver refuses (a UUID Binary of the wrong
   * length, a regex JS can't compile) would only ever offer an Undo that fails.
   */
  private restorableUndoJson(undo: UndoCapture | undefined): string | null {
    if (!undo) return null;
    const json = ejsonStringify(undo);
    try {
      ejsonParse(json);
    } catch (err) {
      this.log?.warn('audit.capture', 'Pre-image would not read back; this Operation cannot be undone', {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return json;
  }

  /**
   * Called by the router after every handler, audited or not. Writes nothing
   * for a channel outside the audit table. Returns the new entry's id when it
   * is Reversible, so the caller can be offered Undo. Throws when the insert
   * fails; the router is what keeps that from reaching the Operation's
   * envelope.
   */
  record(
    channel: string,
    input: unknown,
    envelope: Envelope<unknown>,
    startedAt: number,
    durationMs: number,
    thrown?: unknown,
  ): string | null {
    const rec = auditRecordFor(channel, input, envelope);
    if (!rec) return null;
    // A failure can still carry a capture: an import that stops part-way
    // attaches one for the batches that fully landed before it.
    const undoJson = this.restorableUndoJson(undoCaptureOf(envelope.ok ? envelope.data : thrown));
    const id = randomUUID();
    this.repo.insert({
      id,
      connection_id: rec.connectionId,
      db_name: rec.dbName,
      collection: rec.collection,
      op: rec.op,
      summary_json: JSON.stringify(rec.summary),
      outcome: rec.outcome,
      error_code: rec.errorCode,
      ran_at: new Date(startedAt).toISOString(),
      duration_ms: durationMs,
      reversible: undoJson !== null ? 1 : 0,
      undone_at: null,
    });
    if (undoJson === null) return null;
    this.store.put(id, rec.connectionId, undoJson);
    return id;
  }

  /**
   * Puts back what a Reversible entry changed. Refuses before writing
   * anything; records no entry of its own, so there is no undo-of-undo.
   */
  async undo(input: { entryId: string }): Promise<UndoResult> {
    const row = this.repo.findForUndo(input.entryId);
    if (!row) throw new NotFoundError(`audit entry ${input.entryId} not found`);
    const held = { ...row, undo_json: this.store.get(input.entryId) ?? null };
    assertUndoable(held);
    // Refuses a Connection made read-only since the Operation ran.
    const w = this.pool.write(row.connection_id);
    const capture = ejsonParse<UndoCapture>(held.undo_json);
    let result: UndoResult;
    try {
      if (row.op === 'collectionRename') {
        const db = await w.db(row.db_name);
        // A collection already holding `fromName` fails on the driver's own
        // duplicate-namespace check and surfaces as the existing error path.
        await db.renameCollection(capture.toName!, capture.fromName!, { maxTimeMS: QUERY_TIMEOUT_MS });
        result = { restored: 1, skipped: 0 };
      } else {
        const coll = (await w.db(row.db_name)).collection(row.collection!);
        if (row.op === 'deleteOne') {
          // A reused `_id` fails on the unique index and surfaces as CONFLICT.
          await coll.insertOne(capture.preImage!, { maxTimeMS: QUERY_TIMEOUT_MS });
          result = { restored: 1, skipped: 0 };
        } else if (row.op === 'updateOne' && capture.postImage) {
          const matched = await this.compareAndReplace(coll, capture.postImage, capture.preImage!);
          if (matched === 0) {
            throw new SystemError(
              'AUDIT_TARGET_CHANGED',
              'The document has changed since this Operation, so undoing it would overwrite the newer change.',
            );
          }
          result = { restored: 1, skipped: 0 };
        } else if (row.op === 'insertMany') {
          result = await this.restoreInserted(coll, capture.insertedDocs ?? []);
        } else if (row.op === 'deleteMany') {
          result = await this.restoreDeleted(coll, capture.preImages ?? []);
        } else if (row.op === 'updateMany') {
          result = await this.restoreUpdated(coll, capture.preImages ?? [], capture.postImages ?? []);
        } else if (row.op === 'import') {
          result = await this.restoreImported(coll, capture.importedIds ?? [], capture.digests ?? []);
        } else {
          throw new SystemError('INTERNAL', `undo of ${row.op} is not supported`);
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw classifyMongoOpError(err);
    }
    this.repo.markUndone(input.entryId, new Date().toISOString());
    this.store.delete(input.entryId);
    return result;
  }

  /**
   * The compare-and-set `updateOne` undo uses: nothing can land between the
   * check and the replace, because the check IS the write's own filter.
   * `$$ROOT` equality is field-order and type-bracket exact; only a
   * numerically equal type change (1 → 1.0) slips past it. Returns the
   * matched count, 0 meaning the target changed since.
   */
  private async compareAndReplace(coll: Collection, postImage: Document, preImage: Document): Promise<number> {
    const result = await coll.replaceOne(
      { _id: postImage._id, $expr: { $eq: ['$$ROOT', { $literal: postImage }] } },
      preImage,
      { maxTimeMS: QUERY_TIMEOUT_MS },
    );
    return result.matchedCount;
  }

  /**
   * `insertMany` undo (X13 §6): deletes only the documents that are still
   * byte-identical to what was inserted. A document edited since, or already
   * removed, survives Undo and counts as `skipped` — same honesty as
   * `restoreDeleted`/`restoreUpdated`; Undo must never discard an edit made
   * after the insert it didn't know about.
   */
  private async restoreInserted(coll: Collection, docs: Document[]): Promise<UndoResult> {
    if (docs.length === 0) return { restored: 0, skipped: 0 };
    const ids = docs.map((d) => d._id);
    const current = await coll.find({ _id: { $in: ids } } as Document, { ...EXACT_BSON, maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    const currentById = new Map(current.map((d) => [ejsonStringify(d._id), d]));
    const toDelete: Document[] = [];
    let skipped = 0;
    for (const doc of docs) {
      const cur = currentById.get(ejsonStringify(doc._id));
      // Exact-value match, not just "still present" — an insert that was
      // then edited must survive Undo, not get silently discarded because
      // its _id is still the one this entry created. The capture is already
      // in stored form (`asStored`); running it again is a no-op on one that
      // is, and brings `_id` to the front of one that isn't.
      if (cur !== undefined && ejsonStringify(cur) === ejsonStringify(asStored(doc))) {
        toDelete.push(cur);
      } else {
        skipped++;
      }
    }
    const deleted = await this.deleteIfUnchanged(coll, toDelete);
    return { restored: deleted, skipped: skipped + (toDelete.length - deleted) };
  }

  /**
   * Deletes each of `docs` only while it still equals what Undo just read:
   * the comparison is the delete's own filter, so a write that lands after
   * the read survives rather than being deleted with the rest. The type-exact
   * check before this call still matters — `$$ROOT` equality lets a
   * numerically equal type change (1 → 1.0) through. One `deleteOne` per
   * document, unordered, so the driver splits the batch by size instead of
   * one `$or` filter growing past a command's limit. Returns how many went.
   */
  private async deleteIfUnchanged(coll: Collection, docs: Document[]): Promise<number> {
    if (docs.length === 0) return 0;
    const result = await coll.bulkWrite(
      docs.map((doc) => ({
        deleteOne: { filter: { _id: doc._id, $expr: { $eq: ['$$ROOT', { $literal: doc }] } } },
      })),
      { ordered: false, maxTimeMS: QUERY_TIMEOUT_MS },
    );
    return result.deletedCount;
  }

  /**
   * `deleteMany` undo (X13 §6): re-inserts the Pre-images with
   * `ordered: false` so one revived `_id` doesn't block the rest, and reports
   * `{restored, skipped}` honestly rather than failing the whole batch.
   */
  private async restoreDeleted(coll: Collection, docs: Document[]): Promise<UndoResult> {
    if (docs.length === 0) return { restored: 0, skipped: 0 };
    try {
      const result = await coll.insertMany(docs, { ordered: false, maxTimeMS: QUERY_TIMEOUT_MS });
      return { restored: result.insertedCount, skipped: docs.length - result.insertedCount };
    } catch (err) {
      // A partial insert is only a legitimate skip when every failure was a
      // reused `_id` (11000) — the expected "restored the rest" case (X13
      // test case 9). Anything else (a validator rejecting one document, a
      // dropped connection mid-batch) must not be folded into `skipped`: that
      // would mark the entry undone and drop its Pre-images while some
      // Pre-images were never actually written back.
      if (err instanceof MongoBulkWriteError) {
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        if (writeErrors.length > 0 && writeErrors.every((e) => e.code === 11000)) {
          return { restored: err.result.insertedCount, skipped: docs.length - err.result.insertedCount };
        }
      }
      throw err;
    }
  }

  /**
   * `import` undo (X13 §5 option (b)): deletes only the documents whose
   * digest still matches what landed. Reads and deletes in chunks of
   * `UNDO_ID_CHUNK`, since a capture can hold up to `MAX_IMPORT_CAPTURE_DOCS`
   * ids — far past what `restoreInserted`'s single `find` bothers to chunk.
   * A document edited or removed since counts as `skipped`, same honesty as
   * `restoreInserted`/`restoreDeleted`.
   */
  private async restoreImported(coll: Collection, ids: unknown[], digests: string[]): Promise<UndoResult> {
    if (ids.length === 0) return { restored: 0, skipped: 0 };
    let restored = 0;
    let skipped = 0;
    for (let i = 0; i < ids.length; i += UNDO_ID_CHUNK) {
      const idChunk = ids.slice(i, i + UNDO_ID_CHUNK);
      const digestByKey = new Map(idChunk.map((id, j) => [ejsonStringify(id), digests[i + j]!]));
      const current = await coll
        .find({ _id: { $in: idChunk } } as Document, { ...EXACT_BSON, maxTimeMS: QUERY_TIMEOUT_MS })
        .toArray();
      const toDelete: Document[] = [];
      for (const doc of current) {
        const key = ejsonStringify(doc._id);
        if (importDigest(doc) === digestByKey.get(key)) toDelete.push(doc);
      }
      skipped += idChunk.length - toDelete.length;
      const deleted = await this.deleteIfUnchanged(coll, toDelete);
      restored += deleted;
      skipped += toDelete.length - deleted;
    }
    return { restored, skipped };
  }

  /**
   * `updateMany` undo: the same per-document compare-and-set `updateOne`
   * uses, one document at a time — a document changed again since is
   * skipped rather than failing the whole batch, same honesty as
   * `restoreDeleted`. Bounded to the same ≤1000-document capture ceiling, so
   * this never runs unbounded.
   */
  private async restoreUpdated(coll: Collection, preImages: Document[], postImages: Document[]): Promise<UndoResult> {
    let restored = 0;
    let skipped = 0;
    for (let i = 0; i < preImages.length; i++) {
      const matched = await this.compareAndReplace(coll, postImages[i]!, preImages[i]!);
      if (matched > 0) restored++;
      else skipped++;
    }
    return { restored, skipped };
  }

  list(input: AuditListInput): AuditEntry[] {
    return this.repo
      .list({ ...input, limit: input.limit ?? DEFAULT_LIST_LIMIT })
      .map((row) => toEntry(row, this.store.has(row.id)));
  }
}
