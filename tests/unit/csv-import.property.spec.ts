import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseCsv } from '../../electron/mongo/csvImport';
import { csvEscape } from '../../src/pages/Workspace/exportFormat';

// Biased toward the characters that force quoting, so most runs exercise the
// quoted-field branches rather than plain text.
const cell = fc.oneof(
  fc.string(),
  fc.array(fc.constantFrom('a', ' ', ',', '"', '\r', '\n', 'é', '\u{1F600}'), { maxLength: 8 }).map((cs) => cs.join('')),
);

// What round-trips: rows of one width. Two shapes are left out because the
// CSV text itself can't tell them apart from something else — a one-column
// row holding '' is a blank line, which a trailing line break can't express
// either; and a first cell starting with U+FEFF reads as a BOM.
const table = fc
  .integer({ min: 1, max: 5 })
  .chain((width) => fc.array(fc.array(cell, { minLength: width, maxLength: width }), { maxLength: 6 }))
  .filter((rows) => rows.every((r) => !(r.length === 1 && r[0] === '')))
  .filter((rows) => !rows[0]?.[0]?.startsWith('﻿'));

const serialize = (rows: string[][]) => rows.map((r) => r.map(csvEscape).join(',')).join('\n');

describe('parseCsv — property', () => {
  it('reads back the rows csvEscape wrote', () => {
    fc.assert(fc.property(table, (rows) => {
      expect(parseCsv(serialize(rows))).toEqual(rows);
    }), { numRuns: 500 });
  });

  it('reads the same rows with CRLF line breaks and a trailing one', () => {
    fc.assert(fc.property(table, (rows) => {
      const text = rows.map((r) => `${r.map(csvEscape).join(',')}\r\n`).join('');
      expect(parseCsv(text)).toEqual(rows);
    }), { numRuns: 300 });
  });
});
