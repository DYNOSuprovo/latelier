import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128, BSONRegExp, Code, Timestamp, MinKey, MaxKey, BSONSymbol, Int32, Double } from 'bson';
import {
  ejsonParse,
  ejsonStringify,
  ejsonEncode,
  ejsonEncodeArray,
  ejsonEncodeArrayJson,
  ejsonStringifyRelaxed,
  isValidEjson,
  isPlainDocument,
  parseEjsonField,
  parseEjsonDocument,
  DEFAULT_MAX_EJSON_BYTES,
} from '../../electron/mongo/ejson';
import {
  ejsonParse as ejsonParseRenderer,
  isExactSentinel,
  isValidEjson as isValidEjsonRenderer,
  isPlainDocument as isPlainDocumentRenderer,
  isEjsonDocument as isEjsonDocumentRenderer,
  ejsonStringifyReadable,
} from '../../src/utils/ejson';

describe('ejson', () => {
  it('round-trips ObjectId', () => {
    const id = new ObjectId();
    const s = ejsonStringify({ _id: id });
    const back = ejsonParse<{ _id: ObjectId }>(s);
    expect(back._id).toBeInstanceOf(ObjectId);
    expect(back._id.toHexString()).toBe(id.toHexString());
  });

  it('round-trips Date', () => {
    const d = new Date('2026-04-20T12:00:00Z');
    const back = ejsonParse<{ d: Date }>(ejsonStringify({ d }));
    expect(back.d).toBeInstanceOf(Date);
    expect(back.d.toISOString()).toBe(d.toISOString());
  });

  it('round-trips Long and Decimal128', () => {
    const l = Long.fromString('9000000000000000001');
    const dec = Decimal128.fromString('12345.67890');
    const back = ejsonParse<{ l: Long; d: Decimal128 }>(ejsonStringify({ l, d: dec }));
    expect(back.l.toString()).toBe(l.toString());
    expect(back.d.toString()).toBe(dec.toString());
  });

  it('round-trips RegExp via BSONRegExp', () => {
    const r = /^hello$/i;
    const back = ejsonParse<{ r: BSONRegExp }>(ejsonStringify({ r }));
    // Canonical EJSON preserves regex as BSONRegExp, not the native RegExp.
    expect(back.r).toBeInstanceOf(BSONRegExp);
    expect(back.r.pattern).toBe(r.source);
    expect(back.r.options).toContain('i');
  });

  it('ejsonEncode preserves canonical type sentinels', () => {
    const id = new ObjectId();
    const out = ejsonEncode({ _id: id }) as { _id: { $oid: string } };
    expect(out._id.$oid).toBe(id.toHexString());
  });

  it('isValidEjson returns true for valid, false for invalid', () => {
    expect(isValidEjson('{"x":1}')).toBe(true);
    expect(isValidEjson('{ not json')).toBe(false);
  });

  it('round-trips every remaining SENTINEL_SINGLE type', () => {
    const back = ejsonParse<{
      code: Code; ts: Timestamp; mn: MinKey; mx: MaxKey; sym: BSONSymbol; i: Int32; d: Double;
    }>(ejsonStringify({
      code: new Code('function(){}'),
      ts: new Timestamp({ t: 1, i: 1 }),
      mn: new MinKey(),
      mx: new MaxKey(),
      sym: new BSONSymbol('foo'),
      i: new Int32(5),
      d: new Double(5.5),
    }));
    expect(back.code).toBeInstanceOf(Code);
    expect(back.ts).toBeInstanceOf(Timestamp);
    expect(back.mn).toBeInstanceOf(MinKey);
    expect(back.mx).toBeInstanceOf(MaxKey);
    expect(back.sym).toBeInstanceOf(BSONSymbol);
    expect(back.i).toBeInstanceOf(Int32);
    expect(back.i.valueOf()).toBe(5);
    expect(back.d).toBeInstanceOf(Double);
    expect(back.d.valueOf()).toBe(5.5);
  });

  it('a bare $undefined sentinel revives to null, not a plain {$undefined:true} object', () => {
    // bson 7's EJSON.parse revives an isolated $undefined node to `null`.
    // If '$undefined' ever drops out of SENTINEL_SINGLE, walkRevive would
    // instead pass the sentinel through untouched as a plain object.
    const result = ejsonParse('{"a":{"$undefined":true}}') as { a: unknown };
    expect(result.a).toBeNull();
  });

  it('a bare $dbPointer sentinel revives to a DBRef, not a plain object', () => {
    const raw = '{"a":{"$dbPointer":{"$ref":"coll","$id":{"$oid":"507f1f77bcf86cd799439011"}}}}';
    const result = ejsonParse(raw) as { a: unknown };
    expect(isPlainDocument(result.a)).toBe(false);
  });

  it('CodeWithScope: exact {$code,$scope} pair revives to Code (2-key sentinel)', () => {
    const c = new Code('function(){}', { x: 1 });
    const back = ejsonParse<{ c: Code }>(ejsonStringify({ c }));
    expect(back.c).toBeInstanceOf(Code);
    expect(back.c.code).toBe('function(){}');
  });

  it('CodeWithScope: a third sibling key blocks the 2-key sentinel match', () => {
    const raw = '{"$code":"function(){}","$scope":{"x":1},"extra":true}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Code);
    expect(result).toHaveProperty('extra', true);
  });

  it('CodeWithScope: $code without $scope does not match the 2-key sentinel', () => {
    const raw = '{"$code":"function(){}","other":1}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Code);
    expect(result).toHaveProperty('other', 1);
  });

  it('validateRegexPattern: rejection message names the bad pattern and preserves cause', () => {
    try {
      ejsonParse('{"a":{"$regularExpression":{"pattern":"(","options":""}}}');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('(');
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('$binary shape validation lets a non-object $binary value fall through to EJSON.parse', () => {
    // validateBinarySentinel only checks base64/subType on an object value;
    // a non-object value must not raise OUR message, but bson's own parse
    // still rejects the malformed shape.
    expect(() => ejsonParse('{"a":{"$binary":"not-an-object"}}')).toThrow();
    try {
      ejsonParse('{"a":{"$binary":"not-an-object"}}');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/invalid \$binary\.(base64|subType)/);
    }
  });

  it('$binary subType boundary: empty subType is valid (defaults to 0)', () => {
    const raw = '{"a":{"$binary":{"base64":"aGVsbG8=","subType":""}}}';
    expect(() => ejsonParse(raw)).not.toThrow();
  });

  it('$binary subType hex regex is fully anchored, not a substring match', () => {
    // Trailing junk after a valid hex prefix must still be rejected —
    // catches an unanchored `$`.
    expect(() =>
      ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":"1z"}}}'),
    ).toThrow(/subType/);
    // Leading junk before a valid hex suffix must still be rejected —
    // catches an unanchored `^`.
    expect(() =>
      ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":"z1"}}}'),
    ).toThrow(/subType/);
  });

  it('ejsonEncode defaults to canonical (non-relaxed) when relaxed is omitted', () => {
    expect(ejsonEncode(5)).toEqual({ $numberInt: '5' });
  });

  it('ejsonEncode(v, true) produces relaxed output', () => {
    expect(ejsonEncode(5, true)).toBe(5);
  });

  it('ejsonEncodeArrayJson defaults to canonical when relaxed is omitted', () => {
    expect(ejsonEncodeArrayJson([5])).toBe('[{"$numberInt":"5"}]');
  });

  it('ejsonEncodeArrayJson: exact separator and bracket placement across multiple docs', () => {
    expect(ejsonEncodeArrayJson([{ a: 1 }, { b: 2 }])).toBe(
      '[{"a":{"$numberInt":"1"}},{"b":{"$numberInt":"2"}}]',
    );
  });

  it('honours maxBytes at the exact boundary (> not >=)', () => {
    // After fixing #379, the closing ']' is counted, so the boundary is the
    // full output length (in UTF-8 bytes, not JavaScript string length).
    const exact = ejsonEncodeArrayJson([{ a: 1 }]);
    const boundary = Buffer.byteLength(exact, 'utf8');
    expect(() => ejsonEncodeArrayJson([{ a: 1 }], { maxBytes: boundary })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([{ a: 1 }], { maxBytes: boundary - 1 })).toThrow(
      new RegExp(`${boundary - 1} byte cap`),
    );
  });

  it('maxBytes undefined never throws regardless of size', () => {
    const docs = [{ a: 'x'.repeat(10_000) }];
    expect(() => ejsonEncodeArrayJson(docs)).not.toThrow();
  });

  it('a field literally named __proto__ survives the round trip intact', () => {
    // Regression: walkRevive used to rebuild documents via `result[k] = v`
    // on a `{}` literal. When k === '__proto__' and v revives to a BSON
    // object (not a primitive), that assignment doesn't create an own
    // property — it reassigns the object's actual prototype, so the field
    // silently vanished from Object.keys and isPlainDocument misclassified
    // the corrupted result. Found by the fast-check round-trip property.
    // A literal JSON string, not JSON.stringify({__proto__: ...}) — object
    // LITERAL syntax with a `__proto__` key sets the new object's prototype
    // at construction time rather than creating an own property, so that
    // route would lose the key before ejsonParse ever ran.
    const raw = '{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}';
    const back = ejsonParse<Record<string, unknown>>(raw);
    // walkRevive builds documents on a null-prototype object precisely so
    // this key can't collide with the accessor — isPlainDocument treats
    // null-prototype the same as Object.prototype.
    expect(Object.getPrototypeOf(back)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect((back['__proto__'] as ObjectId).toHexString()).toBe('507f1f77bcf86cd799439011');
    expect(isPlainDocument(back)).toBe(true);
  });

  it('DEFAULT_MAX_EJSON_BYTES is exactly 50 MiB', () => {
    expect(DEFAULT_MAX_EJSON_BYTES).toBe(52_428_800);
  });

  it('isPlainDocument treats a null-prototype object as plain', () => {
    expect(isPlainDocument(Object.create(null) as object)).toBe(true);
  });

  it('isPlainDocument treats an ordinary Object.prototype object as plain', () => {
    // walkRevive itself only ever produces null-prototype documents now
    // (see the __proto__ regression above) — this covers the OTHER half of
    // isPlainDocument's own OR, which a caller can still reach directly.
    expect(isPlainDocument({})).toBe(true);
  });

  it('parseEjsonField wraps the underlying parse error, naming the field', () => {
    try {
      parseEjsonField('{ not json', 'filter');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('filter');
      expect((err as { details?: { field?: string } }).details).toEqual({ field: 'filter' });
    }
  });

  it('parseEjsonDocument rejects a non-document with a message naming the field', () => {
    try {
      parseEjsonDocument('[1,2]', 'projection');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('projection');
      expect((err as { details?: { field?: string } }).details).toEqual({ field: 'projection' });
    }
  });

  // ─── Performance regression guard ───────────────────────────────────────
  //
  // `ejsonEncodeArrayJson` is on the hot path for every find / aggregate
  // result that crosses the IPC boundary; a regression here directly
  // translates to "the app feels slow on big result sets". The current
  // implementation is a per-doc `JSON.stringify(ejsonEncode(doc))` loop —
  // the budget is intentionally loose so it doesn't flake under load, but
  // strict enough to catch a 5-10× regression.
  it('encodes 1000 medium docs within a generous timing budget', () => {
    const docs: Array<Record<string, unknown>> = [];
    // ~10 KB per doc — embedded array of small typed values + a string blob.
    const blob = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 1000; i++) {
      docs.push({
        _id: new ObjectId(),
        seq: i,
        createdAt: new Date(2024, 0, 1, 0, 0, i % 60),
        amount: Decimal128.fromString((i / 7).toFixed(4)),
        nested: { tags: ['a', 'b', 'c'], note: blob },
      });
    }
    const t0 = Date.now();
    const out = ejsonEncodeArrayJson(docs);
    const elapsed = Date.now() - t0;
    expect(out.startsWith('[') && out.endsWith(']')).toBe(true);
    // Wall-clock budget: 1000 docs × ~10 KB ≈ 10 MB JSON. Empirically takes
    // ~150-300 ms on a laptop; 1500 ms gives a comfortable CI cushion.
    expect(elapsed).toBeLessThan(1500);
  });

  it('honours maxBytes ceiling and throws SystemError with the INTERNAL code', () => {
    const docs = [{ a: 'x'.repeat(1024) }, { b: 'y'.repeat(1024) }];
    try {
      ejsonEncodeArrayJson(docs, { maxBytes: 100 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/cap/);
      expect((err as { code?: string }).code).toBe('INTERNAL');
    }
  });

  it('ejsonEncodeArrayJson(docs, {relaxed:true}) produces relaxed output, not canonical', () => {
    expect(ejsonEncodeArrayJson([5], { relaxed: true })).toBe('[5]');
  });

  // ─── Byte cap fixes for #379: closing bracket count + UTF-8 bytes ────────
  //
  // The previous implementation had two bugs:
  // 1. Did not count the closing ']', so arrays at maxBytes+1 would pass
  // 2. Used piece.length (UTF-16 code units) instead of UTF-8 byte length

  it('byte cap: empty array [] is exactly 2 bytes, succeeds at maxBytes 2, throws at 1', () => {
    const out = ejsonEncodeArrayJson([], { relaxed: true });
    expect(out).toBe('[]');
    expect(Buffer.byteLength(out, 'utf8')).toBe(2);
    expect(() => ejsonEncodeArrayJson([], { relaxed: true, maxBytes: 2 })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([], { relaxed: true, maxBytes: 1 })).toThrow();
  });

  it('byte cap boundary: output exactly M bytes succeeds at M, throws at M-1', () => {
    // Create an array with docs that produce an exact byte length.
    const out = ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true });
    const M = Buffer.byteLength(out, 'utf8');
    expect(() => ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true, maxBytes: M })).not.toThrow();
    expect(() => ejsonEncodeArrayJson([{ x: 1 }], { relaxed: true, maxBytes: M - 1 })).toThrow(
      new RegExp(`${M - 1} byte cap`),
    );
  });

  it('off-by-one regression: old code did not count closing bracket', () => {
    // Build an array that would pass the old check but should throw now.
    // The old code: bytes = 1 + piece1 + piece2 + ... (no closing ']')
    // We want output length to be exactly maxBytes + 1 if closing bracket was skipped.
    const M = 100;
    const docs = ['a'.repeat(M - 6), 'b']; // -6 for: '[' + '"a...a"' + ',' + '"b"' + ']'
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    const outBytes = Buffer.byteLength(out, 'utf8');
    // If old code didn't count ']', it would pass at maxBytes = outBytes - 1.
    // Our fix should throw at that threshold.
    if (outBytes > M) {
      expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes - 1 })).toThrow();
    }
  });

  it('multi-byte UTF-8: accented characters exceed cap if using UTF-16 length', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes in canonical form.
    // Build a doc that fits UTF-16 but not UTF-8.
    const accent = 'é'.repeat(50); // 50 UTF-16 units = 100 UTF-8 bytes for this char
    const docs = [accent];
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    const outBytes = Buffer.byteLength(out, 'utf8');
    // Should throw at a maxBytes lower than actual size.
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes - 1 })).toThrow();
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes })).not.toThrow();
  });

  it('byte cap accumulates separator commas in UTF-8 bytes', () => {
    // Each comma separator is 1 UTF-8 byte. Make sure it's counted.
    const docs = [1, 2, 3];
    const out = ejsonEncodeArrayJson(docs, { relaxed: true });
    const outBytes = Buffer.byteLength(out, 'utf8');
    // Commas should be included in the byte count.
    expect(out).toContain(',');
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes })).not.toThrow();
    expect(() => ejsonEncodeArrayJson(docs, { relaxed: true, maxBytes: outBytes - 1 })).toThrow();
  });

  it('ejsonEncodeArray maps each doc through ejsonEncode with the same relaxed flag', () => {
    expect(ejsonEncodeArray([5])).toEqual([{ $numberInt: '5' }]);
    expect(ejsonEncodeArray([5], true)).toEqual([5]);
  });

  it('ejsonStringifyRelaxed renders a plain number without a $numberInt wrapper', () => {
    expect(ejsonStringifyRelaxed({ n: 5 })).toBe('{"n":5}');
  });
});

