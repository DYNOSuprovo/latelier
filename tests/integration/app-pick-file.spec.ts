import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const showOpenDialog = vi.fn();

vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  shell: {},
}));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { IPC_CHANNELS } = await import('../../shared/ipc');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

describe('app:pickFile — remembers what it returned for an import', () => {
  const handlers = new Map<string, Handler>();
  let picked: Set<string>;
  const pick = (purpose: string) => handlers.get(IPC_CHANNELS.appPickFile)!(invokeEvent, purpose);

  beforeEach(() => {
    handlers.clear();
    showOpenDialog.mockReset();
    picked = new Set();
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, picked);
  });

  it('adds a data-import pick to the set the data channels read', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/people.csv'] });
    expect(await pick('data-import')).toEqual({ ok: true, data: { path: '/Users/me/people.csv' } });
    expect([...picked]).toEqual(['/Users/me/people.csv']);
  });

  it('adds nothing for a pick with another purpose', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/ca.pem'] });
    expect(await pick('tls-ca')).toEqual({ ok: true, data: { path: '/Users/me/ca.pem' } });
    expect(picked.size).toBe(0);
  });

  it('adds nothing when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pick('data-import')).toEqual({ ok: true, data: { path: null } });
    expect(picked.size).toBe(0);
  });
});
