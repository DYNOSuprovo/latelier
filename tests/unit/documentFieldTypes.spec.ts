import { describe, it, expect, vi } from 'vitest';
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import {
  SELECTABLE_KINDS,
  TYPE_LABEL,
  convertType,
  kindOf,
  parseAs,
  textOf,
  typeLabel,
  zeroValue,
  type FieldKind,
} from '../../src/pages/Workspace/documentFieldTypes';

describe('kindOf', () => {
  it('names every BSON-adjacent shape', () => {
    expect(kindOf(null)).toBe('null');
    expect(kindOf('x')).toBe('string');
    expect(kindOf(true)).toBe('boolean');
    expect(kindOf(1)).toBe('number');
    expect(kindOf([1, 2])).toBe('array');
    expect(kindOf({ a: 1 })).toBe('object');
    expect(kindOf(Object.create(null))).toBe('object');
    expect(kindOf(new Date(0))).toBe('date');
    expect(kindOf(new Date(Number.NaN))).toBe('other');
    expect(kindOf(new Int32(1))).toBe('int32');
    expect(kindOf(new Double(1))).toBe('double');
    expect(kindOf(Long.fromNumber(1))).toBe('long');
    expect(kindOf(Decimal128.fromString('1'))).toBe('decimal');
    expect(kindOf(new ObjectId())).toBe('objectId');
    expect(kindOf(/x/)).toBe('other');
  });
});

describe('TYPE_LABEL / typeLabel / SELECTABLE_KINDS', () => {
  it('has an exact, spelled-out label for every kind', () => {
    expect(TYPE_LABEL).toEqual({
      string: 'String',
      int32: 'Int32',
      double: 'Double',
      long: 'Int64',
      decimal: 'Decimal128',
      number: 'Number',
      boolean: 'Boolean',
      date: 'Date',
      objectId: 'ObjectId',
      null: 'Null',
      object: 'Object',
      array: 'Array',
    });
  });

  it('labels every non-other kind from TYPE_LABEL', () => {
    for (const [kind, label] of Object.entries(TYPE_LABEL)) {
      expect(typeLabel(kind as FieldKind, undefined)).toBe(label);
    }
  });

  it('labels an unrecognized BSON value by its own tag, or "Value" with none — even for null', () => {
    expect(typeLabel('other', { _bsontype: 'Binary' })).toBe('Binary');
    expect(typeLabel('other', /x/)).toBe('Value');
    expect(typeLabel('other', null)).toBe('Value');
  });

  it('is exactly the type selector\'s advertised vocabulary, in display order', () => {
    expect(SELECTABLE_KINDS).toEqual([
      'string',
      'int32',
      'long',
      'double',
      'decimal',
      'boolean',
      'date',
      'objectId',
      'null',
      'object',
      'array',
    ]);
  });
});

describe('zeroValue', () => {
  it('is the target kind\'s empty/default value, exactly', () => {
    expect(zeroValue('string')).toBe('');
    expect(zeroValue('int32')).toEqual(new Int32(0));
    expect(zeroValue('long')).toEqual(Long.fromNumber(0));
    expect(zeroValue('double')).toEqual(new Double(0));
    expect(zeroValue('decimal')).toEqual(Decimal128.fromString('0'));
    expect(zeroValue('boolean')).toBe(false);
    expect(zeroValue('date')).toEqual(new Date(0));
    expect(zeroValue('objectId')).toEqual(new ObjectId('000000000000000000000000'));
    expect(zeroValue('null')).toBeNull();
    expect(zeroValue('object')).toEqual({});
    expect(zeroValue('array')).toEqual([]);
  });
});

describe('textOf', () => {
  it('renders every kind\'s own text exactly', () => {
    expect(textOf('string', 'hi')).toBe('hi');
    expect(textOf('int32', new Int32(-3))).toBe('-3');
    expect(textOf('int32', new Int32(-2147483648))).toBe('-2147483648');
    // A bare JS number prints as JS does, not as its EJSON sentinel.
    expect(textOf('number', Number.NaN)).toBe('NaN');
    expect(textOf('number', Infinity)).toBe('Infinity');
    expect(textOf('double', new Double(1.5))).toBe('1.5');
    expect(textOf('long', Long.fromString('9007199254740993'))).toBe('9007199254740993');
    expect(textOf('decimal', Decimal128.fromString('1.10'))).toBe('1.10');
    expect(textOf('number', 7)).toBe('7');
    expect(textOf('boolean', true)).toBe('true');
    expect(textOf('boolean', false)).toBe('false');
    expect(textOf('date', new Date(0))).toBe('1970-01-01T00:00:00Z');
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(textOf('objectId', id)).toBe(id.toHexString());
    expect(textOf('array', [1, 'a'])).toBe('[1,"a"]');
    expect(textOf('null', null)).toBe('null');
    expect(textOf('other', 5)).toBe('5');
  });
});

