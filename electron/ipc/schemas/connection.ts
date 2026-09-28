import path from 'node:path';
import { z } from 'zod';
import type { ConnectionInput, ConnectionUpdate } from '@shared/types';
import { HexColor, Port } from '../validators.ts';

/**
 * Runtime validation for connection inputs. Cross-field rules (SCRAM requires
 * password, X.509 requires TLS, etc.) are enforced via superRefine so the
 * error path points at the offending field.
 */

const AuthMechSchema = z.enum(['default', 'scram256', 'scram1', 'x509', 'awsiam', 'none']);
const ConnTypeSchema = z.enum(['srv', 'standard']);
const ReadPrefSchema = z.enum([
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
]);
const SshAuthSchema = z.enum(['key', 'password']);

const TlsSchema = z.object({
  enabled: z.boolean(),
  verify: z.boolean(),
  caPath: z.string().optional(),
  clientCertPath: z.string().optional(),
});

const SshSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().optional(),
    port: Port.optional(),
    username: z.string().optional(),
    authMethod: SshAuthSchema.optional(),
    privateKeyPath: z.string().optional(),
  })
  .optional();

const AdvancedSchema = z.object({
  connectTimeoutMs: z.number().int().min(1000).max(600_000),
  socketTimeoutMs: z.number().int().min(1000).max(600_000),
  serverSelectionTimeoutMs: z.number().int().min(1000).max(600_000),
  readPreference: ReadPrefSchema,
  maxPoolSize: z.number().int().min(1).max(500),
  directConnection: z.boolean(),
  appName: z.string().max(128).optional(),
});

const BaseInputShape = {
  name: z.string().min(1).max(64),
  color: HexColor,
  connectionType: ConnTypeSchema,
  host: z.string().min(1).max(253),
  port: Port,
  defaultDb: z.string().max(128).optional(),
  authMech: AuthMechSchema,
  authUsername: z.string().max(128).optional(),
  authDatabase: z.string().max(128).optional(),
  tls: TlsSchema,
  ssh: SshSchema,
  advanced: AdvancedSchema,
  password: z.string().optional(),
  sshPassword: z.string().optional(),
  sshPassphrase: z.string().optional(),
  readOnly: z.boolean().default(false),
} as const;

/**
 * Cross-field validation. Attaches errors with the specific field path so the
 * UI can highlight the right input.
 */
function applyCrossFieldRules(
  data: Partial<ConnectionInput>,
  ctx: z.RefinementCtx,
  opts: { mode: 'create' | 'update'; existingPasswordStored?: boolean },
): void {
  // 1. SCRAM (and 'default', which negotiates SCRAM) require a username and
  //    (on create) a password.
  if (
    data.authMech === 'scram256' ||
    data.authMech === 'scram1' ||
    data.authMech === 'default'
  ) {
    if (!data.authUsername) {
      ctx.addIssue({
        code: 'custom',
        path: ['authUsername'],
        message: 'Username is required for password authentication',
      });
    }
    if (opts.mode === 'create' && !data.password) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password is required for password authentication',
      });
    }
  }

  // 2. X.509 needs TLS enabled + a client certificate path.
  if (data.authMech === 'x509') {
    if (!data.tls?.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls', 'enabled'],
        message: 'X.509 authentication requires TLS',
      });
    }
    if (!data.tls?.clientCertPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls', 'clientCertPath'],
        message: 'X.509 authentication requires a client certificate',
      });
    }
  }

  // 3. AWS IAM needs username (access key id) and (on create) password (secret).
  if (data.authMech === 'awsiam') {
    if (!data.authUsername) {
      ctx.addIssue({
        code: 'custom',
        path: ['authUsername'],
        message: 'AWS access key ID is required',
      });
    }
    if (opts.mode === 'create' && !data.password) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'AWS secret access key is required',
      });
    }
  }

  // 4. authMech 'none': auth fields must be empty.
  if (data.authMech === 'none') {
    if (data.authUsername) {
      ctx.addIssue({
        code: 'custom',
        path: ['authUsername'],
        message: 'Username must be empty when authentication is none',
      });
    }
    if (data.password) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must be empty when authentication is none',
      });
    }
  }

  // 5. Absolute path check on optional file paths.
  const absOrThrow = (value: string | undefined, ppath: (string | number)[]) => {
    if (value !== undefined && value !== '' && !path.isAbsolute(value)) {
      ctx.addIssue({
        code: 'custom',
        path: ppath,
        message: 'Path must be absolute',
      });
    }
  };
  absOrThrow(data.tls?.caPath, ['tls', 'caPath']);
  absOrThrow(data.tls?.clientCertPath, ['tls', 'clientCertPath']);
  absOrThrow(data.ssh?.privateKeyPath, ['ssh', 'privateKeyPath']);

  // 6. SSH: if enabled, host and username required.
  if (data.ssh?.enabled) {
    if (!data.ssh.host) {
      ctx.addIssue({
        code: 'custom',
        path: ['ssh', 'host'],
        message: 'SSH host is required when SSH is enabled',
      });
    }
    if (!data.ssh.username) {
      ctx.addIssue({
        code: 'custom',
        path: ['ssh', 'username'],
        message: 'SSH username is required when SSH is enabled',
      });
    }
  }
}

export const ConnectionInputSchema: z.ZodType<ConnectionInput> = z
  .object(BaseInputShape)
  .superRefine((data, ctx) => applyCrossFieldRules(data, ctx, { mode: 'create' }));

/**
 * Variant used for conn:test: never requires a password, because probes are
 * how users discover that their credentials don't work. Other cross-field
 * rules (X.509 needs TLS, SSH requires host/user, etc.) still apply.
 */
export const ConnectionTestInputSchema: z.ZodType<ConnectionInput> = z
  .object(BaseInputShape)
  .superRefine((data, ctx) => {
    if (data.authMech === 'x509') {
      // Stryker disable next-line OptionalChaining: `tls` is a required (non-.optional())
      // field of BaseInputShape here (unlike the partial ConnectionUpdateSchema), and zod's
      // superRefine never runs when a required field failed its own shape check — verified
      // with a node probe: a `tls`-omitting input never reaches this callback at all, it
      // fails on the base "expected object, received undefined" issue first. So `data.tls`
      // is always a real object whenever this line executes; `?.` and `.` are equivalent here.
      if (!data.tls?.enabled) {
        ctx.addIssue({
          code: 'custom',
          path: ['tls', 'enabled'],
          message: 'X.509 authentication requires TLS',
        });
      }
    }
    if (data.ssh?.enabled) {
      if (!data.ssh.host) {
        ctx.addIssue({
          code: 'custom',
          path: ['ssh', 'host'],
          message: 'SSH host is required when SSH is enabled',
        });
      }
    }
  });

export const ConnectionUpdateSchema: z.ZodType<ConnectionUpdate> = z
  .object({
    ...BaseInputShape,
    clearPassword: z.boolean().optional(),
    clearSshPassword: z.boolean().optional(),
    clearSshPassphrase: z.boolean().optional(),
  })
  .partial()
  // Stryker disable next-line ObjectLiteral,StringLiteral: `opts.mode` is only ever read via `opts.mode === 'create'` inside applyCrossFieldRules — verified with a node probe that `{ mode: 'update' }`, `{}`, and `{ mode: '' }` all evaluate that comparison to `false` identically, so which literal is passed here doesn't change behavior.
  .superRefine((data, ctx) => applyCrossFieldRules(data as Partial<ConnectionInput>, ctx, { mode: 'update' }));

export const ParseUriInputSchema = z.object({
  uri: z.string().min(1),
});
