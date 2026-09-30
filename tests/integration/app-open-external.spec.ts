import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const openExternalSpy = vi.fn(async (url: string) => {
  void url;
  return undefined;
});

vi.mock('electron', () => ({
  dialog: {},
  shell: { openExternal: (url: string) => openExternalSpy(url) },
}));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { IPC_CHANNELS } = await import('../../shared/ipc');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

describe('app:openExternal', () => {
  const handlers = new Map<string, Handler>();
  const open = async (url: unknown) =>
    (await handlers.get(IPC_CHANNELS.appOpenExternal)!(invokeEvent, url)) as Envelope<{ opened: true }>;

  beforeEach(() => {
    openExternalSpy.mockClear();
    handlers.clear();
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, new Set());
  });

  it.each([
    'https://github.com/anonhym/latelier/blob/main/src/troubleshooting/recipes.ts#L10',
    'https://www.mongodb.com/docs/manual/',
  ])('opens an allow-listed https URL: %s', async (url) => {
    expect(await open(url)).toEqual({ ok: true, data: { opened: true } });
    expect(openExternalSpy).toHaveBeenCalledWith(url);
  });

  it('opens the normalised href, not the raw string', async () => {
    await open('https://GitHub.com/anonhym/latelier');
    expect(openExternalSpy).toHaveBeenCalledWith('https://github.com/anonhym/latelier');
  });

  it.each([
    ['a host outside the allowlist', 'https://evil.example/phishing'],
    ['http', 'http://github.com/anonhym/latelier'],
    ['http on localhost', 'http://localhost:3000/'],
    ['the userinfo trick', 'https://github.com@evil.example/'],
    ['userinfo on an allowed host', 'https://user:pw@github.com/'],
    ['an allowed name as a path segment', 'https://evil.example/github.com'],
    ['an allowed name as a subdomain prefix', 'https://github.com.evil.example/'],
    ['a trailing-dot host', 'https://github.com./anonhym/latelier'],
    ['a non-default port', 'https://github.com:8443/'],
    ['file:', 'file:///etc/passwd'],
    ['javascript:', 'javascript:alert(1)'],
  ])('rejects %s with VALIDATION', async (_label, url) => {
    const env = await open(url);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('rejects a string that is not a URL via the schema', async () => {
    const env = await open('not a url');
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});
