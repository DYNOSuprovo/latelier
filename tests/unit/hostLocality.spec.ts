import { describe, it, expect } from 'vitest';
import { isLocalHost, tlsWarning } from '../../src/utils/hostLocality';

describe('isLocalHost', () => {
  it.each([
    'localhost',
    'LocalHost',
    '127.0.0.1',
    '::1',
    '[::1]',
    '[::1]:27017',
    'localhost:27017',
    '127.0.0.1:27018',
    '  localhost  ',
    'localhost:27017,127.0.0.1:27018',
    '',
    ' , ',
  ])('treats %j as local', (h) => {
    expect(isLocalHost(h)).toBe(true);
  });

  it.each([
    'db.example.com',
    'db.example.com:27017',
    '10.0.0.5',
    '::2',
    '[::2]:27017',
    '127.0.0.2',
    'localhost.example.com',
    'notlocalhost',
    'localhost:27017,db.example.com:27017',
    'db.example.com,localhost',
    '[::1',
    '::1:27017',
  ])('treats %j as not local', (h) => {
    expect(isLocalHost(h)).toBe(false);
  });
});

describe('isLocalHost unclosed bracket', () => {
  it('does not trim an unclosed bracket into a local name', () => {
    expect(isLocalHost('[localhostx')).toBe(false);
  });
});

describe('tlsWarning', () => {
  const base = { enabled: true, verify: true, host: 'db.example.com', viaSshTunnel: false };

  it('is null for verified TLS on any host', () => {
    expect(tlsWarning(base)).toBeNull();
  });

  it('warns about impersonation when verification is off, even for a local host', () => {
    expect(tlsWarning({ ...base, verify: false })).toMatch(/impersonate/);
    expect(tlsWarning({ ...base, verify: false, host: 'localhost' })).toMatch(/impersonate/);
  });

  it('ignores verify when TLS is off', () => {
    expect(tlsWarning({ ...base, enabled: false, verify: false, host: 'localhost' })).toBeNull();
  });

  it('warns about cleartext when TLS is off for a remote host, and not for a local one', () => {
    expect(tlsWarning({ ...base, enabled: false })).toMatch(/cleartext/);
    expect(tlsWarning({ ...base, enabled: false, host: '127.0.0.1' })).toBeNull();
  });

  it('names the tunnel hop when TLS is off behind an SSH tunnel', () => {
    const w = tlsWarning({ ...base, enabled: false, viaSshTunnel: true });
    expect(w).toMatch(/SSH tunnel/);
    expect(w).toMatch(/cleartext/);
    expect(tlsWarning({ ...base, enabled: false }) ?? '').not.toMatch(/SSH tunnel/);
  });

  it('stays quiet for a host that is local to the far side of the tunnel', () => {
    expect(tlsWarning({ ...base, enabled: false, host: 'localhost', viaSshTunnel: true })).toBeNull();
  });
});
