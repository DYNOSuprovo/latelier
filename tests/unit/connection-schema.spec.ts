import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import type { ConnectionInput } from '@shared/types';
import {
  applyCrossFieldRules,
  ConnectionInputSchema,
  ConnectionTestInputSchema,
  ConnectionUpdateSchema,
  ParseUriInputSchema,
} from '../../electron/ipc/schemas/connection';

function mk(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  const base: ConnectionInput = {
    name: 'Test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    authMech: 'none',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
  };
  return { ...base, ...overrides, tls: { ...base.tls, ...(overrides.tls ?? {}) } };
}

function issueAt(err: unknown, segment: string): boolean {
  if (!(err instanceof Error)) return false;
  // ZodError carries `.issues` on Zod v4.
  const issues = (err as unknown as { issues?: Array<{ path: (string | number)[] }> }).issues;
  if (!issues) return false;
  return issues.some((i) => i.path.includes(segment));
}

interface Issue {
  code: string;
  path: (string | number)[];
  message: string;
}

function getIssues(err: unknown): Issue[] {
  if (!(err instanceof Error)) return [];
  return (err as unknown as { issues?: Issue[] }).issues ?? [];
}

/** Catches the parse's throw and hands back the ZodError issues (empty array if it didn't throw). */
function parseIssues(fn: () => unknown): Issue[] {
  try {
    fn();
    return [];
  } catch (err) {
    return getIssues(err);
  }
}

/** Exact-path lookup — distinguishes a mutated path (e.g. `['tls', '']`) from the real one. */
function findIssue(issues: Issue[], path: (string | number)[]): Issue | undefined {
  return issues.find((i) => i.path.length === path.length && i.path.every((seg, idx) => seg === path[idx]));
}

describe('ConnectionInputSchema', () => {
  it('accepts a minimal valid none-auth input', () => {
    expect(() => ConnectionInputSchema.parse(mk())).not.toThrow();
  });

  it('rejects missing password on SCRAM', () => {
    const input = mk({ authMech: 'scram256', authUsername: 'alice' });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'password')).toBe(true);
    }
  });

  it('rejects missing username on SCRAM', () => {
    const input = mk({ authMech: 'scram256', password: 'pw' });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'authUsername')).toBe(true);
    }
  });

  it('rejects X.509 without TLS enabled', () => {
    const input = mk({
      authMech: 'x509',
      tls: { enabled: false, verify: true, clientCertPath: '/abs/client.pem' },
    });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'enabled')).toBe(true);
    }
  });

  it('rejects X.509 without client cert path', () => {
    const input = mk({
      authMech: 'x509',
      tls: { enabled: true, verify: true },
    });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'clientCertPath')).toBe(true);
    }
  });

  it('rejects AWS IAM without access key id', () => {
    const input = mk({ authMech: 'awsiam', password: 'secret' });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'authUsername')).toBe(true);
    }
  });

  it('rejects auth-mech=none with non-empty credentials', () => {
    const input = mk({ authMech: 'none', authUsername: 'alice' });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'authUsername')).toBe(true);
    }
  });

  it('rejects malformed color', () => {
    const input = mk({ color: 'red' });
    expect(() => ConnectionInputSchema.parse(input)).toThrow();
  });

  it('rejects out-of-range port', () => {
    const input = mk({ port: 0 });
    expect(() => ConnectionInputSchema.parse(input)).toThrow();
    const input2 = mk({ port: 70_000 });
    expect(() => ConnectionInputSchema.parse(input2)).toThrow();
  });

  it('rejects empty name', () => {
    const input = mk({ name: '' });
    expect(() => ConnectionInputSchema.parse(input)).toThrow();
  });

  it('rejects too-small timeout', () => {
    const input = mk({
      advanced: {
        ...mk().advanced,
        connectTimeoutMs: 10, // below 1000 minimum
      },
    });
    expect(() => ConnectionInputSchema.parse(input)).toThrow();
  });

  it('rejects relative TLS paths', () => {
    const input = mk({
      tls: { enabled: true, verify: true, caPath: 'relative/ca.pem' },
    });
    try {
      ConnectionInputSchema.parse(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(issueAt(err, 'caPath')).toBe(true);
    }
  });

  it('accepts absolute TLS paths', () => {
    const input = mk({
      tls: { enabled: true, verify: true, caPath: '/etc/ssl/ca.pem' },
    });
    expect(() => ConnectionInputSchema.parse(input)).not.toThrow();
  });

  it('rejects ssh.enabled because SSH tunnels are not supported yet', () => {
    const issues = parseIssues(() => ConnectionInputSchema.parse(mk({ ssh: { enabled: true } })));
    const issue = findIssue(issues, ['ssh', 'enabled']);
    expect(issue?.code).toBe('custom');
    expect(issue?.message).toBe('SSH tunnels are not supported yet');
  });
});

