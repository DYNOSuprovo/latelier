import { describe, it, expect } from 'vitest';
import { parseAllowedExternalUrl } from '../../electron/security/externalUrl';
import { ValidationError } from '../../electron/errors';

const HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.mongodb.com']);
const parse = (raw: string) => parseAllowedExternalUrl(raw, HOSTS);

describe('parseAllowedExternalUrl', () => {
  it('accepts an https URL on an allow-listed host and returns it parsed', () => {
    const parsed = parse('https://github.com/anonhym/latelier/blob/main/README.md#usage');
    expect(parsed.href).toBe('https://github.com/anonhym/latelier/blob/main/README.md#usage');
    expect(parsed.hostname).toBe('github.com');
  });

  it('accepts every host in the set', () => {
    expect(parse('https://www.mongodb.com/docs/').hostname).toBe('www.mongodb.com');
  });

  it('lowercases the host, so an uppercase spelling matches', () => {
    expect(parse('https://GitHub.COM/x').href).toBe('https://github.com/x');
  });

  it('accepts the explicit default port, which URL normalises away', () => {
    expect(parse('https://github.com:443/x').href).toBe('https://github.com/x');
  });

  it('rejects a host that is not in the set', () => {
    expect(() => parse('https://evil.example/')).toThrow(ValidationError);
    expect(() => parse('https://evil.example/')).toThrow('host not allowed: evil.example');
  });

  it('rejects http even on an allow-listed host', () => {
    expect(() => parse('http://github.com/')).toThrow(ValidationError);
    expect(() => parse('http://github.com/')).toThrow('unsupported protocol: http:');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'mailto:a@github.com'])(
    'rejects the %s scheme',
    (raw) => {
      expect(() => parse(raw)).toThrow(/unsupported protocol/);
    },
  );

  it('rejects the userinfo trick, where the real host is after the @', () => {
    expect(() => parse('https://github.com@evil.example/')).toThrow(ValidationError);
    expect(() => parse('https://github.com@evil.example/')).toThrow('URL must not contain credentials');
  });

  it('rejects userinfo even when the real host is allow-listed', () => {
    expect(() => parse('https://user@github.com/')).toThrow('URL must not contain credentials');
    expect(() => parse('https://user:secret@github.com/')).toThrow('URL must not contain credentials');
    // An empty username with a password is still a credential.
    expect(() => parse('https://:secret@github.com/')).toThrow('URL must not contain credentials');
  });

  it('rejects an allow-listed name used as a path segment or subdomain label', () => {
    expect(() => parse('https://evil.example/github.com')).toThrow('host not allowed: evil.example');
    expect(() => parse('https://github.com.evil.example/')).toThrow('host not allowed');
    expect(() => parse('https://evilgithub.com/')).toThrow('host not allowed');
    expect(() => parse('https://sub.github.com/')).toThrow('host not allowed');
  });

  it('rejects a trailing-dot host instead of normalising it', () => {
    expect(() => parse('https://github.com./x')).toThrow('host not allowed: github.com.');
  });

  it('rejects any explicit non-default port', () => {
    expect(() => parse('https://github.com:8443/')).toThrow('URL must not specify a port');
    expect(() => parse('https://github.com:80/')).toThrow('URL must not specify a port');
  });

  it('rejects strings that do not parse as a URL', () => {
    expect(() => parse('not a url')).toThrow('invalid URL');
    expect(() => parse('')).toThrow('invalid URL');
  });

  it('honours the set it is given, not a fixed list', () => {
    expect(() => parseAllowedExternalUrl('https://github.com/', new Set(['example.org']))).toThrow(
      'host not allowed',
    );
    expect(parseAllowedExternalUrl('https://example.org/', new Set(['example.org'])).hostname).toBe(
      'example.org',
    );
  });

  it('carries the VALIDATION code on every rejection', () => {
    try {
      parse('https://evil.example/');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ValidationError).code).toBe('VALIDATION');
    }
  });
});
