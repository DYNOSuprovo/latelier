import { ValidationError } from '../errors.ts';

/**
 * Parse a URL the renderer asked the main process to open in the system
 * browser, and accept it only when it is an `https:` URL on an allow-listed
 * host. Returns the parsed URL; callers open `parsed.href`, the normalised
 * form, never the raw string they were handed.
 *
 * A prefix test cannot answer this: `https://github.com@evil.example/` starts
 * with `https://github.com` and its real host is `evil.example`, because
 * everything before the `@` is userinfo. So the check is on parsed components:
 *
 * - `hostname` is compared to the set for exact equality. `URL` has already
 *   lowercased it, so `GitHub.com` matches. A trailing-dot host
 *   (`github.com.`) is a distinct name to this comparison and is rejected, not
 *   normalised: no link the app ships uses one.
 * - userinfo is refused outright, even on an allow-listed host.
 * - an explicit port is refused. `URL` reports the default 443 as an empty
 *   string, so `https://github.com:443/` still passes; any other port does not.
 */
export function parseAllowedExternalUrl(
  raw: string,
  allowedHosts: ReadonlySet<string>,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError('invalid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(`unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError('URL must not contain credentials');
  }
  if (parsed.port !== '') {
    throw new ValidationError('URL must not specify a port');
  }
  if (!allowedHosts.has(parsed.hostname)) {
    throw new ValidationError(`host not allowed: ${parsed.hostname}`);
  }
  return parsed;
}
