import { Binary, Double, Int32 } from 'bson';

/**
 * The one number rule for values crossing the script bridge.
 *
 * Canonical EJSON wraps every number so it can round-trip (`$numberInt`,
 * `$numberDouble`), and parsing it back yields `Int32` / `Double` objects.
 * Neither end wants those for what started as a plain JS number: the driver's
 * own option checks reject an `Int32` where a number is required
 * (`maxTimeMS(6000)`), and the driver hands a script plain numbers for the
 * same stored values. So both ends unwrap.
 *
 * The one thing an unwrap could lose is a `Double` the script asked for on
 * purpose. `new Double(5)` and the JS number `5` differ on the wire (double 5.0
 * against int32 5), and the canonical form of `5` is `$numberInt`, so a
 * `$numberDouble` holding an int32-range integer can only have come from an
 * explicit `Double`. `keepIntegralDoubles` leaves those alone, which is what
 * arguments need. Results do not: the driver has already turned a stored 5.0
 * into the number 5, and a `Double` there would just be noise.
 *
 * Documents are rebuilt as ordinary objects (the parser makes prototype-less
 * ones so a `__proto__` field survives); a field is defined rather than
 * assigned for the same reason. Arrays are updated in place, since the caller
 * has just parsed them.
 */
export function promoteNumbers(value: unknown, keepIntegralDoubles: boolean): unknown {
  if (value instanceof Int32) return value.valueOf();
  if (value instanceof Double) {
    const n = value.valueOf();
    return keepIntegralDoubles && isInt32(n) ? value : n;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = promoteNumbers(value[i], keepIntegralDoubles);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== null && proto !== Object.prototype) return value;
  const doc: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(doc, key, {
      value: promoteNumbers(field, keepIntegralDoubles),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return doc;
}

function isInt32(n: number): boolean {
  return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
}

/**
 * The other half of the number rule, applied before a value is encoded.
 *
 * Canonical EJSON writes a JS integer outside the int32 range as
 * `$numberLong`, which is indistinguishable from a real `Long` on the far
 * side. But a JS number is a double to the driver (that is how it writes
 * `Date.now()`), and the driver hands one back as a JS number, so the long
 * label would change the stored type going in and the script's `typeof`
 * coming out. Wrapping such an integer in a `Double` makes the canonical
 * form say what it is (`$numberDouble`); `promoteNumbers` unwraps it again.
 * An actual `Long` is a BSON value and is left alone, so a value past 2^53
 * keeps its type.
 *
 * A `Uint8Array` (a `Buffer` is one) becomes a `Binary`, as the driver would
 * have written it: left as it is, EJSON would encode it as a plain document of
 * index keys and the stored type would be lost. Only arguments carry one; a
 * result holds the `Binary` the driver already made.
 *
 * Copies what it walks (arrays and ordinary documents), so a script's own
 * objects are never changed. Anything else, BSON values and dates included,
 * is passed through as it is.
 */
export function markWideIntegers(value: unknown): unknown {
  if (typeof value === 'number') return isWideInteger(value) ? new Double(value) : value;
  if (Array.isArray(value)) return value.map(markWideIntegers);
  if (value === null || typeof value !== 'object' || '_bsontype' in value) return value;
  // The tag, not the prototype: a script's objects come from another realm.
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Uint8Array]') return new Binary(value as Uint8Array);
  if (tag !== '[object Object]') return value;
  const doc: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(doc, key, {
      value: markWideIntegers(field),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return doc;
}

function isWideInteger(n: number): boolean {
  return Number.isInteger(n) && !isInt32(n);
}
