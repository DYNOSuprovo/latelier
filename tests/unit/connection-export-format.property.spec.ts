import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Connection } from '@shared/types';
import {
  buildConnectionExport,
  decryptSelected,
  entryToConnectionInput,
  MAX_NAME_LENGTH,
  parseConnectionExport,
  planNames,
  toExportEntry,
  type ExportItem,
} from '../../electron/services/connectionExportFormat';
import { normalizeConnectionInput } from '../../electron/mongo/normalize';

// Real arbitraries over the whole entry-valid input space. Scrypt runs at the
// format's lowest allowed cost so a run stays fast; the cost itself is not
// what these properties are about.
const FAST = { N: 1024, r: 8, p: 1 };
const PASS = 'a passphrase of enough length';

const text = (max: number) => fc.string({ minLength: 1, maxLength: max }).filter((s) => s.trim() !== '');
const secret = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 30 });
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });

const authArb = fc.oneof(
  fc.constant({ authMech: 'none' as const, authUsername: undefined }),
  fc.record({
    authMech: fc.constantFrom('default', 'scram256', 'scram1', 'awsiam', 'x509'),
    authUsername: text(20),
  }),
);

const connectionArb: fc.Arbitrary<Connection> = fc
  .record({
    name: text(MAX_NAME_LENGTH),
    color: fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, '0')}`),
    connectionType: fc.constantFrom('srv', 'standard'),
    readOnly: fc.boolean(),
    host: text(40),
    port: fc.integer({ min: 1, max: 65_535 }),
    defaultDb: opt(text(20)),
    authDatabase: opt(text(20)),
    auth: authArb,
    tlsVerify: fc.boolean(),
    tlsEnabled: fc.boolean(),
    ssh: opt(
      fc.record({
        enabled: fc.boolean(),
        host: opt(text(20)),
        port: opt(fc.integer({ min: 1, max: 65_535 })),
        username: opt(text(20)),
        authMethod: opt(fc.constantFrom('key', 'password')),
      }),
    ),
    advanced: fc.record({
      connectTimeoutMs: fc.integer({ min: 1000, max: 600_000 }),
      socketTimeoutMs: fc.integer({ min: 1000, max: 600_000 }),
      serverSelectionTimeoutMs: fc.integer({ min: 1000, max: 600_000 }),
      readPreference: fc.constantFrom('primary', 'secondary', 'nearest'),
      maxPoolSize: fc.integer({ min: 1, max: 500 }),
      directConnection: fc.boolean(),
      appName: opt(text(30)),
    }),
  })
  .map(({ auth, tlsEnabled, tlsVerify, ...rest }) => ({
    ...rest,
    ...auth,
    // x509 is only valid over TLS.
    tls: { enabled: tlsEnabled || auth.authMech === 'x509', verify: tlsVerify },
    id: 'x',
    hasPasswordStored: false,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));

const itemArb: fc.Arbitrary<ExportItem> = fc
  .record({
    conn: connectionArb,
    secrets: opt(
      fc.record({ password: opt(secret), sshPassword: opt(secret), sshPassphrase: opt(secret) }),
    ),
  })
  .map(({ conn, secrets }) => ({ entry: toExportEntry(conn), secrets }));

const present = (secrets: ExportItem['secrets']) =>
  Object.fromEntries(Object.entries(secrets ?? {}).filter(([, v]) => v !== undefined));

describe('export → import round trip', () => {
  it('recovers every field and every secret, with or without a passphrase', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(itemArb, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        async (items, withSecrets) => {
          const given = items.map((i) => (withSecrets ? i : { entry: i.entry }));
          const file = parseConnectionExport(
            await buildConnectionExport({ items: given, passphrase: PASS, scrypt: FAST }),
          );
          const secrets = await decryptSelected(
            file,
            PASS,
            file.connections.map((_, i) => i),
          );
          file.connections.forEach((parsed, i) => {
            // Fields: exactly what went in (the file stores values as given;
            // normalization happens at create()).
            expect(entryToConnectionInput(parsed)).toEqual(entryToConnectionInput(items[i]!.entry));
            // Secrets: exactly the non-empty ones that went in, nothing else.
            const expected = withSecrets ? present(items[i]!.secrets) : {};
            expect(secrets.get(i) ?? {}).toEqual(expected);
          });
          // Nothing sealed → no encryption block.
          const anySecret = given.some((g) => Object.keys(present(g.secrets)).length > 0);
          expect(file.encryption === null).toBe(!anySecret);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('never writes a secret, a credential path or an id into the file text', async () => {
    await fc.assert(
      fc.asyncProperty(itemArb, async (item) => {
        const out = await buildConnectionExport({ items: [item], passphrase: PASS, scrypt: FAST });
        // Secrets legitimately appear, sealed, under `secrets`; everywhere else
        // their names (and the path/id names) must be absent.
        const file = JSON.parse(out) as { connections: Record<string, unknown>[] };
        for (const c of file.connections) delete c.secrets;
        const keys = new Set<string>();
        JSON.parse(JSON.stringify(file), function (key) {
          keys.add(key);
          return this[key];
        });
        for (const forbidden of [
          'password',
          'sshPassword',
          'sshPassphrase',
          'caPath',
          'clientCertPath',
          'privateKeyPath',
          'id',
          'createdAt',
        ]) {
          expect(keys.has(forbidden)).toBe(false);
        }
        // A short secret can occur inside unrelated JSON by chance, and a secret
        // equal to one of the entry's own fields (password "toString", host
        // "toString") is that field in the file, not a leak.
        const fields = JSON.stringify(item.entry);
        for (const value of Object.values(present(item.secrets)) as string[]) {
          if (value.length >= 8 && !fields.includes(value)) expect(out).not.toContain(value);
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe('planNames', () => {
  const nameArb = fc.constantFrom(
    'Prod',
    'Prod (2)',
    'Dev',
    '  Prod  ',
    'Prod   East',
    'x'.repeat(MAX_NAME_LENGTH),
    `${'y'.repeat(MAX_NAME_LENGTH - 1)} `,
    'a (2)',
  );

  it('yields pairwise-unique names, disjoint from the existing set, within the length limit', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('Prod', 'Prod (2)', 'Prod (3)', 'Dev', 'x'.repeat(MAX_NAME_LENGTH)), { maxLength: 5 }),
        fc.array(nameArb, { minLength: 1, maxLength: 8 }),
        (existing, names) => {
          const planned = planNames(existing, names);
          expect(planned).toHaveLength(names.length);
          expect(new Set(planned).size).toBe(planned.length);
          for (const p of planned) {
            expect(existing).not.toContain(p);
            expect(p.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
            // create() normalizes: a planned name must already be its own normal form.
            expect(normalizeConnectionInput({ name: p }).name).toBe(p);
          }
        },
      ),
    );
  });

  it('only changes a name by appending " (n)" to its normalized form', () => {
    fc.assert(
      fc.property(fc.array(nameArb, { minLength: 1, maxLength: 8 }), (names) => {
        const planned = planNames([], names);
        planned.forEach((p, i) => {
          const base = normalizeConnectionInput({ name: names[i]! }).name;
          const suffix = / \((\d+)\)$/.exec(p);
          if (p === base) return;
          expect(suffix).not.toBeNull();
          expect(base.startsWith(p.slice(0, suffix!.index))).toBe(true);
        });
      }),
    );
  });
});
