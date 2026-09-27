import { describe, expect, it } from 'vitest';
import {
  decodeKey,
  editAddress,
  firstArraySegment,
  isUnderSegments,
  keyOf,
  purgeCollapsedUnder,
  purgeUnder,
  rekeyAfterRemoval,
  rekeyMapAfterRemoval,
  rekeySetAfterRemoval,
} from '../../src/pages/Workspace/editorRowKeys';

describe('keyOf / decodeKey', () => {
  it('round-trips segments, including ones with dots and quotes', () => {
    const segments = ['a.b', 'say "hi"', '0'];
    expect(decodeKey(keyOf(segments))).toEqual(segments);
  });

  it('refuses text that is not JSON', () => {
    expect(decodeKey('not json')).toBeNull();
  });

  it('refuses JSON that is not an array', () => {
    expect(decodeKey('{"a":1}')).toBeNull();
  });

  it('refuses an array holding anything but strings', () => {
    expect(decodeKey('["a",1]')).toBeNull();
  });

  it('accepts an empty array', () => {
    expect(decodeKey('[]')).toEqual([]);
  });
});

describe('isUnderSegments', () => {
  it('is true for the prefix itself and anything nested under it', () => {
    expect(isUnderSegments(keyOf(['a']), ['a'])).toBe(true);
    expect(isUnderSegments(keyOf(['a', 'b']), ['a'])).toBe(true);
  });

  it('is false for a sibling, a shorter key, or a key that is not ours', () => {
    expect(isUnderSegments(keyOf(['b']), ['a'])).toBe(false);
    expect(isUnderSegments(keyOf(['a']), ['a', 'b'])).toBe(false);
    expect(isUnderSegments('garbage', ['a'])).toBe(false);
  });

  it('needs every prefix segment to match, not just one', () => {
    expect(isUnderSegments(keyOf(['a', 'c']), ['a', 'b'])).toBe(false);
    expect(isUnderSegments(keyOf(['c', 'b']), ['a', 'b'])).toBe(false);
  });

  it('compares whole segments, never a string prefix', () => {
    expect(isUnderSegments(keyOf(['ab']), ['a'])).toBe(false);
  });
});

describe('purgeUnder / purgeCollapsedUnder', () => {
  const keys = [keyOf(['a']), keyOf(['a', 'x']), keyOf(['b'])];

  it('drops the path and its subtree from a map, keeping the rest, without mutating the input', () => {
    const m = new Map(keys.map((k) => [k, k]));
    const next = purgeUnder(m, ['a']);
    expect([...next.keys()]).toEqual([keyOf(['b'])]);
    expect(m.size).toBe(3);
  });

  it('does the same for a set', () => {
    const s = new Set(keys);
    const next = purgeCollapsedUnder(s, ['a']);
    expect([...next]).toEqual([keyOf(['b'])]);
    expect(s.size).toBe(3);
  });
});

describe('rekeyAfterRemoval', () => {
  const removed = ['arr', '1'];

  it('drops the removed element itself and anything under it', () => {
    expect(rekeyAfterRemoval(keyOf(['arr', '1']), removed)).toBeNull();
    expect(rekeyAfterRemoval(keyOf(['arr', '1', 'name']), removed)).toBeNull();
  });

  it('moves a later sibling, and anything under it, down one index', () => {
    expect(rekeyAfterRemoval(keyOf(['arr', '2']), removed)).toBe(keyOf(['arr', '1']));
    expect(rekeyAfterRemoval(keyOf(['arr', '12', 'x']), removed)).toBe(keyOf(['arr', '11', 'x']));
  });

  it('leaves an earlier sibling where it is', () => {
    expect(rekeyAfterRemoval(keyOf(['arr', '0']), removed)).toBe(keyOf(['arr', '0']));
  });

  it('leaves the array itself and anything outside it alone', () => {
    expect(rekeyAfterRemoval(keyOf(['arr']), removed)).toBe(keyOf(['arr']));
    expect(rekeyAfterRemoval(keyOf(['other', '2']), removed)).toBe(keyOf(['other', '2']));
    expect(rekeyAfterRemoval(keyOf(['arrr', '2']), removed)).toBe(keyOf(['arrr', '2']));
  });

  it('leaves a key that is not ours, or whose segment at that depth is not an index, alone', () => {
    expect(rekeyAfterRemoval('garbage', removed)).toBe('garbage');
    expect(rekeyAfterRemoval(keyOf(['arr', 'x']), removed)).toBe(keyOf(['arr', 'x']));
  });

  it('works for an element of a nested array, leaving the outer indices untouched', () => {
    const inner = ['m', '3', '0'];
    expect(rekeyAfterRemoval(keyOf(['m', '3', '1']), inner)).toBe(keyOf(['m', '3', '0']));
    expect(rekeyAfterRemoval(keyOf(['m', '4', '1']), inner)).toBe(keyOf(['m', '4', '1']));
  });

  it('leaves a non-index sibling alone even when the removed element is the first', () => {
    expect(rekeyAfterRemoval(keyOf(['arr', 'x']), ['arr', '0'])).toBe(keyOf(['arr', 'x']));
  });

  it('works for a top-level removal', () => {
    expect(rekeyAfterRemoval(keyOf(['5']), ['2'])).toBe(keyOf(['4']));
  });

  it('changes nothing when the removed path does not end in an index', () => {
    expect(rekeyAfterRemoval(keyOf(['arr', '2']), ['arr', 'x'])).toBe(keyOf(['arr', '2']));
    expect(rekeyAfterRemoval(keyOf(['arr', '2']), [])).toBe(keyOf(['arr', '2']));
  });
});

