import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { csvCellValue, csvEscape, neutralizeFormula, serializeCsv } from '../../src/pages/Workspace/exportFormat';

/**
 * Reverses `csvEscape` for a single standalone field — not a general CSV
 * parser (no multi-column awareness needed here). If the text is wrapped in
 * `"…"`, strip the wrapper and undouble embedded quotes; otherwise it is
 * exactly what `csvEscape` was given.
 */
function unescapeOne(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text;
}

describe('csvEscape (property)', () => {
  it('round-trips any string through escape -> unescape', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(unescapeOne(csvEscape(s))).toBe(s);
      }),
    );
  });

  it('quotes exactly when the field contains a comma, quote, or newline/CR — and leaves everything else untouched', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const escaped = csvEscape(s);
        const needsQuoting = /[",\r\n]/.test(s);
        if (needsQuoting) {
          expect(escaped[0]).toBe('"');
          expect(escaped[escaped.length - 1]).toBe('"');
        } else {
          expect(escaped).toBe(s);
        }
      }),
    );
  });
});

describe('serializeCsv (property)', () => {
  it('every row has exactly as many comma-joined top-level fields as columns, for single-column output', () => {
    // Single column avoids re-deriving a full CSV parser in the test: with
    // one column, an escaped cell's own embedded commas are the only ones on
    // the line, so "no bare unescaped comma" is exactly "one field".
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (values) => {
        const docs = values.map((v) => ({ a: v }));
        const csv = serializeCsv(docs, [{ header: 'a', path: 'a' }]);
        const lines = csv.split('\n');
        // header + one line per doc + trailing empty string from the final \n
        expect(lines.length).toBe(docs.length + 2);
        expect(lines[0]).toBe('a');
        expect(lines[lines.length - 1]).toBe('');
        for (let i = 0; i < values.length; i++) {
          expect(unescapeOne(lines[i + 1]!)).toBe(neutralizeFormula(csvCellValue(values[i]), values[i]));
        }
      }),
    );
  });
});
