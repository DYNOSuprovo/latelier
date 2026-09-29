export type DisplayType =
  | 'objectid'
  | 'date'
  | 'long'
  | 'decimal'
  | 'regex'
  | 'binary'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'undefined';

export interface DisplayValue {
  type: DisplayType;
  display: string;
  raw: unknown;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Per-document-object identity, not per-`_id` or per-position: pipeline
// output can repeat an `_id` (e.g. after $unwind) and a refetch reuses the
// same row index for an unrelated document, so neither is a safe key on its
// own. A real refetch always builds new document objects, so keying off the
// object reference itself makes collapse state expire exactly when the
// document it was collapsing is gone, with no separate invalidation needed.
const docIdentity = new WeakMap<object, string>();
let nextDocId = 0;

// A stable identity for a document instance, used to scope per-document UI
// state (e.g. collapsed JSON nodes) across re-renders without leaking across
// unrelated documents.
export function docKey(doc: unknown, idx: number): string {
  if (!isRecord(doc)) return `idx:${idx}`;
  const cached = docIdentity.get(doc);
  if (cached !== undefined) return cached;
  const key = `doc:${nextDocId++}`;
  docIdentity.set(doc, key);
  return key;
}

export function valueToClipboardText(val: unknown): string {
  if (val === undefined) return '';
  if (typeof val === 'string') return val;
  const dv = toDisplayValue(val);
  if (
    dv.type === 'objectid' ||
    dv.type === 'date' ||
    dv.type === 'long' ||
    dv.type === 'decimal' ||
    dv.type === 'regex' ||
    dv.type === 'number' ||
    // Stryker disable next-line ConditionalExpression,StringLiteral: dropping this clause only changes the fallback taken for an actual boolean, and `String(v)` (this branch's `dv.display`) and `JSON.stringify(v)` (the fallback) are byte-identical for both `true` and `false` — verified with node.
    dv.type === 'boolean' ||
    // Stryker disable next-line ConditionalExpression,StringLiteral: same reasoning as 'boolean' above — `dv.display` for a null value is the literal string 'null', which is also `JSON.stringify(null)`.
    dv.type === 'null'
  ) {
    return dv.display;
  }
  return JSON.stringify(val);
}

export function toDisplayValue(v: unknown): DisplayValue {
  if (v === undefined) {
    return { type: 'undefined', display: 'undefined', raw: v };
  }

  if (v === null) {
    return { type: 'null', display: 'null', raw: v };
  }

  if (typeof v === 'boolean') {
    return { type: 'boolean', display: String(v), raw: v };
  }

  if (typeof v === 'number') {
    return { type: 'number', display: String(v), raw: v };
  }

  if (typeof v === 'string') {
    // Stryker disable next-line StringLiteral,BlockStatement: this branch is redundant with the function's final catch-all (`return { type: 'string', display: String(v), raw: v }`) for any actual string `v` — `Array.isArray` and `isRecord` are both false for a string, so it falls through there, and `String(v) === v` for every string. Skipping or emptying this branch changes nothing observable.
    return { type: 'string', display: v, raw: v };
  }

  if (Array.isArray(v)) {
    return { type: 'array', display: `[${v.length}]`, raw: v };
  }

  if (isRecord(v)) {
    // ObjectId: { $oid: "hex" }
    if ('$oid' in v && typeof v.$oid === 'string' && Object.keys(v).length === 1) {
      return { type: 'objectid', display: v.$oid, raw: v };
    }

    // Date: { $date: "iso" | number | { $numberLong: "..." } }
    if ('$date' in v && Object.keys(v).length === 1) {
      const d = v.$date;
      let dateStr: string;
      // Stryker disable next-line StringLiteral: this branch is redundant with the final `else { dateStr = String(d); }` for any actual string `d` — `typeof d === 'number'` and `isRecord(d)` are both false for a string, so it falls through there, and `String(d) === d` for every string.
      if (typeof d === 'string') {
        dateStr = d;
      } else if (typeof d === 'number') {
        dateStr = new Date(d).toISOString();
      } else if (isRecord(d) && typeof d.$numberLong === 'string') {
        dateStr = new Date(Number(d.$numberLong)).toISOString();
      } else {
        dateStr = String(d);
      }
      return { type: 'date', display: dateStr, raw: v };
    }

    // NumberInt: { $numberInt: "..." } — canonical EJSON for 32-bit ints.
    // The driver emits this in canonical mode (relaxed=false); collapse to
    // 'number' so the builder treats it like a plain JS number on drag-drop.
    if ('$numberInt' in v && typeof v.$numberInt === 'string' && Object.keys(v).length === 1) {
      return { type: 'number', display: v.$numberInt, raw: v };
    }

    // NumberDouble: { $numberDouble: "..." } — canonical EJSON for 64-bit
    // floats. Value is a numeric string or one of "Infinity"/"-Infinity"/"NaN".
    if ('$numberDouble' in v && typeof v.$numberDouble === 'string' && Object.keys(v).length === 1) {
      return { type: 'number', display: v.$numberDouble, raw: v };
    }

    // NumberLong: { $numberLong: "..." }
    if ('$numberLong' in v && typeof v.$numberLong === 'string' && Object.keys(v).length === 1) {
      return { type: 'long', display: v.$numberLong, raw: v };
    }

    // NumberDecimal: { $numberDecimal: "..." }
    if ('$numberDecimal' in v && typeof v.$numberDecimal === 'string' && Object.keys(v).length === 1) {
      return { type: 'decimal', display: v.$numberDecimal, raw: v };
    }

    // Regex: { $regex: "...", $options?: "..." }
    if ('$regex' in v && typeof v.$regex === 'string') {
      const opts = typeof v.$options === 'string' ? v.$options : '';
      return { type: 'regex', display: `/${v.$regex}/${opts}`, raw: v };
    }

    // Binary: { $binary: { base64: "...", subType: "..." } }
    if ('$binary' in v && isRecord(v.$binary)) {
      const b = v.$binary;
      const b64 = typeof b.base64 === 'string' ? b.base64.slice(0, 16) : '?';
      return { type: 'binary', display: `Binary(${b64}...)`, raw: v };
    }

    const keys = Object.keys(v).length;
    return { type: 'object', display: `{${keys}}`, raw: v };
  }

  return { type: 'string', display: String(v), raw: v };
}
