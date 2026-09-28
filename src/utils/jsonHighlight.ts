const NUMBER_CHAR_RE = /[0-9eE+\-.]/u;
const LOWER_ALPHA_RE = /[a-z]/u;
const WHITESPACE_RE = /\s/u;

export type TokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * Tiny JSON tokenizer. Returns an array of tokens with semantic kinds.
 * No external dependencies — hand-rolled state machine.
 */
export function tokenizeJson(json: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = json.length;

  // Track whether we just emitted a colon (next string is a value, not a key)
  let expectValue = false;

  function peek(): string {
    // Stryker disable next-line StringLiteral: peek's only call site is guarded by the enclosing `while (i < len)`, so json[i] is never undefined here — the '' fallback is unreachable, and any replacement literal is equally unobservable.
    return json[i] ?? '';
  }

  function readString(): string {
    let s = '"';
    i++; // skip opening "
    while (i < len) {
      const c = json[i];
      s += c;
      if (c === '\\') {
        i++;
        if (i < len) {
          s += json[i];
          i++;
        }
        continue;
      }
      if (c === '"') {
        i++;
        break;
      }
      i++;
    }
    return s;
  }

  function readNumber(): string {
    let s = '';
    while (i < len) {
      const c = json[i];
      if (NUMBER_CHAR_RE.test(c)) {
        s += c;
        i++;
      } else {
        break;
      }
    }
    return s;
  }

  function readLiteral(word: string): string {
    if (json.slice(i, i + word.length) === word) {
      i += word.length;
      return word;
    }
    // Fallback: read until non-alpha
    let s = '';
    // Stryker disable next-line StringLiteral,ConditionalExpression,EqualityOperator: json[i] is only ever undefined once i reaches len, where LOWER_ALPHA_RE.test('') is already false (verified) — so `i < len` collapsing to `true`, or loosening to `i <= len`, or the '' fallback's exact value, can never change where this loop stops. Only the `&&`/`||` choice is observable (see the LogicalOperator test above, "stops exactly at..."), because it changes how the two operands combine mid-string, not just at the boundary.
    while (i < len && LOWER_ALPHA_RE.test(json[i] ?? '')) {
      s += json[i];
      i++;
    }
    return s;
  }

  while (i < len) {
    const c = peek();

    // Whitespace was special-cased here, but it did exactly what the
    // catch-all fallback at the bottom of this loop already does for any
    // unmatched character — push a single-char punct token and advance —
    // so it was dead weight. Removed rather than kept as a no-op branch;
    // a whitespace character still becomes its own punct token, via that
    // fallback.

    // Punctuation
    if ('{}[],'.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i++;
      expectValue = false;
      continue;
    }

    if (c === ':') {
      tokens.push({ kind: 'punct', text: c });
      i++;
      expectValue = true;
      continue;
    }

    // String
    if (c === '"') {
      const raw = readString();
      if (!expectValue) {
        // Check if it's followed by ':' (it's a key)
        let j = i;
        // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: WHITESPACE_RE never matches '' (verified), so the loop always stops the moment json[j] is undefined regardless of the `j < len` bound or the '' fallback's exact value — both are unreachable-different.
        while (j < len && WHITESPACE_RE.test(json[j] ?? '')) j++;
        if (json[j] === ':') {
          tokens.push({ kind: 'key', text: raw });
        } else {
          tokens.push({ kind: 'string', text: raw });
        }
      } else {
        tokens.push({ kind: 'string', text: raw });
        expectValue = false;
      }
      continue;
    }

    // Number
    if (/[-0-9]/u.test(c)) {
      const num = readNumber();
      tokens.push({ kind: 'number', text: num });
      expectValue = false;
      continue;
    }

    // Boolean / null
    if (c === 't' || c === 'f') {
      const word = readLiteral(c === 't' ? 'true' : 'false');
      tokens.push({ kind: 'boolean', text: word });
      expectValue = false;
      continue;
    }

    if (c === 'n') {
      const word = readLiteral('null');
      tokens.push({ kind: 'null', text: word });
      expectValue = false;
      continue;
    }

    // Fallback: emit as punct
    tokens.push({ kind: 'punct', text: c });
    i++;
  }

  return tokens;
}
