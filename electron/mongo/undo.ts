import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'bson';
import type { Document } from 'mongodb';
import { SystemError } from '../errors.ts';
import { ByteCapExceededError, ejsonEncodeArrayJson, ejsonStringify } from './ejson.ts';

/**
 * What a write kept so it can be undone. Single-document ops use
 * `preImage`/`postImage` (`postImage` is what the write left behind, which
 * Undo compares against before putting `preImage` back); bulk ops use the
 * plural arrays, paired by index; `insertMany` keeps the documents it
 * inserted — the Node driver assigns `_id` onto each input document in
 * place unless `forceServerObjectId` is set (neither `insertMany` call sets
 * it), so the same array holds the ids after the write with no second read;
 * `collectionRename` keeps the two names; `import` keeps only ids plus a
 * per-document digest (X13 §5's option (b)) — a full-body capture like
 * `insertedDocs` would be tens of MB at the ~10,000-document ceiling `import`
 * needs, well past `insertMany`'s ≤1000/≤1MB bulk capture.
 */
export interface UndoCapture {
  preImage?: Document;
  postImage?: Document;
  preImages?: Document[];
  postImages?: Document[];
  insertedDocs?: Document[];
  /** `import` only, paired by index with `digests`. */
  importedIds?: unknown[];
  /** `import` only — `importDigest` of each landed document. */
  digests?: string[];
  fromName?: string;
  toName?: string;
}

/** X13 §5: an import capture never keeps more ids/digests than this. */
export const MAX_IMPORT_CAPTURE_DOCS = 10_000;

/**
 * A document as the server stores it and `EXACT_BSON` reads it back: `_id`
 * first (the driver appends a generated `_id` last, and a pasted document can
 * carry it anywhere) and BSON round-tripped (a parsed JS number outside int32,
 * such as an epoch-ms timestamp, serializes as `$numberLong` but is stored
 * and read back as a double). Captures taken from the renderer's input go
 * through this so Undo's compare-before-delete sees the same bytes it will
 * read; re-running it on an already-read document changes nothing.
 */
export function asStored(doc: Document): Document {
  const { _id, ...rest } = doc;
  return deserialize(serialize({ _id, ...rest }), EXACT_BSON);
}

/**
 * The per-document digest an import capture keeps, and what `restoreImported`
 * recomputes to decide whether a landed document is still unchanged.
 */
export function importDigest(doc: Document): string {
  return createHash('sha256').update(ejsonStringify(asStored(doc))).digest('hex');
}

/** X13 §5: a bulk Pre-image capture never holds more than this many documents… */
export const MAX_BULK_CAPTURE_DOCS = 1000;
/** …nor more than this many encoded bytes. */
export const MAX_BULK_CAPTURE_BYTES = 1_048_576;

/**
 * Bounds a bulk Pre-image capture (X13 §5): breach either ceiling and nothing
 * is kept — the Operation still runs, only without an Undo, and no partial
 * capture is ever stored. `docs` should be read with a `limit` one past
 * `MAX_BULK_CAPTURE_DOCS` so the doc-count ceiling can be detected without
 * reading an unbounded result set first.
 */
export function boundedCapture(docs: Document[]): Document[] | null {
  if (docs.length > MAX_BULK_CAPTURE_DOCS) return null;
  try {
    ejsonEncodeArrayJson(docs, { maxBytes: MAX_BULK_CAPTURE_BYTES });
  } catch (err) {
    // Over the byte ceiling is an expected outcome; anything else is a real
    // failure the caller logs (and pays for with the Undo, not the write).
    if (err instanceof ByteCapExceededError) return null;
    throw err;
  }
  return docs;
}

/**
 * Read options that keep every BSON value as its own type — a Double stays a
 * Double rather than coming back as a JS number that re-inserts as an Int32, a
 * Long stays a Long, a regex keeps flags a JS RegExp can't hold — so a
 * restored Pre-image is the document that was read, not an approximation.
 */
export const EXACT_BSON = { promoteValues: false, bsonRegExp: true } as const;

// Keyed by the result object a service returns, which is the same object the
// router hands the audit sink as the envelope's data. The Pre-image rides next
// to the result instead of inside it, so it can never cross IPC.
const captures = new WeakMap<object, UndoCapture>();

export function attachUndo<T extends object>(result: T, capture: UndoCapture): T {
  captures.set(result, capture);
  return result;
}

// `WeakMap#get` answers undefined for a primitive rather than throwing.
export function undoCaptureOf(result: unknown): UndoCapture | undefined {
  return captures.get(result as object);
}

/**
 * Refuses an Undo before anything is written (X13 §6). `reversible` records
 * whether a Pre-image was ever captured and never changes afterwards; the
 * sweep only nulls `undo_json`, which is how an expired entry stays
 * distinguishable from one that was never reversible.
 */
export function assertUndoable(row: {
  reversible: number;
  undone_at: string | null;
  undo_json: string | null;
}): asserts row is { reversible: number; undone_at: null; undo_json: string } {
  if (row.reversible !== 1) {
    throw new SystemError('AUDIT_NOT_REVERSIBLE', 'Nothing was kept that could undo this change.');
  }
  if (row.undone_at !== null) {
    throw new SystemError('AUDIT_ALREADY_UNDONE', 'This change has already been undone.');
  }
  if (row.undo_json === null) {
    throw new SystemError('AUDIT_UNDO_EXPIRED', 'This change is too old to undo.');
  }
}