describe('ConnectionTestInputSchema', () => {
  it('accepts SCRAM without password (probe may test wrong creds)', () => {
    const input = mk({ authMech: 'scram256', authUsername: 'alice' });
    expect(() => ConnectionTestInputSchema.parse(input)).not.toThrow();
  });

  it('still requires TLS for X.509', () => {
    const input = mk({ authMech: 'x509', tls: { enabled: false, verify: true } });
    expect(() => ConnectionTestInputSchema.parse(input)).toThrow();
  });
});

describe('ConnectionUpdateSchema', () => {
  it('accepts empty patch', () => {
    expect(() => ConnectionUpdateSchema.parse({})).not.toThrow();
  });

  it('accepts partial patch with only color', () => {
    expect(() => ConnectionUpdateSchema.parse({ color: '#1A5068' })).not.toThrow();
  });

  it('allows clearPassword without requiring password', () => {
    expect(() =>
      ConnectionUpdateSchema.parse({ clearPassword: true }),
    ).not.toThrow();
  });

  it('still enforces X.509 TLS rule when authMech is set in patch', () => {
    expect(() =>
      ConnectionUpdateSchema.parse({
        authMech: 'x509',
        tls: { enabled: false, verify: true },
      }),
    ).toThrow();
  });

  it('rejects out-of-range port even inside a partial patch', () => {
    expect(() => ConnectionUpdateSchema.parse({ port: 0 })).toThrow();
    expect(() => ConnectionUpdateSchema.parse({ port: 70_000 })).toThrow();
  });

  it('accepts clearSshPassword / clearSshPassphrase flags alone', () => {
    expect(() =>
      ConnectionUpdateSchema.parse({ clearSshPassword: true, clearSshPassphrase: true }),
    ).not.toThrow();
  });
});

describe('boundary values', () => {
  it('accepts name at the 1 and 64 char limits, rejects 0 and 65', () => {
    expect(() => ConnectionInputSchema.parse(mk({ name: 'a' }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ name: 'a'.repeat(64) }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ name: '' }))).toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ name: 'a'.repeat(65) }))).toThrow();
  });

  it('accepts host at the 1 and 253 char limits, rejects 0 and 254', () => {
    expect(() => ConnectionInputSchema.parse(mk({ host: 'h' }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ host: 'h'.repeat(253) }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ host: '' }))).toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ host: 'h'.repeat(254) }))).toThrow();
  });

  it('accepts port at the 1 and 65535 limits, rejects 0 and 65536', () => {
    expect(() => ConnectionInputSchema.parse(mk({ port: 1 }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ port: 65_535 }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ port: 0 }))).toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ port: 65_536 }))).toThrow();
  });

  it('rejects a non-integer port', () => {
    expect(() => ConnectionInputSchema.parse(mk({ port: 27_017.5 }))).toThrow();
  });

  it('accepts advanced timeouts at the 1000ms and 600000ms limits, rejects outside', () => {
    const base = mk().advanced;
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...base, connectTimeoutMs: 1_000 } }),
      ),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...base, connectTimeoutMs: 600_000 } }),
      ),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(mk({ advanced: { ...base, connectTimeoutMs: 999 } })),
    ).toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...base, connectTimeoutMs: 600_001 } }),
      ),
    ).toThrow();
  });

  it('accepts maxPoolSize at the 1 and 500 limits, rejects 0 and 501', () => {
    const base = mk().advanced;
    expect(() =>
      ConnectionInputSchema.parse(mk({ advanced: { ...base, maxPoolSize: 1 } })),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(mk({ advanced: { ...base, maxPoolSize: 500 } })),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(mk({ advanced: { ...base, maxPoolSize: 0 } })),
    ).toThrow();
    expect(() =>
      ConnectionInputSchema.parse(mk({ advanced: { ...base, maxPoolSize: 501 } })),
    ).toThrow();
  });

  it('accepts appName at the 128 char limit, rejects 129', () => {
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...mk().advanced, appName: 'a'.repeat(128) } }),
      ),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...mk().advanced, appName: 'a'.repeat(129) } }),
      ),
    ).toThrow();
  });

  it('accepts defaultDb/authUsername/authDatabase at the 128 char limit, rejects 129', () => {
    expect(() => ConnectionInputSchema.parse(mk({ defaultDb: 'd'.repeat(128) }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ defaultDb: 'd'.repeat(129) }))).toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ authMech: 'none', authDatabase: 'd'.repeat(128) }),
      ),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ authMech: 'none', authDatabase: 'd'.repeat(129) }),
      ),
    ).toThrow();
  });

  it('rejects a 7-char hex color and a 3-char shorthand', () => {
    expect(() => ConnectionInputSchema.parse(mk({ color: '#1A6835F' }))).toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ color: '#1A6' }))).toThrow();
  });

  it('accepts every documented color hex digit case (upper and lower)', () => {
    expect(() => ConnectionInputSchema.parse(mk({ color: '#abcdef' }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ color: '#ABCDEF' }))).not.toThrow();
    expect(() => ConnectionInputSchema.parse(mk({ color: '#000000' }))).not.toThrow();
  });
});

