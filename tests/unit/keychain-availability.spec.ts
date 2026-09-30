import { describe, it, expect, vi } from 'vitest';
import {
  isWeakBackend,
  makeEncryptionAvailable,
  selectedBackend,
  vaultSafeStorage,
  type KeychainProbe,
} from '../../electron/secrets/keychainAvailability';

function fake(backend: string, available = true) {
  const getSelectedStorageBackend = vi.fn(() => backend);
  const isEncryptionAvailable = vi.fn(() => available);
  const probe: KeychainProbe = { isEncryptionAvailable, getSelectedStorageBackend };
  return { probe, getSelectedStorageBackend, isEncryptionAvailable };
}

describe('makeEncryptionAvailable', () => {
  it.each(['basic_text', 'unknown'])(
    'linux + %s is unavailable even when safeStorage claims otherwise',
    (backend) => {
      const f = fake(backend, true);
      expect(makeEncryptionAvailable(f.probe, 'linux')()).toBe(false);
    },
  );

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'linux + %s defers to isEncryptionAvailable',
    (backend) => {
      expect(makeEncryptionAvailable(fake(backend, true).probe, 'linux')()).toBe(true);
      expect(makeEncryptionAvailable(fake(backend, false).probe, 'linux')()).toBe(false);
    },
  );

  it.each<NodeJS.Platform>(['darwin', 'win32', 'freebsd'])(
    '%s never asks for the backend and defers to isEncryptionAvailable',
    (platform) => {
      const yes = fake('basic_text', true);
      expect(makeEncryptionAvailable(yes.probe, platform)()).toBe(true);
      expect(yes.getSelectedStorageBackend).not.toHaveBeenCalled();
      expect(makeEncryptionAvailable(fake('x', false).probe, platform)()).toBe(false);
    },
  );

  it('re-reads the backend on every call', () => {
    let backend = 'unknown';
    const probe: KeychainProbe = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
    };
    const available = makeEncryptionAvailable(probe, 'linux');
    expect(available()).toBe(false);
    backend = 'gnome_libsecret';
    expect(available()).toBe(true);
  });
});

describe('selectedBackend', () => {
  it('reports the backend on linux only', () => {
    const f = fake('kwallet6');
    expect(selectedBackend(f.probe, 'linux')).toBe('kwallet6');
    expect(selectedBackend(f.probe, 'darwin')).toBeNull();
    expect(selectedBackend(f.probe, 'win32')).toBeNull();
    expect(f.getSelectedStorageBackend).toHaveBeenCalledTimes(1);
  });
});

describe('isWeakBackend', () => {
  it('flags basic_text and unknown only', () => {
    expect(isWeakBackend('basic_text')).toBe(true);
    expect(isWeakBackend('unknown')).toBe(true);
    expect(isWeakBackend('kwallet')).toBe(false);
    expect(isWeakBackend('')).toBe(false);
    expect(isWeakBackend(null)).toBe(false);
  });
});

describe('vaultSafeStorage', () => {
  function electronLike(backend: string) {
    return {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
      encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
      decryptString: vi.fn((b: Buffer) => `dec:${b.toString()}`),
    };
  }

  it('applies the weak-backend rule to availability', () => {
    expect(vaultSafeStorage(electronLike('basic_text'), 'linux').isEncryptionAvailable()).toBe(false);
    expect(vaultSafeStorage(electronLike('gnome_libsecret'), 'linux').isEncryptionAvailable()).toBe(true);
  });

  it('delegates encrypt and decrypt to safeStorage unchanged', () => {
    const ss = electronLike('gnome_libsecret');
    const vault = vaultSafeStorage(ss, 'linux');
    expect(vault.encryptString('pw').toString()).toBe('enc:pw');
    expect(ss.encryptString).toHaveBeenCalledWith('pw');
    expect(vault.decryptString(Buffer.from('x'))).toBe('dec:x');
    expect(ss.decryptString).toHaveBeenCalledWith(Buffer.from('x'));
  });
});
