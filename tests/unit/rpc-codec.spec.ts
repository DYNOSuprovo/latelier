import { describe, it, expect } from 'vitest';
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { markWideIntegers, promoteNumbers } from '../../electron/script-runner/rpcCodec';

describe('promoteNumbers', () => {
  it('turns an Int32 into the plain number', () => {
    const out = promoteNumbers(new Int32(7), false);
    expect(out).toBe(7);
    expect(typeof out).toBe('number');
  });

  it('turns a Double into the plain number when results ask for it', () => {
    expect(promoteNumbers(new Double(5), false)).toBe(5);
    expect(promoteNumbers(new Double(1.5), false)).toBe(1.5);
    expect(Object.is(promoteNumbers(new Double(-0), false), -0)).toBe(true);
    expect(promoteNumbers(new Double(Number.NaN), false)).toBeNaN();
  });

  it('keeps an integral in-range Double when arguments ask for it', () => {
    const five = new Double(5);
    expect(promoteNumbers(five, true)).toBe(five);
    const low = new Double(-2147483648);
    expect(promoteNumbers(low, true)).toBe(low);
    const high = new Double(2147483647);
    expect(promoteNumbers(high, true)).toBe(high);
  });

  it('unwraps every other Double in arguments', () => {
    expect(promoteNumbers(new Double(1.5), true)).toBe(1.5);
    expect(promoteNumbers(new Double(2147483648), true)).toBe(2147483648);
    expect(promoteNumbers(new Double(-2147483649), true)).toBe(-2147483649);
    expect(promoteNumbers(new Double(Number.POSITIVE_INFINITY), true)).toBe(Number.POSITIVE_INFINITY);
    expect(promoteNumbers(new Double(Number.NaN), true)).toBeNaN();
  });

  it('leaves other BSON values and primitives alone', () => {
    const oid = new ObjectId('64b7f0f5a1b2c3d4e5f60718');
    const long = Long.fromString('9007199254740993');
    const dec = Decimal128.fromString('1.5');
    const bin = new Binary(Buffer.from('ab'));
    const date = new Date(0);
    for (const v of [oid, long, dec, bin, date, 'str', true, null, undefined, 3]) {
      expect(promoteNumbers(v, false)).toBe(v);
      expect(promoteNumbers(v, true)).toBe(v);
    }
  });

  it('walks arrays in place and documents into ordinary objects', () => {
    const arr = [new Int32(1), { a: new Int32(2), b: [new Double(3)] }];
    const out = promoteNumbers(arr, false) as unknown[];
    expect(out).toBe(arr);
    expect(out).toEqual([1, { a: 2, b: [3] }]);

    const proto = Object.create(null) as Record<string, unknown>;
    proto.n = new Int32(4);
    const doc = promoteNumbers(proto, false) as Record<string, unknown>;
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(doc).toEqual({ n: 4 });
    expect(typeof doc.hasOwnProperty).toBe('function');
    // A plain, editable document: the script may well assign to it.
    expect(Object.getOwnPropertyDescriptor(doc, 'n')).toEqual({
      value: 4,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });

  it('keeps a __proto__ field as an own property', () => {
    const src = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>;
    const out = promoteNumbers(src, false) as Record<string, unknown>;
    expect(Object.keys(out).sort((a, b) => a.localeCompare(b))).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { x?: number }).x).toBeUndefined();
  });

  it('does not rebuild an object with its own class', () => {
    class Custom {
      n = new Int32(1);
    }
    const c = new Custom();
    expect(promoteNumbers(c, false)).toBe(c);
    expect(c.n).toBeInstanceOf(Int32);
  });

  it('threads the argument rule down into nested values', () => {
    const d = new Double(9);
    const out = promoteNumbers({ a: [{ b: d }] }, true) as { a: Array<{ b: unknown }> };
    expect(out.a[0]!.b).toBe(d);
  });
});

describe('markWideIntegers', () => {
  it('wraps an integer outside int32 range as a Double, at and past each edge', () => {
    for (const n of [2147483648, -2147483649, 1714000000000, 2 ** 53, 2 ** 60, -(2 ** 40)]) {
      const out = markWideIntegers(n);
      expect(out).toBeInstanceOf(Double);
      expect((out as Double).valueOf()).toBe(n);
    }
  });

  it('leaves int32-range integers, fractions, non-finite numbers and -0 as numbers', () => {
    for (const n of [0, 5, -5, 2147483647, -2147483648, 1.5, -1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = markWideIntegers(n);
      expect(typeof out).toBe('number');
      if (Number.isNaN(n)) expect(out).toBeNaN();
      else expect(out).toBe(n);
    }
    expect(Object.is(markWideIntegers(-0), -0)).toBe(true);
  });

  it('walks arrays and documents, and does not change its input', () => {
    const input = { a: [1714000000000, { b: 3000000000, c: 7 }], d: 'x' };
    const snapshot = JSON.stringify(input);
    const out = markWideIntegers(input) as { a: [Double, { b: Double; c: number }]; d: string };
    expect(out).not.toBe(input);
    expect(out.a[0]).toBeInstanceOf(Double);
    expect(out.a[1].b).toBeInstanceOf(Double);
    expect(out.a[1].c).toBe(7);
    expect(out.d).toBe('x');
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(typeof input.a[0]).toBe('number');
  });

  it('builds ordinary editable documents', () => {
    const out = markWideIntegers({ n: 1 }) as object;
    expect(Object.getOwnPropertyDescriptor(out, 'n')).toEqual({ value: 1, enumerable: true, writable: true, configurable: true });
  });

  it('walks a document from another realm', async () => {
    const vm = await import('node:vm');
    const foreign = vm.runInNewContext('({ t: 1714000000000, nested: { u: [3000000000] } })') as {
      t: number;
      nested: { u: number[] };
    };
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    const out = markWideIntegers(foreign) as { t: unknown; nested: { u: unknown[] } };
    expect(out.t).toBeInstanceOf(Double);
    expect(out.nested.u[0]).toBeInstanceOf(Double);
  });

  it('passes BSON values, dates, binary data and other objects through untouched', () => {
    const long = Long.fromString('9007199254740993');
    const oid = new ObjectId('64b7f0f5a1b2c3d4e5f60718');
    const date = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    const re = /x/;
    const map = new Map([[1, 2]]);
    for (const v of [long, oid, date, bytes, re, map, null, undefined, 'str', true, new Int32(1), new Double(2)]) {
      expect(markWideIntegers(v)).toBe(v);
    }
  });

  it('keeps a __proto__ field as an own property', () => {
    const src = JSON.parse('{"__proto__":{"t":1714000000000}}') as object;
    const out = markWideIntegers(src) as Record<string, { t: unknown }>;
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')!.value.t).toBeInstanceOf(Double);
  });

  it('round-trips with promoteNumbers to the plain number', () => {
    expect(promoteNumbers(markWideIntegers(1714000000000), false)).toBe(1714000000000);
    expect(promoteNumbers(markWideIntegers(1714000000000), true)).toBe(1714000000000);
  });
});
