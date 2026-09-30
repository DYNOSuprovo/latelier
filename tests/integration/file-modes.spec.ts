import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../electron/db/sqlite';
import { useUmask022 } from '../helpers/umask';

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')('user-data file modes', () => {
  let root: string;
  let restoreUmask: () => void;

  beforeEach(() => {
    restoreUmask = useUmask022();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-modes-'));
  });

  afterEach(() => {
    restoreUmask();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the dir 0700 and the db, -wal and -shm 0600 under a permissive umask', () => {
    const dir = path.join(root, 'fresh', 'profile');
    const db = openDatabase({ userDataDir: dir });
    try {
      // A write keeps the WAL populated so -wal and -shm exist while open.
      db.exec('CREATE TABLE IF NOT EXISTS modes_probe (x)');
      db.exec('INSERT INTO modes_probe VALUES (1)');
      const dbPath = path.join(dir, 'mongolab.db');
      expect(mode(dir)).toBe(0o700);
      expect(mode(dbPath)).toBe(0o600);
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      expect(mode(`${dbPath}-wal`)).toBe(0o600);
      expect(mode(`${dbPath}-shm`)).toBe(0o600);
    } finally {
      closeDatabase(db);
    }
  });

  it('tightens a pre-existing 0755 dir and 0644 db, wal and shm', () => {
    const dir = path.join(root, 'legacy');
    fs.mkdirSync(dir, { mode: 0o755 });
    const dbPath = path.join(dir, 'mongolab.db');
    // A crash leaves a non-empty -wal that SQLite keeps (and its mode with it);
    // capture one from a live connection, then restore it at the default mode.
    const seed = new BetterSqlite3(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.pragma('wal_autocheckpoint = 0');
    seed.exec('CREATE TABLE seed (x); INSERT INTO seed VALUES (1)');
    const leftovers = ['-wal', '-shm'].map((suffix) => fs.readFileSync(dbPath + suffix));
    seed.close();
    fs.chmodSync(dbPath, 0o644);
    ['-wal', '-shm'].forEach((suffix, i) => fs.writeFileSync(dbPath + suffix, leftovers[i]!, { mode: 0o644 }));
    fs.chmodSync(dir, 0o755);

    const db = openDatabase({ userDataDir: dir });
    try {
      expect(mode(dir)).toBe(0o700);
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(`${dbPath}-wal`)).toBe(0o600);
      expect(mode(`${dbPath}-shm`)).toBe(0o600);
    } finally {
      closeDatabase(db);
    }
  });
});
