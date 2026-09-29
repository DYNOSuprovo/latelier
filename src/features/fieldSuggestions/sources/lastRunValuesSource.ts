import { toDisplayValue } from '../../../utils/displayValue';
import type { ValueSource, ValueSuggestion } from '../types';

const MAX_DOCS = 50;

/** Dotted-path lookup that only descends through plain objects, mirroring `lastRunSource`'s walk. */
function readPath(doc: unknown, segments: string[]): unknown {
  let cur: unknown = doc;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Values a field actually held in the current results (Source 1, X02
 * "Value suggestions"). `value === display`: every suggestion is a plain
 * string, since `CondRow`'s pick just writes `s.display` into the cond's
 * text `value` field — there's no separate wire encoding to carry here, only
 * the human-readable form. Arrays at the leaf expand into one suggestion per
 * element rather than one `[n]` suggestion, since that's what a person
 * typing into an `$in`/`$eq` box actually wants to pick from.
 */
export const lastRunValuesSource: ValueSource = (ctx) => {
  const docs = ctx.recentDocs;
  const field = ctx.target.field.trim();
  if (!docs || docs.length === 0 || !field) return [];
  const segments = field.split('.');
  const counts = new Map<string, number>();
  for (const doc of docs.slice(0, MAX_DOCS)) {
    const leaf = readPath(doc, segments);
    if (leaf === undefined) continue;
    const values = Array.isArray(leaf) ? leaf : [leaf];
    for (const v of values) {
      const dv = toDisplayValue(v);
      // Objects, arrays-of-arrays and undefined have no single scalar text a
      // cond's `value` field could hold — skip rather than suggest garbage.
      if (dv.type === 'object' || dv.type === 'array' || dv.type === 'undefined') continue;
      counts.set(dv.display, (counts.get(dv.display) ?? 0) + 1);
    }
  }
  const out: ValueSuggestion[] = [];
  for (const [display, frequency] of counts) {
    out.push({ kind: 'value', value: display, display, source: 'lastRun', frequency });
  }
  return out;
};
