# F03 — Secrets vault

## Purpose

Keep connection passwords, SSH passwords, and SSH private-key passphrases at rest in an OS-keychain-backed encrypted form so no sensitive material is readable in the SQLite file by itself. Give services a narrow, testable API to encrypt, decrypt, and delete secret fields.

## Scope

- **In**: `SecretsVault` service, integration with `connection_secrets` table, plaintext-never-returned-to-renderer guarantee.
- **Out**: UI for editing secrets (covered in C03), TLS cert contents (iteration 1 stores TLS **paths** only — no secret material).

## Dependencies

- F01 (conventions), F02 (`connection_secrets` table).
- Electron `safeStorage` API (built-in, no extra dep).

## 1. Why `safeStorage`

- It is shipped with Electron, no native modules to rebuild.
- On macOS it uses Keychain; on Windows it uses DPAPI; on Linux it uses libsecret (falling back to a passphrase prompt or plaintext with a warning).
- Output is an opaque `Buffer` we store as `BLOB`.
- `safeStorage.isEncryptionAvailable()` is `false` on Linux if no secret service is present. We must detect this and refuse to save secrets (with a clear error).

## 2. API

```ts
// electron/secrets/SecretsVault.ts
import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

export type SecretField =
  | 'password'
  | 'ssh_password'
  | 'ssh_passphrase';

export class SecretsVault {
  constructor(private db: Database.Database) {
    this.selectStmt = db.prepare(
      `SELECT ciphertext FROM connection_secrets WHERE connection_id = ? AND field = ?`
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO connection_secrets (connection_id, field, ciphertext, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (connection_id, field) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at`
    );
    this.deleteOneStmt = db.prepare(
      `DELETE FROM connection_secrets WHERE connection_id = ? AND field = ?`
    );
    this.deleteAllStmt = db.prepare(
      `DELETE FROM connection_secrets WHERE connection_id = ?`
    );
  }

  /** Throws `SystemError('SECRETS_UNAVAILABLE')` if safeStorage cannot encrypt. */
  assertAvailable(): void;

  /** Stores or updates a secret. Empty string ⇒ delete. */
  set(connectionId: string, field: SecretField, plaintext: string): void;

  /** Returns plaintext, or null if missing. Main-process only. */
  get(connectionId: string, field: SecretField): string | null;

  /** Convenience — true if any ciphertext exists for the field. */
  has(connectionId: string, field: SecretField): boolean;

  /** Removes a single field. */
  delete(connectionId: string, field: SecretField): void;

  /** Removes all secrets for a connection (used on connection delete; FK cascade also covers this). */
  deleteAll(connectionId: string): void;
}
```

## 3. Behavior

### set
1. If `plaintext === ''` or `undefined`, delegate to `delete(connectionId, field)` and return.
2. `assertAvailable()` — throw `SystemError('SECRETS_UNAVAILABLE', 'OS keychain not accessible on this system')` if `safeStorage.isEncryptionAvailable()` is false.
3. `ciphertext = safeStorage.encryptString(plaintext)`.
4. `upsertStmt.run(connectionId, field, ciphertext, new Date().toISOString())`.

### get
1. Row lookup. If missing, return `null`.
2. `return safeStorage.decryptString(row.ciphertext);`
3. If `decryptString` throws (keychain data cleared, user profile moved, etc.), throw `SystemError('SECRET_DECRYPT_FAILED', 'Stored secret could not be decrypted. You may need to re-enter it.')`. Do not delete the row automatically — the user decides.

### Cross-process rules
- **Plaintext never leaves main process.** `SecretsVault.get` is called from within `ConnectionService.buildMongoUri(...)` and nowhere else.
- There is **no IPC channel** that returns a plaintext secret. If the renderer needs to know whether a password is set, it gets a boolean from `has(...)` via `conn:get` (see C02).
- When the renderer saves a form, it sends the plaintext through IPC; main persists it and drops the plaintext reference. The IPC channel that accepts secrets is marked in F04 as `SECRET_INPUT` so auditors can grep for it.

## 4. Keychain unavailability UX

If `safeStorage.isEncryptionAvailable()` returns `false` and the user has not opted in to plaintext storage, `SecretsVault.set` throws `SECRETS_UNAVAILABLE`.

- The NewConnection page's **Save** action opens a confirmation modal explaining the situation: the user can either switch to an auth mech that doesn't store a password (X.509, none) or opt in to **plaintext password storage** (issue #4 follow-up). Confirming the modal sets the app-state pref `secrets.allowPlaintextFallback = true` and retries the save.
- Once the pref is on, the form shows a persistent banner with a **Disable** button so the user can flip it back. The pref is per-installation (stored in `app_state`).
- Saving a connection with `auth_mech = 'none'` or `'x509'` and no SSH password bypasses the check entirely.

### Linux keyring backends

On Linux, Electron falls back to a `basic_text` backend when no keyring (libsecret, KWallet) is reachable. That backend encrypts with a hardcoded key yet still reports encryption as available, so the vault's injected `isEncryptionAvailable` (`electron/secrets/keychainAvailability.ts`) treats `basic_text` and `unknown` as unavailable. Linux without a keyring therefore takes the same `SECRETS_UNAVAILABLE` / plaintext opt-in flow as above. `kwallet` counts as a real keychain. Only the availability check is wrapped: `encryptString` / `decryptString` are untouched, so rows already encrypted under `basic_text` stay readable. macOS and Windows never consult the backend. The diagnostic bundle carries `secrets: { encryptionAvailable, backend }` (`backend` is `null` off Linux).

### Plaintext fallback semantics

- Migration `009-secret-plaintext-flag.sql` adds `is_plaintext INTEGER NOT NULL DEFAULT 0` to `connection_secrets`. Existing rows are encrypted (default `0`).
- When the keychain is unavailable AND the pref is on, `SecretsVault.set` writes the password as raw UTF-8 bytes with `is_plaintext = 1`.
- `SecretsVault.get` reads `is_plaintext` and returns the bytes directly (no `decryptString`) when the row was stored plaintext. Encrypted rows continue to use `safeStorage.decryptString`.
- When the keychain becomes available again, the next write for that field re-encrypts and clears the flag. Previously-stored plaintext rows remain readable until they are overwritten or deleted.
- The plaintext path is intentionally limited: no UI is offered to bulk-migrate previously-saved passwords, and the diagnostic bundle never includes secret rows.

## 5. Acceptance criteria

- [ ] A plaintext secret stored via `set` cannot be recovered by opening `mongolab.db` in a third-party SQLite tool.
- [ ] `get` returns the same plaintext that was passed to `set`.
- [ ] `delete` removes the row; subsequent `get` returns `null`.
- [ ] Deleting the parent connection cascades (F02) and removes all secrets for that id.
- [ ] No IPC channel in F04 declares a response shape containing a plaintext secret.

## 6. Test cases

### Integration (Vitest + temp SQLite; `safeStorage` is only available in a running Electron app, so a **mock shim** is injected)

```ts
// tests/helpers/safeStorageMock.ts
export function installSafeStorageMock() {
  const store = new Map<string, string>();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => {
      const id = crypto.randomUUID();
      store.set(id, s);
      return Buffer.from(id);
    },
    decryptString: (b: Buffer) => {
      const id = b.toString();
      const v = store.get(id);
      if (v === undefined) throw new Error('not found');
      return v;
    },
  };
}
```

- **set-get-roundtrip.spec.ts**: set a password, get it back → equal.
- **set-overwrite.spec.ts**: set twice with different values → second value wins; `updated_at` advances.
- **delete.spec.ts**: after delete, `get` returns `null` and `has` returns `false`.
- **cascade-via-db.spec.ts**: delete parent connection in SQL → vault reports secret gone.
- **decrypt-failure.spec.ts**: corrupt the ciphertext manually → `get` throws `SECRET_DECRYPT_FAILED`.
- **unavailable.spec.ts**: mock `isEncryptionAvailable = false` → `set` throws `SECRETS_UNAVAILABLE`.

### E2E (Playwright + real Electron, macOS only — skipped on Linux CI without keychain)
- Create a connection with password → quit app → relaunch → connect succeeds. Confirms the Keychain round-trip actually works end-to-end.