describe('parseAs', () => {
  it('parses string text back unchanged', () => {
    expect(parseAs('string', 'hello')).toEqual({ ok: true, value: 'hello' });
  });

  it.each([
    ['-2147483648', true],
    ['2147483647', true],
    ['-2147483649', false],
    ['2147483648', false],
    ['1.5', false],
    ['abc', false],
    ['', false],
  ])('int32 %s → ok=%s, at exactly its 32-bit boundary', (text, ok) => {
    const result = parseAs('int32', text);
    expect(result.ok).toBe(ok);
    if (ok) expect(result).toEqual({ ok: true, value: new Int32(Number(text)) });
    else expect(result).toEqual({ ok: false, error: 'Enter a whole number between -2147483648 and 2147483647' });
  });

  it('trims surrounding whitespace before parsing a number', () => {
    expect(parseAs('int32', ' 5 ')).toEqual({ ok: true, value: new Int32(5) });
  });

  it.each([
    ['-9223372036854775808', true],
    ['9223372036854775807', true],
    ['-9223372036854775809', false],
    ['9223372036854775808', false],
    ['1.5', false],
  ])('long %s → ok=%s, at exactly its 64-bit boundary', (text, ok) => {
    const result = parseAs('long', text);
    expect(result.ok).toBe(ok);
    if (ok) expect(result).toEqual({ ok: true, value: Long.fromString(text) });
    else expect(result).toEqual({ ok: false, error: 'Enter a whole number that fits in 64 bits' });
  });

  it.each([
    ['double', '1.5', { ok: true, value: new Double(1.5) }],
    ['double', '', { ok: false, error: 'Enter a number' }],
    ['double', 'abc', { ok: false, error: 'Enter a number' }],
    ['number', '1.5', { ok: true, value: 1.5 }],
    ['number', 'abc', { ok: false, error: 'Enter a number' }],
  ] as const)('%s %s parses to its own JS shape', (kind, text, expected) => {
    expect(parseAs(kind, text)).toEqual(expected);
  });

  it('parses a decimal, and reports the library\'s own message on bad text', () => {
    expect(parseAs('decimal', '1.10')).toEqual({ ok: true, value: Decimal128.fromString('1.10') });
    const bad = parseAs('decimal', 'not a decimal');
    expect(bad.ok).toBe(false);
  });

  it('falls back to a generic decimal message when the thrown value is not an Error', () => {
    const spy = vi.spyOn(Decimal128, 'fromString').mockImplementation(() => {
      throw 'boom' as unknown as Error;
    });
    expect(parseAs('decimal', 'x')).toEqual({ ok: false, error: 'Enter a decimal number' });
    spy.mockRestore();
  });

  it('requires a zone on a date, and reports the exact hint', () => {
    expect(parseAs('date', '2026-09-24T20:31:00Z')).toEqual({ ok: true, value: new Date(Date.parse('2026-09-24T20:31:00Z')) });
    expect(parseAs('date', '2026-09-24T20:31:00')).toEqual({
      ok: false,
      error: 'Enter an ISO-8601 date with a zone, like 2026-09-24T20:31:00Z',
    });
  });

  it('anchors the whole date text — no leading or trailing garbage', () => {
    expect(parseAs('date', 'x2026-09-24T20:31:00Z').ok).toBe(false);
    expect(parseAs('date', '2026-09-24T20:31:00Zx').ok).toBe(false);
  });

  it('accepts a date with a zone offset, without seconds, and with fractional seconds', () => {
    expect(parseAs('date', '2026-09-24T20:31+02:00').ok).toBe(true);
    expect(parseAs('date', '2026-09-24T20:31Z').ok).toBe(true);
    expect(parseAs('date', '2026-09-24T20:31:00.123Z').ok).toBe(true);
  });

  it('refuses a date whose zone offset digits are not both present', () => {
    expect(parseAs('date', '2026-09-24T20:31:00+2:00').ok).toBe(false);
    expect(parseAs('date', '2026-09-24T20:31:00+02:0').ok).toBe(false);
    expect(parseAs('date', '2026-09-24T20:31:00Q').ok).toBe(false);
  });

  it('refuses a date whose seconds are present without two digits, or with a non-digit fraction', () => {
    expect(parseAs('date', '2026-09-24T20:31:0Z').ok).toBe(false);
    expect(parseAs('date', '2026-09-24T20:31:00.aZ').ok).toBe(false);
  });

  it('requires exactly 24 hex characters for an ObjectId, anchored both ends', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(parseAs('objectId', id.toHexString())).toEqual({ ok: true, value: id });
    expect(parseAs('objectId', '507f1f77bcf86cd79943901')).toEqual({ ok: false, error: 'Enter 24 hexadecimal characters' });
    expect(parseAs('objectId', '507f1f77bcf86cd799439011x')).toEqual({ ok: false, error: 'Enter 24 hexadecimal characters' });
    expect(parseAs('objectId', 'x507f1f77bcf86cd799439011')).toEqual({ ok: false, error: 'Enter 24 hexadecimal characters' });
    expect(parseAs('objectId', '507f1f77bcf86cd79943901g')).toEqual({ ok: false, error: 'Enter 24 hexadecimal characters' });
  });

  it('parses true/false case-insensitively and refuses anything else', () => {
    expect(parseAs('boolean', 'TRUE')).toEqual({ ok: true, value: true });
    expect(parseAs('boolean', 'false')).toEqual({ ok: true, value: false });
    expect(parseAs('boolean', 'yes')).toEqual({ ok: false, error: 'Enter true or false' });
  });

  it('refuses a kind with no typed input of its own — a container row has none', () => {
    expect(parseAs('object', 'x')).toEqual({ ok: false, error: 'This type is not editable here' });
    expect(parseAs('array', 'x')).toEqual({ ok: false, error: 'This type is not editable here' });
    expect(parseAs('other', 'x')).toEqual({ ok: false, error: 'This type is not editable here' });
  });
});

