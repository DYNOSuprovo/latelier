import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type Envelope } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerPrefsChannels, THEME_KEY } from '../../electron/ipc/handlers/prefs';
import { AppStateRepo } from '../../electron/db/repositories/AppStateRepo';
import { AppStateService } from '../../electron/services/AppStateService';
import { createTempDb, type TempDb } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// The router never reads the event (`_evt` in router.ts), so the shim stands
// one in rather than constructing a real Electron event.

function ipcShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
    invoke: async <T>(ch: string, payload?: unknown): Promise<Envelope<T>> => {
      const h = handlers.get(ch);
      if (!h) throw new Error(`no handler for ${ch}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

describe('prefs theme channels', () => {
  let tmp: TempDb | null = null;
  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  function setup() {
    tmp = createTempDb();
    const service = new AppStateService(new AppStateRepo(tmp.db));
    const wc = { send: vi.fn(), isDestroyed: () => false };
    const shim = ipcShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerPrefsChannels(router, service, () => wc as never);
    return { service, wc, shim };
  }

  it('returns "system" when no theme has been stored', async () => {
    const { shim } = setup();
    const env = await shim.invoke<'light' | 'dark' | 'system'>(IPC_CHANNELS.prefsGetTheme);
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data).toBe('system');
  });

  it('persists setTheme and broadcasts via prefs:theme-event', async () => {
    const { shim, wc, service } = setup();
    const env = await shim.invoke(IPC_CHANNELS.prefsSetTheme, { mode: 'dark' });
    expect(env.ok).toBe(true);
    expect(service.get(THEME_KEY)).toBe('dark');
    expect(wc.send).toHaveBeenCalledWith(IPC_CHANNELS.prefsThemeEvent, 'dark');
  });

  it('broadcasts when the stored theme is updated externally (e.g. nativeTheme flip)', () => {
    const { service, wc } = setup();
    service.set(THEME_KEY, 'system');
    wc.send.mockClear();
    // Simulate the main-process nativeTheme listener re-touching the value.
    service.set(THEME_KEY, 'system');
    expect(wc.send).toHaveBeenCalledWith(IPC_CHANNELS.prefsThemeEvent, 'system');
  });

  it('rejects an invalid theme mode', async () => {
    const { shim } = setup();
    const env = await shim.invoke(IPC_CHANNELS.prefsSetTheme, { mode: 'sepia' });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });
});
