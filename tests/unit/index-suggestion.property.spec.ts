import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { suggestIndex } from '../../src/utils/indexSuggestion';

const fieldName = fc
  .stringMatching(/^[a-z][a-z0-9]{0,7}$/)
  .filter((s) => s.length > 0);

// Equality/range predicates only — $or/$text/$where/$expr/$regex live in
// their own dedicated test below, since a mix would make "any filter with
// $or gives null" untestable in isolation (the filter would already be
// null for other reasons).
const predicateValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.record({ $eq: fc.integer() }),
  fc.record({ $in: fc.array(fc.integer(), { maxLength: 3 }) }),
  fc.record({ $gt: fc.integer() }),
  fc.record({ $gte: fc.integer() }),
  fc.record({ $lt: fc.integer() }),
  fc.record({ $lte: fc.integer() }),
  fc.record({ $ne: fc.integer() }),
  fc.record({ $nin: fc.array(fc.integer(), { maxLength: 3 }) }),
  fc.record({ $exists: fc.boolean() }),
);

const filterArb = fc
  .uniqueArray(fieldName, { minLength: 0, maxLength: 5 })
  .chain((fields) =>
    fc.tuple(...fields.map(() => predicateValue)).map(
      (values): Record<string, unknown> =>
        Object.fromEntries(fields.map((f, i) => [f, values[i]])),
    ),
  );

const sortArb = fc
  .uniqueArray(fieldName, { minLength: 0, maxLength: 3 })
  .chain((fields) =>
    fc
      .tuple(...fields.map(() => fc.constantFrom<1 | -1>(1, -1)))
      .map(
        (dirs): Record<string, 1 | -1> =>
          Object.fromEntries(fields.map((f, i) => [f, dirs[i]])),
      ),
  );

const NE_LIKE = new Set(['$ne', '$nin', '$exists']);

describe('suggestIndex properties', () => {
  it('never places a field twice', () => {
    fc.assert(
      fc.property(filterArb, sortArb, (filter, sort) => {
        const result = suggestIndex(filter, sort);
        if (result === null) return;
        const fields = result.keys.map((k) => k.field);
        expect(new Set(fields).size).toBe(fields.length);
      }),
    );
  });

  it('every key field occurs in the filter or the sort document', () => {
    fc.assert(
      fc.property(filterArb, sortArb, (filter, sort) => {
        const result = suggestIndex(filter, sort);
        if (result === null) return;
        for (const { field } of result.keys) {
          expect(field in filter || field in sort).toBe(true);
        }
      }),
    );
  });

  it('preserves sort directions verbatim for fields not already placed by equality', () => {
    fc.assert(
      fc.property(filterArb, sortArb, (filter, sort) => {
        const result = suggestIndex(filter, sort);
        if (result === null) return;
        for (const [field, direction] of Object.entries(sort)) {
          const key = result.keys.find((k) => k.field === field);
          const eqValue = filter[field];
          const isFilterEquality =
            eqValue !== undefined &&
            !(
              typeof eqValue === 'object' &&
              eqValue !== null &&
              Object.keys(eqValue as object).some((k) => NE_LIKE.has(k))
            ) &&
            (typeof eqValue !== 'object' ||
              eqValue === null ||
              '$eq' in (eqValue as object) ||
              '$in' in (eqValue as object));
          if (isFilterEquality) continue; // equality wins, direction not obligated
          if (key) expect(key.direction).toBe(direction);
        }
      }),
    );
  });

  it('a field predicated only by $ne/$nin/$exists is never a key', () => {
    fc.assert(
      fc.property(filterArb, sortArb, (filter, sort) => {
        const result = suggestIndex(filter, sort);
        if (result === null) return;
        for (const [field, value] of Object.entries(filter)) {
          if (field in sort) continue; // sort can still place it
          const isNeLike =
            typeof value === 'object' &&
            value !== null &&
            Object.keys(value as object).length === 1 &&
            Object.keys(value as object).some((k) => NE_LIKE.has(k));
          if (!isNeLike) continue;
          expect(result.keys.some((k) => k.field === field)).toBe(false);
        }
      }),
    );
  });

  it('any filter containing a top-level or nested $or gives null', () => {
    const orClause = fc.record({ $or: fc.array(fc.record({ a: fc.integer() }), { minLength: 1, maxLength: 2 }) });
    fc.assert(
      fc.property(filterArb, orClause, (filter, or) => {
        // $or nested one level under $and — exercises "nested anywhere", not just top level.
        const nested = { $and: [filter, or] };
        expect(suggestIndex(nested)).toBeNull();
        expect(suggestIndex({ ...filter, ...or })).toBeNull();
      }),
    );
  });
});
