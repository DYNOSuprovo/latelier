import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertCredentialPathsAllowed,
  createPickedCredentialPaths,
  credentialPathsOf,
  CREDENTIAL_PURPOSES,
  type PickedCredentialPaths,
} from '../../electron/security/credentialPaths';
import { ValidationError } from '../../electron/errors';

type Issue = { path: string[]; message: string };

function issuesOf(fn: () => void): Issue[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return ((err as ValidationError).details as { issues: Issue[] }).issues;
  }
  throw new Error('expected a throw');
}

describe('createPickedCredentialPaths', () => {
  it('remembers a path for the purpose it was picked for, and no other', () => {
    const p = createPickedCredentialPaths();
    p.record('tls-ca', '/a.pem');
    expect(p.has('tls-ca', '/a.pem')).toBe(true);
    expect(p.has('tls-client-cert', '/a.pem')).toBe(false);
    expect(p.has('ssh-key', '/a.pem')).toBe(false);
  });

  it.each(CREDENTIAL_PURPOSES)('records a %s pick', (purpose) => {
    const p = createPickedCredentialPaths();
    p.record(purpose, '/x');
    expect(p.has(purpose, '/x')).toBe(true);
  });

  it.each(['data-import', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''])(
    'ignores the non-credential purpose %j',
    (purpose) => {
      const p = createPickedCredentialPaths();
      expect(() => p.record(purpose, '/x')).not.toThrow();
      for (const c of CREDENTIAL_PURPOSES) expect(p.has(c, '/x')).toBe(false);
    },
  );

  it('compares exactly, with no normalisation', () => {
    const p = createPickedCredentialPaths();
    p.record('tls-ca', '/certs/ca.pem');
    expect(p.has('tls-ca', '/certs/ca.pem/')).toBe(false);
    expect(p.has('tls-ca', '/certs/./ca.pem')).toBe(false);
    expect(p.has('tls-ca', '/CERTS/ca.pem')).toBe(false);
  });
});

describe('credentialPathsOf', () => {
  it('reads the three paths from a connection-shaped source', () => {
    expect(
      credentialPathsOf({
        tls: { caPath: '/ca', clientCertPath: '/cc' },
        ssh: { privateKeyPath: '/k' },
      }),
    ).toEqual({ caPath: '/ca', clientCertPath: '/cc', privateKeyPath: '/k' });
  });

  it('returns undefined paths when tls and ssh are absent', () => {
    expect(credentialPathsOf({})).toEqual({
      caPath: undefined,
      clientCertPath: undefined,
      privateKeyPath: undefined,
    });
  });
});

describe('assertCredentialPathsAllowed', () => {
  let picked: PickedCredentialPaths;
  beforeEach(() => {
    picked = createPickedCredentialPaths();
    picked.record('tls-ca', '/picked/ca.pem');
    picked.record('tls-client-cert', '/picked/client.pem');
    picked.record('ssh-key', '/picked/id.key');
  });

  it('passes when nothing is set, including empty strings', () => {
    expect(() => assertCredentialPathsAllowed({}, picked, [])).not.toThrow();
    expect(() =>
      assertCredentialPathsAllowed({ caPath: '', clientCertPath: '', privateKeyPath: '' }, picked, []),
    ).not.toThrow();
  });

  it('passes for paths picked for the matching purpose', () => {
    expect(() =>
      assertCredentialPathsAllowed(
        { caPath: '/picked/ca.pem', clientCertPath: '/picked/client.pem', privateKeyPath: '/picked/id.key' },
        picked,
        [],
      ),
    ).not.toThrow();
  });

  it.each(['caPath', 'clientCertPath', 'privateKeyPath'] as const)(
    'passes for a %s equal to the stored path of the same field',
    (field) => {
      expect(() =>
        assertCredentialPathsAllowed({ [field]: '/old' }, createPickedCredentialPaths(), [{ [field]: '/old' }]),
      ).not.toThrow();
    },
  );

  it('passes when any one of several stored entries matches', () => {
    expect(() =>
      assertCredentialPathsAllowed({ privateKeyPath: '/k2' }, createPickedCredentialPaths(), [
        { privateKeyPath: '/k1' },
        {},
        { privateKeyPath: '/k2' },
      ]),
    ).not.toThrow();
  });

  it.each([
    ['caPath', ['tls', 'caPath']],
    ['clientCertPath', ['tls', 'clientCertPath']],
    ['privateKeyPath', ['ssh', 'privateKeyPath']],
  ] as const)('rejects an unpicked %s with the form field path', (field, path) => {
    const issues = issuesOf(() =>
      assertCredentialPathsAllowed({ [field]: '/evil' }, createPickedCredentialPaths(), []),
    );
    expect(issues).toEqual([{ path, message: expect.stringContaining('Browse') }]);
  });

  it('rejects a path picked for another purpose', () => {
    expect(issuesOf(() => assertCredentialPathsAllowed({ caPath: '/picked/id.key' }, picked, []))).toHaveLength(1);
  });

  it('rejects a stored path that belongs to another field', () => {
    const issues = issuesOf(() =>
      assertCredentialPathsAllowed({ clientCertPath: '/s' }, createPickedCredentialPaths(), [
        { caPath: '/s' },
      ]),
    );
    expect(issues.map((i) => i.path.join('.'))).toEqual(['tls.clientCertPath']);
  });

  it('lists every bad path, in form order, and keeps the good ones out', () => {
    const issues = issuesOf(() =>
      assertCredentialPathsAllowed(
        { caPath: '/bad1', clientCertPath: '/picked/client.pem', privateKeyPath: '/bad2' },
        picked,
        [],
      ),
    );
    expect(issues.map((i) => i.path.join('.'))).toEqual(['tls.caPath', 'ssh.privateKeyPath']);
  });

  it('carries a message on the error itself', () => {
    expect(() => assertCredentialPathsAllowed({ caPath: '/x' }, picked, [])).toThrow(/file picker/);
  });
});
