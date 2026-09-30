/** The slice of Electron's `safeStorage` this module needs. */
export interface KeychainProbe {
  isEncryptionAvailable(): boolean;
  /** Electron documents this as Linux-only; never call it elsewhere. */
  getSelectedStorageBackend(): string;
}

/**
 * On Linux, Electron falls back to `basic_text` when no keyring is reachable:
 * it "encrypts" with a hardcoded key yet still reports encryption as
 * available. `unknown` is what it returns before the app is ready. Both are
 * treated as no keychain. Every other backend, `kwallet` (KDE 4) included, is
 * a real one.
 */
const WEAK_LINUX_BACKENDS: ReadonlySet<string | null> = new Set(['basic_text', 'unknown']);

export function isWeakBackend(backend: string | null): boolean {
  return WEAK_LINUX_BACKENDS.has(backend);
}

/** The backend name on Linux, `null` on platforms where the concept does not exist. */
export function selectedBackend(
  safeStorage: KeychainProbe,
  platform: NodeJS.Platform,
): string | null {
  return platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null;
}

export function makeEncryptionAvailable(
  safeStorage: KeychainProbe,
  platform: NodeJS.Platform,
): () => boolean {
  return () => {
    if (isWeakBackend(selectedBackend(safeStorage, platform))) return false;
    return safeStorage.isEncryptionAvailable();
  };
}
