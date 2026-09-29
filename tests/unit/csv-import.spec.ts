import { describe, it, expect } from 'vitest';
import { ObjectId } from 'bson';
import type { CsvColumnMapping, CsvColumnType } from '@shared/types';
import { PREVIEW_ROWS, coerce, csvRecords, inferColumnType, parseCsv, previewCsv } from '../../electron/mongo/csvImport';

describe('parseCsv', () => {
  it('splits plain fields and records', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
    expect(parseCsv('a,')).toEqual([['a', '']]);
  });

  it('reads nothing from an empty file or a lone BOM', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
  });

  it('keeps commas, doubled quotes and line breaks inside a quoted field', () => {
    expect(parseCsv('"a,b","say ""hi""","x\ny","p\r\nq"')).toEqual([['a,b', 'say "hi"', 'x\ny', 'p\r\nq']]);
    expect(parseCsv('"",""""')).toEqual([['', '"']]);
  });

  it('treats a quote after the start of a field as text, and joins text after a closing quote', () => {
    expect(parseCsv('ab"c,"d"e')).toEqual([['ab"c', 'de']]);
    expect(parseCsv('"a" b')).toEqual([['a b']]);
  });

  it('ends records at LF and CRLF, but not at a lone CR', () => {
    expect(parseCsv('a\r\nb\nc')).toEqual([['a'], ['b'], ['c']]);
    expect(parseCsv('a\rb\r')).toEqual([['a\rb\r']]);
  });

  it('starts no record after a final line break, but keeps a final quoted empty field', () => {
    expect(parseCsv('a\n')).toEqual([['a']]);
    expect(parseCsv('a\r\n')).toEqual([['a']]);
    expect(parseCsv('a\n""')).toEqual([['a'], ['']]);
  });

  it('reads a blank line as one empty field, so it still takes a row', () => {
    expect(parseCsv('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });

  it('strips a BOM only at the very start', () => {
    expect(parseCsv('﻿a,b\n﻿c')).toEqual([['a', 'b'], ['﻿c']]);
  });

  it('keeps ragged rows ragged', () => {
    expect(parseCsv('a,b,c\n1\n1,2,3,4')).toEqual([['a', 'b', 'c'], ['1'], ['1', '2', '3', '4']]);
  });

  it('refuses a quoted field that never closes, naming its row', () => {
    expect(() => parseCsv('a\nb\n"open,x')).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: 'invalid CSV: row 3 opens a quoted field that never closes' }),
    );
    expect(() => parseCsv('"a""')).toThrow(/row 1 opens a quoted field/);
  });
});

