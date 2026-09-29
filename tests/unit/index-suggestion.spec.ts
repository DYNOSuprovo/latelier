import { describe, it, expect } from 'vitest';
import { BSONRegExp } from 'bson';
import { suggestIndex } from '../../src/utils/indexSuggestion';

describe('suggestIndex', () => {
  it('equality only', () => {
    expect(suggestIndex({ status: 'active' })).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('equality then sort', () => {
    expect(suggestIndex({ status: 'active' }, { createdAt: -1 })).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'createdAt', direction: -1 },
      ],
      reason: "Equality on `status`, then sort on `createdAt` — MongoDB's ESR order.",
    });
  });

  it('full ESR', () => {
    expect(
      suggestIndex({ status: 'active', amount: { $gt: 10 } }, { createdAt: 1 }),
    ).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'createdAt', direction: 1 },
        { field: 'amount', direction: 1 },
      ],
      reason:
        "Equality on `status`, then sort on `createdAt`, then range on `amount` — MongoDB's ESR order.",
    });
  });

  it('{a:1,b:-1} sort kept as-is', () => {
    expect(suggestIndex({}, { a: 1, b: -1 })).toEqual({
      keys: [
        { field: 'a', direction: 1 },
        { field: 'b', direction: -1 },
      ],
      reason: "Sort on `a`, `b` — MongoDB's ESR order.",
    });
  });

  it('$in as equality', () => {
    expect(suggestIndex({ tag: { $in: ['a', 'b'] } })).toEqual({
      keys: [{ field: 'tag', direction: 1 }],
      reason: "Equality on `tag` — MongoDB's ESR order.",
    });
  });

  it('range last, even when it appears first in the filter', () => {
    expect(suggestIndex({ amount: { $gte: 10 }, status: 'active' })).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'amount', direction: 1 },
      ],
      reason: "Equality on `status`, then range on `amount` — MongoDB's ESR order.",
    });
  });

  it('$ne excluded', () => {
    expect(suggestIndex({ status: { $ne: 'archived' } })).toBeNull();
  });

  it('$nin excluded', () => {
    expect(suggestIndex({ status: { $nin: ['a', 'b'] } })).toBeNull();
  });

  it('no duplicates: a field in both filter equality and sort keys once, as equality', () => {
    expect(suggestIndex({ status: 'active' }, { status: 1, createdAt: 1 })).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'createdAt', direction: 1 },
      ],
      reason: "Equality on `status`, then sort on `createdAt` — MongoDB's ESR order.",
    });
  });

  it('$and flattened', () => {
    expect(
      suggestIndex({ $and: [{ status: 'active' }, { amount: { $gt: 10 } }] }),
    ).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'amount', direction: 1 },
      ],
      reason: "Equality on `status`, then range on `amount` — MongoDB's ESR order.",
    });
  });

  it('refuses a top-level $or', () => {
    expect(suggestIndex({ $or: [{ a: 1 }, { b: 2 }] })).toBeNull();
  });

  it('refuses a top-level $nor', () => {
    expect(suggestIndex({ $nor: [{ a: 1 }, { b: 2 }] })).toBeNull();
  });

  it('refuses an $or nested under $and', () => {
    expect(
      suggestIndex({ $and: [{ status: 'active' }, { $or: [{ a: 1 }, { b: 2 }] }] }),
    ).toBeNull();
  });

  it('refuses on the RAW filter, not the flattened one — an $and branch cannot erase an earlier branch\'s refusal by overwriting the same field', () => {
    // Flattening merges same-named $and branches with Object.assign (later
    // branch wins), so `name` ends up `'x'` in the flattened result — but
    // the filter as written still has an unanchored $regex on `name`, and
    // that has to refuse regardless of what a later branch does to the key.
    expect(
      suggestIndex({ $and: [{ name: { $regex: 'abc' } }, { name: 'x' }] }),
    ).toBeNull();
  });

  it('refuses a $nor nested under $and — flattening promotes it to top level first', () => {
    // "A top-level $and is flattened and processing continues" reads as
    // flatten-then-check: once flattened, this $nor IS a top-level key,
    // same as if it had been written at the filter's own top level.
    expect(
      suggestIndex({ $and: [{ status: 'active' }, { $nor: [{ a: 1 }, { b: 2 }] }] }),
    ).toBeNull();
  });

  it('refuses an unanchored $regex (plain-object form)', () => {
    expect(suggestIndex({ name: { $regex: 'abc' } })).toBeNull();
  });

  it('refuses an unanchored $regex (BSONRegExp)', () => {
    expect(suggestIndex({ name: new BSONRegExp('abc', '') })).toBeNull();
  });

  it('refuses $text', () => {
    expect(suggestIndex({ $text: { $search: 'abc' } })).toBeNull();
  });

  it('refuses $where', () => {
    expect(suggestIndex({ $where: 'this.a === 1' })).toBeNull();
  });

  it('refuses $expr', () => {
    expect(suggestIndex({ $expr: { $gt: ['$a', '$b'] } })).toBeNull();
  });

  it('refuses an empty filter with no sort', () => {
    expect(suggestIndex({})).toBeNull();
  });

  it('an anchored ^ regex is allowed and classed as range (plain-object form)', () => {
    expect(suggestIndex({ name: { $regex: '^abc' } })).toEqual({
      keys: [{ field: 'name', direction: 1 }],
      reason: "Range on `name` — MongoDB's ESR order.",
    });
  });

  it('an anchored ^ regex is allowed and classed as range (BSONRegExp)', () => {
    expect(suggestIndex({ name: new BSONRegExp('^abc', '') })).toEqual({
      keys: [{ field: 'name', direction: 1 }],
      reason: "Range on `name` — MongoDB's ESR order.",
    });
  });

  it('excludes fields keyed only by operators W16 §4.1 does not mention', () => {
    expect(
      suggestIndex({
        a: { $exists: true },
        b: { $type: 'string' },
        c: { $size: 3 },
        d: { $elemMatch: { x: 1 } },
        e: { $all: [1, 2] },
        f: { $mod: [4, 0] },
        g: { $geoWithin: { $centerSphere: [[0, 0], 1] } },
        status: 'active',
      }),
    ).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('reason names only the classes actually used', () => {
    const eqOnly = suggestIndex({ status: 'active' });
    expect(eqOnly?.reason).not.toContain('sort');
    expect(eqOnly?.reason).not.toContain('range');

    const sortOnly = suggestIndex({}, { createdAt: 1 });
    expect(sortOnly?.reason).not.toContain('Equality');
    expect(sortOnly?.reason).not.toContain('range');

    const rangeOnly = suggestIndex({ amount: { $gt: 10 } });
    expect(rangeOnly?.reason).not.toContain('Equality');
    expect(rangeOnly?.reason).not.toContain('sort');
  });

  it('explicit $eq is equality, same as a bare scalar', () => {
    expect(suggestIndex({ status: { $eq: 'active' } })).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('$lt is a range operator', () => {
    expect(suggestIndex({ amount: { $lt: 100 } })).toEqual({
      keys: [{ field: 'amount', direction: 1 }],
      reason: "Range on `amount` — MongoDB's ESR order.",
    });
  });

  it('$lte is a range operator', () => {
    expect(suggestIndex({ amount: { $lte: 100 } })).toEqual({
      keys: [{ field: 'amount', direction: 1 }],
      reason: "Range on `amount` — MongoDB's ESR order.",
    });
  });

  it('a field is still classed as range when only one of its several operators is a range op', () => {
    // .some, not .every — an unrecognized sibling operator doesn't disqualify the field.
    expect(suggestIndex({ amount: { $gt: 10, $comment: 'x' } as Record<string, unknown> })).toEqual({
      keys: [{ field: 'amount', direction: 1 }],
      reason: "Range on `amount` — MongoDB's ESR order.",
    });
  });

  it('refuses $or/$nor/$text/$where/$expr even alongside an otherwise-valid field', () => {
    // Each combined with a real equality field, so a wrongly-permissive
    // refusal check can't hide behind "the filter has no keys anyway".
    expect(suggestIndex({ status: 'active', $or: [{ a: 1 }, { b: 2 }] })).toBeNull();
    expect(suggestIndex({ status: 'active', $nor: [{ a: 1 }, { b: 2 }] })).toBeNull();
    expect(suggestIndex({ status: 'active', $text: { $search: 'x' } })).toBeNull();
    expect(suggestIndex({ status: 'active', $where: 'this.a === 1' })).toBeNull();
    expect(suggestIndex({ status: 'active', $expr: { $gt: ['$a', '$b'] } })).toBeNull();
  });

  it('a $nor nested under a plain field (not the filter\'s own top level) is not a refusal', () => {
    // Pins hasRefusal's topLevel=false on the object-value recursion path
    // (as opposed to the array-element path, covered separately below):
    // only a $nor that is a direct key of the filter itself refuses.
    expect(
      suggestIndex({ status: 'active', wrapper: { $nor: [{ a: 1 }] } }),
    ).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('refuses when only one of several array elements is a refusal (.some, not .every)', () => {
    expect(
      suggestIndex({ status: 'active', list: [{ ok: 1 }, { $or: [{ a: 1 }] }] }),
    ).toBeNull();
  });

  it('a $nor nested inside an array value is not a refusal', () => {
    // Pins hasRefusal's topLevel=false on the array-element recursion path.
    expect(
      suggestIndex({ status: 'active', list: [{ $nor: [{ a: 1 }] }] }),
    ).toEqual({
      keys: [
        { field: 'status', direction: 1 },
        { field: 'list', direction: 1 },
      ],
      reason: "Equality on `status`, `list` — MongoDB's ESR order.",
    });
  });

  it('a field placed by sort is not duplicated as a range key', () => {
    expect(suggestIndex({ amount: { $gt: 5 } }, { amount: 1 })).toEqual({
      keys: [{ field: 'amount', direction: 1 }],
      reason: "Sort on `amount` — MongoDB's ESR order.",
    });
  });

  it('a stray top-level operator that is not a refusal and not $and is ignored, not classed as a field', () => {
    expect(suggestIndex({ $comment: 'hi', status: 'active' } as Record<string, unknown>)).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('a non-array $and value is left alone rather than iterated', () => {
    expect(() => suggestIndex({ $and: 5, status: 'active' } as Record<string, unknown>)).not.toThrow();
    expect(suggestIndex({ $and: 5, status: 'active' } as Record<string, unknown>)).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('a non-document $and branch is skipped, not merged', () => {
    expect(suggestIndex({ $and: [{ status: 'active' }, 'oops'] } as Record<string, unknown>)).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('a $regex with a non-string value is neither a refusal nor a regex predicate', () => {
    expect(
      suggestIndex({ name: { $regex: 123 } as unknown as Record<string, unknown>, status: 'active' }),
    ).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });

  it('a null field value is equality, not a crash from probing it for $regex', () => {
    expect(suggestIndex({ tag: null, status: 'active' } as Record<string, unknown>)).toEqual({
      keys: [
        { field: 'tag', direction: 1 },
        { field: 'status', direction: 1 },
      ],
      reason: "Equality on `tag`, `status` — MongoDB's ESR order.",
    });
  });

  it('a sort direction other than ±1 gets no prefill for that field', () => {
    expect(
      suggestIndex({ status: 'active' }, { createdAt: 0 as unknown as 1 }),
    ).toEqual({
      keys: [{ field: 'status', direction: 1 }],
      reason: "Equality on `status` — MongoDB's ESR order.",
    });
  });
});
