import { describe, it, expect } from 'vitest';
import { Double } from 'bson';
import {
  assertUndoable,
  attachUndo,
  boundedCapture,
  importDigest,
  MAX_BULK_CAPTURE_DOCS,
  MAX_BULK_CAPTURE_BYTES,
  undoCaptureOf,
} from '../../electron/mongo/undo';
import { AppError } from '../../electron/errors';
import { ByteCapExceededError } from '../../electron/mongo/ejson';
import { undoFailureMessage, undoneMessage } from '../../src/utils/auditUndo';

function refusal(row: { reversible: number; undone_at: string | null; undo_json: string | null }): string | null {
  try {
    assertUndoable(row);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
}

describe('assertUndoable — refuses before anything is written', () => {
  const held = { reversible: 1, undone_at: null, undo_json: '{"preImage":{}}' };

  it('lets a held, unused Pre-image through', () => {
    expect(refusal(held)).toBeNull();
  });

  it('refuses an entry that never kept a Pre-image', () => {
    expect(refusal({ reversible: 0, undone_at: null, undo_json: null })).toBe('AUDIT_NOT_REVERSIBLE');
  });

  it('refuses an entry already undone, even though its Pre-image is gone too', () => {
    expect(refusal({ ...held, undone_at: '2026-01-01T00:00:00.000Z', undo_json: null })).toBe('AUDIT_ALREADY_UNDONE');
  });

  it('refuses an entry whose Pre-image was swept', () => {
    expect(refusal({ ...held, undo_json: null })).toBe('AUDIT_UNDO_EXPIRED');
  });

  it('names what happened in the message, not only the code', () => {
    expect(() => assertUndoable({ ...held, undo_json: null })).toThrow('after L\'Atelier restarts');
    expect(() => assertUndoable({ ...held, reversible: 0 })).toThrow('Nothing was kept');
    expect(() => assertUndoable({ ...held, undone_at: 'x' })).toThrow('already been undone');
  });
});

describe('attachUndo / undoCaptureOf', () => {
  it('hands back the same result object, with the capture readable beside it', () => {
    const result = { deletedCount: 1 };
    const capture = { preImage: { _id: 1 } };

    expect(attachUndo(result, capture)).toBe(result);
    expect(undoCaptureOf(result)).toBe(capture);
    expect(Object.keys(result)).toEqual(['deletedCount']);
  });

  it('finds nothing for a result that carried no capture, or for a non-object', () => {
    expect(undoCaptureOf({ deletedCount: 1 })).toBeUndefined();
    expect(undoCaptureOf(null)).toBeUndefined();
    expect(undoCaptureOf(undefined)).toBeUndefined();
    expect(undoCaptureOf('x')).toBeUndefined();
  });
});

describe('boundedCapture — X13 §5\'s bulk Pre-image ceiling', () => {
  it('keeps documents at or under both ceilings', () => {
    const docs = [{ a: 1 }, { a: 2 }];
    expect(boundedCapture(docs)).toBe(docs);
  });

  it('keeps exactly MAX_BULK_CAPTURE_DOCS documents', () => {
    const docs = Array.from({ length: MAX_BULK_CAPTURE_DOCS }, (_, i) => ({ i }));
    expect(boundedCapture(docs)).toBe(docs);
  });

  it('refuses one document over the doc ceiling', () => {
    const docs = Array.from({ length: MAX_BULK_CAPTURE_DOCS + 1 }, (_, i) => ({ i }));
    expect(boundedCapture(docs)).toBeNull();
  });

  it('passes on a failure that is not the byte ceiling, rather than reading it as one', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => boundedCapture([circular])).toThrow();
    expect(() => boundedCapture([circular])).not.toThrow(ByteCapExceededError);
  });

  it('refuses documents whose encoded size is over the byte ceiling', () => {
    const docs = [{ blob: 'x'.repeat(MAX_BULK_CAPTURE_BYTES) }];
    expect(boundedCapture(docs)).toBeNull();
  });

  it('keeps documents right at the byte ceiling', () => {
    // ejsonEncodeArrayJson's own accounting (brackets/commas/quotes), not a
    // guess: this is the largest single string field that keeps the
    // encoded array at or under MAX_BULK_CAPTURE_BYTES.
    const overhead = '[{"blob":""}]'.length;
    const docs = [{ blob: 'x'.repeat(MAX_BULK_CAPTURE_BYTES - overhead) }];
    expect(boundedCapture(docs)).toBe(docs);
  });
});

describe('importDigest — the _id-first normalization import undo relies on', () => {
  it('is the same whether _id is written first (server order) or last (driver-appended)', () => {
    const idFirst = { _id: 1, name: 'alpha' };
    const idLast = { name: 'alpha', _id: 1 };
    expect(importDigest(idFirst)).toBe(importDigest(idLast));
  });

  it('changes when a field value changes', () => {
    expect(importDigest({ _id: 1, name: 'alpha' })).not.toBe(importDigest({ _id: 1, name: 'beta' }));
  });

  it('is order-sensitive beyond _id — canonical EJSON, not a value-set compare', () => {
    expect(importDigest({ _id: 1, a: 1, b: 2 })).not.toBe(importDigest({ _id: 1, b: 2, a: 1 }));
  });

  it('hashes the stored form: a parsed integer past int32 matches the double the server reads back', () => {
    expect(importDigest({ _id: 1, at: 1700000000000 })).toBe(importDigest({ _id: 1, at: new Double(1700000000000) }));
  });
});

describe('undoFailureMessage', () => {
  const err = (code: string, message = code) => ({ code, message });

  it.each([
    ['AUDIT_TARGET_CHANGED', /has changed since.*outside L'Atelier can't be unwound from here/],
    ['AUDIT_ALREADY_UNDONE', /^This change has already been undone\.$/],
    ['AUDIT_UNDO_EXPIRED', /^This change can't be undone any more/],
    ['AUDIT_NOT_REVERSIBLE', /^This change can't be undone/],
    ['CONFLICT', /same _id exists again/],
  ])('explains %s in words', (code, text) => {
    expect(undoFailureMessage(err(code))).toMatch(text);
  });

  it('falls back to the error message for any other failure', () => {
    expect(undoFailureMessage(err('READ_ONLY', 'Connection "prod" is read-only.'))).toBe(
      'Connection "prod" is read-only.',
    );
  });

  it('falls back to a generic line when there is no usable message', () => {
    expect(undoFailureMessage(undefined)).toBe('Undo failed');
    expect(undoFailureMessage({ message: 'no code' })).toBe('no code');
  });
});

describe('undoneMessage', () => {
  it('counts what came back', () => {
    expect(undoneMessage({ restored: 1, skipped: 0 })).toBe('Restored 1 document');
    expect(undoneMessage({ restored: 3, skipped: 0 })).toBe('Restored 3 documents');
  });

  it('names a partial restore honestly (X13 §6: "restored 47 of 50, 3 already exist")', () => {
    expect(undoneMessage({ restored: 2, skipped: 1 })).toBe('Restored 2 of 3 documents (1 skipped)');
  });

  it('uses the singular only when the total is exactly one document', () => {
    expect(undoneMessage({ restored: 0, skipped: 1 })).toBe('Restored 0 of 1 document (1 skipped)');
    expect(undoneMessage({ restored: 1, skipped: 1 })).toBe('Restored 1 of 2 documents (1 skipped)');
  });
});
