import { Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { ejsonStringifyReadable, isPlainDocument } from '../../utils/ejson';

/**
 * The Document Editor's per-field type vocabulary (W18 §3): what kind a
 * value is, how it renders as text, how typed text parses back, and how the
 * type selector converts one kind's value into another's. Pure and
 * side-effect free so it qualifies for Stryker's `mutate` list — the actual
 * type-selector behavior lives here, not in the component.
 */

export type Doc = Record<string, unknown>;

/** The type-selector's full target vocabulary — every kind a row can be. */
export type FieldKind =
  | 'string'
  | 'int32'
  | 'long'
  | 'double'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'null'
  | 'object'
  | 'array';

/**
 * What a value actually is right now. `number` is a bare JS number — never
 * produced by this editor, but a hand-built document can hold one — and
 * `other` is anything the Fields view doesn't have a typed input for
 * (Binary, RegExp, Timestamp, …), which stays read-only.
 */
export type Kind = FieldKind | 'number' | 'other';

export function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'other' : 'date';
  if (v instanceof Int32) return 'int32';
  if (v instanceof Double) return 'double';
  if (v instanceof Long) return 'long';
  if (v instanceof Decimal128) return 'decimal';
  if (v instanceof ObjectId) return 'objectId';
  if (isPlainDocument(v)) return 'object';
  return 'other';
}

export const TYPE_LABEL: Record<Exclude<Kind, 'other'>, string> = {
  string: 'String',
  int32: 'Int32',
  double: 'Double',
  long: 'Int64',
  decimal: 'Decimal128',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  null: 'Null',
  object: 'Object',
  array: 'Array',
};

export function typeLabel(kind: Kind, v: unknown): string {
  if (kind !== 'other') return TYPE_LABEL[kind];
  const bsonType = (v as { _bsontype?: unknown } | null)?._bsontype;
  return typeof bsonType === 'string' ? bsonType : 'Value';
}

/** Every kind the type selector can switch a row to. */
export const SELECTABLE_KINDS: readonly FieldKind[] = [
  'string',
  'int32',
  'long',
  'double',
  'decimal',
  'boolean',
  'date',
  'objectId',
  'null',
  'object',
  'array',
];

/** ISO-8601 in UTC, without the `.000` a whole second doesn't need. */
export function isoOf(d: Date): string {
  return d.toISOString().replace('.000Z', 'Z');
}

const INTEGER = /^-?\d+$/;
// Zone required: without one, `Date.parse` reads the text as local time and
// the stored instant silently shifts by the machine's offset.
// Stryker disable next-line Regex: V8's Date.parse, the only engine this ships on, already refuses every text an unanchored match would let through (probed: prefixes, suffixes, 5-digit years); the anchors keep the regex correct on its own.
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const HEX_24 = /^[0-9a-fA-F]{24}$/;

/** The default value a freshly picked kind opens with (Null, Add field, an unconvertible source). */
export function zeroValue(kind: FieldKind): unknown {
  switch (kind) {
    case 'string':
      return '';
    case 'int32':
      return new Int32(0);
    case 'long':
      return Long.fromNumber(0);
    case 'double':
      return new Double(0);
    case 'decimal':
      return Decimal128.fromString('0');
    case 'boolean':
      return false;
    case 'date':
      return new Date(0);
    case 'objectId':
      return new ObjectId('000000000000000000000000');
    case 'null':
      return null;
    case 'object':
      return Object.create(null) as Doc;
    case 'array':
      return [];
  }
}

/**
 * How a value renders in its own row's input — also the source text
 * `convertType` stringifies from. Every BSON numeric wrapper (`Int32`,
 * `Long`, `Double`, `Decimal128`) and `ObjectId` already stringify to their
 * plain, exact text through their own `toString`, so a bare `String(v)`
 * covers all of them — no per-kind unwrapping needed.
 */
