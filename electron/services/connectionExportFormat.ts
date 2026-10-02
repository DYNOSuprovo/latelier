import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Connection, ConnectionInput, ExportSecretField, RepickFile } from '@shared/types';
import { BadPassphraseError, ValidationError } from '../errors.ts';
import { normalizeConnectionInput } from '../mongo/normalize.ts';
import {
  AdvancedSchema,
  applyCrossFieldRules,
  BaseInputShape,
  SshObjectSchema,
  TlsSchema,
} from '../ipc/schemas/connection.ts';

/**
 * The Connection Export file (C13): pure parsing, validation, secret
 * encryption and name planning. No I/O and no Electron, so it can be exercised
 * (and mutation-tested) without a window or a database.
 */

export const EXPORT_FORMAT = 'latelier.connection-export';
export const EXPORT_VERSION = 1;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_NAME_LENGTH = 64;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
export const DEFAULT_SCRYPT: ScryptParams = { N: 131_072, r: 8, p: 1 };

/** Vault field name for each exported secret. */
export const SECRET_FIELDS: readonly ExportSecretField[] = [
  'password',
  'sshPassword',
  'sshPassphrase',
];

const NOT_AN_EXPORT_MESSAGE = "This file isn't a L'Atelier Connection Export.";
const NEWER_VERSION_MESSAGE =
  "This file was made by a newer version of L'Atelier. Update to import it.";
const DAMAGED_MESSAGE = 'This file is damaged: a saved password in it could not be decrypted.';

// ─── schema ──────────────────────────────────────────────────────────────────

/** Decoded size is checked too: z.base64() alone accepts any length. */
const b64Bytes = (bytes: number) =>
  z
    .base64()
    .refine((s) => Buffer.from(s, 'base64').length === bytes, `must decode to ${bytes} bytes`);

const SealedSchema = z.strictObject({
  iv: b64Bytes(12),
  ct: z.base64().min(1).max(65_536),
  tag: b64Bytes(16),
});

// Bounds are a memory/CPU guard, not a format rule: the file chooses the cost
// of the scrypt run on the importer's machine, so a crafted one must not be
// able to ask for gigabytes. The default (N=2^17, r=8) sits at half the cap.
const MAX_N_TIMES_R = 2 ** 21;
const EncryptionSchema = z
  .strictObject({
    kdf: z.literal('scrypt'),
    salt: b64Bytes(16),
    N: z
      .number()
      .int()
      .min(1024)
      .max(MAX_N_TIMES_R)
      .refine((n) => (n & (n - 1)) === 0, 'N must be a power of 2'),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(4),
    cipher: z.literal('aes-256-gcm'),
  })
  .refine((e) => e.N * e.r <= MAX_N_TIMES_R, 'scrypt cost (N × r) is too high');

const EntrySchema = z
  .strictObject(BaseInputShape)
  // The three secrets are only ever carried sealed, and credential paths are
  // never carried at all (a path from a stranger's file is the attack C13 §4.3
  // exists to prevent) — so none of them is a field an entry may have.
  .omit({ password: true, sshPassword: true, sshPassphrase: true })
  .extend({
    tls: TlsSchema.omit({ caPath: true, clientCertPath: true }).strict(),
    ssh: SshObjectSchema.omit({ privateKeyPath: true }).strict().optional(),
    advanced: AdvancedSchema.strict(),
    repick: z.array(z.enum(['tlsCa', 'tlsClientCert', 'sshKey'])).max(3).optional(),
    secrets: z
      .strictObject({
        password: SealedSchema.optional(),
        sshPassword: SealedSchema.optional(),
        sshPassphrase: SealedSchema.optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    applyCrossFieldRules(data as Partial<ConnectionInput>, ctx, { mode: 'import' });
    // create() normalizes before inserting, so a name or host that is only
    // whitespace would reach the table empty.
    const normalized = normalizeConnectionInput(data);
    if (normalized.name === '') {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Name must not be blank' });
    }
    if (normalized.host === '') {
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'Host must not be blank' });
    }
  });

const ExportFileSchema = z
  .strictObject({
    format: z.literal(EXPORT_FORMAT),
    // Above EXPORT_VERSION is refused earlier, with its own message.
    version: z.number().min(1),
    exportedAt: z.iso.datetime(),
    encryption: EncryptionSchema.nullable(),
    connections: z.array(EntrySchema).min(1).max(1000),
  })
  .superRefine((file, ctx) => {
    const anySecrets = file.connections.some((c) => c.secrets !== undefined);
    if (file.encryption === null && anySecrets) {
      ctx.addIssue({
        code: 'custom',
        path: ['encryption'],
        message: 'A file with encrypted secrets must record how they were encrypted',
      });
    }
  });

export type ExportEntry = z.infer<typeof EntrySchema>;
export type ParsedExport = z.infer<typeof ExportFileSchema>;
export type SecretValues = Partial<Record<ExportSecretField, string>>;

/** Throws `ValidationError` for anything that is not a Connection Export this build can read. */
export function parseConnectionExport(text: string): ParsedExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError("This file isn't valid JSON.");
  }
  // A primitive or an array has no `format`, so it fails the check below too.
  const head = (raw ?? {}) as { format?: unknown; version?: unknown };
  if (head.format !== EXPORT_FORMAT) throw new ValidationError(NOT_AN_EXPORT_MESSAGE);
  if (typeof head.version === 'number' && head.version > EXPORT_VERSION) {
    throw new ValidationError(NEWER_VERSION_MESSAGE);
  }
  const result = ExportFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path, message: i.message }));
    const first = issues[0]!;
    throw new ValidationError(
      `Invalid Connection Export at ${first.path.join('.') || '(root)'}: ${first.message}`,
      { issues },
    );
  }
  return result.data;
}