// ─── src/utils/ejson.ts — the renderer's own mirror (not re-exported from
// electron/, so its own gaps need direct coverage) ──────────────────────────
describe('renderer isExactSentinel — shape checks, tested directly', () => {
  it('recognises every SENTINEL_SINGLE key as a sole key', () => {
    for (const key of [
      '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
      '$binary', '$timestamp', '$regularExpression', '$minKey', '$maxKey',
      '$undefined', '$code', '$symbol', '$dbPointer',
    ]) {
      expect(isExactSentinel({ [key]: 'x' })).toBe(true);
    }
  });

  it('CodeWithScope: exact {$code,$scope} pair matches', () => {
    expect(isExactSentinel({ $code: 'f', $scope: {} })).toBe(true);
  });

  it('CodeWithScope: a third key blocks the match', () => {
    expect(isExactSentinel({ $code: 'f', $scope: {}, extra: 1 })).toBe(false);
  });

  it('CodeWithScope: $code without $scope does not match', () => {
    expect(isExactSentinel({ $code: 'f', other: 1 })).toBe(false);
  });

  it('CodeWithScope: $scope without $code does not match', () => {
    expect(isExactSentinel({ $scope: {}, other: 1 })).toBe(false);
  });

  it('an ordinary two-key document is not a sentinel', () => {
    expect(isExactSentinel({ a: 1, b: 2 })).toBe(false);
  });
});

