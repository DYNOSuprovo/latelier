import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { applyDiff, buildUpdateRequest, diff, isEmptyDiff } from '../../src/pages/Workspace/documentDiff';
import { ejsonStringify } from '../../src/utils/ejson';

type Doc = Record<string, unknown>;

// Small key pools so an original and a draft share keys often enough to
// exercise changed, nested and removed paths, not only adds. Nested levels
// include names no update path can address; the top level does not, because
// `buildUpdateRequest` refuses those and the round trip is not defined there.
const topKey = fc.constantFrom('a', 'b', 'c', 'n', '__proto__');
const nestedKey = fc.constantFrom('a', 'b', 'x.y', '$d', '', '__proto__');

const leaf = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.boolean(),
  fc.constant(null),
  fc.integer({ min: -3, max: 3 }).map((n) => new Int32(n)),
  fc.integer({ min: -3, max: 3 }).map((n) => new Double(n)),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((n) => Long.fromString(n.toString())),
  fc.constantFrom('1.10', '1.1', '-0').map((s) => Decimal128.fromString(s)),
  fc.constantFrom('507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012').map((h) => new ObjectId(h)),
  fc.integer({ min: 0, max: 2 }).map((ms) => new Date(ms)),
);

/** Null-prototype and `defineProperty`, as `ejsonParse` builds them, so `__proto__` is an ordinary key. */
function docOf(entries: [string, unknown][]): Doc {
  const out = Object.create(null) as Doc;
  for (const [k, v] of entries) {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const entriesOf = (key: fc.Arbitrary<string>, value: fc.Arbitrary<unknown>) =>
  fc.uniqueArray(fc.tuple(key, value), { selector: ([k]) => k, maxLength: 4 });

const { value } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('value'), { maxLength: 3 }),
    entriesOf(nestedKey, tie('value')).map(docOf),
  ),
}));

const ID = new ObjectId('507f1f77bcf86cd799439099');
const topDoc = entriesOf(topKey, value).map((entries) => docOf([['_id', ID], ...entries]));

/** Same content, any key order: recursively sorted canonical EJSON. */
function canonical(v: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== 'object') return node;
    const keys = Object.keys(node).sort((x, y) => x.localeCompare(y));
    return docOf(keys.map((k) => [k, sort((node as Doc)[k])]));
  };
  return JSON.stringify(sort(JSON.parse(ejsonStringify(v))));
}

/** A draft that shares structure with `base`: `patch` overrides, recursing into shared sub-documents. */
function overlay(base: unknown, patch: unknown): unknown {
  const isDoc = (x: unknown): x is Doc => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === null;
  if (!isDoc(base) || !isDoc(patch)) return patch;
  return docOf([
    ...Object.keys(base).filter((k) => !(k in patch)).map((k): [string, unknown] => [k, base[k]]),
    ...Object.keys(patch).map((k): [string, unknown] => [k, k in base ? overlay(base[k], patch[k]) : patch[k]]),
  ]);
}

const pair = fc.oneof(
  fc.tuple(topDoc, topDoc),
  fc.tuple(topDoc, topDoc).map(([base, patch]) => [base, overlay(base, patch) as Doc] as const),
);

describe('documentDiff — properties', () => {
  it('applying the diff to the original yields the draft, ignoring key order', () => {
    fc.assert(
      fc.property(pair, ([original, draft]) => {
        expect(canonical(applyDiff(original, diff(original, draft)))).toBe(canonical(draft));
      }),
    );
  });

  it('diff(x, x) is empty, and so no request is built', () => {
    fc.assert(
      fc.property(topDoc, (doc) => {
        expect(isEmptyDiff(diff(doc, doc))).toBe(true);
        expect(buildUpdateRequest(doc, doc)).toBeNull();
      }),
    );
  });

  it('no emitted path is a prefix of another, so the server never sees a path conflict', () => {
    fc.assert(
      fc.property(pair, ([original, draft]) => {
        const d = diff(original, draft);
        const paths = [...Object.keys(d.set), ...d.unset];
        for (const p of paths) {
          for (const q of paths) {
            if (p !== q) expect(q.startsWith(`${p}.`)).toBe(false);
          }
        }
        expect(new Set(paths).size).toBe(paths.length);
      }),
    );
  });

  it('the filter holds _id plus exactly one guard per changed path', () => {
    fc.assert(
      fc.property(pair, ([original, draft]) => {
        const req = buildUpdateRequest(original, draft);
        const d = diff(original, draft);
        if (req === null) {
          expect(isEmptyDiff(d)).toBe(true);
          return;
        }
        const filterKeys = Object.keys(JSON.parse(req.filterJson) as Doc);
        expect(filterKeys.sort((x, y) => x.localeCompare(y))).toEqual(
          ['_id', ...Object.keys(d.set), ...d.unset].sort((x, y) => x.localeCompare(y)),
        );
      }),
    );
  });
});
