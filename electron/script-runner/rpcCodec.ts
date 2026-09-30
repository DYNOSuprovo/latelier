import { Double, Int32 } from 'bson';

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
