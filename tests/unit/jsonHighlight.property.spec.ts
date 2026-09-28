import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { tokenizeJson } from '../../src/utils/jsonHighlight';

// Any JSON value fast-check can build, run through JSON.stringify the same
// way the JSON view does (with and without indentation) — nested
// objects/arrays, escapes, unicode, and numbers with exponents all included.
const jsonValue = fc.jsonValue();

describe('tokenizeJson (property)', () => {
  it('concatenating every token\'s text reproduces the input exactly, for any JSON.stringify output', () => {
    fc.assert(
      fc.property(jsonValue, fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }), (value, indent) => {
        const json = JSON.stringify(value, null, indent);
        const rebuilt = tokenizeJson(json)
          .map((t) => t.text)
          .join('');
        expect(rebuilt).toBe(json);
      }),
    );
  });

  it('classifies every object property name as a key and every string value as a string', () => {
    // Restrict to object/record values so every string in the output is
    // either a property name or a value — no bare top-level string case here.
    const record = fc.dictionary(fc.string(), jsonValue, { minKeys: 1 });
    fc.assert(
      fc.property(record, (obj) => {
        const json = JSON.stringify(obj);
        const tokens = tokenizeJson(json);
        // Re-derive, from the same source text, which quoted spans are keys
        // (immediately followed, modulo whitespace, by a colon) — an
        // independent check on the token stream itself, not a re-run of the
        // tokenizer's own classification logic.
        let i = 0;
        for (const t of tokens) {
          if (t.kind === 'key' || t.kind === 'string') {
            let j = i + t.text.length;
            while (j < json.length && /\s/.test(json[j])) j++;
            const isKeyPosition = json[j] === ':';
            expect(t.kind).toBe(isKeyPosition ? 'key' : 'string');
          }
          i += t.text.length;
        }
      }),
    );
  });
});
