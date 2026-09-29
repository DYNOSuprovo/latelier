import { describe, it, expect } from 'vitest';
import {
  csvCellValue,
  csvEscape,
  exportColumnsFrom,
  exportFileExtension,
  neutralizeFormula,
  serializeCsv,
  serializeJsonArray,
  serializeJsonl,
} from '../../src/pages/Workspace/exportFormat';
import type { ResolvedColumn } from '../../src/pages/Workspace/views/tableColumns';

// Canonical-EJSON-shaped documents, exactly the plain-object shape
// `electron/preload.ts` hands the renderer (`JSON.parse(wire.documentsJson)`)
// — no BSON class instances anywhere in these fixtures.
const canonicalDocs = [
  {
    _id: { $oid: '507f1f77bcf86cd799439011' },
    n: { $numberInt: '5' },
    big: { $numberLong: '9007199254740993' },
    when: { $date: { $numberLong: '1700000000000' } },
  },
];

describe('serializeJsonArray', () => {
  it('canonical (default) is a plain pretty stringify — documents are already this shape', () => {
    expect(serializeJsonArray(canonicalDocs, false)).toBe(JSON.stringify(canonicalDocs, null, 2));
  });

  it('relaxed unwraps int/double sentinels and writes $date as an ISO string', () => {
    const out = JSON.parse(serializeJsonArray(canonicalDocs, true));
    expect(out).toEqual([
      {
        _id: { $oid: '507f1f77bcf86cd799439011' },
        n: 5,
        // Relaxed is documented as lossy for int64 beyond the safe-integer
        // range — this is the checkbox's "not lossless for every type"
        // warning, verified against bson's own writer rather than assumed.
        big: 9007199254740992,
        when: { $date: '2023-11-14T22:13:20Z' },
      },
    ]);
  });

  it('empty input is an empty array, not an empty string', () => {
    expect(serializeJsonArray([], false)).toBe('[]');
  });
});

describe('serializeJsonl', () => {
  it('empty input is the empty string', () => {
    expect(serializeJsonl([], false)).toBe('');
  });

  it('one document per line, LF-terminated including the last line', () => {
    const docs = [{ a: 1 }, { b: 2 }];
    expect(serializeJsonl(docs, false)).toBe('{"a":1}\n{"b":2}\n');
  });

  it('relaxed applies per line, independently of serializeJsonArray', () => {
    const out = serializeJsonl(canonicalDocs, true);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.trim())).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      n: 5,
      big: 9007199254740992,
      when: { $date: '2023-11-14T22:13:20Z' },
    });
  });
});

