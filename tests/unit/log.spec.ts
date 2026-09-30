import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../../electron/log';
import { useUmask022 } from '../helpers/umask';

describe('createLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-log-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes structured JSON lines to a daily log file', () => {
    const log = createLogger(dir, { toStderr: false, level: 'debug' });
    log.info('boot', 'hello', { x: 1 });

    const logsDir = path.join(dir, 'logs');
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(logsDir, files[0]!), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'info', tag: 'boot', msg: 'hello', data: { x: 1 } });
    expect(typeof parsed.t).toBe('string');
  });

  it('respects level filter', () => {
    const log = createLogger(dir, { toStderr: false, level: 'warn' });
    log.debug('t', 'debug');
    log.info('t', 'info');
    log.warn('t', 'warn');
    log.error('t', 'error');

    const logsDir = path.join(dir, 'logs');
    const files = fs.readdirSync(logsDir);
    const content = fs.readFileSync(path.join(logsDir, files[0]!), 'utf8').trim();
    const levels = content.split('\n').map((l) => JSON.parse(l).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('prunes log files older than retentionDays on startup', () => {
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const old = path.join(logsDir, 'mongolab.2000-01-01.log');
    fs.writeFileSync(old, 'stale\n');
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, tenDaysAgo / 1000, tenDaysAgo / 1000);

    createLogger(dir, { toStderr: false, retentionDays: 7 });

    expect(fs.existsSync(old)).toBe(false);
  });

  it('never throws on disk failure', () => {
    const log = createLogger(dir, { toStderr: false });
    const logsDir = path.join(dir, 'logs');
    // Remove the logs dir between writes to provoke ENOENT on appendFileSync.
    fs.rmSync(logsDir, { recursive: true, force: true });
    expect(() => log.info('t', 'still alive')).not.toThrow();
  });

  it('log.debug actually writes a debug-level line when the threshold allows it', () => {
    const log = createLogger(dir, { toStderr: false, level: 'debug' });
    log.debug('t', 'msg');
    const logsDir = path.join(dir, 'logs');
    const content = fs.readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]!), 'utf8').trim();
    expect(JSON.parse(content).level).toBe('debug');
  });

  it('names the daily log file from the UTC date, zero-padded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    const log = createLogger(dir, { toStderr: false, level: 'debug' });
    log.info('t', 'msg');
    const logsDir = path.join(dir, 'logs');
    expect(fs.readdirSync(logsDir)).toEqual(['mongolab.2026-03-05.log']);
  });

  it('omits the data field entirely when no data is passed', () => {
    const log = createLogger(dir, { toStderr: false, level: 'debug' });
    log.info('t', 'msg');
    const logsDir = path.join(dir, 'logs');
    const content = fs.readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]!), 'utf8').trim();
    expect(JSON.parse(content)).not.toHaveProperty('data');
  });

  describe('level defaulting', () => {
    const levelsWritten = () => {
      const logsDir = path.join(dir, 'logs');
      return fs
        .readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]!), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).level);
    };

    // The caller decides, and the default is the quiet one. An omitted level
    // must never be the verbose one: `ipc.req` writes raw request payloads at
    // debug, so a leaky default turns one forgotten argument into user data
    // on disk.
    it('defaults to info, filtering out debug', () => {
      const log = createLogger(dir, { toStderr: false });
      log.debug('t', 'debug-msg');
      log.info('t', 'info-msg');
      expect(levelsWritten()).toEqual(['info']);
    });

    // No NODE_ENV value may talk the default back up to debug. Nothing in the
    // build ever sets this variable, so a shipped app reads whatever the
    // user's shell happens to hold.
    it.each(['production', 'development', 'test', ''])(
      'still defaults to info with NODE_ENV=%j',
      (value) => {
        vi.stubEnv('NODE_ENV', value);
        const log = createLogger(dir, { toStderr: false });
        log.debug('t', 'debug-msg');
        log.info('t', 'info-msg');
        expect(levelsWritten()).toEqual(['info']);
      },
    );

    it('honours an explicit debug level', () => {
      const log = createLogger(dir, { toStderr: false, level: 'debug' });
      log.debug('t', 'debug-msg');
      log.info('t', 'info-msg');
      expect(levelsWritten()).toEqual(['debug', 'info']);
    });
  });

  describe('toStderr defaulting', () => {
    it('defaults to true — writes the exact serialized line to stderr', () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const log = createLogger(dir, { level: 'debug' });
      log.info('t', 'msg', { x: 1 });
      const logsDir = path.join(dir, 'logs');
      const fileContent = fs.readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]!), 'utf8');
      expect(spy).toHaveBeenCalledWith(fileContent);
    });

    it('writes nothing to stderr when explicitly set to false', () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const log = createLogger(dir, { toStderr: false, level: 'debug' });
      log.info('t', 'msg');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('retentionDays defaulting and pruning boundaries', () => {
    it('defaults retentionDays to 7 when not provided', () => {
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const old = path.join(logsDir, 'mongolab.2000-01-01.log');
      const fresh = path.join(logsDir, 'mongolab.2000-01-02.log');
      fs.writeFileSync(old, 'stale\n');
      fs.writeFileSync(fresh, 'fresh\n');
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
      fs.utimesSync(old, eightDaysAgo / 1000, eightDaysAgo / 1000);
      fs.utimesSync(fresh, sixDaysAgo / 1000, sixDaysAgo / 1000);

      createLogger(dir, { toStderr: false });

      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    });

    it('keeps a file whose mtime lands exactly on the retention cutoff (strict less-than)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-05T00:00:00.000Z'));
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const retentionDays = 5;
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const onCutoff = path.join(logsDir, 'mongolab.on-cutoff.log');
      fs.writeFileSync(onCutoff, 'x\n');
      fs.utimesSync(onCutoff, cutoff / 1000, cutoff / 1000);
      // Guard the boundary premise: the filesystem must actually store the mtime we set,
      // or this test would pass/fail for the wrong reason.
      expect(fs.statSync(onCutoff).mtimeMs).toBe(cutoff);

      createLogger(dir, { toStderr: false, retentionDays });

      expect(fs.existsSync(onCutoff)).toBe(true);
    });

    it('skips files that do not match the mongolab.*.log name pattern, however old', () => {
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const wrongPrefix = path.join(logsDir, 'other.log');
      const wrongExt = path.join(logsDir, 'mongolab.2000-01-01.txt');
      fs.writeFileSync(wrongPrefix, 'x\n');
      fs.writeFileSync(wrongExt, 'x\n');
      const ancient = Date.now() - 365 * 24 * 60 * 60 * 1000;
      fs.utimesSync(wrongPrefix, ancient / 1000, ancient / 1000);
      fs.utimesSync(wrongExt, ancient / 1000, ancient / 1000);

      createLogger(dir, { toStderr: false, retentionDays: 7 });

      expect(fs.existsSync(wrongPrefix)).toBe(true);
      expect(fs.existsSync(wrongExt)).toBe(true);
    });
  });
  describe.skipIf(process.platform === 'win32')('file modes', () => {
    let restoreUmask: () => void;
    const mode = (p: string): number => fs.statSync(p).mode & 0o777;

    beforeEach(() => {
      restoreUmask = useUmask022();
    });

    afterEach(() => {
      restoreUmask();
    });

    it('creates the logs dir 0700 and the log file 0600 under a permissive umask', () => {
      const log = createLogger(dir, { toStderr: false });
      log.info('t', 'hello');
      const logsDir = path.join(dir, 'logs');
      expect(mode(logsDir)).toBe(0o700);
      const files = fs.readdirSync(logsDir);
      expect(files.length).toBe(1);
      expect(mode(path.join(logsDir, files[0]!))).toBe(0o600);
    });

    it('tightens a pre-existing 0755 logs dir and 0644 log file at startup, before any write', () => {
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { mode: 0o755 });
      const old = path.join(logsDir, 'mongolab.2999-01-01.log');
      const other = path.join(logsDir, 'notes.txt');
      fs.writeFileSync(old, 'x\n', { mode: 0o644 });
      fs.writeFileSync(other, 'x\n', { mode: 0o644 });

      createLogger(dir, { toStderr: false });

      expect(mode(logsDir)).toBe(0o700);
      expect(mode(old)).toBe(0o600);
      expect(mode(other)).toBe(0o644);
    });

    it('reports a log file it could not tighten instead of swallowing it, and keeps logging', () => {
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir);
      const stuck = path.join(logsDir, 'mongolab.2999-01-01.log');
      fs.writeFileSync(stuck, 'x\n');
      const realChmod = fs.chmodSync;
      vi.spyOn(fs, 'chmodSync').mockImplementation((p, m) => {
        if (String(p) === stuck) throw new Error('EPERM: nope');
        realChmod(p, m);
      });

      const log = createLogger(dir, { toStderr: false });
      log.info('t', 'after');

      const today = fs.readdirSync(logsDir).filter((f) => f !== 'mongolab.2999-01-01.log');
      const lines = fs.readFileSync(path.join(logsDir, today[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({
        level: 'warn',
        tag: 'log',
        msg: 'could not restrict log file permissions',
        data: { file: 'mongolab.2999-01-01.log' },
      });
      expect(lines[0].data.message).toContain('EPERM: nope');
      expect(lines[1]).toMatchObject({ msg: 'after' });
    });

    it('lets a failed mkdir of the logs dir surface at startup, unchanged', () => {
      vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('EACCES: cannot create logs');
      });
      expect(() => createLogger(dir, { toStderr: false })).toThrow('EACCES: cannot create logs');
    });

    it('degrades a failed chmod of the logs dir to a warn line instead of aborting', () => {
      const logsDir = path.join(dir, 'logs');
      fs.mkdirSync(logsDir, { mode: 0o755 });
      const realChmod = fs.chmodSync;
      vi.spyOn(fs, 'chmodSync').mockImplementation((p, m) => {
        if (String(p) === logsDir) throw new Error('EPERM: not the owner');
        realChmod(p, m);
      });

      const log = createLogger(dir, { toStderr: false });
      log.info('t', 'after');

      const lines = fs
        .readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]!), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines[0]).toMatchObject({
        level: 'warn',
        tag: 'log',
        msg: 'could not restrict logs directory permissions',
      });
      expect(lines[0].data.message).toContain(logsDir);
      expect(lines[0].data.message).toContain('EPERM: not the owner');
      expect(lines[1]).toMatchObject({ msg: 'after' });
    });
  });
});
