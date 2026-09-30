import { describe, it, expect } from 'vitest';
import { redactSecrets, isSecretFieldPath } from '../../electron/log';

describe('redactSecrets', () => {
  it('redacts top-level password fields', () => {
    const out = redactSecrets({ user: 'alice', password: 'hunter2' });
    expect(out).toEqual({ user: 'alice', password: '<redacted>' });
  });

  it('redacts pwd anywhere in the tree', () => {
    const out = redactSecrets({
      cmd: { createUser: 'alice', pwd: 'hunter2', roles: [] },
    });
    expect(out).toEqual({
      cmd: { createUser: 'alice', pwd: '<redacted>', roles: [] },
    });
  });

  it('redacts case-insensitively (Password / PWD)', () => {
    const out = redactSecrets({ Password: 'a', PWD: 'b' });
    expect(out).toEqual({ Password: '<redacted>', PWD: '<redacted>' });
  });

  it('redacts sshPassword and sshPassphrase too', () => {
    const out = redactSecrets({
      sshPassword: 'a',
      sshPassphrase: 'b',
      benign: 'c',
    });
    expect(out).toEqual({
      sshPassword: '<redacted>',
      sshPassphrase: '<redacted>',
      benign: 'c',
    });
  });

  it('walks arrays of objects', () => {
    const out = redactSecrets({
      users: [
        { user: 'alice', password: 'a' },
        { user: 'bob', password: 'b' },
      ],
    });
    expect(out).toEqual({
      users: [
        { user: 'alice', password: '<redacted>' },
        { user: 'bob', password: '<redacted>' },
      ],
    });
  });

  it('passes through primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('handles cyclic references without infinite recursion', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
  });

  it('replaces a cyclic self-reference with a circular marker, not the original object', () => {
    const a: Record<string, unknown> = { name: 'a', password: 'hunter2' };
    a.self = a;
    const out = redactSecrets(a) as Record<string, unknown>;
    expect(out).toEqual({ name: 'a', password: '<redacted>', self: '[Circular]' });
  });

  it('redacts a non-string value under a redacted key too', () => {
    const out = redactSecrets({ password: 12345 });
    expect(out).toEqual({ password: '<redacted>' });
  });

  it('redacts a secret reached through every alias of a shared (non-cyclic) reference', () => {
    const shared = { password: 'hunter2' };
    const out = redactSecrets({ first: shared, second: shared }) as Record<string, unknown>;
    expect(out).toEqual({
      first: { password: '<redacted>' },
      second: { password: '<redacted>' },
    });
  });
});

const NEW_SECRET_KEYS = [
  'passphrase', 'secret', 'token', 'apiKey', 'authorization', 'ssh_password', 'ssh_passphrase',
];

describe('redactSecrets: extended secret keys', () => {
  it.each(NEW_SECRET_KEYS)('redacts %s, case-insensitively, at any depth', (key) => {
    const out = redactSecrets({ keep: 'x', [key]: 'v', nested: [{ [key.toUpperCase()]: 'v' }] });
    expect(out).toEqual({ keep: 'x', [key]: '<redacted>', nested: [{ [key.toUpperCase()]: '<redacted>' }] });
  });
});

describe('redactSecrets: credentials inside strings', () => {
  it('masks URI userinfo in a bare string', () => {
    expect(redactSecrets('mongodb://alice:hunter2@host:27017/db')).toBe('mongodb://***@host:27017/db');
  });

  it('masks mongodb+srv and an uppercase scheme', () => {
    expect(redactSecrets('MongoDB+SRV://a:b@cluster.example.net/x')).toBe('MongoDB+SRV://***@cluster.example.net/x');
  });

  it('masks through to the last @ so an unencoded @ in the password leaves no tail', () => {
    expect(redactSecrets('mongodb://u:p@ss@host/db')).toBe('mongodb://***@host/db');
  });

  it('masks every URI in one string and stops at whitespace', () => {
    const out = redactSecrets('a mongodb://u1:p1@h1 b mongodb://u2:p2@h2/db c');
    expect(out).toBe('a mongodb://***@h1 b mongodb://***@h2/db c');
  });

  it('does not touch a URI without userinfo, nor a path that holds an @', () => {
    expect(redactSecrets('mongodb://host:27017/db@x')).toBe('mongodb://host:27017/db@x');
    expect(redactSecrets('mongodb://host/')).toBe('mongodb://host/');
  });

  it('masks strings nested in objects and arrays', () => {
    const out = redactSecrets({ err: { message: ['x mongodb://u:p@h y'] } });
    expect(out).toEqual({ err: { message: ['x mongodb://***@h y'] } });
  });

  it('stays fast on a long userinfo-less run', () => {
    const big = `mongodb://${'a'.repeat(200_000)}`;
    const start = Date.now();
    expect(redactSecrets(big)).toBe(big);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('isSecretFieldPath', () => {
  it.each(NEW_SECRET_KEYS)('flags the new key %s', (key) => {
    expect(isSecretFieldPath(key)).toBe(true);
    expect(isSecretFieldPath(`auth.${key.toUpperCase()}`)).toBe(true);
  });

  it('flags a top-level secret key', () => {
    expect(isSecretFieldPath('password')).toBe(true);
    expect(isSecretFieldPath('pwd')).toBe(true);
    expect(isSecretFieldPath('sshPassword')).toBe(true);
    expect(isSecretFieldPath('sshPassphrase')).toBe(true);
  });

  it('flags a secret key at any dotted depth', () => {
    expect(isSecretFieldPath('auth.password')).toBe(true);
    expect(isSecretFieldPath('user.cmd.pwd')).toBe(true);
  });

  it('is case-insensitive per segment', () => {
    expect(isSecretFieldPath('Auth.PASSWORD')).toBe(true);
  });

  it('does not flag a benign path, including one that merely contains "password" as a substring', () => {
    expect(isSecretFieldPath('user.email')).toBe(false);
    expect(isSecretFieldPath('passwordHint')).toBe(false);
  });
});
