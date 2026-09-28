import { describe, it, expect } from 'vitest';
import { tokenizeJson } from '../../src/utils/jsonHighlight';

function kinds(json: string) {
  return tokenizeJson(json).map((t) => t.kind);
}

describe('tokenizeJson', () => {
  it('tokenizes an empty object', () => {
    expect(tokenizeJson('{}')).toEqual([
      { kind: 'punct', text: '{' },
      { kind: 'punct', text: '}' },
    ]);
  });

  it('tokenizes an empty array', () => {
    expect(tokenizeJson('[]')).toEqual([
      { kind: 'punct', text: '[' },
      { kind: 'punct', text: ']' },
    ]);
  });

  it('classifies an object property name as a key, and its string value as a string', () => {
    expect(tokenizeJson('{"a":"b"}')).toEqual([
      { kind: 'punct', text: '{' },
      { kind: 'key', text: '"a"' },
      { kind: 'punct', text: ':' },
      { kind: 'string', text: '"b"' },
      { kind: 'punct', text: '}' },
    ]);
  });

  it('classifies a bare top-level string as a string, not a key', () => {
    expect(tokenizeJson('"hello"')).toEqual([{ kind: 'string', text: '"hello"' }]);
  });

  it('classifies a string array element as a string, not a key, even with whitespace before the next comma', () => {
    expect(kinds('["a" , "b"]')).toEqual(['punct', 'string', 'punct', 'punct', 'punct', 'string', 'punct']);
  });

  it('a key is still a key across whitespace before its colon', () => {
    expect(tokenizeJson('{"a"   :1}').map((t) => t.kind)).toEqual([
      'punct',
      'key',
      'punct',
      'punct',
      'punct',
      'punct',
      'number',
      'punct',
    ]);
  });

  it('reads numbers, including negative, decimal, and exponent forms', () => {
    const json = '[-1, 2.5, 1e10, -3.2e-8]';
    const numberTexts = tokenizeJson(json)
      .filter((t) => t.kind === 'number')
      .map((t) => t.text);
    expect(numberTexts).toEqual(['-1', '2.5', '1e10', '-3.2e-8']);
  });

  it('reads true/false/null as their own kinds', () => {
    expect(tokenizeJson('[true,false,null]').filter((t) => t.kind !== 'punct')).toEqual([
      { kind: 'boolean', text: 'true' },
      { kind: 'boolean', text: 'false' },
      { kind: 'null', text: 'null' },
    ]);
  });

  it('keeps an escaped quote inside a string from ending it early', () => {
    const json = '"a\\"b"';
    expect(tokenizeJson(json)).toEqual([{ kind: 'string', text: json }]);
  });

  it('keeps an escaped backslash from consuming the following quote as an escape target', () => {
    // `"a\\"` is a two-char string "a\" (a, then an escaped backslash) — the
    // closing quote must still end the string, not be swallowed as part of
    // a (nonexistent) backslash-quote escape.
    const json = '"a\\\\"';
    expect(tokenizeJson(json)).toEqual([{ kind: 'string', text: json }]);
  });

  it('does not throw on an unterminated string, and reads to the end', () => {
    expect(tokenizeJson('"unterminated')).toEqual([{ kind: 'string', text: '"unterminated' }]);
  });

  it('does not throw on a trailing escape with nothing after it', () => {
    expect(tokenizeJson('"a\\')).toEqual([{ kind: 'string', text: '"a\\' }]);
  });

  it('emits each whitespace character as its own punct token', () => {
    expect(tokenizeJson(' \t\n')).toEqual([
      { kind: 'punct', text: ' ' },
      { kind: 'punct', text: '\t' },
      { kind: 'punct', text: '\n' },
    ]);
  });

  it('falls back to a single-char punct token for a stray unrecognized character', () => {
    expect(tokenizeJson('a')).toEqual([{ kind: 'punct', text: 'a' }]);
  });

  it('reads a truncated literal via the alpha-fallback, not the exact-match branch', () => {
    // "tru" is not "true", so readLiteral falls into its alpha-scan fallback.
    expect(tokenizeJson('tru')).toEqual([{ kind: 'boolean', text: 'tru' }]);
  });

  // readLiteral is handed 'true' or 'false' based on which character (t/f)
  // triggered it. Both compare-words are exact-match against the SAME
  // lowercase-alpha run, so a wrong-word mutant is normally masked (the
  // fallback scan still recovers the right substring). Trailing lowercase
  // letters right after the literal break that masking: an exact match stops
  // right at the literal's own length, while a forced mismatch falls through
  // to the greedy alpha scan and swallows the trailing letters too, merging
  // what should be two tokens into one.
  it('stops exactly at "true", leaving trailing lowercase letters as their own token', () => {
    expect(tokenizeJson('truefoo')).toEqual([
      { kind: 'boolean', text: 'true' },
      { kind: 'boolean', text: 'foo' },
    ]);
  });

  it('stops exactly at "false", leaving trailing lowercase letters as their own tokens', () => {
    expect(tokenizeJson('falsebar')).toEqual([
      { kind: 'boolean', text: 'false' },
      { kind: 'punct', text: 'b' },
      { kind: 'punct', text: 'a' },
      { kind: 'punct', text: 'r' },
    ]);
  });

  // readLiteral's alpha-scan fallback must stop the instant it hits a
  // non-alpha character, not keep consuming past it. With `i < len` — not
  // `<` swapped for `||` — the loop needs BOTH "still in bounds" and "still
  // alpha" to continue; a digit run right after a truncated literal is what
  // exposes an `||` that would keep it going regardless of the alpha test.
  it('the alpha-scan fallback stops at the first non-alpha character, not at the string\'s end', () => {
    expect(tokenizeJson('tru123')).toEqual([
      { kind: 'boolean', text: 'tru' },
      { kind: 'number', text: '123' },
    ]);
  });

  // Nothing precedes the very first token, so `expectValue`'s initial value
  // is what a leading string is classified against.
  it('the first token, if a string, is still classified by lookahead — a leading key is still a key', () => {
    expect(tokenizeJson('"a":1').map((t) => t.kind)).toEqual(['key', 'punct', 'number']);
  });

  it('a string immediately after another string value (no comma) reads as a key again', () => {
    expect(tokenizeJson('{"a":"b""c":"d"}').map((t) => t.kind)).toEqual([
      'punct', 'key', 'punct', 'string', 'key', 'punct', 'string', 'punct',
    ]);
  });

  it('concatenating every token\'s text reproduces the input exactly', () => {
    const json = '{"a": [1, 2.5, -3e2, true, false, null, "x\\"y", {"nested":"v"}]}';
    expect(tokenizeJson(json).map((t) => t.text).join('')).toBe(json);
  });

  // `expectValue` is the only state carried between tokens: a colon sets it,
  // a value token clears it, and a value string's own classification reads
  // it rather than always doing the colon lookahead. Each case below is
  // shaped so a delimiter (`,`, `}`, `]`) never sits between the two tokens
  // that matter — a comma or brace resets `expectValue` on its own, which
  // would otherwise mask a mutant on the value token's own reset.
  describe('expectValue tracking across tokens', () => {
    it('a colon value string is always a string, even when immediately followed by another colon', () => {
      // Malformed (no real JSON has two colons for one key), but the
      // tokenizer does not validate — it isolates the colon->string edge.
      expect(tokenizeJson('{"a":"b":2}').map((t) => t.kind)).toEqual([
        'punct', 'key', 'punct', 'string', 'punct', 'number', 'punct',
      ]);
    });

    it('a second key is still a key after a string value, across a comma', () => {
      expect(tokenizeJson('{"a":"b","c":"d"}').map((t) => t.kind)).toEqual([
        'punct', 'key', 'punct', 'string', 'punct', 'key', 'punct', 'string', 'punct',
      ]);
    });

    it('a string immediately after a number value (no comma) reads as a key again', () => {
      expect(tokenizeJson('{"a":1"b":2}').map((t) => t.kind)).toEqual([
        'punct', 'key', 'punct', 'number', 'key', 'punct', 'number', 'punct',
      ]);
    });

    it('a string immediately after a boolean value (no comma) reads as a key again', () => {
      expect(tokenizeJson('{"a":true"b":2}').map((t) => t.kind)).toEqual([
        'punct', 'key', 'punct', 'boolean', 'key', 'punct', 'number', 'punct',
      ]);
    });

    it('a string immediately after a null value (no comma) reads as a key again', () => {
      expect(tokenizeJson('{"a":null"b":2}').map((t) => t.kind)).toEqual([
        'punct', 'key', 'punct', 'null', 'key', 'punct', 'number', 'punct',
      ]);
    });
  });
});