describe('renderer walkRevive — __proto__ field regression', () => {
  it('a field literally named __proto__ survives the round trip intact', () => {
    // A literal JSON string, not JSON.stringify({__proto__: ...}) — see the
    // electron-side test above for why the object-literal route loses it.
    const raw = '{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}';
    const back = ejsonParseRenderer<Record<string, unknown>>(raw);
    // walkRevive builds documents on a null-prototype object precisely so
    // this key can't collide with the accessor — isPlainDocument treats
    // null-prototype the same as Object.prototype.
    expect(Object.getPrototypeOf(back)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect(isPlainDocumentRenderer(back)).toBe(true);
  });

  it('ejsonStringifyReadable preserves a __proto__ field rather than dropping it', () => {
    // Object.defineProperty, not an object literal — `{__proto__: v}` in
    // literal syntax sets the new object's prototype at construction time
    // instead of creating an own property with that name.
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, '__proto__', {
      value: { $oid: '507f1f77bcf86cd799439011' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const text = ejsonStringifyReadable(input);
    // Compare against a value parsed from JSON text, not an object literal
    // with a __proto__ key — same reason as above, on the expectation side.
    expect(JSON.parse(text)).toEqual(JSON.parse('{"__proto__":{"$oid":"507f1f77bcf86cd799439011"}}'));
  });
});

describe('renderer isValidEjson / isPlainDocument', () => {
  it('isValidEjson returns false, not just non-true, for invalid text', () => {
    expect(isValidEjsonRenderer('{ not json')).toBe(false);
  });

  it('isPlainDocument treats a null-prototype object as plain', () => {
    expect(isPlainDocumentRenderer(Object.create(null) as object)).toBe(true);
  });

  it('isPlainDocument treats an ordinary Object.prototype object as plain', () => {
    expect(isPlainDocumentRenderer({})).toBe(true);
  });

  it('isPlainDocument rejects null without crashing on Object.getPrototypeOf', () => {
    // `typeof null === 'object'`, so `!parsed` has to short-circuit the
    // whole check on its own — if it were ANDed instead of ORed with the
    // next clause, `null` would fall through to `Object.getPrototypeOf(null)`,
    // which throws.
    expect(isPlainDocumentRenderer(null)).toBe(false);
    expect(isEjsonDocumentRenderer('null')).toBe(false);
  });
});

describe('renderer ejsonStringifyReadable — isoDate does not crash on a malformed inner $date', () => {
  // These bypass ejsonParse deliberately: a real Date always round-trips to a
  // {$numberLong:"<digits>"} inner shape via bson's own serializer, so these
  // malformed shapes are only reachable if `v` is handed in directly rather
  // than produced by ejsonParse — still a real path, since ejsonStringifyReadable
  // takes an arbitrary value, not only ejsonParse's output.
  it('a null inner $date falls back to the sentinel unchanged, rather than throwing', () => {
    expect(() => ejsonStringifyReadable({ at: { $date: null } })).not.toThrow();
    expect(ejsonStringifyReadable({ at: { $date: null } })).toBe('{"at":{"$date":null}}');
  });

  it('a non-string $numberLong is left wrapped, not coerced', () => {
    // A boolean survives ejsonStringify's own number-canonicalization pass
    // untouched, unlike a raw number (which would get re-wrapped first).
    const text = ejsonStringifyReadable({ at: { $date: { $numberLong: true } } });
    expect(text).toBe('{"at":{"$date":{"$numberLong":true}}}');
  });
});

// ─── Regression tests for greedy EJSON.parse bugs (#2.1, #2.2, #2.3) ───────
// These tests FAIL against the current ejsonParse (EJSON.parse with relaxed:false)
// and PASS once ejsonParse is wired to safeEjsonParse.
describe('safeEjsonParse — strict sentinel revival (REPRO 2.1, 2.2, 2.3)', () => {
  // BUG #2.2 / #2.3: sibling key alongside $date is silently dropped.
  // EJSON.parse collapses {"$date":"…","kept":"x"} to a Date, losing "kept".
  it('object with $date key + sibling key is NOT collapsed — sibling preserved', () => {
    const raw = '{"$date":"2026-01-01T00:00:00Z","kept":"x"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Date);
    expect(result).toHaveProperty('$date', '2026-01-01T00:00:00Z');
    expect(result).toHaveProperty('kept', 'x');
  });

  // BUG #2.1: sibling operator alongside $regex is silently dropped.
  // EJSON.parse collapses {"$regex":"^9","$gte":"93"} to BSONRegExp, losing $gte.
  it('object with $regex key + sibling $gte is NOT collapsed — both operators preserved', () => {
    const raw = '{"$regex":"^9","$gte":"93"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(BSONRegExp);
    expect(result).toHaveProperty('$regex', '^9');
    expect(result).toHaveProperty('$gte', '93');
  });

  // Legacy {$regex, $options} form is deliberately excluded from revival —
  // in a filter it is a query operator, not a document sentinel.
  it('legacy {$regex, $options} two-key form is NOT revived to BSONRegExp', () => {
    const raw = '{"$regex":"^foo","$options":"i"}';
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(BSONRegExp);
    expect(result).toHaveProperty('$regex', '^foo');
    expect(result).toHaveProperty('$options', 'i');
  });

  // Exact single-key sentinels must still revive correctly (no regression).
  it('exact single-key $date sentinel is still revived to Date', () => {
    expect(ejsonParse('{"$date":"2026-01-01T00:00:00Z"}')).toBeInstanceOf(Date);
  });

  it('exact $regularExpression sentinel is still revived to BSONRegExp', () => {
    const result = ejsonParse('{"$regularExpression":{"pattern":"^foo","options":"i"}}');
    expect(result).toBeInstanceOf(BSONRegExp);
    expect((result as BSONRegExp).pattern).toBe('^foo');
  });

  it('nested exact sentinels inside a plain wrapper object are all revived', () => {
    const raw = JSON.stringify({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      ts: { $date: '2026-01-01T00:00:00Z' },
      extra: 42,
    });
    const result = ejsonParse(raw) as Record<string, unknown>;
    expect(result._id).toBeInstanceOf(ObjectId);
    expect(result.ts).toBeInstanceOf(Date);
    expect(result.extra).toBe(42);
  });

  it('sentinels inside arrays are revived', () => {
    const raw = JSON.stringify([{ $oid: '507f1f77bcf86cd799439011' }, 99]);
    const result = ejsonParse(raw) as unknown[];
    expect(result[0]).toBeInstanceOf(ObjectId);
    expect(result[1]).toBe(99);
  });

  // Renderer-side ejsonParse must exhibit the same safe behavior.
  it('renderer ejsonParse: sibling key alongside $date is NOT collapsed', () => {
    const raw = '{"$date":"2026-01-01T00:00:00Z","kept":"x"}';
    const result = ejsonParseRenderer(raw) as Record<string, unknown>;
    expect(result).not.toBeInstanceOf(Date);
    expect(result).toHaveProperty('kept', 'x');
  });

  it('renderer ejsonParse: exact $date sentinel still revives to Date', () => {
    expect(ejsonParseRenderer('{"$date":"2026-01-01T00:00:00Z"}')).toBeInstanceOf(Date);
  });
});

// ─── Bug 1 (HIGH) — invalid $regularExpression pattern must be rejected at ─
// parse time, not silently stored. bson's BSONRegExp constructor never
// compiles `pattern`; the only place it gets compiled is deep inside the
// driver's BSON deserializer on a later read, which throws and bricks reads
// for the whole collection. walkRevive is the one shared choke point every
// filter/doc/docs/update string passes through, so the fix belongs there.
describe('safeEjsonParse — invalid $regularExpression pattern is rejected', () => {
  it('rejects a $regularExpression whose pattern does not compile', () => {
    const raw = '{"a":{"$regularExpression":{"pattern":"(","options":"x"}}}';
    expect(() => ejsonParse(raw)).toThrow();
  });

  it('a bare invalid $regularExpression sentinel is rejected the same way', () => {
    const raw = '{"$regularExpression":{"pattern":"(","options":""}}';
    expect(() => ejsonParse(raw)).toThrow();
  });

  it('a valid $regularExpression pattern still revives to BSONRegExp (no regression)', () => {
    const raw = '{"a":{"$regularExpression":{"pattern":"^valid$","options":"i"}}}';
    const result = ejsonParse(raw) as { a: BSONRegExp };
    expect(result.a).toBeInstanceOf(BSONRegExp);
    expect(result.a.pattern).toBe('^valid$');
  });
});

// ─── Bug 2 (MEDIUM) — malformed $date / $binary content must be rejected, ──
// not silently corrupted. bson's EJSON.parse is lenient: Date.parse('garbage')
// is NaN → Invalid Date → stored as epoch 0; Buffer.from(base64,'base64')
// silently drops invalid characters; parseInt(subType,16) on a non-hex string
// is NaN, masked to 0 by `& 0xff`. Nothing re-validates the revived value's
// CONTENT after the sentinel SHAPE check passes.
describe('safeEjsonParse — malformed $date / $binary content is rejected', () => {
  it('rejects a $date that does not parse to a real instant, naming the value', () => {
    const raw = '{"a":{"$date":"garbage"}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$date value.*garbage/);
  });

  it('a valid $date still round-trips to the correct instant (no regression)', () => {
    const result = ejsonParse('{"a":{"$date":"2026-01-01T00:00:00Z"}}') as { a: Date };
    expect(result.a).toBeInstanceOf(Date);
    expect(result.a.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects $binary with base64 that contains invalid characters, naming the field', () => {
    const raw = '{"a":{"$binary":{"base64":"!!!invalid!!!","subType":"00"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.base64/);
  });

  it('rejects $binary with a subType that is not a valid hex byte, naming the field', () => {
    const raw = '{"a":{"$binary":{"base64":"aGVsbG8=","subType":"zz"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.subType/);
  });

  it('rejects a base64 length that is not a multiple of 4, even with valid characters', () => {
    // BASE64_RE's `{4}` grouping is what catches this — an unanchored-length
    // version would accept any run of base64 characters.
    const raw = '{"a":{"$binary":{"base64":"AAAAA","subType":"00"}}}';
    expect(() => ejsonParse(raw)).toThrow(/invalid \$binary\.base64/);
  });

  it('a $binary value that is null is left for EJSON.parse, not our validator', () => {
    // validateBinarySentinel's null/non-object guard exists so property
    // access on the raw sentinel value (base64/subType) can't itself throw
    // before EJSON.parse gets a chance to raise its own shape error.
    expect(() => ejsonParse('{"a":{"$binary":null}}')).not.toThrow();
  });

  it('a non-string base64 is left for EJSON.parse, not flagged as invalid base64 text', () => {
    expect(() => ejsonParse('{"a":{"$binary":{"base64":123,"subType":"00"}}}')).toThrow();
    try {
      ejsonParse('{"a":{"$binary":{"base64":123,"subType":"00"}}}');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/invalid \$binary\.base64/);
    }
  });

  it('a non-string subType is not flagged as an invalid hex byte (no regression)', () => {
    // The validator only guards the STRING shape of subType; a numeric
    // subType is a separate, already-documented lenient-EJSON.parse quirk.
    expect(() => ejsonParse('{"a":{"$binary":{"base64":"aGVsbG8=","subType":100}}}')).not.toThrow();
  });

  it('a valid $binary still round-trips correctly (no regression)', () => {
    const result = ejsonParse(
      '{"a":{"$binary":{"base64":"aGVsbG8=","subType":"00"}}}',
    ) as { a: { buffer: Uint8Array; sub_type: number } };
    expect(Buffer.from(result.a.buffer).toString('base64')).toBe('aGVsbG8=');
    expect(result.a.sub_type).toBe(0);
  });
});
