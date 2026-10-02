import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerConnExportChannels } from '../../electron/ipc/handlers/connExport';
import { IPC_CHANNELS } from '../../shared/ipc';
import { BadPassphraseError, ValidationError } from '../../electron/errors';
import type { ConnectionExportService } from '../../electron/services/ConnectionExportService';
import type { Envelope } from '../../shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as const,
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

const PASS = 'twelve chars!!';

describe('conn:export / conn:importPreview / conn:importCommit handlers', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: {
    export: ReturnType<typeof vi.fn>;
    importPreview: ReturnType<typeof vi.fn>;
    importCommit: ReturnType<typeof vi.fn>;
    previewUris: ReturnType<typeof vi.fn>;
    createFromUris: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    shim = createShim();
    svc = {
      export: vi.fn(async () => ({ written: 1, omittedSecrets: [] })),
      importPreview: vi.fn(async () => ({ cancelled: true as const })),
      importCommit: vi.fn(async () => ({ created: [], secretsNotStored: [] })),
      previewUris: vi.fn(() => ({ entries: [] })),
      createFromUris: vi.fn(async () => ({ created: [], failed: [], secretsNotStored: [] })),
    };
    registerConnExportChannels(
      createRouter(shim.ipcMain, testSenderCheck),
      svc as unknown as ConnectionExportService,
    );
  });

  const code = (env: Envelope<unknown>) => (env.ok ? null : env.error.code);

  describe('conn:export', () => {
    it('passes a valid payload to the service', async () => {
      const payload = { ids: ['a', 'b'], includeSecrets: true, passphrase: PASS };
      const env = await shim.invoke(IPC_CHANNELS.connExport, payload);
      expect(env).toEqual({ ok: true, data: { written: 1, omittedSecrets: [] } });
      expect(svc.export).toHaveBeenCalledWith(payload);
    });

    it('accepts no passphrase when passwords are not included', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: false });
      expect(env.ok).toBe(true);
    });

    it('rejects a passphrase under 12 characters', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: 'x'.repeat(11) });
      expect(code(env)).toBe('VALIDATION');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it('accepts a 12-character passphrase', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: 'x'.repeat(12) });
      expect(env.ok).toBe(true);
    });

    it('rejects includeSecrets without a passphrase', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true });
      expect(code(env)).toBe('VALIDATION');
      expect(env.ok ? '' : env.error.message).toContain('passphrase');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown key', { ids: ['a'], includeSecrets: false, extra: 1 }],
      ['no ids', { ids: [], includeSecrets: false }],
      ['an empty id', { ids: [''], includeSecrets: false }],
      ['a missing includeSecrets', { ids: ['a'] }],
      ['a non-object', 'nope'],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connExport, payload))).toBe('VALIDATION');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it('never echoes the passphrase back in an error', async () => {
      svc.export.mockRejectedValueOnce(new ValidationError('nope'));
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: PASS });
      expect(JSON.stringify(env)).not.toContain(PASS);
    });
  });

  describe('conn:importPreview', () => {
    it.each([undefined, null, {}])('accepts %j and calls the service', async (payload) => {
      const env = await shim.invoke(IPC_CHANNELS.connImportPreview, payload);
      expect(env).toEqual({ ok: true, data: { cancelled: true } });
      expect(svc.importPreview).toHaveBeenCalledTimes(1);
    });

    it('rejects a payload that tries to name a file', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connImportPreview, { path: '/etc/passwd' });
      expect(code(env)).toBe('VALIDATION');
      expect(svc.importPreview).not.toHaveBeenCalled();
    });
  });

  describe('conn:importCommit', () => {
    it('passes a valid payload to the service', async () => {
      const payload = { token: 't', indices: [0, 2], passphrase: PASS, withoutSecrets: false };
      expect((await shim.invoke(IPC_CHANNELS.connImportCommit, payload)).ok).toBe(true);
      expect(svc.importCommit).toHaveBeenCalledWith(payload);
    });

    it('surfaces BAD_PASSPHRASE as a stable error code', async () => {
      svc.importCommit.mockRejectedValueOnce(new BadPassphraseError('Wrong Export Passphrase.'));
      const env = await shim.invoke(IPC_CHANNELS.connImportCommit, { token: 't', indices: [0], passphrase: PASS });
      expect(env).toMatchObject({ ok: false, error: { code: 'BAD_PASSPHRASE', message: 'Wrong Export Passphrase.' } });
    });

    it.each([
      ['an unknown key', { token: 't', indices: [0], extra: 1 }],
      ['no token', { indices: [0] }],
      ['an empty token', { token: '', indices: [0] }],
      ['no indices', { token: 't', indices: [] }],
      ['a negative index', { token: 't', indices: [-1] }],
      ['a fractional index', { token: 't', indices: [0.5] }],
      ['an empty passphrase', { token: 't', indices: [0], passphrase: '' }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connImportCommit, payload))).toBe('VALIDATION');
      expect(svc.importCommit).not.toHaveBeenCalled();
    });
  });

  describe('conn:previewUris', () => {
    it('passes the lines to the service', async () => {
      expect((await shim.invoke(IPC_CHANNELS.connPreviewUris, { uris: ['mongodb://h'] })).ok).toBe(true);
      expect(svc.previewUris).toHaveBeenCalledWith(['mongodb://h']);
    });

    it.each([
      ['no lines', { uris: [] }],
      ['an empty line', { uris: [''] }],
      ['101 lines', { uris: Array.from({ length: 101 }, () => 'mongodb://h') }],
      ['a 4097-character line', { uris: ['m'.repeat(4097)] }],
      ['an unknown key', { uris: ['mongodb://h'], extra: 1 }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connPreviewUris, payload))).toBe('VALIDATION');
      expect(svc.previewUris).not.toHaveBeenCalled();
    });

    it('accepts exactly 100 lines of 4096 characters', async () => {
      const uris = Array.from({ length: 100 }, () => 'm'.repeat(4096));
      expect((await shim.invoke(IPC_CHANNELS.connPreviewUris, { uris })).ok).toBe(true);
    });
  });

  describe('conn:createFromUris', () => {
    const valid = {
      uris: ['mongodb://h'],
      defaults: { readOnly: true, directConnection: false },
      credentials: [{ index: 0, username: 'u', password: 'p' }],
    };

    it('passes a valid payload to the service', async () => {
      expect((await shim.invoke(IPC_CHANNELS.connCreateFromUris, valid)).ok).toBe(true);
      expect(svc.createFromUris).toHaveBeenCalledWith(valid);
    });

    it('accepts the last line index and a username of 128 characters', async () => {
      const payload = { ...valid, credentials: [{ index: 99, username: 'u'.repeat(128) }] };
      expect((await shim.invoke(IPC_CHANNELS.connCreateFromUris, payload)).ok).toBe(true);
    });

    it.each([
      ['no defaults', { uris: valid.uris, credentials: [] }],
      ['an unknown default', { ...valid, defaults: { ...valid.defaults, tls: true } }],
      ['a non-boolean default', { ...valid, defaults: { readOnly: 'yes', directConnection: false } }],
      ['an index past the last line', { ...valid, credentials: [{ index: 100 }] }],
      ['a negative index', { ...valid, credentials: [{ index: -1 }] }],
      ['an unknown credential key', { ...valid, credentials: [{ index: 0, token: 'x' }] }],
      ['a 129-character username', { ...valid, credentials: [{ index: 0, username: 'u'.repeat(129) }] }],
      ['101 credentials', { ...valid, credentials: Array.from({ length: 101 }, () => ({ index: 0 })) }],
      ['no lines', { ...valid, uris: [] }],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connCreateFromUris, payload))).toBe('VALIDATION');
      expect(svc.createFromUris).not.toHaveBeenCalled();
    });
  });
});
