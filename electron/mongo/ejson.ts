import { EJSON, BSONRegExp } from 'bson';
import { SystemError, ValidationError } from '../errors.ts';

// Soft cap on a single EJSON payload (encode of a read result, or a raw
// write string before it's parsed). Spec PLAN-workspace.md:424 — refuse
// anything whose EJSON size exceeds 50 MB so one fat payload can't freeze
// the main process. One constant, shared by every caller that needs this
// guard, so the threshold can't drift between a read path and a write path.
export const DEFAULT_MAX_EJSON_BYTES = 50 * 1024 * 1024;

// Single-key EJSON v2 canonical sentinel names that unambiguously identify a
// BSON type when the object has EXACTLY that one key (no siblings).
// Deliberately excludes '$regex' and '$options': in a filter they are query
// operators, not type sentinels, and the canonical form for BSONRegExp is the
// two-key '$regularExpression' object below.
const SENTINEL_SINGLE = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',        // canonical: {$binary:{base64,subType}} — one top-level key
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$undefined',
  '$code',
  '$symbol',
  '$dbPointer',
]);

// Returns true only when the object's key set EXACTLY matches a known BSON
// sentinel signature — no extra keys allowed.
function isExactSentinel(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 1) return SENTINEL_SINGLE.has(keys[0]!);
  // CodeWithScope: {$code, $scope}
  if (keys.length === 2 && '$code' in obj && '$scope' in obj) return true;
  // Note: legacy binary {$binary, $type} is intentionally NOT listed here.
  // bson ≥7 removed EJSON v1 binary; EJSON.parse throws on that format.
  // Falling through to plain-object is safer than propagating the throw.
  return false;
}

// Canonical EJSON v2 base64: RFC 4648 alphabet, correctly padded. An empty
// string (zero bytes) is valid. Anything outside this — stray punctuation,
// wrong padding — is what Node's lenient `Buffer.from(s, 'base64')` silently
// drops characters from instead of rejecting.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// BSON Binary subType is a one-byte value written as 1-2 hex digits.
const HEX_BYTE_RE = /^[0-9a-fA-F]{1,2}$/;

/**
 * A $regularExpression's `pattern` is never compiled at BSON-construction
 * time — BSONRegExp just stores the string. The only place it IS compiled is
 * `new RegExp(source, ...)` deep inside the driver's BSON deserializer, on a
 * later read of the stored document. An uncompilable pattern therefore
 * inserts cleanly and then bricks every subsequent read of that collection.
 * Catch it here, at the one shared revival point every filter/doc/docs/update
 * string passes through.
 */