describe('enums', () => {
  it('rejects an unknown connectionType', () => {
    expect(() =>
      ConnectionInputSchema.parse(mk({ connectionType: 'bogus' as never })),
    ).toThrow();
  });

  it('accepts both srv and standard connectionType', () => {
    expect(() => ConnectionInputSchema.parse(mk({ connectionType: 'srv' }))).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(mk({ connectionType: 'standard' })),
    ).not.toThrow();
  });

  it('rejects an unknown authMech', () => {
    expect(() => ConnectionInputSchema.parse(mk({ authMech: 'bogus' as never }))).toThrow();
  });

  it('rejects an unknown readPreference', () => {
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ advanced: { ...mk().advanced, readPreference: 'bogus' as never } }),
      ),
    ).toThrow();
  });

  it('accepts every documented readPreference value', () => {
    const values = [
      'primary',
      'primaryPreferred',
      'secondary',
      'secondaryPreferred',
      'nearest',
    ] as const;
    for (const readPreference of values) {
      expect(() =>
        ConnectionInputSchema.parse(mk({ advanced: { ...mk().advanced, readPreference } })),
      ).not.toThrow();
    }
  });

  it('rejects an unknown ssh authMethod', () => {
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ ssh: { enabled: false, host: 'h', username: 'u', authMethod: 'bogus' as never } }),
      ),
    ).toThrow();
  });

  it('accepts both ssh authMethod values', () => {
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ ssh: { enabled: false, host: 'h', username: 'u', authMethod: 'key' } }),
      ),
    ).not.toThrow();
    expect(() =>
      ConnectionInputSchema.parse(
        mk({ ssh: { enabled: false, host: 'h', username: 'u', authMethod: 'password' } }),
      ),
    ).not.toThrow();
  });
});

function without(field: string): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...mk() };
  delete obj[field];
  return obj;
}

describe('required vs optional fields', () => {
  it('defaults readOnly to false when omitted', () => {
    const parsed = ConnectionInputSchema.parse(without('readOnly'));
    expect(parsed.readOnly).toBe(false);
  });

  it('allows ssh to be entirely omitted', () => {
    expect(() => ConnectionInputSchema.parse(without('ssh'))).not.toThrow();
  });

  it('allows defaultDb, appName, and password to be omitted', () => {
    expect(() => ConnectionInputSchema.parse(without('defaultDb'))).not.toThrow();
  });

  it('rejects a missing required field (host)', () => {
    expect(() => ConnectionInputSchema.parse(without('host'))).toThrow();
  });

  it('rejects a missing required field (tls)', () => {
    expect(() => ConnectionInputSchema.parse(without('tls'))).toThrow();
  });
});

describe('unknown-key handling (no .strict() on this schema)', () => {
  it('silently strips keys not in the schema rather than rejecting them', () => {
    const input = { ...mk(), notAField: 'surprise' };
    const parsed = ConnectionInputSchema.parse(input);
    expect(parsed).not.toHaveProperty('notAField');
  });
});

describe('ParseUriInputSchema', () => {
  it('accepts a non-empty uri string', () => {
    expect(() => ParseUriInputSchema.parse({ uri: 'mongodb://localhost' })).not.toThrow();
  });

  it('rejects an empty uri string', () => {
    expect(() => ParseUriInputSchema.parse({ uri: '' })).toThrow();
  });

  it('rejects a missing uri field', () => {
    expect(() => ParseUriInputSchema.parse({})).toThrow();
  });
});

