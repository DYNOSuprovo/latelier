import { describe, it, expect } from 'vitest';
import { ObjectId } from 'bson';
import {
  MAX_REPORTED_ERRORS,
  emptyReport,
  extensionFormat,
  parseJsonArray,
  parseJsonlLine,
  recordFailure,
  sniffFormat,
} from '../../electron/mongo/importParse';

describe('extensionFormat', () => {
  it('settles .jsonl and .ndjson, leaves .json to sniffing, refuses the rest', () => {
    expect(extensionFormat('/d/a.jsonl')).toBe('jsonl');
    expect(extensionFormat('/d/a.NDJSON')).toBe('jsonl');
    expect(extensionFormat('/d/a.Json')).toBe('sniff');
    expect(extensionFormat('/d/a.CSV')).toBe('csv');
    expect(extensionFormat('/d/a.tsv')).toBeUndefined();
    expect(extensionFormat('/d/json')).toBeUndefined();
    expect(extensionFormat('/d/a.constructor')).toBeUndefined();
  });
});

describe('sniffFormat', () => {
  it('reads the first significant character, stepping over whitespace and a BOM', () => {
    expect(sniffFormat('﻿ \n\t[')).toBe('json');
    expect(sniffFormat('  {"a":1}')).toBe('jsonl');
    expect(sniffFormat('x[')).toBe('jsonl');
    expect(sniffFormat(' \n ')).toBeUndefined();
    expect(sniffFormat('')).toBeUndefined();
  });
});

describe('parseJsonlLine', () => {
  it('parses a document, reviving EJSON', () => {
    const oid = new ObjectId();
    const rec = parseJsonlLine(`{"_id":{"$oid":"${oid.toHexString()}"}}`, 4);
    expect(rec).toEqual({ at: 4, doc: { _id: oid } });
  });

  it('skips a blank or whitespace-only line', () => {
    expect(parseJsonlLine('', 2)).toBeNull();
    expect(parseJsonlLine(' \t ', 2)).toBeNull();
  });

  it('strips a BOM from the first line only', () => {
    expect(parseJsonlLine('﻿{"a":1}', 1)).toEqual({ at: 1, doc: { a: 1 } });
    expect(parseJsonlLine('﻿', 1)).toBeNull();
    expect(parseJsonlLine('﻿{"a":1}', 2)).toMatchObject({ at: 2, error: expect.stringMatching(/^invalid document: /) });
  });

  it('reports malformed JSON and a non-document by line', () => {
    expect(parseJsonlLine('{"a":', 3)).toEqual({ at: 3, error: expect.stringMatching(/^invalid document: /) });
    expect(parseJsonlLine('[1]', 5)).toEqual({ at: 5, error: 'invalid document: expected a document like { field: 1 }' });
  });
});

describe('parseJsonArray', () => {
  it('reports each element by index, each revived on its own', () => {
    expect(parseJsonArray('﻿[{"a":1}, 2, {"d":{"$date":"nope"}}, {"b":{"$numberLong":"5"}}]')).toEqual([
      { at: 0, doc: { a: 1 } },
      { at: 1, error: 'invalid document: expected a document like { field: 1 }' },
      { at: 2, error: expect.stringMatching(/invalid \$date/) },
      { at: 3, doc: { b: expect.anything() } },
    ]);
    expect(parseJsonArray('[]')).toEqual([]);
  });

  it('refuses invalid JSON and a top level that is not an array', () => {
    expect(() => parseJsonArray('[{"a":1},')).toThrow(/^invalid JSON array: /);
    expect(() => parseJsonArray('{"a":1}')).toThrow('expected a JSON array of documents');
  });
});

describe('recordFailure', () => {
  it('lists the first failures and only counts the rest', () => {
    const report = emptyReport('f.json', 'json');
    expect(report).toEqual({ fileName: 'f.json', format: 'json', inserted: 0, failed: 0, errors: [], errorsTruncated: false, cancelled: false });
    for (let i = 0; i < MAX_REPORTED_ERRORS; i++) recordFailure(report, i, `e${i}`);
    expect(report.errors).toHaveLength(50);
    expect(report.errors[49]).toEqual({ at: 49, message: 'e49' });
    expect(report.errorsTruncated).toBe(false);
    recordFailure(report, 50, 'e50');
    expect(report.failed).toBe(51);
    expect(report.errors).toHaveLength(50);
    expect(report.errorsTruncated).toBe(true);
  });
});
