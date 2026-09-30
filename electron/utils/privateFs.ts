import fs from 'node:fs';

// POSIX modes carry no meaning on Windows, where the profile dir is already
// per-user by ACL. Read at call time so a test can stub the platform.
const posixModes = (): boolean => process.platform !== 'win32';

/**
 * Creates `dir` (and any missing parents) owner-only. `mkdirSync`'s mode is
 * ignored for a directory that already exists, so the explicit chmod is what
 * tightens an existing one. Throws on failure: a directory that cannot be
 * made private must not silently hold user data.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posixModes()) fs.chmodSync(dir, 0o700);
}

/**
 * Makes `path` exist with owner-only read/write. Creating it here, before
 * SQLite opens it, is what gives the `-wal`/`-shm` side files 0600 as well:
 * SQLite copies the main file's mode when it creates them. Throws on failure.
 */
export function ensurePrivateFile(path: string): void {
  if (!posixModes()) return;
  fs.closeSync(fs.openSync(path, 'a', 0o600));
  fs.chmodSync(path, 0o600);
}
