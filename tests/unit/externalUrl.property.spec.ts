import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValidationError } from '../../electron/errors';
import { parseAllowedExternalUrl } from '../../electron/security/externalUrl';

const HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.mongodb.com']);

describe('parseAllowedExternalUrl properties', () => {
  // Whatever string arrives, anything the guard lets through is https, on an
  // allow-listed host, with no userinfo and no port. Feeding it URL-shaped
  // strings built around the allowed hosts reaches the accepting branch often
  // enough for the invariant to bite.
  const urlish = fc
    .tuple(
      fc.constantFrom('https', 'http', 'javascript', 'file'),
      fc.constantFrom('', 'u@', 'u:p@', 'github.com@', ':@'),
      fc.constantFrom('github.com', 'GITHUB.COM', 'www.mongodb.com', 'evil.example', 'github.com.', 'github.com.evil.example'),
      fc.constantFrom('', ':443', ':8443', ':80'),
      fc.webPath(),
    )
    .map(([scheme, userinfo, host, port, path]) => `${scheme}://${userinfo}${host}${port}${path}`);

  // A rejection is the guard's own ValidationError; anything else is a bug and
  // is rethrown so the property fails on it.
  function tryParse(raw: string): URL | null {
    try {
      return parseAllowedExternalUrl(raw, HOSTS);
    } catch (err) {
      if (err instanceof ValidationError) return null;
      throw err;
    }
  }

  it('every accepted URL is https on an allow-listed host with no userinfo or port', () => {
    fc.assert(
      fc.property(fc.oneof(urlish, fc.string()), (raw) => {
        const parsed = tryParse(raw);
        if (parsed === null) return;
        expect(parsed.protocol).toBe('https:');
        expect(HOSTS.has(parsed.hostname)).toBe(true);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
        expect(parsed.port).toBe('');
      }),
    );
  });

  it('accepts some generated URLs, so the invariant is not vacuous', () => {
    const accepted = fc
      .sample(urlish, 200)
      .filter((raw) => tryParse(raw) !== null);
    expect(accepted.length).toBeGreaterThan(0);
  });
});