describe('csvCellValue', () => {
  it('undefined/null render as an empty cell', () => {
    expect(csvCellValue(undefined)).toBe('');
    expect(csvCellValue(null)).toBe('');
  });

  it('strings/numbers/booleans stringify plainly', () => {
    expect(csvCellValue('hi')).toBe('hi');
    expect(csvCellValue(42)).toBe('42');
    expect(csvCellValue(true)).toBe('true');
  });

  it('an ObjectId sentinel renders as its bare hex', () => {
    expect(csvCellValue({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
  });

  it('a canonical $date sentinel renders as an ISO string', () => {
    // Native `Date.prototype.toISOString`, not bson's Relaxed EJSON writer —
    // it always includes milliseconds, unlike the JSON export path below.
    expect(csvCellValue({ $date: { $numberLong: '1700000000000' } })).toBe(
      '2023-11-14T22:13:20.000Z',
    );
  });

  it('an already-relaxed $date string sentinel passes through unchanged', () => {
    expect(csvCellValue({ $date: '2023-11-14T22:13:20Z' })).toBe('2023-11-14T22:13:20Z');
  });

  it('a $date sentinel with a non-string, non-numberLong-object inner value falls back to its JSON text', () => {
    expect(csvCellValue({ $date: 123 })).toBe('{"$date":123}');
    expect(csvCellValue({ $date: {} })).toBe('{"$date":{}}');
    expect(csvCellValue({ $date: { $numberLong: 123 } })).toBe(
      '{"$date":{"$numberLong":123}}',
    );
  });

  it('a $date sentinel whose inner value is null falls back to its JSON text (no crash on property access)', () => {
    expect(csvCellValue({ $date: null })).toBe('{"$date":null}');
  });

  it('a $date sentinel whose $numberLong does not parse to a valid instant falls back to its JSON text', () => {
    expect(csvCellValue({ $date: { $numberLong: 'not-a-number' } })).toBe(
      '{"$date":{"$numberLong":"not-a-number"}}',
    );
  });

  it('a truthy, non-object $date inner value never decodes, even one carrying a look-alike $numberLong', () => {
    // A function is truthy and `typeof … !== 'object'` — distinct from every
    // other case above, which are either objects or null/number/string. Real
    // wire data never puts a function here; this exists to pin down that the
    // decode requires the inner value to genuinely be an object, not merely
    // to have a `$numberLong`-shaped property.
    const inner = Object.assign(() => {}, { $numberLong: '1700000000000' });
    expect(csvCellValue({ $date: inner as unknown })).toBe('{}');
  });

  it('int32/double sentinels unwrap to a plain number', () => {
    expect(csvCellValue({ $numberInt: '30' })).toBe('30');
    expect(csvCellValue({ $numberDouble: '3.5' })).toBe('3.5');
  });

  it('a $numberLong sentinel stays wrapped (int64 can exceed a JS number exactly)', () => {
    expect(csvCellValue({ $numberLong: '9007199254740993' })).toBe(
      '{"$numberLong":"9007199254740993"}',
    );
  });

  it('a plain sub-document renders as its JSON text, not [object Object]', () => {
    expect(csvCellValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('an array renders as its JSON text', () => {
    expect(csvCellValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('a two-digit numeric sentinel that is not an exact BSON wrapper is a sub-document', () => {
    // `$oid` plus an extra key is not `isExactSentinel` — same rule
    // `schemaSummary.ts:inferType` uses — so it falls through to generic
    // object JSON rather than being misread as an ObjectId.
    expect(csvCellValue({ $oid: 'x', extra: true })).toBe('{"$oid":"x","extra":true}');
  });
});

describe('csvEscape', () => {
  it('leaves a plain field unquoted', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('')).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline or CR', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });
});

describe('serializeCsv', () => {
  it('writes a header row and one row per document, in column order', () => {
    const docs = [
      { name: 'Ann, A.', age: 30 },
      { name: 'Bo', age: 25 },
    ];
    const columns = [
      { header: 'name', path: 'name' },
      { header: 'age', path: 'age' },
    ];
    expect(serializeCsv(docs, columns)).toBe('name,age\n"Ann, A.",30\nBo,25\n');
  });

  it('a missing field resolves to an empty cell, keeping column alignment', () => {
    const docs = [{ a: 1 }];
    const columns = [
      { header: 'a', path: 'a' },
      { header: 'b', path: 'b' },
    ];
    expect(serializeCsv(docs, columns)).toBe('a,b\n1,\n');
  });

  it('empty documents still emit the header row', () => {
    expect(serializeCsv([], [{ header: 'a', path: 'a' }])).toBe('a\n');
  });

  it('resolves a dotted path into a nested sub-document', () => {
    const docs = [{ address: { city: 'NYC' } }];
    expect(serializeCsv(docs, [{ header: 'address.city', path: 'address.city' }])).toBe(
      'address.city\nNYC\n',
    );
  });
});

describe('neutralizeFormula', () => {
  it.each(['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'prefixes a string cell starting with a formula character: %j',
    (cell) => {
      expect(neutralizeFormula(cell, cell)).toBe(`'${cell}`);
    },
  );

  it('leaves ordinary strings and non-string values alone', () => {
    expect(neutralizeFormula('plain', 'plain')).toBe('plain');
    expect(neutralizeFormula('a=b', 'a=b')).toBe('a=b');
    expect(neutralizeFormula('-5', -5)).toBe('-5');
    expect(neutralizeFormula('-5', { $numberInt: '-5' })).toBe('-5');
  });

  it('is applied to header cells too, since field names come from the data', () => {
    expect(serializeCsv([{ '=cmd': 1 }], [{ header: '=cmd', path: '=cmd' }])).toBe("'=cmd\n1\n");
  });

  it('is applied by serializeCsv before quoting', () => {
    const docs = [{ f: '=1+1', n: -3 }];
    const columns = [
      { header: 'f', path: 'f' },
      { header: 'n', path: 'n' },
    ];
    expect(serializeCsv(docs, columns)).toBe("f,n\n'=1+1,-3\n");
  });
});

describe('exportColumnsFrom', () => {
  it('a plain field column uses its own name as both header and path', () => {
    const resolved: ResolvedColumn[] = [{ kind: 'field', field: 'name' }];
    expect(exportColumnsFrom(resolved)).toEqual([{ header: 'name', path: 'name' }]);
  });

  it('a computed column falls back to its path when it has no label', () => {
    const resolved: ResolvedColumn[] = [
      { kind: 'computed', field: 'c1', path: 'address.city' },
    ];
    expect(exportColumnsFrom(resolved)).toEqual([
      { header: 'address.city', path: 'address.city' },
    ]);
  });

  it('a computed column with a label uses the label as its header', () => {
    const resolved: ResolvedColumn[] = [
      { kind: 'computed', field: 'c1', path: 'address.city', label: 'City' },
    ];
    expect(exportColumnsFrom(resolved)).toEqual([{ header: 'City', path: 'address.city' }]);
  });
});

describe('exportFileExtension', () => {
  it('maps each format to its file extension', () => {
    expect(exportFileExtension('json')).toBe('json');
    expect(exportFileExtension('jsonl')).toBe('jsonl');
    expect(exportFileExtension('csv')).toBe('csv');
  });
});
