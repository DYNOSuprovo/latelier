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
import { createPickedCredentialPaths, type PickedCredentialPaths } from '../../electron/security/credentialPaths';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

describe('app:pickFile — remembers what it returned for an import', () => {
  const handlers = new Map<string, Handler>();
  let picked: Set<string>;
  let credentialPaths: PickedCredentialPaths;
  const pick = (purpose: string) => handlers.get(IPC_CHANNELS.appPickFile)!(invokeEvent, purpose);

  beforeEach(() => {
    handlers.clear();
    showOpenDialog.mockReset();
    picked = new Set();
    credentialPaths = createPickedCredentialPaths();
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, picked, credentialPaths);
  });

  it('adds a data-import pick to the set the data channels read', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/people.csv'] });
    expect(await pick('data-import')).toEqual({ ok: true, data: { path: '/Users/me/people.csv' } });
    expect([...picked]).toEqual(['/Users/me/people.csv']);
  });

  it('does not add a credential pick to the import set', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/ca.pem'] });
    expect(await pick('tls-ca')).toEqual({ ok: true, data: { path: '/Users/me/ca.pem' } });
    expect(picked.size).toBe(0);
  });

  it.each([
    ['tls-ca', 'tls-client-cert'],
    ['tls-client-cert', 'ssh-key'],
    ['ssh-key', 'tls-ca'],
  ] as const)('records a %s pick for that purpose only', async (purpose, other) => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/x.pem'] });
    await pick(purpose);
    expect(credentialPaths.has(purpose, '/Users/me/x.pem')).toBe(true);
    expect(credentialPaths.has(other, '/Users/me/x.pem')).toBe(false);
  });

  it('records no credential path for a data-import pick', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/me/people.csv'] });
    await pick('data-import');
    for (const p of ['tls-ca', 'tls-client-cert', 'ssh-key'] as const) {
      expect(credentialPaths.has(p, '/Users/me/people.csv')).toBe(false);
    }
  });

  it('adds nothing when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pick('data-import')).toEqual({ ok: true, data: { path: null } });
    expect(await pick('tls-ca')).toEqual({ ok: true, data: { path: null } });
    expect(picked.size).toBe(0);
    expect(credentialPaths.has('tls-ca', '')).toBe(false);
  });
});
