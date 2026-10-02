import { describe, expect, it } from 'vitest';
import { ALLOWED_PERMISSIONS, installPermissionHandlers } from '../../electron/security/permissions.ts';

type RequestHandler = (wc: unknown, permission: string, cb: (granted: boolean) => void) => void;
type CheckHandler = (wc: unknown, permission: string) => boolean;

function install() {
  let request: RequestHandler | null = null;
  let check: CheckHandler | null = null;
  installPermissionHandlers({
    setPermissionRequestHandler: (h) => {
      request = h as unknown as RequestHandler;
    },
    setPermissionCheckHandler: (h) => {
      check = h as unknown as CheckHandler;
    },
  });
  if (!request || !check) throw new Error('handlers were not installed');
  return { request: request as RequestHandler, check: check as CheckHandler };
}

const DENIED = [
  'clipboard-read',
  'media',
  'mediaKeySystem',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'pointerLock',
  'fullscreen',
  'openExternal',
  'window-management',
  'unknown',
  'fileSystem',
  'hid',
  'serial',
  'usb',
  'clipboard-sanitized-write-but-not',
  '',
];

describe('installPermissionHandlers', () => {
  it('allows exactly clipboard-sanitized-write', () => {
    expect([...ALLOWED_PERMISSIONS]).toEqual(['clipboard-sanitized-write']);
  });

  it('grants the allow-listed permission through the request handler', () => {
    const { request } = install();
    const answers: boolean[] = [];
    request(null, 'clipboard-sanitized-write', (g) => answers.push(g));
    expect(answers).toEqual([true]);
  });

  it('denies every other permission through the request handler', () => {
    const { request } = install();
    for (const p of DENIED) {
      const answers: boolean[] = [];
      request(null, p, (g) => answers.push(g));
      expect(answers, p).toEqual([false]);
    }
  });

  it('answers the synchronous check the same way', () => {
    const { check } = install();
    expect(check(null, 'clipboard-sanitized-write')).toBe(true);
    for (const p of DENIED) expect(check(null, p), p).toBe(false);
  });
});