// ─── Connection ⇄ entry ──────────────────────────────────────────────────────

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Drops the id, timestamps, `has*Stored` flags and the three credential paths. */
export function toExportEntry(conn: Connection): ExportEntry {
  const repick: RepickFile[] = [];
  if (conn.tls.caPath) repick.push('tlsCa');
  if (conn.tls.clientCertPath) repick.push('tlsClientCert');
  if (conn.ssh?.privateKeyPath) repick.push('sshKey');
  return defined({
    name: conn.name,
    color: conn.color,
    connectionType: conn.connectionType,
    readOnly: conn.readOnly,
    host: conn.host,
    port: conn.port,
    defaultDb: conn.defaultDb,
    authMech: conn.authMech,
    authUsername: conn.authUsername,
    authDatabase: conn.authDatabase,
    tls: { enabled: conn.tls.enabled, verify: conn.tls.verify },
    ssh: conn.ssh
      ? defined({
          enabled: conn.ssh.enabled,
          host: conn.ssh.host,
          port: conn.ssh.port,
          username: conn.ssh.username,
          authMethod: conn.ssh.authMethod,
        })
      : undefined,
    advanced: defined({ ...conn.advanced }),
    repick: repick.length > 0 ? repick : undefined,
  });
}

/** A secret-free `ConnectionInput`: secrets are stored separately, after the row exists. */
export function entryToConnectionInput(entry: ExportEntry): ConnectionInput {
  const input: Record<string, unknown> = { ...entry };
  delete input.repick;
  delete input.secrets;
  return input as unknown as ConnectionInput;
}

// ─── crypto ──────────────────────────────────────────────────────────────────

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Node's default `maxmem` (32 MiB) is below what the default N needs, so it is sized to the cost. */
async function deriveKey(passphrase: string, salt: Buffer, { N, r, p }: ScryptParams) {
  return scryptAsync(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r });
}

type Sealed = z.infer<typeof SealedSchema>;

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Throws on a failed GCM authentication; the caller decides what that means. */
function open(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export interface ExportItem {
  entry: ExportEntry;
  secrets?: SecretValues;
}

/**
 * Serializes the file. The key is derived once for the whole file, from a fresh
 * salt; `encryption` is `null` unless at least one secret is actually included.
 */
export async function buildConnectionExport(opts: {
  items: ExportItem[];
  passphrase?: string;
  now?: Date;
  scrypt?: ScryptParams;
}): Promise<string> {
  const { items, passphrase, now = new Date(), scrypt: params = DEFAULT_SCRYPT } = opts;
  const hasSecrets = items.some((i) =>
    SECRET_FIELDS.some((f) => (i.secrets?.[f] ?? '') !== ''),
  );
  let encryption: ParsedExport['encryption'] = null;
  let key: Buffer | null = null;
  if (hasSecrets) {
    if (!passphrase) throw new ValidationError('An Export Passphrase is required to include passwords');
    const salt = randomBytes(16);
    key = await deriveKey(passphrase, salt, params);
    encryption = {
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      ...params,
      cipher: 'aes-256-gcm',
    };
  }
  const connections = items.map(({ entry, secrets }) => {
    const sealed: NonNullable<ExportEntry['secrets']> = {};
    for (const field of SECRET_FIELDS) {
      const value = secrets?.[field];
      if (key && value) sealed[field] = seal(key, value);
    }
    return Object.keys(sealed).length > 0 ? { ...entry, secrets: sealed } : entry;
  });
  const file: ParsedExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    encryption,
    connections,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Decrypts the secrets of the selected entries, or throws before returning any
 * so the caller can write nothing. The key comes from the file's own recorded
 * parameters. A failure on the first secret is indistinguishable from a wrong
 * passphrase (GCM has no separate check value), so it is reported as one; a
 * failure after one succeeded proves the passphrase, so the file is damaged.
 */
export async function decryptSelected(
  file: ParsedExport,
  passphrase: string | undefined,
  indices: readonly number[],
): Promise<Map<number, SecretValues>> {
  const out = new Map<number, SecretValues>();
  const withSecrets = indices.flatMap((i) => {
    const sealed = file.connections[i]?.secrets;
    return sealed ? [{ i, sealed }] : [];
  });
  if (withSecrets.length === 0) return out;
  if (!passphrase) throw new ValidationError('An Export Passphrase is required to import passwords');
  const enc = file.encryption;
  if (enc === null) throw new ValidationError(NOT_AN_EXPORT_MESSAGE);
  const key = await deriveKey(passphrase, Buffer.from(enc.salt, 'base64'), enc);
  let passphraseProven = false;
  for (const { i, sealed } of withSecrets) {
    const values: SecretValues = {};
    for (const field of SECRET_FIELDS) {
      const one = sealed[field];
      if (!one) continue;
      try {
        values[field] = open(key, one);
        passphraseProven = true;
      } catch {
        if (!passphraseProven) throw new BadPassphraseError('Wrong Export Passphrase.');
        throw new ValidationError(DAMAGED_MESSAGE);
      }
    }
    out.set(i, values);
  }
  return out;
}

// ─── name planning ───────────────────────────────────────────────────────────

/** `name`, or `name (2)`, `name (3)`… (cut so the result stays within the name limit). */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The name each imported entry will be saved under. Normalized first, because
 * `create()` normalizes too and the planned name must be the stored one; each
 * assigned name joins the taken set, which also resolves clashes inside one
 * file. Case-sensitive, like the table's unique index.
 */
export function planNames(existing: Iterable<string>, names: readonly string[]): string[] {
  const taken = new Set(existing);
  return names.map((raw) => {
    const name = uniqueName(normalizeConnectionInput({ name: raw }).name, taken);
    taken.add(name);
    return name;
  });
}