function validateRegexPattern(pattern: string): void {
  try {
    void new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `invalid regex pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * bson's EJSON.parse is lenient about a $binary sentinel's CONTENTS even
 * though it checks the SHAPE: `Buffer.from(base64, 'base64')` silently drops
 * characters it can't decode instead of throwing, and `parseInt(subType, 16)`
 * on a non-hex string is `NaN`, which the `Binary` constructor's `& 0xff`
 * masks down to 0. Both corrupt the stored value without ever raising an
 * error. Validate the raw sentinel fields before handing them to EJSON.parse,
 * since by the time it returns the invalid characters are already gone.
 */
function validateBinarySentinel(value: unknown): void {
  if (value === null || typeof value !== 'object') return; // let EJSON.parse raise its own shape error
  const b = value as { base64?: unknown; subType?: unknown };
  if (typeof b.base64 === 'string' && !BASE64_RE.test(b.base64)) {
    throw new Error(`invalid $binary.base64: not valid base64`);
  }
  if (typeof b.subType === 'string' && b.subType !== '' && !HEX_BYTE_RE.test(b.subType)) {
    throw new Error(`invalid $binary.subType: not a valid hex byte`);
  }
}

function walkRevive(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return (node as unknown[]).map(walkRevive);
  const obj = node as Record<string, unknown>;
  // Exact sentinel → delegate to EJSON.parse (isolated node, no sibling drop).
  if (isExactSentinel(obj)) {
    // $binary must be checked BEFORE revival: EJSON.parse already silently
    // corrupts bad content on the way through, so by the time it returns
    // there's nothing left to validate.
    if ('$binary' in obj) validateBinarySentinel(obj.$binary);
    const revived = EJSON.parse(JSON.stringify(obj), { relaxed: false });
    // $date and $regularExpression revive without losing information, so
    // validating the revived BSON value is equivalent and simpler than
    // re-deriving the check from the raw sentinel.
    if (revived instanceof Date && Number.isNaN(revived.getTime())) {
      throw new Error(`invalid $date value: ${JSON.stringify(obj.$date)}`);
    }
    if (revived instanceof BSONRegExp) {
      validateRegexPattern(revived.pattern);
    }
    return revived;
  }
  // Object.create(null), not {} — a field literally named `__proto__` whose
  // value revives to a BSON object (ObjectId, Date, Int32, …) would otherwise
  // hit the `__proto__` accessor on a `{}` literal: `result[k] = v` silently
  // reassigns the object's prototype instead of creating an own property,
  // the field vanishes from Object.keys, and isPlainDocument below
  // misclassifies the corrupted result. isPlainDocument already treats a
  // null-prototype object as plain for exactly this reason.
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) result[k] = walkRevive(v);
  return result;
}

/**
 * Shape-exact EJSON parser. Unlike the greedy EJSON.parse(relaxed:false), this
 * walker only revives an object to a BSON type when its key set EXACTLY matches
 * a known sentinel signature.  Objects with extra sibling keys (e.g.
 * {$date:"…",kept:"x"} or {$regex:"…",$gte:100}) are left as plain objects —
 * operators and user data are never silently dropped.
 */
export function safeEjsonParse<T = unknown>(s: string): T {
  return walkRevive(JSON.parse(s) as unknown) as T;
}

/**
 * Parse an Extended JSON string (canonical) into a JavaScript value. BSON
 * types like ObjectId, Date, Long, Decimal128, RegExp are preserved.
 */
export function ejsonParse<T = unknown>(s: string): T {
  return safeEjsonParse<T>(s);
}

/**
 * Serialize a value to a canonical EJSON string.
 */
export function ejsonStringify(v: unknown, indent?: number): string {
  return EJSON.stringify(v, undefined, indent, { relaxed: false });
}

/**
 * Relaxed-mode EJSON for human consumption (the W11 shell pane). Numbers,
 * booleans, dates and strings print naturally; ObjectId / Decimal128 still
 * surface as `$oid` / `$numberDecimal` so the user can see the underlying
 * BSON type.
 *
 * Returns `undefined` for values EJSON can't serialise (functions, including
 * Proxies wrapping functions). Callers should fall back to `util.inspect`.
 */
export function ejsonStringifyRelaxed(v: unknown, indent?: number): string | undefined {
  return EJSON.stringify(v, undefined, indent, { relaxed: true }) as string | undefined;
}

/**
 * Convert a single value (BSON-native or plain) to its EJSON-encoded form.
 * The resulting object is plain JSON + EJSON type sentinels; safe to cross
 * IPC.
 */
export function ejsonEncode(v: unknown, relaxed = false): unknown {
  return EJSON.serialize(v as object, { relaxed });
}

export function ejsonEncodeArray(docs: unknown[], relaxed = false): unknown[] {
  return docs.map((d) => ejsonEncode(d, relaxed));
}

/**
 * `ejsonEncodeArrayJson`'s byte cap was breached. The same code and message a
 * plain `SystemError` carried before, as its own class so a caller that
 * treats the cap as an expected outcome can tell it from a real failure.
 */
export class ByteCapExceededError extends SystemError {
  constructor(maxBytes: number) {
    super('INTERNAL', `result size exceeds ${maxBytes} byte cap`);
  }
}

/**
 * Encode + JSON-stringify a document array in a single pass. The wire format
 * for find/aggregate results is a JSON string (parsed once at the renderer
 * boundary), which is meaningfully cheaper than structured-cloning N nested
 * objects across the contextBridge.
 *
 * If `maxBytes` is set and the cumulative encoded length exceeds it, throws
 * a SystemError instead of returning. Replaces an earlier `guardResultSize`
 * helper that did a separate full stringify just to measure size.
 */
export function ejsonEncodeArrayJson(
  docs: unknown[],
  opts: { relaxed?: boolean; maxBytes?: number } = {},
): string {
  const relaxed = opts.relaxed ?? false;
  const max = opts.maxBytes;
  let out = '[';
  let bytes = 1;
  for (let i = 0; i < docs.length; i++) {
    const piece = JSON.stringify(ejsonEncode(docs[i], relaxed));
    const sep = i === 0 ? '' : ',';
    bytes += sep.length + piece.length;
    if (max !== undefined && bytes > max) throw new ByteCapExceededError(max);
    out += sep + piece;
  }
  out += ']';
  return out;
}

export function isValidEjson(s: string): boolean {
  try {
    safeEjsonParse(s);
    return true;
  } catch {
    return false;
  }
}

export function parseEjsonField<T = unknown>(json: string, field: string): T {
  try {
    return ejsonParse<T>(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invalid EJSON';
    throw new ValidationError(`invalid ${field}: ${reason}`, { field });
  }
}

/**
 * `parseEjsonField` plus the document check every `find` argument needs.
 *
 * Parsing is not validation: `'null'`, `'[1,2]'` and `'"abc"'` are all valid
 * EJSON, and the `<Record<string, unknown>>` / `<Sort>` type argument at the
 * call site is a compile-time fiction over whatever the string actually held.
 * The driver does not save us — it *ignores* a `null` or array `sort`, and
 * ignores a `null` `projection`, running the query unsorted and full-width
 * with no error. That is the fail-open the W15 spec restates as its §11
 * invariant: no path may silently widen a refused projection.
 *
 * Deliberately a separate function rather than a check inside
 * `parseEjsonField`: `DocumentService.insertMany` parses `docsJson` as an
 * array through that same helper, and a blanket document check there would
 * break it.
 *
 * `isRawProjection` in the renderer resolves to the same rule via
 * `isEjsonDocument`, and the two must not drift — `ejson-document-guard.spec.ts`
 * drives both from one table. The shape test was tightened from the loose
 * `typeof === 'object'` check, which a BSON instance used to pass on both
 * sides; `isPlainDocument` below is the rule and says why.
 */
export function parseEjsonDocument<T = unknown>(json: string, field: string): T {
  const parsed = parseEjsonField<unknown>(json, field);
  if (!isPlainDocument(parsed)) {
    throw new ValidationError(
      `invalid ${field}: expected a document like { field: 1 }`,
      { field },
    );
  }
  return parsed as T;
}

/**
 * Is this parsed value a *plain* document, as opposed to a BSON instance?
 *
 * `typeof x === 'object' && !Array.isArray(x)` is not enough: a bare sentinel
 * like `{"$oid":"507f1f77bcf86cd799439011"}` revives to an `ObjectId`, which
 * satisfies all of it and reaches the driver as a sort or projection.
 * Two of those cases are silent — `{"$date":…}` as a sort runs in insertion
 * order because `Object.keys(new Date())` is `[]`, and `{"$oid":…}` as a
 * filter matches nothing — which is the W15 §11 fail-open reopened through
 * a sentinel after it had already been closed for `[1,2]` and `null`.
 *
 * The prototype test rather than an `_bsontype` / `instanceof Date` list: it
 * covers every BSON type, including ones added later, and `walkRevive` and
 * `JSON.parse` both produce ordinary object literals for real documents.
 *
 * Only the *top level* is checked. `{"createdAt":{"$date":"…"}}` is an
 * ordinary filter and must keep working.
 *
 * Mirrored by `isPlainDocument` in `src/utils/ejson.ts` — `shared/` is
 * types-only, so the rule cannot be hoisted into one module. The two copies
 * are pinned together by `tests/unit/ejson-document-guard.spec.ts`.
 */
export function isPlainDocument(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const proto = Object.getPrototypeOf(parsed) as unknown;
  return proto === Object.prototype || proto === null;
}
