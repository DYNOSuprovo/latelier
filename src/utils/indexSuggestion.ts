import { BSONRegExp } from 'bson';
import { isPlainDocument } from './ejson';

export interface IndexKey {
  field: string;
  direction: 1 | -1;
}

export interface IndexSuggestion {
  keys: IndexKey[];
  reason: string;
}

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);

/**
 * Suggests a compound index for a find query, in MongoDB's ESR order
 * (Equality, Sort, Range) — driven by `ExplainDrawer`'s "Create an index for
 * this query" action on a COLLSCAN. Pure: takes the already-parsed filter
 * and sort documents (`ejsonParse` output), not a filterTree node, and never
 * touches the network or a live index.
 *
 * A field placed by an earlier class (Equality, then Sort, then Range) is
 * never repeated by a later one — a field used for both an equality
 * predicate and a sort key is keyed once, as Equality.
 *
 * Returns `null` when the filter can't be turned into a sane single-index
 * suggestion: a top-level `$or`/`$nor`, an `$or` nested anywhere, `$text`/
 * `$where`/`$expr`, an unanchored `$regex`, or a filter that (after `$ne`/
 * `$nin`/unlisted operators are excluded) yields no key at all.
 */
export function suggestIndex(
  filter: Record<string, unknown>,
  sort?: Record<string, 1 | -1>,
): IndexSuggestion | null {
  // `hasRefusal` scans the RAW filter, not the flattened one — flattening
  // merges same-named `$and` branches with `Object.assign` (later branch
  // wins), which would silently drop an earlier branch's `$or`/`$text`/
  // `$where`/`$expr`/unanchored `$regex` before this ever saw it: e.g.
  // `{$and:[{name:{$regex:'abc'}}, {name:'x'}]}` must still refuse even
  // though the flattened `name` is just `'x'`.
  //
  // `$nor` is the one exception, checked separately against `flattened`:
  // "a top-level $and is flattened and processing continues" reads as
  // flatten-then-check, so a `$nor` written inside a top-level `$and`
  // branch refuses too, the same as if it had been written at the filter's
  // own top level. `Object.assign` can't lose a `$nor` refusal the way it
  // can lose the others above — a `$nor` key survives the merge untouched,
  // it just isn't at the position `hasRefusal`'s own top-level check
  // would find it at, since that runs on `filter`, not `flattened`.
  if (hasRefusal(filter)) return null;
  const flattened = flattenAnd(filter);
  if ('$nor' in flattened) return null;

  const equality: string[] = [];
  const filterRange: string[] = [];
  for (const [field, value] of Object.entries(flattened)) {
    if (field.startsWith('$')) continue; // a stray top-level operator; not a field predicate
    const cls = classifyFilterField(value);
    if (cls === 'equality') equality.push(field);
    else if (cls === 'range') filterRange.push(field);
  }

  const placed = new Set(equality);
  const sortKeys: IndexKey[] = [];
  for (const [field, direction] of Object.entries(sort ?? {})) {
    if (placed.has(field) || (direction !== 1 && direction !== -1)) continue;
    placed.add(field);
    sortKeys.push({ field, direction });
  }

  // No `placed.add` here (unlike the sort loop above): `filterRange` is
  // built from `Object.entries`, so its fields are already unique, and
  // nothing reads `placed` after this loop.
  const rangeKeys: IndexKey[] = [];
  for (const field of filterRange) {
    if (placed.has(field)) continue;
    rangeKeys.push({ field, direction: 1 });
  }

  const keys: IndexKey[] = [
    ...equality.map((field): IndexKey => ({ field, direction: 1 })),
    ...sortKeys,
    ...rangeKeys,
  ];
  if (keys.length === 0) return null;

  return { keys, reason: buildReason(equality, sortKeys, rangeKeys) };
}