describe('property: every valid ConnectionInput round-trips through the schema', () => {
  it('parses a generated valid (name, host, port) combination back to itself', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 253 }).filter((s) => s.trim().length > 0),
        fc.integer({ min: 1, max: 65_535 }),
        (name, host, port) => {
          const input = mk({ name, host, port });
          const parsed = ConnectionInputSchema.parse(input);
          expect(parsed.name).toBe(name);
          expect(parsed.host).toBe(host);
          expect(parsed.port).toBe(port);
        },
      ),
    );
  });

  it('every generated appName within [0,128] chars parses back unchanged', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 128 }), (appName) => {
        const input = mk({ advanced: { ...mk().advanced, appName } });
        const parsed = ConnectionInputSchema.parse(input);
        expect(parsed.advanced.appName).toBe(appName);
      }),
    );
  });
});

describe('applyCrossFieldRules — exact issue shape and branch coverage', () => {
  // Rule 1: SCRAM (and 'default', which negotiates SCRAM) — username + (create-only) password.
  describe('rule 1: SCRAM / default auth', () => {
    it.each(['scram256', 'scram1', 'default'] as const)(
      'flags missing username for authMech=%s',
      (authMech) => {
        const issues = parseIssues(() =>
          ConnectionInputSchema.parse(mk({ authMech, password: 'pw' })),
        );
        const issue = findIssue(issues, ['authUsername']);
        expect(issue?.code).toBe('custom');
        expect(issue?.message).toBe('Username is required for password authentication');
      },
    );

    it('flags missing password on create for authMech=scram256', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'scram256', authUsername: 'alice' })),
      );
      const issue = findIssue(issues, ['password']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('Password is required for password authentication');
    });

    it('does NOT require password on update for authMech=scram256', () => {
      const issues = parseIssues(() =>
        ConnectionUpdateSchema.parse({ authMech: 'scram256', authUsername: 'alice' }),
      );
      expect(findIssue(issues, ['password'])).toBeUndefined();
    });

    it('raises no rule-1 issues once username and password are both present', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'scram256', authUsername: 'alice', password: 'pw' })),
      );
      expect(findIssue(issues, ['authUsername'])).toBeUndefined();
      expect(findIssue(issues, ['password'])).toBeUndefined();
    });

    it('does not apply rule 1 to an unrelated authMech', () => {
      const issues = parseIssues(() => ConnectionInputSchema.parse(mk({ authMech: 'awsiam' })));
      expect(
        issues.some((i) => i.message === 'Username is required for password authentication'),
      ).toBe(false);
    });
  });

  // Rule 2: X.509 — TLS enabled + client cert path.
  describe('rule 2: X.509 auth', () => {
    it('flags TLS not enabled', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(
          mk({ authMech: 'x509', tls: { enabled: false, verify: true, clientCertPath: '/a.pem' } }),
        ),
      );
      const issue = findIssue(issues, ['tls', 'enabled']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('X.509 authentication requires TLS');
    });

    it('flags missing client certificate path', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'x509', tls: { enabled: true, verify: true } })),
      );
      const issue = findIssue(issues, ['tls', 'clientCertPath']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('X.509 authentication requires a client certificate');
    });

    it('flags TLS not enabled when tls is entirely omitted from an update patch (optional chaining matters here)', () => {
      // Unlike ConnectionInputSchema, ConnectionUpdateSchema is `.partial()`, so `data.tls`
      // can genuinely be `undefined` when applyCrossFieldRules runs — this is the one call
      // site where `data.tls?.enabled` and `data.tls.enabled` are NOT equivalent: the latter
      // throws instead of reporting a validation issue.
      const issues = parseIssues(() => ConnectionUpdateSchema.parse({ authMech: 'x509' }));
      const enabledIssue = findIssue(issues, ['tls', 'enabled']);
      expect(enabledIssue?.message).toBe('X.509 authentication requires TLS');
      const certIssue = findIssue(issues, ['tls', 'clientCertPath']);
      expect(certIssue?.message).toBe('X.509 authentication requires a client certificate');
    });

    it('raises no rule-2 issues once TLS is enabled and a cert path is set', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(
          mk({ authMech: 'x509', tls: { enabled: true, verify: true, clientCertPath: '/a.pem' } }),
        ),
      );
      expect(findIssue(issues, ['tls', 'enabled'])).toBeUndefined();
      expect(findIssue(issues, ['tls', 'clientCertPath'])).toBeUndefined();
    });
  });

  // Rule 3: AWS IAM — access key id + (create-only) secret.
  describe('rule 3: AWS IAM auth', () => {
    it('flags missing access key id', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'awsiam', password: 'secret' })),
      );
      const issue = findIssue(issues, ['authUsername']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('AWS access key ID is required');
    });

    it('flags missing secret access key on create', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'awsiam', authUsername: 'AKIA...' })),
      );
      const issue = findIssue(issues, ['password']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('AWS secret access key is required');
    });

    it('does NOT require secret access key on update for authMech=awsiam', () => {
      const issues = parseIssues(() =>
        ConnectionUpdateSchema.parse({ authMech: 'awsiam', authUsername: 'AKIA...' }),
      );
      expect(findIssue(issues, ['password'])).toBeUndefined();
    });

    it('raises no rule-3 issues once access key id and secret are both present', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'awsiam', authUsername: 'AKIA...', password: 'secret' })),
      );
      expect(findIssue(issues, ['authUsername'])).toBeUndefined();
      expect(findIssue(issues, ['password'])).toBeUndefined();
    });
  });

  // Rule 4: authMech 'none' — auth fields must be empty.
  describe("rule 4: authMech='none'", () => {
    it('flags a non-empty username', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'none', authUsername: 'alice' })),
      );
      const issue = findIssue(issues, ['authUsername']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('Username must be empty when authentication is none');
    });

    it('flags a non-empty password', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ authMech: 'none', password: 'secret' })),
      );
      const issue = findIssue(issues, ['password']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('Password must be empty when authentication is none');
    });

    it('raises no rule-4 issues when both fields are empty', () => {
      const issues = parseIssues(() => ConnectionInputSchema.parse(mk({ authMech: 'none' })));
      expect(findIssue(issues, ['authUsername'])).toBeUndefined();
      expect(findIssue(issues, ['password'])).toBeUndefined();
    });
  });

  // Rule 5: absolute-path check, applied independently to three optional fields.
  describe('rule 5: absolute path checks', () => {
    it.each([
      ['tls.caPath', (v: string) => mk({ tls: { enabled: false, verify: true, caPath: v } }), ['tls', 'caPath']],
      [
        'tls.clientCertPath',
        (v: string) => mk({ authMech: 'none', tls: { enabled: false, verify: true, clientCertPath: v } }),
        ['tls', 'clientCertPath'],
      ],
      [
        'ssh.privateKeyPath',
        (v: string) => mk({ ssh: { enabled: false, privateKeyPath: v } }),
        ['ssh', 'privateKeyPath'],
      ],
    ] as const)('flags a relative %s', (_label, build, path) => {
      const issues = parseIssues(() => ConnectionInputSchema.parse(build('relative/path')));
      const issue = findIssue(issues, [...path]);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('Path must be absolute');
    });

    it('does not flag an absolute path', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ tls: { enabled: false, verify: true, caPath: '/etc/ca.pem' } })),
      );
      expect(findIssue(issues, ['tls', 'caPath'])).toBeUndefined();
    });

    it('does not flag an omitted path', () => {
      const issues = parseIssues(() => ConnectionInputSchema.parse(mk()));
      expect(findIssue(issues, ['tls', 'caPath'])).toBeUndefined();
    });

    it('does not flag an empty-string path (distinct from omitted)', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ tls: { enabled: false, verify: true, caPath: '' } })),
      );
      expect(findIssue(issues, ['tls', 'caPath'])).toBeUndefined();
    });
  });

  // Rule 6: SSH tunnels are unsupported, so ssh.enabled is rejected outright.
  describe('rule 6: SSH enabled is rejected', () => {
    it('flags ssh.enabled even when host and username are present', () => {
      const issues = parseIssues(() =>
        ConnectionInputSchema.parse(mk({ ssh: { enabled: true, host: 'h', username: 'u' } })),
      );
      const issue = findIssue(issues, ['ssh', 'enabled']);
      expect(issue?.code).toBe('custom');
      expect(issue?.message).toBe('SSH tunnels are not supported yet');
      expect(issues).toHaveLength(1);
    });

    it('raises no ssh issue when ssh.enabled is false', () => {
      const issues = parseIssues(() => ConnectionInputSchema.parse(mk({ ssh: { enabled: false } })));
      expect(findIssue(issues, ['ssh', 'enabled'])).toBeUndefined();
    });

    it('flags ssh.enabled on update', () => {
      const issues = parseIssues(() => ConnectionUpdateSchema.parse({ ssh: { enabled: true } }));
      const issue = findIssue(issues, ['ssh', 'enabled']);
      expect(issue?.message).toBe('SSH tunnels are not supported yet');
    });

    it('accepts an update that sets ssh.enabled to false', () => {
      expect(() => ConnectionUpdateSchema.parse({ ssh: { enabled: false } })).not.toThrow();
    });
  });
});