describe('coerce', () => {
  it('passes a string through', () => {
    expect(coerce(' x ', 'string')).toBe(' x ');
  });

  it('reads decimal numbers, signs and exponents', () => {
    expect(coerce('42', 'number')).toBe(42);
    expect(coerce('-3.5', 'number')).toBe(-3.5);
    expect(coerce('+7', 'number')).toBe(7);
    expect(coerce('.5', 'number')).toBe(0.5);
    expect(coerce('.25', 'number')).toBe(0.25);
    expect(coerce('5.', 'number')).toBe(5);
    expect(coerce('1e3', 'number')).toBe(1000);
    expect(coerce('1.5E-2', 'number')).toBe(0.015);
    expect(coerce('2e+2', 'number')).toBe(200);
    expect(coerce('9007199254740991', 'number')).toBe(Number.MAX_SAFE_INTEGER);
    expect(coerce('-9007199254740991', 'number')).toBe(-Number.MAX_SAFE_INTEGER);
    expect(coerce('1e300', 'number')).toBe(1e300);
  });

  it('refuses what Number() would accept but is not a decimal number', () => {
    for (const cell of ['0x10', '0b1', '0o7', 'Infinity', '-Infinity', 'NaN', ' 1', '1 ', '1,5', '1.2.3', '.', '-', 'e5', '1e', '12abc']) {
      expect(coerce(cell, 'number'), cell).toBeUndefined();
    }
  });

  it('refuses a whole number past 2^53 and a number past the double range', () => {
    expect(coerce('9007199254740992', 'number')).toBeUndefined();
    expect(coerce('-9007199254740992', 'number')).toBeUndefined();
    expect(coerce('9007199254740993.0', 'number')).toBeUndefined();
    expect(coerce('9007199254740993.', 'number')).toBeUndefined();
    expect(coerce('12.000', 'number')).toBe(12);
    expect(coerce('1e400', 'number')).toBeUndefined();
    expect(coerce('-1e400', 'number')).toBeUndefined();
  });

  it('reads true and false in any case, nothing else', () => {
    expect(coerce('true', 'boolean')).toBe(true);
    expect(coerce('FALSE', 'boolean')).toBe(false);
    expect(coerce('True', 'boolean')).toBe(true);
    for (const cell of ['1', '0', 'yes', 'truex', ' true']) expect(coerce(cell, 'boolean'), cell).toBeUndefined();
  });

  it('reads ISO-8601 dates and zoned date-times as UTC instants', () => {
    expect(coerce('2024-01-02', 'date')).toEqual(new Date('2024-01-02T00:00:00Z'));
    expect(coerce('2024-01-02T03:04:05Z', 'date')).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)));
    expect(coerce('2024-01-02T03:04:05.123Z', 'date')).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 123)));
    expect(coerce('2024-01-02 03:04Z', 'date')).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4)));
    expect(coerce('2024-01-02T03:04:05+02:00', 'date')).toEqual(new Date(Date.UTC(2024, 0, 2, 1, 4, 5)));
    expect(coerce('2024-02-29', 'date')).toEqual(new Date('2024-02-29T00:00:00Z'));
    expect(coerce('0000-02-29', 'date')).toEqual(new Date('0000-02-29T00:00:00Z'));
  });

  it('refuses a zone-less time, a date that rolls over, and anything not ISO', () => {
    for (const cell of [
      '2024-01-02T03:04:05', '2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10', '2024-01-02T25:00Z',
      '2024-1-2', '01/02/2024', 'x2024-01-02',
      // V8 reads text after a `(` as a comment, so only the anchors refuse this.
      '2024-01-02(2024-01-02', '2024-01-02x', '2024-01-02T03:04:05+0200', '1700000000000',
    ]) {
      expect(coerce(cell, 'date'), cell).toBeUndefined();
    }
  });

  it('reads exactly 24 hex digits as an ObjectId', () => {
    const oid = coerce('507F1F77BCF86CD799439011', 'objectId');
    expect(oid).toBeInstanceOf(ObjectId);
    expect((oid as ObjectId).toHexString()).toBe('507f1f77bcf86cd799439011');
    for (const cell of ['aaaaaaaaaaaa', '507f1f77bcf86cd79943901', '507f1f77bcf86cd7994390111', 'x07f1f77bcf86cd799439011']) {
      expect(coerce(cell, 'objectId'), cell).toBeUndefined();
    }
  });
});

describe('inferColumnType', () => {
  it('picks the first type every non-empty value converts to', () => {
    expect(inferColumnType(['true', '', 'False'])).toBe('boolean');
    expect(inferColumnType(['1', '2.5', ''])).toBe('number');
    expect(inferColumnType(['507f1f77bcf86cd799439011', ''])).toBe('objectId');
    expect(inferColumnType(['2024-01-02', '2024-01-02T03:04Z'])).toBe('date');
    expect(inferColumnType(['1', 'x'])).toBe('string');
  });

  it('reads an all-digit 24-character id as an ObjectId, not a number', () => {
    expect(inferColumnType(['000000000000000000000001'])).toBe('objectId');
  });

  it('falls back to string for an all-empty or empty column', () => {
    expect(inferColumnType(['', ''])).toBe('string');
    expect(inferColumnType([])).toBe('string');
  });
});

