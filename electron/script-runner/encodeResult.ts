import { SystemError } from '../errors.ts';
import { ByteCapExceededError, ejsonEncode, ejsonEncodeArrayJson } from '../mongo/ejson.ts';

/**
 * Soft cap on the EJSON encode of a script result. An explicit `.toArray()`
 * on a large collection materializes everything; without a cap, 200k docs is
 * a 95 MB blob sent over the message port and held in renderer memory.
 * Matches the find cap (50 MB).
 */
export const MAX_SCRIPT_RESULT_BYTES = 50 * 1024 * 1024;

function overCap(): SystemError {
  return new SystemError(
    'INTERNAL',
    `script result exceeds ${MAX_SCRIPT_RESULT_BYTES} byte cap — refine your script (e.g. add .limit())`,
  );
}

/**
 * EJSON-encode a script's final value to a JSON string, enforcing the byte cap.
 *
 * Runs inside the runner child, where a long encode blocks only that process:
 * the parent's wall-clock kill is the bound, so there is no deadline or yield
 * logic here. A value that cannot be encoded (a function, a cycle, the `db`
 * proxy) collapses to 'null'; the cap is the one failure that is reported.
 */
export function encodeResultJson(value: unknown, relaxed: boolean): string {
  // Stryker disable all: sending arrays through `ejsonEncodeArrayJson` only lets the byte cap stop the encode early instead of after the whole string is built; the whole-value path below returns the identical JSON and the identical cap error (probed: a 600k-document array encodes to the same string either way), so the two differ in peak memory alone. Removing or emptying any part of this block falls through to that path.
  if (Array.isArray(value)) {
    try {
      return ejsonEncodeArrayJson(value, { relaxed, maxBytes: MAX_SCRIPT_RESULT_BYTES });
    } catch (err) {
      if (err instanceof ByteCapExceededError) throw overCap();
      return 'null';
    }
  }
  // Stryker restore all
  let json: string;
  if (typeof value === 'number') {
    // A bare number stays a plain JSON number: EJSON would wrap it as
    // `$numberInt`/`$numberDouble`, and `1 + 2` should read as 3.
    json = JSON.stringify(value);
  } else {
    try {
      json = JSON.stringify(ejsonEncode(value, relaxed));
    } catch {
      return 'null';
    }
  }
  // Cap-check outside the try so the SystemError is not swallowed to 'null'.
  if (json.length > MAX_SCRIPT_RESULT_BYTES) throw overCap();
  return json;
}
