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

describe('isSecretFieldPath', () => {
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
