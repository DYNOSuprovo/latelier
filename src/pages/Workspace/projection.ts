// Formatting / parsing for the Fields control's projection input. Lives
// outside FieldsControl.tsx so the helpers can be unit-tested without
// bundling React, and so that module stays single-export-component for
// fast-refresh.

import { ejsonParse, isEjsonDocument } from '../../utils/ejson';
import type { BuilderState } from '@shared/types';

export function formatProjection(projection: string[]): string {
  if (projection.length === 0) return '';
  return `{ ${projection.map((f) => `${f}: 1`).join(', ')} }`;
}

// Why a projection was refused. The two causes call for different user
// actions, so the Fields control can say which one happened (W14 §3):
//   - 'malformed'   — the text isn't a projection at all; fix the text.
//   - 'unmodelable' — a real projection BuilderState can't express (an
//                     exclusion, `$slice`). That is no longer a
//                     dead end: `isRawProjection` below decides whether the
//                     same text can go to the driver verbatim instead.
export type ProjectionFailure = 'malformed' | 'unmodelable';

export type ProjectionParse =
  | { ok: true; fields: string[] }
  | { ok: false; reason: ProjectionFailure };

// Accepts strict JSON `{"a":1,"b":1}`, mongo-shell `{a: 1, b: 1}`, or bare
// comma lists `a, b, c`. Refuses — rather than parsing lossily — anything
// with an explicit non-inclusion value (e.g. `{a: 0}`, `{a: false}`,
// `$slice`), so the caller keeps the user's draft text instead of silently
// dropping fields. BuilderState.projection only models inclusions.
export function parseProjection(text: string): ProjectionParse {
  // Blank needs no early return: `JSON.parse('')` throws, and the lenient
  // path below strips it to nothing and answers "no projection".
  const t = text.trim();
  try {
    const obj = JSON.parse(t) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const fields: string[] = [];
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        // Valid JSON, so whatever the value is it was typed deliberately —
        // 0 / false / {$slice} are projections we can't model, not typos.
        if (v !== 1 && v !== true) return { ok: false, reason: 'unmodelable' };
        fields.push(k);
      }
      return { ok: true, fields };
    }
  } catch {
    // Fall through to lenient parsing.
  }
  // Stryker disable next-line MethodExpression: dropping this .trim() is unobservable — `t` is already outer-trimmed, so the only string shaped "{" + whitespace + "}" is valid empty-object JSON handled above, and every per-field token gets its own .trim() in the split loop below (fuzzed 200k random {}/whitespace/field strings against both versions with zero diffs)
  const stripped = t.replace(/^\{|\}$/g, '').trim();
  if (!stripped) return { ok: true, fields: [] };
  const fields: string[] = [];
  for (const part of stripped.split(',')) {
    const [rawK, rawV] = part.split(':').map((s) => s.trim());
    if (!rawK) continue;
    const k = rawK.replace(/^["']|["']$/g, '');
    if (rawV === undefined || rawV === '1' || rawV === 'true') {
      fields.push(k);
    } else if (rawV === '') {
      // `{a: }` — a colon with nothing after it is a half-typed field, not a
      // projection this editor can't model.
      return { ok: false, reason: 'malformed' };
    } else {
      return { ok: false, reason: 'unmodelable' };
    }
  }
  // Nothing survived (`,,,`): not a field list by any reading.
  return fields.length > 0 ? { ok: true, fields } : { ok: false, reason: 'malformed' };
}

/**
 * W15 §2.1/§2.2 — can this text be a `builder.projectionRaw`?
 *
 * The escape hatch for everything the inclusion model refuses: `{"_id": 0}`,
 * `$slice`, mixed documents. The bar is exactly the filter's — it must parse
 * as an EJSON *document* — so the two raw fields have one rule between them
 * rather than two, and a raw projection is never stored in a state the driver
 * would reject. Arrays and scalars are out: `find` takes a document.
 *
 * "One rule between them" is now literal — the shape test was lifted into
 * `isEjsonDocument`, which `sortProblem` calls too.
 */
export function isRawProjection(text: string): boolean {
  return isEjsonDocument(text);
}

// `0`, `false`, or a boxed numeric zero (`{"$numberInt": "0"}` revives to an
// Int32) — the values that drop a field. A plain object's `valueOf` is itself,
// and a null-prototype one is not an `Object` instance, so neither matches.
function isExclusion(v: unknown): boolean {
  return v === false || ((typeof v === 'number' || v instanceof Object) && v.valueOf() === 0);
}

// `{a: {$slice: n}}` trims an array but decides nothing about which fields
// come back, so it counts toward neither mode.
function isSliceOnly(v: unknown): boolean {
  // A primitive has no own keys, so only `null` needs keeping away from
  // `Object.keys`, which throws on it.
  // Stryker disable next-line ArrayDeclaration: the null branch's array content only matters through `keys[0] === '$slice'` below, and no mutant literal is ever the string '$slice'
  const keys = v === null ? [] : Object.keys(v as object);
  return keys.length === 1 && keys[0] === '$slice';
}

/**
 * Which top-level fields the committed projection keeps the server from
 * returning, so the Fields control can name them "not fetched" instead of
 * letting them vanish from the list.
 *
 * `known` is every top-level name the caller can vouch for without asking
 * the server. An inclusion projection names what comes back, so its
 * complement is only as complete as `known`; an exclusion names what does
 * not, so its own top-level keys are reported whether or not `known` has
 * them. A dotted exclusion (`"a.b": 0`) trims inside `a` and never drops
 * `a` itself. A raw projection the app cannot read reports nothing —
 * `projectionProblem` is what speaks for that one.
 */
export function notFetchedFields(builder: BuilderState, known: readonly string[]): string[] {
  const raw = builder.projectionRaw?.trim();
  if (raw && !isRawProjection(raw)) return [];
  // No projection at all is an empty modelled list, which falls through to
  // the exclusion branch with nothing excluded. The modelled path's `_id: 1`
  // (`compileFindOptions` sends it) needs no entry: the inclusion branch
  // keeps `_id` unless it is excluded.
  const entries: [string, unknown][] = raw
    ? Object.entries(ejsonParse<Record<string, unknown>>(raw))
    : builder.projection.map((f): [string, unknown] => [f, 1]);
  const excluded = entries.filter(([, v]) => isExclusion(v)).map(([k]) => k);
  const included = entries.filter(([, v]) => !isExclusion(v) && !isSliceOnly(v)).map(([k]) => k);
  const inclusion = included.some((k) => k !== '_id') || (included.length > 0 && excluded.length === 0);
  if (inclusion) {
    const fetched = new Set(entries.filter(([, v]) => !isExclusion(v)).map(([k]) => k.split('.')[0]));
    if (!excluded.includes('_id')) fetched.add('_id');
    return known.filter((f) => !fetched.has(f));
  }
  const dropped = excluded.filter((k) => !k.includes('.'));
  return [...known.filter((f) => dropped.includes(f)), ...dropped.filter((k) => !known.includes(k))];
}
