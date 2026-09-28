import { describe, it, expect } from 'vitest';
import {
  getDocId,
  getFullDocId,
  buildIdFilter,
  isInlineEditable,
  reviveTableValue,
  stripIdForDuplicate,
} from '../../src/pages/Workspace/views/docId';

describe('getDocId', () => {
  it('takes the last 8 chars of an $oid', () => {
    const doc = { _id: { $oid: '507f1f77bcf86cd799439011' } };
    expect(getDocId(doc)).toBe('99439011');
  });

  it('returns "(no _id)" when _id is missing or null', () => {
    expect(getDocId({})).toBe('(no _id)');
    expect(getDocId({ _id: null })).toBe('(no _id)');
  });

  it('renders a readable JSON form for a custom-object _id, not "[object Object]"', () => {
    // Reviewer-bot finding: a non-$oid record `_id` fell through to
    // `String(id)`, which stringifies any plain object to "[object Object]".
    const doc = { _id: { a: 1, b: 2 } };
    const result = getDocId(doc);
    expect(result).not.toBe('[object Object]');
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }).slice(0, 12));
  });

  it('still uses plain stringification for a primitive (non-record) _id', () => {
    expect(getDocId({ _id: 'abc123' })).toBe('abc123');
    expect(getDocId({ _id: 42 })).toBe('42');
  });

  it('falls back to a truncated JSON form for non-record input', () => {
    // Long enough that `.slice(0, 12)` actually cuts something off — a
    // shorter fixture can't tell a truncating slice from a dropped one.
    const input = 'this string is much longer than twelve characters';
    expect(getDocId(input)).toBe(JSON.stringify(input).slice(0, 12));
    expect(getDocId(input).length).toBe(12);
  });

  it('truncates a long primitive _id to 12 chars', () => {
    const id = 'a-primitive-id-well-past-twelve-characters-long';
    expect(getDocId({ _id: id })).toBe(String(id).slice(0, 12));
    expect(getDocId({ _id: id }).length).toBe(12);
  });
});

describe('getFullDocId', () => {
  it('returns the full $oid unmodified', () => {
    const doc = { _id: { $oid: '507f1f77bcf86cd799439011' } };
    expect(getFullDocId(doc)).toBe('507f1f77bcf86cd799439011');
  });

  it('JSON-stringifies a custom-object _id, truncated to 24 chars', () => {
    const doc = { _id: { a: 'a value long enough to push the JSON past 24 characters' } };
    const expected = JSON.stringify(doc._id).slice(0, 24);
    expect(getFullDocId(doc)).toBe(expected);
    expect(getFullDocId(doc).length).toBe(24);
  });

  it('falls back to a truncated JSON form for non-record input', () => {
    const input = 'this string is much longer than twenty-four characters';
    expect(getFullDocId(input)).toBe(JSON.stringify(input).slice(0, 24));
    expect(getFullDocId(input).length).toBe(24);
  });

  it('returns "(no _id)" when _id is missing or null', () => {
    expect(getFullDocId({})).toBe('(no _id)');
    expect(getFullDocId({ _id: null })).toBe('(no _id)');
  });
});

describe('reviveTableValue', () => {
  it('falls back to the raw value when it cannot be JSON-stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(reviveTableValue(circular)).toBe(circular);
  });
});

// T2.6 — shared `{_id}` filter for inline edit and delete (no drift between
// the write surfaces).
describe('buildIdFilter', () => {
  it('builds a JSON.stringify (not ejsonStringify) filter for an ObjectId sentinel _id', () => {
    const doc = { _id: { $oid: '507f1f77bcf86cd799439011' } };
    expect(buildIdFilter(doc)).toBe(JSON.stringify({ _id: doc._id }));
    expect(JSON.parse(buildIdFilter(doc)!)).toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
  });

  it('builds a filter for a plain string _id', () => {
    expect(buildIdFilter({ _id: 'abc123' })).toBe(JSON.stringify({ _id: 'abc123' }));
  });

  it('builds a filter for a custom-object _id', () => {
    const doc = { _id: { a: 1, b: 2 } };
    expect(buildIdFilter(doc)).toBe(JSON.stringify({ _id: { a: 1, b: 2 } }));
  });

  it('returns null when the document has no _id', () => {
    expect(buildIdFilter({ sku: 'x' })).toBeNull();
  });

  it('returns null for non-record input', () => {
    expect(buildIdFilter('not a doc')).toBeNull();
    expect(buildIdFilter(null)).toBeNull();
  });
});

