import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensurePrivateDir, ensurePrivateFile } from '../../electron/utils/privateFs';
import { useUmask022 } from '../helpers/umask';

const posix = process.platform !== 'win32';
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe('privateFs', () => {
  let root: string;
  let restoreUmask: () => void;

  beforeEach(() => {
    restoreUmask = useUmask022();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-privfs-'));
  });

  afterEach(() => {
    restoreUmask();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe.skipIf(!posix)('on POSIX', () => {
    it('creates a missing directory and its new parents as 0700', () => {
      const leaf = path.join(root, 'a', 'b');
      ensurePrivateDir(leaf);
      expect(mode(leaf)).toBe(0o700);
      expect(mode(path.join(root, 'a'))).toBe(0o700);
    });

    it('tightens an existing 0755 directory, where mkdir ignores the mode', () => {
      const dir = path.join(root, 'existing');
      fs.mkdirSync(dir, { mode: 0o755 });
      ensurePrivateDir(dir);
      expect(mode(dir)).toBe(0o700);
    });

    it('creates a missing file as 0600 and empty', () => {
      const file = path.join(root, 'new.db');
      ensurePrivateFile(file);
      expect(mode(file)).toBe(0o600);
      expect(fs.statSync(file).size).toBe(0);
    });

    it('tightens an existing 0644 file without touching its content', () => {
      const file = path.join(root, 'old.log');
      fs.writeFileSync(file, 'keep\n', { mode: 0o644 });
      ensurePrivateFile(file);
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep\n');
    });

    it('throws when the directory cannot be made private', () => {
      const file = path.join(root, 'plain');
      fs.writeFileSync(file, 'x');
      expect(() => ensurePrivateDir(path.join(file, 'child'))).toThrow();
    });

    it('throws when the file cannot be created', () => {
      expect(() => ensurePrivateFile(path.join(root, 'missing-dir', 'f'))).toThrow();
    });
  });

  describe('on win32', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    });

    it('creates the directory but applies no mode', () => {
      const chmod = vi.spyOn(fs, 'chmodSync');
      const dir = path.join(root, 'win');
      ensurePrivateDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
      expect(chmod).not.toHaveBeenCalled();
    });

    it('does not create or chmod a file', () => {
      const chmod = vi.spyOn(fs, 'chmodSync');
      const file = path.join(root, 'win.db');
      ensurePrivateFile(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(chmod).not.toHaveBeenCalled();
    });
  });
});
