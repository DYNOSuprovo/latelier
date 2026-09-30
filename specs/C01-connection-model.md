# C01 — Connection model, URI parser, validation

## Purpose

Define the canonical `Connection` type used everywhere, the input shape used to create/update one, the rules for normalizing a pasted `mongodb://`/`mongodb+srv://` URI into that input, and the validation that guards both form submission and IPC payloads.

## Scope

- **In**: `Connection`, `ConnectionInput`, `ConnectionUpdate`, `ConnectionSummary` types; URI → input parser; Zod schemas.
- **Out**: DB persistence (C02), UI (C03), probing (C04).

## Dependencies

- F01 (conventions), F02 (SQL columns that mirror these types).

## 1. Types

```ts
// shared/types.ts
export type AuthMech   = 'default' | 'scram256' | 'scram1' | 'x509' | 'awsiam' | 'none';
export type ConnType   = 'srv' | 'standard';
export type ReadPref   = 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
export type SshAuth    = 'key' | 'password';

export interface Connection {
  id: string;
  name: string;
  color: string;                 // '#rrggbb'
  connectionType: ConnType;

  host: string;
  port: number;                  // ignored for srv
  defaultDb?: string;

  authMech: AuthMech;
  authUsername?: string;         // required iff authMech ∈ scram*, awsiam
  authDatabase?: string;         // default 'admin' for scram*

  tls: {
    enabled: boolean;
    verify: boolean;
    caPath?: string;
    clientCertPath?: string;
  };

  ssh?: {                        // SSH deferred — schema present but `enabled: false`
    enabled: boolean;
    host?: string;
    port?: number;
    username?: string;
    authMethod?: SshAuth;
    privateKeyPath?: string;
  };

  advanced: {
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    serverSelectionTimeoutMs: number;
    readPreference: ReadPref;
    maxPoolSize: number;
    directConnection: boolean;
    appName?: string;
  };

  hasPasswordStored: boolean;    // derived from SecretsVault.has — never the plaintext
  hasSshPasswordStored: boolean;
  hasSshPassphraseStored: boolean;

  createdAt: string;             // ISO
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ConnectionInput extends Omit<Connection,
  'id' | 'hasPasswordStored' | 'hasSshPasswordStored' | 'hasSshPassphraseStored' |
  'createdAt' | 'updatedAt' | 'lastUsedAt'
> {
  password?: string;             // plaintext; main writes to SecretsVault on save
  sshPassword?: string;
  sshPassphrase?: string;
}

export type ConnectionUpdate = Partial<ConnectionInput> & {
  clearPassword?: boolean;
  clearSshPassword?: boolean;
  clearSshPassphrase?: boolean;
};

export interface ConnectionSummary {
  id: string;
  name: string;
  color: string;
  host: string;
  port: number;
  connectionType: ConnType;
  lastUsedAt?: string;
  status: 'unknown' | 'connected' | 'disconnected' | 'error';
  serverVersion?: string;        // cached from last successful connect
}
```

## 2. Validation

Zod schemas live in `electron/ipc/validators.ts`:

```ts
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Host  = z.string().min(1).max(253).regex(/^[A-Za-z0-9.\-+:/]+$/);
const Port  = z.number().int().min(1).max(65535);

const TlsBlock = z.object({
  enabled: z.boolean(),
  verify:  z.boolean(),
  caPath:  z.string().optional(),
  clientCertPath: z.string().optional(),
});

// … ConnectionInputSchema composes these.
```

**Rules that cross fields** (enforced via `superRefine`):
- If `connectionType === 'srv'`: `port` must equal 27017 (placeholder; ignored at build time) and `host` must not contain a port.
- If `authMech ∈ {default, scram256, scram1}`: `authUsername` and `password` required (unless update clears). `default` emits no `authMechanism` query param so the driver negotiates via SASL `saslSupportedMechs` (matches `mongosh` / Compass behavior when authMechanism is absent).
- If `authMech === 'x509'`: `tls.enabled` must be true and `tls.clientCertPath` required.
- If `authMech === 'awsiam'`: `authUsername` (access key id) and `password` (secret) required.
- If `authMech === 'none'`: `authUsername`, `authDatabase`, `password` must be absent or empty.
- `name` must be unique per user; DB uniqueness is enforced by C02 and surfaced as `CONFLICT`.
- Port range 1–65535.
- Timeouts ≥ 1000 ms and ≤ 600 000 ms.
- `maxPoolSize` 1–500.
- If `tls.caPath` / `tls.clientCertPath` / `ssh.privateKeyPath` are present, they must be absolute paths. Existence is **not** checked at save time — validation only catches malformed strings; real failures surface at connect/probe time with a helpful error.
- `ssh.enabled: true` is rejected (`VALIDATION`, field `ssh.enabled`) on create, update and test until SSH tunnels exist. `MongoPool.connect()` also refuses a stored `ssh_enabled = 1` row with the same error rather than connecting directly, so legacy data can never bypass the tunnel. The edit form loads such a row with the toggle off and sends `ssh: { enabled: false }`, which clears the stored flag on the next save.
- **When SSH is built, server host-key verification (known_hosts or pinning) is a hard requirement**, not an option: an unverified tunnel endpoint defeats the point of the tunnel.

