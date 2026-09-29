import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type Envelope } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerPrefsChannels } from '../../electron/ipc/handlers/prefs';
import { AppStateRepo } from '../../electron/db/repositories/AppStateRepo';
import { AppStateService } from '../../electron/services/AppStateService';
import { createTempDb, type TempDb } from '../helpers/db';
import type { FeatureHintDismissalState } from '../../shared/types';
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

describe('hints prefs round-trip', () => {
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
    return { service, shim };
  }

  const KEY = 'ui.hints.dismissed';

  it('returns null when no hint state exists', async () => {
    const { shim } = setup();
    const env = await shim.invoke<unknown>(IPC_CHANNELS.prefsGet, { key: KEY });
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data).toBeNull();
  });

  it('persists a dismissal and returns it on get', async () => {
    const { shim } = setup();
    const value: FeatureHintDismissalState = {
      dismissedIds: ['refs.configure'],
    };
    const setEnv = await shim.invoke(IPC_CHANNELS.prefsSet, { key: KEY, value });
    expect(setEnv.ok).toBe(true);

    const getEnv = await shim.invoke<FeatureHintDismissalState>(
      IPC_CHANNELS.prefsGet,
      { key: KEY },
    );
    expect(getEnv.ok).toBe(true);
    if (getEnv.ok) {
      expect(getEnv.data).toEqual(value);
    }
  });

  it('replaces the value on subsequent set (e.g. reset clears the list)', async () => {
    const { shim } = setup();
    await shim.invoke(IPC_CHANNELS.prefsSet, {
      key: KEY,
      value: { dismissedIds: ['refs.configure', 'tabs.pin'] },
    });
    await shim.invoke(IPC_CHANNELS.prefsSet, {
      key: KEY,
      value: { dismissedIds: [], resetAt: '2026-04-25T00:00:00Z' },
    });
    const env = await shim.invoke<FeatureHintDismissalState>(
      IPC_CHANNELS.prefsGet,
      { key: KEY },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data?.dismissedIds).toEqual([]);
      expect(env.data?.resetAt).toBe('2026-04-25T00:00:00Z');
    }
  });
});