describe('ConnectionTestInputSchema — exact issue shape', () => {
  it('flags TLS not enabled for X.509 with the documented message and path', () => {
    const issues = parseIssues(() =>
      ConnectionTestInputSchema.parse(mk({ authMech: 'x509', tls: { enabled: false, verify: true } })),
    );
    const issue = findIssue(issues, ['tls', 'enabled']);
    expect(issue?.code).toBe('custom');
    expect(issue?.message).toBe('X.509 authentication requires TLS');
  });

  it('does not require a client cert path (unlike ConnectionInputSchema)', () => {
    const issues = parseIssues(() =>
      ConnectionTestInputSchema.parse(mk({ authMech: 'x509', tls: { enabled: true, verify: true } })),
    );
    expect(findIssue(issues, ['tls', 'clientCertPath'])).toBeUndefined();
  });

  it('does not flag TLS when it is already enabled', () => {
    const issues = parseIssues(() =>
      ConnectionTestInputSchema.parse(mk({ authMech: 'x509', tls: { enabled: true, verify: true } })),
    );
    expect(findIssue(issues, ['tls', 'enabled'])).toBeUndefined();
  });

  it('flags ssh.enabled because SSH tunnels are not supported yet', () => {
    const issues = parseIssues(() =>
      ConnectionTestInputSchema.parse(mk({ ssh: { enabled: true, host: 'h', username: 'u' } })),
    );
    const issue = findIssue(issues, ['ssh', 'enabled']);
    expect(issue?.code).toBe('custom');
    expect(issue?.message).toBe('SSH tunnels are not supported yet');
    expect(issues).toHaveLength(1);
  });

  it('raises no ssh issue when ssh.enabled is false', () => {
    const issues = parseIssues(() => ConnectionTestInputSchema.parse(mk({ ssh: { enabled: false } })));
    expect(findIssue(issues, ['ssh', 'enabled'])).toBeUndefined();
  });

  it('does not require a password for SCRAM even with no username', () => {
    expect(() =>
      ConnectionTestInputSchema.parse(mk({ authMech: 'scram256' })),
    ).not.toThrow();
  });
});

