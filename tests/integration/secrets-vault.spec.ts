import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { SystemError } from '../../electron/errors';
import { makeEncryptionAvailable } from '../../electron/secrets/keychainAvailability';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';

function seedConnection(tmp: TempDb, id: string): void {
  const now = new Date().toISOString();
  tmp.db
    .prepare(
      `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
       VALUES (?, 'Conn ' || ?, 'standard', 'localhost', 27017, 'scram256', ?, ?)`,
    )
    .run(id, id, now, now);
}

describe('SecretsVault', () => {
  let tmp: TempDb;
  let ss: ReturnType<typeof createSafeStorageMock>;
  let vault: SecretsVault;
  let allowPlaintext: boolean;
  const connId = 'c1';

  beforeEach(() => {
    tmp = createTempDb();
    ss = createSafeStorageMock();
    allowPlaintext = false;
    vault = new SecretsVault(tmp.db, ss, {
      getAllowPlaintext: () => allowPlaintext,
    });
    seedConnection(tmp, connId);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('set + get round-trips plaintext', () => {
    vault.set(connId, 'password', 'hunter2');
    expect(vault.get(connId, 'password')).toBe('hunter2');
    expect(vault.has(connId, 'password')).toBe(true);
  });

  it('set overwrites existing values', () => {
    vault.set(connId, 'password', 'first');
    vault.set(connId, 'password', 'second');
    expect(vault.get(connId, 'password')).toBe('second');
    const count = (tmp.db
      .prepare('SELECT COUNT(*) AS c FROM connection_secrets WHERE connection_id = ?')
      .get(connId) as { c: number }).c;
    expect(count).toBe(1);
  });

  it('empty plaintext deletes', () => {
    vault.set(connId, 'password', 'x');
    vault.set(connId, 'password', '');
    expect(vault.has(connId, 'password')).toBe(false);
    expect(vault.get(connId, 'password')).toBeNull();
  });

  it('delete + deleteAll remove rows', () => {
    vault.set(connId, 'password', 'a');
    vault.set(connId, 'ssh_password', 'b');
    vault.delete(connId, 'password');
    expect(vault.has(connId, 'password')).toBe(false);
    expect(vault.has(connId, 'ssh_password')).toBe(true);

    vault.deleteAll(connId);
    expect(vault.has(connId, 'ssh_password')).toBe(false);
  });

  it('get returns null when missing', () => {
    expect(vault.get(connId, 'password')).toBeNull();
  });

  it('decrypt failure surfaces SECRET_DECRYPT_FAILED', () => {
    vault.set(connId, 'password', 'orig');
    // Corrupt ciphertext directly in SQLite.
    tmp.db
      .prepare(
        `UPDATE connection_secrets SET ciphertext = ? WHERE connection_id = ? AND field = 'password'`,
      )
      .run(Buffer.from('not-a-sentinel'), connId);
    try {
      vault.get(connId, 'password');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SystemError);
      expect((err as SystemError).code).toBe('SECRET_DECRYPT_FAILED');
    }
  });

  it('refuses set when keychain unavailable and plaintext fallback is off', () => {
    ss.setAvailable(false);
    try {
      vault.set(connId, 'password', 'x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SystemError);
      expect((err as SystemError).code).toBe('SECRETS_UNAVAILABLE');
    }
  });

  it('stores plaintext when keychain unavailable and fallback opt-in is on', () => {
    ss.setAvailable(false);
    allowPlaintext = true;
    vault.set(connId, 'password', 'fallback-pw');
    expect(vault.get(connId, 'password')).toBe('fallback-pw');
    const row = tmp.db
      .prepare(
        `SELECT ciphertext, is_plaintext FROM connection_secrets
         WHERE connection_id = ? AND field = 'password'`,
      )
      .get(connId) as { ciphertext: Buffer; is_plaintext: number };
    expect(row.is_plaintext).toBe(1);
    expect(row.ciphertext.toString('utf8')).toBe('fallback-pw');
  });

  it('round-trips a plaintext row even after keychain becomes available again', () => {
    ss.setAvailable(false);
    allowPlaintext = true;
    vault.set(connId, 'password', 'p1');
    ss.setAvailable(true);
    // Stored row is still plaintext-flagged; get() must not try to decrypt it.
    expect(vault.get(connId, 'password')).toBe('p1');
  });

  it('overwriting a plaintext row with keychain available re-encrypts it', () => {
    ss.setAvailable(false);
    allowPlaintext = true;
    vault.set(connId, 'password', 'plain');
    ss.setAvailable(true);
    vault.set(connId, 'password', 'enc');
    const row = tmp.db
      .prepare(
        `SELECT is_plaintext FROM connection_secrets
         WHERE connection_id = ? AND field = 'password'`,
      )
      .get(connId) as { is_plaintext: number };
    expect(row.is_plaintext).toBe(0);
    expect(vault.get(connId, 'password')).toBe('enc');
  });

  it('assertAvailable does not throw when fallback opt-in is on without a keychain', () => {
    ss.setAvailable(false);
    allowPlaintext = true;
    expect(() => vault.assertAvailable()).not.toThrow();
  });

  it('cascades via FK when the parent connection is deleted', () => {
    vault.set(connId, 'password', 'x');
    tmp.db.prepare('DELETE FROM connections WHERE id = ?').run(connId);
    expect(vault.has(connId, 'password')).toBe(false);
  });

  describe('Linux basic_text backend', () => {
    function linuxVault(backend: string): SecretsVault {
      const probe = {
        isEncryptionAvailable: ss.isEncryptionAvailable,
        getSelectedStorageBackend: () => backend,
      };
      return new SecretsVault(
        tmp.db,
        {
          isEncryptionAvailable: makeEncryptionAvailable(probe, 'linux'),
          encryptString: ss.encryptString,
          decryptString: ss.decryptString,
        },
        { getAllowPlaintext: () => allowPlaintext },
      );
    }

    it('refuses to save and still reads a row encrypted earlier', () => {
      vault.set(connId, 'password', 'stored-earlier');
      const basicText = linuxVault('basic_text');

      expect(() => basicText.set(connId, 'ssh_password', 'new')).toThrow(
        expect.objectContaining({ code: 'SECRETS_UNAVAILABLE' }),
      );
      expect(() => basicText.assertAvailable()).toThrow(SystemError);
      expect(basicText.get(connId, 'password')).toBe('stored-earlier');
    });

    it('falls into the plaintext opt-in flow', () => {
      const basicText = linuxVault('basic_text');
      allowPlaintext = true;
      basicText.set(connId, 'password', 'opted-in');
      const row = tmp.db
        .prepare('SELECT is_plaintext FROM connection_secrets WHERE connection_id = ?')
        .get(connId) as { is_plaintext: number };
      expect(row.is_plaintext).toBe(1);
    });

    it('encrypts normally on a real keyring backend', () => {
      const keyring = linuxVault('gnome_libsecret');
      keyring.set(connId, 'password', 'safe');
      expect(keyring.get(connId, 'password')).toBe('safe');
    });
  });
});