describe('convertType', () => {
  it('is a no-op between the same kind', () => {
    const v = new Int32(5);
    expect(convertType('int32', 'int32', v)).toBe(v);
  });

  it('always succeeds converting into null, discarding the source', () => {
    expect(convertType('string', 'null', 'x')).toBeNull();
    expect(convertType('object', 'null', { a: 1 })).toBeNull();
  });

  it('opens at the target zero value when converting from null', () => {
    expect(convertType('null', 'string', null)).toBe('');
    expect(convertType('null', 'int32', null)).toEqual(new Int32(0));
    expect(convertType('null', 'boolean', null)).toBe(false);
  });

  it('widens Int32 to Double losslessly', () => {
    expect(convertType('int32', 'double', new Int32(1))).toEqual(new Double(1));
  });

  it('clears a fractional Double converting to Int32', () => {
    expect(convertType('double', 'int32', new Double(1.5))).toEqual(new Int32(0));
  });

  it('clears a Long that would lose precision as a Double', () => {
    const big = Long.fromString('9007199254740993');
    expect(convertType('long', 'double', big)).toEqual(new Double(0));
  });

  it('converts a numeric string to its numeric kind, and clears on non-numeric text', () => {
    expect(convertType('string', 'int32', '42')).toEqual(new Int32(42));
    expect(convertType('string', 'int32', 'abc')).toEqual(new Int32(0));
  });

  it('stringifies a number, a date and an ObjectId losslessly', () => {
    expect(convertType('int32', 'string', new Int32(7))).toBe('7');
    expect(convertType('date', 'string', new Date(0))).toBe('1970-01-01T00:00:00Z');
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(convertType('objectId', 'string', id)).toBe(id.toHexString());
  });

  it.each([
    ['object', 'string', { a: 1 }, ''],
    ['array', 'string', [1], ''],
    ['other', 'string', /x/, ''],
  ] as const)('clears converting %s to %s, never printing the source', (from, to, value, expected) => {
    expect(convertType(from, to, value)).toBe(expected);
  });

  it.each(['string', 'int32', 'boolean', 'date', 'null'] as const)(
    'always opens object/array at their own zero value, from %s',
    (from) => {
      const sample = from === 'string' ? 'x' : from === 'int32' ? new Int32(1) : from === 'boolean' ? true : from === 'date' ? new Date(0) : null;
      expect(convertType(from, 'object', sample)).toEqual({});
      expect(convertType(from, 'array', sample)).toEqual([]);
    },
  );

  it('clears an unrecognized BSON value converting to anything', () => {
    expect(convertType('other', 'string', /x/)).toBe('');
  });

  it('produces a value of the target kind for every source kind, for every target', () => {
    const samples: Array<{ kind: Parameters<typeof convertType>[0]; value: unknown }> = [
      { kind: 'string', value: 'hi' },
      { kind: 'int32', value: new Int32(3) },
      { kind: 'long', value: Long.fromNumber(3) },
      { kind: 'double', value: new Double(3.5) },
      { kind: 'decimal', value: Decimal128.fromString('3.5') },
      { kind: 'boolean', value: true },
      { kind: 'date', value: new Date(0) },
      { kind: 'objectId', value: new ObjectId() },
      { kind: 'null', value: null },
      { kind: 'object', value: { a: 1 } },
      { kind: 'array', value: [1] },
      { kind: 'other', value: /x/ },
      { kind: 'number', value: 3 },
    ];
    const targets = SELECTABLE_KINDS;
    for (const { kind, value } of samples) {
      for (const target of targets) {
        expect(kindOf(convertType(kind, target, value))).toBe(target);
      }
    }
  });
});