describe('rekeyMapAfterRemoval / rekeySetAfterRemoval', () => {
  it('re-keys every entry of a map, dropping the removed element, and keeps the values', () => {
    const m = new Map([
      [keyOf(['arr', '0']), 'zero'],
      [keyOf(['arr', '1']), 'one'],
      [keyOf(['arr', '2']), 'two'],
    ]);
    expect([...rekeyMapAfterRemoval(m, ['arr', '1'])]).toEqual([
      [keyOf(['arr', '0']), 'zero'],
      [keyOf(['arr', '1']), 'two'],
    ]);
  });

  it('re-keys every entry of a set, dropping the removed element', () => {
    const s = new Set([keyOf(['arr', '0']), keyOf(['arr', '2'])]);
    expect([...rekeySetAfterRemoval(s, ['arr', '0'])]).toEqual([keyOf(['arr', '1'])]);
  });
});

describe('firstArraySegment', () => {
  const draft = { a: { b: [{ c: 1 }] }, s: 'x' };

  it('is the position of the first segment that indexes into an array', () => {
    expect(firstArraySegment(draft, ['a', 'b', '0', 'c'])).toBe(2);
  });

  it('is -1 for the array row itself and for a path with no array on it', () => {
    expect(firstArraySegment(draft, ['a', 'b'])).toBe(-1);
    expect(firstArraySegment(draft, ['a'])).toBe(-1);
  });

  it('is -1 once the path runs through a scalar or off the document', () => {
    expect(firstArraySegment(draft, ['s', '0'])).toBe(-1);
    expect(firstArraySegment(draft, ['missing', '0'])).toBe(-1);
  });

  it('is 0 when the draft itself is an array', () => {
    expect(firstArraySegment([1] as unknown as Record<string, unknown>, ['0'])).toBe(0);
  });
});

describe('editAddress', () => {
  const draft = { a: { b: [{ c: 1 }] }, x: { 'd.e': { f: 1 } } };

  it('is the dotted path when nothing on it is unsafe or an array element', () => {
    expect(editAddress(draft, ['a', 'b'])).toBe('a.b');
  });

  it('stops at the array for anything under one', () => {
    expect(editAddress(draft, ['a', 'b', '0', 'c'])).toBe('a.b');
  });

  it('stops before the first unsafe name', () => {
    expect(editAddress(draft, ['x', 'd.e', 'f'])).toBe('x');
    expect(editAddress(draft, ['x', '$f'])).toBe('x');
  });

  it('takes whichever cut comes first when both apply', () => {
    const both = { a: [{ 'd.e': 1 }], 'u.v': [1] };
    expect(editAddress(both, ['a', '0', 'd.e'])).toBe('a');
    expect(editAddress(both, ['u.v', '0'])).toBe('u.v.0');
  });

  it('falls back to the whole path when the unsafe name is at the top', () => {
    expect(editAddress(draft, ['d.e'])).toBe('d.e');
  });
});
