import { describe, it, expect } from 'vitest';
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { promoteNumbers } from '../../electron/script-runner/rpcCodec';

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