## 3. URI parser

Accepts pasted connection strings and fills the form. Does NOT itself persist anything.

```ts
// electron/mongo/uri.ts
export function parseConnectionUri(uri: string): Partial<ConnectionInput>;
```

Algorithm (simplified):
1. Reject anything that doesn't start with `mongodb://` or `mongodb+srv://`.
2. Parse using the `mongodb-connection-string-url` package (transitively available via `mongodb`).
3. Derive:
   - `connectionType`: `'srv'` if scheme is `mongodb+srv`, else `'standard'`.
   - `host`, `port`: from first host entry (SRV: only host).
   - `defaultDb`: from pathname.
   - `authUsername`, `password` (plaintext, only to be forwarded to the form), `authDatabase` (from `authSource`).
   - `authMech`: from `authMechanism` query param, mapped (`SCRAM-SHA-256` → `scram256`, etc.). If absent, default to `default` if creds present, else `none`.
   - `tls.enabled`: `true` if `tls=true` or scheme is `srv` (SRV always implies TLS), unless explicitly `tls=false`.
   - `tls.verify`: from `tlsAllowInvalidCertificates=false` (double-negation).
   - `advanced.*`: pulled from corresponding URI params with sensible fallbacks.
   - `advanced.readPreference`: from `readPreference`.
   - `advanced.directConnection`: from `directConnection`.
4. Return the partial input. Form code merges this into its local state.

### Edge cases handled
- Multiple hosts: take the first; note to user that replica-set host lists aren't modeled (iteration 1).
- URL-encoded password containing `@`, `:` → decoded once and stored as plaintext for the form (it will be re-encoded on URI rebuild by F05).
- `options` in the userinfo rather than query string → normalized.
- `retryWrites`, `w`, `wtimeoutMS` etc. are dropped with a warning banner (not modeled in iteration 1).

## 4. Name normalization

Before persistence:
- `trim()` on `name`, `host`, `authUsername`, `authDatabase`, `appName`, all path fields.
- Collapse internal whitespace in `name` to single spaces.
- Lowercase `host`.
- If `port` is the scheme default (27017 for standard; ignored for SRV), store it anyway — it's explicit.

## 5. Derived fields

`hasPasswordStored`, `hasSshPasswordStored`, `hasSshPassphraseStored` are **always** computed at read time by C02 by calling `vault.has(...)`, never stored as a column.

## 6. Acceptance criteria

- [ ] Valid `ConnectionInput` passes schema parse.
- [ ] Each cross-field rule above has a failing test that produces a `ValidationError` naming the offending field.
- [ ] `parseConnectionUri` round-trips: for an input built from form state then rebuilt by F05 into a URI, re-parsing returns the same structural shape (modulo password presence, which may be round-tripped or not depending on plaintext handling).
- [ ] Invalid URIs throw `ValidationError` with a message pointing at the segment that failed.

## 7. Test cases

### Unit
- **uri-parser.spec.ts** — table-driven fixtures:
  - `mongodb+srv://user:pass@cluster.mongodb.net/mydb?authSource=admin&authMechanism=SCRAM-SHA-256`
  - `mongodb://user:pa%40ss@127.0.0.1:27017/db?tls=false`
  - `mongodb://127.0.0.1:27017/?directConnection=true`
  - `mongodb://host/?readPreference=secondaryPreferred`
  - Missing scheme → throws.
  - Unsupported scheme → throws.
  - Empty URI → throws.
  - URI with multiple hosts → first host captured, warning in result metadata.
- **validation.spec.ts**:
  - SCRAM without username → VALIDATION err naming `authUsername`.
  - X.509 without TLS → VALIDATION err naming `tls.enabled`.
  - Out-of-range port → VALIDATION err.
  - Empty `name` → VALIDATION err.
  - `color` malformed → VALIDATION err.

### Integration
- Covered by C02 (round-trip through repo).