describe('previewCsv', () => {
  it('returns the header, the first data rows and a type per column, skipping blank lines', () => {
    expect(previewCsv('﻿name,age\nann,3\n\nbob,\n')).toEqual({
      headers: ['name', 'age'],
      rows: [['ann', '3'], ['bob', '']],
      inferred: ['string', 'number'],
    });
  });

  it(`shows at most ${PREVIEW_ROWS} rows but infers from every row`, () => {
    const rows = Array.from({ length: PREVIEW_ROWS + 5 }, (_, i) => String(i));
    const preview = previewCsv(['n', ...rows, 'x'].join('\n'));
    expect(PREVIEW_ROWS).toBe(20);
    expect(preview.rows).toEqual(rows.slice(0, PREVIEW_ROWS).map((r) => [r]));
    expect(preview.inferred).toEqual(['string']);
  });

  it('reads a short row as empty cells when inferring', () => {
    expect(previewCsv('a,b\n1\n2,3').inferred).toEqual(['number', 'number']);
  });

  it('refuses an empty file', () => {
    expect(() => previewCsv('')).toThrow(expect.objectContaining({ code: 'VALIDATION', message: 'the CSV file is empty' }));
  });
});

describe('csvRecords', () => {
  const col = (header: string, type: CsvColumnType = 'string', emptyAsNull = false): CsvColumnMapping =>
    ({ header, type, emptyAsNull });

  it('converts each kept column, numbering rows as a spreadsheet does', () => {
    const text = 'name,age,active,born,ref,note\nann,3,true,2024-01-02,507f1f77bcf86cd799439011,hi\n\nbob,4,false,2020-05-06,507f1f77bcf86cd799439012,x';
    const records = csvRecords(text, [
      col('name'), col('age', 'number'), col('active', 'boolean'), col('born', 'date'), col('ref', 'objectId'), col('note', 'skip'),
    ]);
    expect(records).toEqual([
      { at: 2, doc: { name: 'ann', age: 3, active: true, born: new Date('2024-01-02'), ref: new ObjectId('507f1f77bcf86cd799439011') } },
      { at: 4, doc: { name: 'bob', age: 4, active: false, born: new Date('2020-05-06'), ref: new ObjectId('507f1f77bcf86cd799439012') } },
    ]);
  });

  it('leaves an empty cell out, or stores null when the column asks for it', () => {
    const records = csvRecords('a,b,c\n,,', [col('a'), col('b', 'number', true), col('c', 'skip', true)]);
    expect(records).toEqual([{ at: 2, doc: { b: null } }]);
    expect(Object.keys((records[0] as { doc: object }).doc)).toEqual(['b']);
  });

  it('reads a short row\'s missing cells as empty and fails a long row', () => {
    expect(csvRecords('a,b\n1\n1,2,3', [col('a'), col('b', 'string', true)])).toEqual([
      { at: 2, doc: { a: '1', b: null } },
      { at: 3, error: '3 fields, but the header row has 2' },
    ]);
  });

  it('fails only the row whose cell does not convert, naming the column', () => {
    const records = csvRecords('n,b,d,o\n1,true,2024-01-02,507f1f77bcf86cd799439011\nx,,,\n,maybe,,\n,,2024-02-30,\n,,,nope', [
      col('n', 'number'), col('b', 'boolean'), col('d', 'date'), col('o', 'objectId'),
    ]);
    expect(records.map((r) => ('error' in r ? r.error : 'ok'))).toEqual([
      'ok',
      'column "n": not a number',
      'column "b": not true or false',
      'column "d": not an ISO-8601 date',
      'column "o": not a 24-digit hex ObjectId',
    ]);
    expect(records.map((r) => r.at)).toEqual([2, 3, 4, 5, 6]);
  });

  it('nests dotted headers into null-prototype objects, in header order', () => {
    const [record] = csvRecords('a.b,x,a.c.d\n1,2,3', [col('a.b', 'number'), col('x'), col('a.c.d')]);
    const doc = (record as { doc: Record<string, Record<string, unknown>> }).doc;
    expect(JSON.stringify(doc)).toBe('{"a":{"b":1,"c":{"d":"3"}},"x":"2"}');
    expect(Object.getPrototypeOf(doc.a)).toBeNull();
    expect(Object.getPrototypeOf(doc.a!.c)).toBeNull();
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
  });

  it('writes a __proto__ header as an own field, never touching a prototype', () => {
    const [record] = csvRecords('__proto__.polluted,__proto__\n1,2', [col('__proto__.polluted'), col('__proto__', 'skip')]);
    const doc = (record as { doc: Record<string, unknown> }).doc;
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(Object.hasOwn(doc, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')!.value).toEqual(Object.assign(Object.create(null), { polluted: '1' }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('skips blank lines but still counts their rows', () => {
    expect(csvRecords('a\n1\n\n2\n', [col('a')]).map((r) => r.at)).toEqual([2, 4]);
  });

  it('imports nothing from a header-only file, and refuses an empty one', () => {
    expect(csvRecords('a,b\n', [col('a'), col('b')])).toEqual([]);
    expect(() => csvRecords('', [col('a')])).toThrow(expect.objectContaining({ code: 'VALIDATION', message: 'the CSV file is empty' }));
  });

  it('refuses a mapping that no longer matches the header row', () => {
    const mismatch = expect.objectContaining({ code: 'VALIDATION', message: expect.stringMatching(/header row — preview the file again$/) });
    expect(() => csvRecords('a,b\n1,2', [col('a')])).toThrow(mismatch);
    expect(() => csvRecords('a,b\n1,2', [col('a'), col('b'), col('c')])).toThrow(mismatch);
    expect(() => csvRecords('a,b\n1,2', [col('a'), col('B')])).toThrow(mismatch);
  });

  it('refuses kept columns that would write the same field twice, whichever comes first', () => {
    const clash = (h: string) => expect.objectContaining({
      code: 'VALIDATION', message: `column "${h}" writes the same field as another column — skip one of them`,
    });
    expect(() => csvRecords('a,a\n1,2', [col('a'), col('a')])).toThrow(clash('a'));
    expect(() => csvRecords('a,a.b\n1,2', [col('a'), col('a.b')])).toThrow(clash('a.b'));
    expect(() => csvRecords('a.b,a\n1,2', [col('a.b'), col('a')])).toThrow(clash('a'));
    expect(() => csvRecords('a.b.c,a.b\n1,2', [col('a.b.c'), col('a.b')])).toThrow(clash('a.b'));
    expect(() => csvRecords('a.b,a.b.c\n1,2', [col('a.b'), col('a.b.c')])).toThrow(clash('a.b.c'));
    expect(() => csvRecords('a,a.b.c\n1,2', [col('a'), col('a.b.c')])).toThrow(clash('a.b.c'));
    expect(() => csvRecords('a.b.c,a\n1,2', [col('a.b.c'), col('a')])).toThrow(clash('a'));
  });

  it('accepts clashing columns once one of them is skipped, and siblings under one parent', () => {
    expect(csvRecords('a,a.b\n1,2', [col('a', 'skip'), col('a.b')])).toEqual([{ at: 2, doc: { a: { b: '2' } } }]);
    expect(csvRecords('a.b,a,a.c\n1,2,3', [col('a.b'), col('a', 'skip'), col('a.c')])).toEqual([
      { at: 2, doc: { a: { b: '1', c: '3' } } },
    ]);
    expect(csvRecords('ab,a.b\n1,2', [col('ab'), col('a.b')])).toEqual([{ at: 2, doc: { ab: '1', a: { b: '2' } } }]);
  });

  it('refuses a kept column with an empty field name, but not a skipped one', () => {
    const empty = (h: string) => expect.objectContaining({
      code: 'VALIDATION', message: `column "${h}" has an empty field name — skip it to import the rest`,
    });
    expect(() => csvRecords(',b\n1,2', [col(''), col('b')])).toThrow(empty(''));
    expect(() => csvRecords('a..b\n1', [col('a..b')])).toThrow(empty('a..b'));
    expect(() => csvRecords('.a\n1', [col('.a')])).toThrow(empty('.a'));
    expect(() => csvRecords('a.\n1', [col('a.')])).toThrow(empty('a.'));
    expect(csvRecords(',b\n1,2', [col('', 'skip'), col('b')])).toEqual([{ at: 2, doc: { b: '2' } }]);
  });
});