// C13: a Connection Export carries no secrets and no credential paths, and it
// stores each row as it was exported, so the 'import' mode drops exactly the
// rules those omissions would trip — and nothing else.
describe("applyCrossFieldRules — 'import' mode", () => {
  const importSchema = z
    .any()
    .superRefine((data, ctx) => applyCrossFieldRules(data, ctx, { mode: 'import' }));
  const importIssues = (input: Partial<ConnectionInput>) =>
    parseIssues(() => importSchema.parse(input));

  it.each(['scram256', 'scram1', 'default', 'awsiam'] as const)(
    'does not require a password for authMech=%s',
    (authMech) => {
      expect(importIssues(mk({ authMech, authUsername: 'alice' }))).toEqual([]);
    },
  );

  it('does not require a client certificate path for x509, but still requires TLS', () => {
    expect(importIssues(mk({ authMech: 'x509', tls: { enabled: true, verify: true } }))).toEqual([]);
    const issue = findIssue(
      importIssues(mk({ authMech: 'x509', tls: { enabled: false, verify: true } })),
      ['tls', 'enabled'],
    );
    expect(issue?.message).toBe('X.509 authentication requires TLS');
  });

  it('accepts ssh.enabled: true instead of rejecting the whole file', () => {
    expect(importIssues(mk({ ssh: { enabled: true, host: 'h', username: 'u' } }))).toEqual([]);
  });

  it('still enforces the username rules and authMech none', () => {
    expect(findIssue(importIssues(mk({ authMech: 'scram256' })), ['authUsername'])).toBeDefined();
    expect(findIssue(importIssues(mk({ authMech: 'awsiam' })), ['authUsername'])).toBeDefined();
    expect(
      findIssue(importIssues(mk({ authMech: 'none', authUsername: 'alice' })), ['authUsername']),
    ).toBeDefined();
  });
});