describe('isInlineEditable', () => {
  it('allows a plain string value on a non-_id field', () => {
    expect(isInlineEditable('pending', 'status')).toBe(true);
  });

  it('never allows editing _id, even when its value is a string', () => {
    expect(isInlineEditable('abc123', '_id')).toBe(false);
  });

  // W18 §8 — widened from v1: the BSON numeric sentinels keep their loaded
  // type through the guarded save path (`documentDiff.ts`), so they're no
  // longer routed away from the cell.
  it('allows the BSON numeric sentinels (Int32/Int64/Double/Decimal128)', () => {
    expect(isInlineEditable({ $numberInt: '5' }, 'qty')).toBe(true);
    expect(isInlineEditable({ $numberDouble: '5.5' }, 'qty')).toBe(true);
    expect(isInlineEditable({ $numberLong: '5' }, 'qty')).toBe(true);
    expect(isInlineEditable({ $numberDecimal: '5.5' }, 'qty')).toBe(true);
  });

  // W18 §8 — booleans are the other type this widens to allow.
  it('allows booleans', () => {
    expect(isInlineEditable(true, 'active')).toBe(true);
    expect(isInlineEditable(false, 'active')).toBe(true);
  });

  it('rejects sentinel types the inline editor still doesn\'t handle (Date, ObjectId, Binary) — those open the Document Editor on the field instead', () => {
    expect(isInlineEditable({ $date: '2026-01-01T00:00:00Z' }, 'createdAt')).toBe(false);
    expect(isInlineEditable({ $oid: '507f1f77bcf86cd799439011' }, 'userId')).toBe(false);
    expect(isInlineEditable({ $binary: { base64: 'AA==', subType: '00' } }, 'blob')).toBe(false);
  });

  it('rejects null, array, and plain-object values', () => {
    expect(isInlineEditable(null, 'note')).toBe(false);
    expect(isInlineEditable([1, 2], 'tags')).toBe(false);
    expect(isInlineEditable({ city: 'Springfield' }, 'address')).toBe(false);
  });

  it('rejects a plain number too — canonical EJSON never round-trips a bare JS number', () => {
    expect(isInlineEditable(42, 'qty')).toBe(false);
  });
});

describe('stripIdForDuplicate', () => {
  it('returns the document EJSON with _id removed', () => {
    const doc = {
      _id: { $oid: '507f1f77bcf86cd799439011' },
      name: 'alpha',
      qty: { $numberInt: '5' },
    };
    const result = stripIdForDuplicate(doc);
    // the int32 arrives as a plain number now. It re-parses to the same
    // int32, which is the rule that made the drawer safe to relax.
    expect(JSON.parse(result)).toEqual({ name: 'alpha', qty: 5 });
  });

  it('preserves a BSON-typed sibling field across the strip', () => {
    const doc = { _id: 1, price: { $numberDecimal: '9.99' } };
    const result = stripIdForDuplicate(doc);
    expect(JSON.parse(result)).toEqual({ price: { $numberDecimal: '9.99' } });
  });

  it('falls back to "{}" for non-record input', () => {
    expect(stripIdForDuplicate('not a doc')).toBe('{}');
    expect(stripIdForDuplicate(null)).toBe('{}');
    expect(stripIdForDuplicate(42)).toBe('{}');
  });

  it('falls back to "{}" when the round-tripped document is not a record', () => {
    // A document whose only key is itself a BSON sentinel round-trips
    // through `ejsonStringify`/`ejsonParse` to that sentinel's *revived
    // value*, not a record — `{ $undefined: true }` revives to `null`.
    expect(stripIdForDuplicate({ $undefined: true })).toBe('{}');
  });

  it('falls back to "{}" when the document fails to encode as EJSON', () => {
    // An invalid $oid hex string encodes fine (it's just a string at that
    // point) but throws on the way back in — proves the catch is reached,
    // not just theoretical.
    const doc = { _id: { $oid: 'not-a-valid-hex-string' }, name: 'x' };
    expect(stripIdForDuplicate(doc)).toBe('{}');
  });
});