export function textOf(kind: Kind, v: unknown): string {
  switch (kind) {
    case 'date':
      return isoOf(v as Date);
    // No `int32` case: its canonical EJSON always relaxes to the same plain
    // integer text `String` gives, so the default below prints it identically.
    case 'double':
    case 'long':
    case 'decimal':
    case 'objectId':
    case 'number':
      return String(v);
    case 'string':
      return v as string;
    default:
      // `boolean` and `array` fall here too: `ejsonStringifyReadable` already
      // prints `true`/`false` and a compact JSON array exactly as their own
      // dedicated case would, so a separate branch would only repeat it.
      return ejsonStringifyReadable(v);
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Typed text back to a value of the row's own kind — never another one. */
export function parseAs(kind: Kind, text: string): Parsed {
  const t = text.trim();
  switch (kind) {
    case 'string':
      return { ok: true, value: text };
    case 'int32': {
      const n = Number(t);
      return INTEGER.test(t) && n >= -(2 ** 31) && n < 2 ** 31
        ? { ok: true, value: new Int32(n) }
        : { ok: false, error: 'Enter a whole number between -2147483648 and 2147483647' };
    }
    case 'long': {
      // `BigInt(t)` only ever throws on text `INTEGER` already refused.
      const ok = INTEGER.test(t) && BigInt(t) >= -(2n ** 63n) && BigInt(t) < 2n ** 63n;
      return ok ? { ok: true, value: Long.fromString(t) } : { ok: false, error: 'Enter a whole number that fits in 64 bits' };
    }
    case 'double':
    case 'number': {
      const n = Number(t);
      if (t === '' || Number.isNaN(n)) return { ok: false, error: 'Enter a number' };
      return { ok: true, value: kind === 'double' ? new Double(n) : n };
    }
    case 'decimal':
      try {
        return { ok: true, value: Decimal128.fromString(t) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Enter a decimal number' };
      }
    case 'date': {
      // The regex only checks shape; a text like `2026-13-01T00:00Z` passes
      // it but parses to NaN, which would otherwise write an Invalid Date
      // into the draft and strand the row as uneditable.
      const ms = ISO_UTC.test(t) ? Date.parse(t) : Number.NaN;
      return Number.isNaN(ms)
        ? { ok: false, error: 'Enter an ISO-8601 date with a zone, like 2026-09-24T20:31:00Z' }
        : { ok: true, value: new Date(ms) };
    }
    case 'objectId':
      return HEX_24.test(t) ? { ok: true, value: new ObjectId(t) } : { ok: false, error: 'Enter 24 hexadecimal characters' };
    case 'boolean': {
      const lower = t.toLowerCase();
      return lower === 'true' || lower === 'false'
        ? { ok: true, value: lower === 'true' }
        : { ok: false, error: 'Enter true or false' };
    }
    default:
      return { ok: false, error: 'This type is not editable here' };
  }
}

/**
 * The type selector's conversion (W18 §3): reuses this module's own
 * text round trip rather than a hand-written table of pairwise rules, so a
 * conversion can never produce a value the row's own input would refuse.
 *
 * `from`/`to` the same kind is a no-op. Either end at `null` always
 * succeeds — discarding the source, or opening the target at its zero value.
 * Otherwise, the source's text is parsed as the target kind; the result is
 * kept only if it prints back to the exact text it came from, so a
 * precision-losing conversion (Decimal128 → Double, a fraction → Int32)
 * clears instead of silently truncating.
 */
export function convertType(from: Kind, to: FieldKind, value: unknown): unknown {
  if (from === to) return value;
  if (from === 'null') return zeroValue(to);
  // Object, array and an unrecognized BSON value never round-trip through
  // text the way a scalar does — printing one's structure as a string isn't
  // the conservative "clears when it can't convert" this selector promises,
  // so these clear up front instead of being handed to `parseAs`. Converting
  // *to* object/array/null needs no such special case: `parseAs` has no case
  // for any of them, so the round trip below already fails and clears on its
  // own — to `zeroValue('null')`, which is `null`, for the last.
  if (from === 'other' || from === 'object' || from === 'array') {
    return zeroValue(to);
  }
  const sourceText = textOf(from, value);
  const attempt = parseAs(to, sourceText);
  if (!attempt.ok) return zeroValue(to);
  return textOf(to, attempt.value) === sourceText ? attempt.value : zeroValue(to);
}
