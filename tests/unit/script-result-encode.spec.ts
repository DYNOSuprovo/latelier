import { describe, it, expect } from 'vitest';
import { ObjectId } from 'bson';
import { SystemError } from '../../electron/errors';
import { encodeResultJson, MAX_SCRIPT_RESULT_BYTES } from '../../electron/script-runner/encodeResult';

describe('encodeResultJson', () => {
  it('encodes primitives as plain JSON', () => {
    expect(encodeResultJson(42, false)).toBe('42');
    expect(encodeResultJson('hi', false)).toBe('"hi"');
    expect(encodeResultJson(true, false)).toBe('true');
    expect(encodeResultJson(null, false)).toBe('null');
  });

  it('wraps BSON types canonically, or relaxed when asked', () => {
    const oid = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    expect(encodeResultJson({ _id: oid, n: 1 }, false)).toBe('{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"},"n":{"$numberInt":"1"}}');
    expect(encodeResultJson({ n: 1 }, true)).toBe('{"n":1}');
  });

  it('encodes arrays element by element, preserving order and commas', () => {
    expect(encodeResultJson([], false)).toBe('[]');
    expect(encodeResultJson([{ a: 1 }, { a: 2 }, 'x'], true)).toBe('[{"a":1},{"a":2},"x"]');
  });

  // A cycle cannot be serialized; functions and symbols are simply dropped.
  const cyclic = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.self = c;
    return c;
  };

  it('collapses a value that cannot be encoded to null', () => {
    expect(encodeResultJson(cyclic(), false)).toBe('null');
  });

  it('collapses an array holding an unencodable element to null', () => {
    expect(encodeResultJson([{ a: 1 }, cyclic()], false)).toBe('null');
  });

  it('refuses an oversized primitive', () => {
    const big = 'x'.repeat(MAX_SCRIPT_RESULT_BYTES);
    let caught: unknown;
    try {
      encodeResultJson(big, false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SystemError);
    expect((caught as SystemError).code).toBe('INTERNAL');
    expect((caught as SystemError).message).toMatch(/byte cap/);
  });

  it('refuses an oversized array and keeps the cap error out of the null fallback', () => {
    const chunk = 'x'.repeat(1024 * 1024);
    const arr = Array.from({ length: 52 }, () => chunk);
    let caught: unknown;
    try {
      encodeResultJson(arr, false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SystemError);
    expect((caught as SystemError).code).toBe('INTERNAL');
    expect((caught as SystemError).message).toBe(
      `script result exceeds ${MAX_SCRIPT_RESULT_BYTES} byte cap — refine your script (e.g. add .limit())`,
    );
  });

  it('accepts an array just under the cap and refuses one well over it', () => {
    const under = ['a'.repeat(MAX_SCRIPT_RESULT_BYTES - 100), 'b'];
    expect(JSON.parse(encodeResultJson(under, false))).toHaveLength(2);
    const over = ['a'.repeat(MAX_SCRIPT_RESULT_BYTES), 'b'];
    expect(() => encodeResultJson(over, false)).toThrow(/byte cap/);
  }, 30_000);

  it('accepts a primitive encoding to exactly the cap and refuses one byte more', () => {
    expect(encodeResultJson('x'.repeat(MAX_SCRIPT_RESULT_BYTES - 2), false).length).toBe(MAX_SCRIPT_RESULT_BYTES);
    expect(() => encodeResultJson('x'.repeat(MAX_SCRIPT_RESULT_BYTES - 1), false)).toThrow(/byte cap/);
  });

  it('refuses an oversized object through the object path, not the null fallback', () => {
    const obj = { s: 'x'.repeat(MAX_SCRIPT_RESULT_BYTES) };
    expect(() => encodeResultJson(obj, false)).toThrow(/byte cap/);
  });
});