/**
 * `$or`/`$text`/`$where`/`$expr` refuse wherever they appear, at any depth —
 * `$nor` is handled separately in `suggestIndex` (against the *flattened*
 * filter; see its own comment for why this one has to stay on the raw
 * filter instead). A `$regex` is a refusal only when unanchored; an
 * anchored one (`^prefix`) is left for `classifyFilterField` to class as
 * Range.
 */
function hasRefusal(node: unknown): boolean {
  if (node instanceof BSONRegExp) return !node.pattern.startsWith('^');
  if (Array.isArray(node)) return node.some((el) => hasRefusal(el));
  if (!isPlainDocument(node)) return false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$or') return true;
    if (k === '$text' || k === '$where' || k === '$expr') return true;
    if (k === '$regex' && typeof v === 'string' && !v.startsWith('^')) return true;
    if (hasRefusal(v)) return true;
  }
  return false;
}

/**
 * Merges a top-level `$and`'s branches into the surrounding document,
 * recursively (an `$and` branch may itself hold an `$and`). Non-`$and` keys
 * pass through unchanged.
 *
 * Known gap: this is a plain-object merge, so two branches predicating the
 * *same* field (`{$and:[{a:1},{a:{$gt:0}}]}`) collapse to whichever branch
 * came last, not the earliest-class one W16 §4.1's "placed once, in the
 * earliest" calls for — the classifier only ever sees one predicate per
 * field here, never both. Refusal-triggering keys don't have this problem;
 * see `suggestIndex`'s own comment for why that scan runs on the raw filter
 * instead of this merged one.
 */
function flattenAnd(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '$and' && Array.isArray(v)) {
      for (const branch of v) {
        if (isPlainDocument(branch)) Object.assign(result, flattenAnd(branch));
      }
    } else {
      result[k] = v;
    }
  }
  return result;
}

/** The `$regex` pattern this predicate value carries, from either a revived `BSONRegExp` or a plain `{$regex: '…'}` object — `null` if it isn't a regex predicate. By the time this runs, `hasRefusal` has already ruled out an unanchored one. */
function regexPattern(value: unknown): string | null {
  if (value instanceof BSONRegExp) return value.pattern;
  if (isPlainDocument(value)) {
    const pattern = (value as Record<string, unknown>).$regex;
    if (typeof pattern === 'string') return pattern;
  }
  return null;
}

function classifyFilterField(value: unknown): 'equality' | 'range' | null {
  if (regexPattern(value) !== null) return 'range'; // anchored prefix scan
  if (!isPlainDocument(value)) return 'equality'; // scalar, array, Date, ObjectId, …
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.includes('$eq') || keys.includes('$in')) return 'equality';
  if (keys.some((k) => RANGE_OPS.has(k))) return 'range';
  return null; // $ne/$nin, or an operator W16 §4.1 doesn't mention ($exists, $type, $size, $elemMatch, $all, $mod, geo)
}

function fieldList(fields: string[]): string {
  return fields.map((f) => `\`${f}\``).join(', ');
}

/**
 * Equality is always the first clause when present — it's first in ESR and
 * first checked here — so it's always capitalized and never needs the
 * "already have a clause" check Sort and Range do.
 */
function buildReason(equality: string[], sortKeys: IndexKey[], rangeKeys: IndexKey[]): string {
  const clauses: string[] = [];
  if (equality.length > 0) clauses.push(`Equality on ${fieldList(equality)}`);

  const sortFields = sortKeys.map((k) => k.field);
  if (sortFields.length > 0) {
    clauses.push(`${clauses.length === 0 ? 'Sort' : 'sort'} on ${fieldList(sortFields)}`);
  }

  const rangeFields = rangeKeys.map((k) => k.field);
  if (rangeFields.length > 0) {
    clauses.push(`${clauses.length === 0 ? 'Range' : 'range'} on ${fieldList(rangeFields)}`);
  }

  return `${clauses.join(', then ')} — MongoDB's ESR order.`;
}
