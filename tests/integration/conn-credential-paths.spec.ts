import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { ConnectionInput, ProbeResult } from '@shared/types';

const showOpenDialog = vi.fn();

vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  shell: {},
}));

// Imports must come after the mock so the app handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { registerConnChannels } = await import('../../electron/ipc/handlers/conn');
const { createPickedCredentialPaths } = await import('../../electron/security/credentialPaths');
const { ConnectionRepo } = await import('../../electron/db/repositories/ConnectionRepo');
const { ConnectionService, connectionReader } = await import('../../electron/mongo/ConnectionService');
const { SecretsVault } = await import('../../electron/secrets/SecretsVault');
const { MongoPool } = await import('../../electron/mongo/MongoPool');
const { IPC_CHANNELS } = await import('../../shared/ipc');
const { createTempDb } = await import('../helpers/db');
const { createSafeStorageMock } = await import('../helpers/safeStorageMock');
import type { TempDb } from '../helpers/db';
import type { Envelope } from '../../shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

const CA = '/certs/ca.pem';
const CLIENT = '/certs/client.pem';
const KEY = '/keys/id.key';

function input(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    authMech: 'none',
    tls: { enabled: true, verify: true },
    advanced: {
      connectTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
      serverSelectionTimeoutMs: 30_000,
      readPreference: 'primary',
      maxPoolSize: 100,
      directConnection: false,
    },
    ...overrides,
  };
}

const withTls = (tls: Partial<ConnectionInput['tls']>): Partial<ConnectionInput> => ({
  tls: { enabled: true, verify: true, ...tls },
});

describe('credential file paths on the connection channels', () => {
  let tmp: TempDb;
  const handlers = new Map<string, Handler>();
  let probeSpy: ReturnType<typeof vi.spyOn>;

  const call = async <T = unknown>(channel: string, payload: unknown) =>
    (await handlers.get(channel)!(invokeEvent, payload)) as Envelope<T>;
  const pick = async (purpose: string, filePath: string) => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
    await call(IPC_CHANNELS.appPickFile, purpose);
  };
  const create = (over: Partial<ConnectionInput>) =>
    call<{ id: string }>(IPC_CHANNELS.connCreate, input(over));

  beforeEach(() => {
    tmp = createTempDb();
    handlers.clear();
    showOpenDialog.mockReset();
    const repo = new ConnectionRepo(tmp.db);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    probeSpy = vi
      .spyOn(pool, 'probe')
      .mockResolvedValue({ ok: true, serverVersion: '7.0.0', topology: 'Single' } as ProbeResult);
    vi.spyOn(pool, 'disconnect').mockResolvedValue(undefined);
    const svc = new ConnectionService({ repo, vault, pool });
    const router = createRouter(
      { handle: (c: string, fn: Handler) => void handlers.set(c, fn) },
      testSenderCheck,
    );
    const picked = createPickedCredentialPaths();
    registerAppChannels(router, () => null, new Set(), picked);
    registerConnChannels(router, svc, picked);
  });

  afterEach(() => {
    tmp.cleanup();
    vi.restoreAllMocks();
  });

  describe('conn:create', () => {
    it('rejects a CA path that was not picked, with an issue on tls.caPath', async () => {
      const res = await create(withTls({ caPath: CA }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('VALIDATION');
      expect(res.error.details).toEqual({
        issues: [{ path: ['tls', 'caPath'], message: expect.any(String) }],
      });
    });

    it('reports every offending field at once', async () => {
      const res = await create({
        ...withTls({ caPath: CA, clientCertPath: CLIENT }),
        ssh: { enabled: false, privateKeyPath: KEY },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const issues = (res.error.details as { issues: Array<{ path: string[] }> }).issues;
      expect(issues.map((i) => i.path.join('.'))).toEqual([
        'tls.caPath',
        'tls.clientCertPath',
        'ssh.privateKeyPath',
      ]);
    });

    it('saves a path picked through app:pickFile', async () => {
      await pick('tls-ca', CA);
      await pick('tls-client-cert', CLIENT);
      await pick('ssh-key', KEY);
      const res = await create({
        ...withTls({ caPath: CA, clientCertPath: CLIENT }),
        ssh: { enabled: false, privateKeyPath: KEY },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const got = await call<{ tls: { caPath?: string; clientCertPath?: string }; ssh?: { privateKeyPath?: string } }>(
        IPC_CHANNELS.connGet,
        { id: res.data.id },
      );
      expect(got.ok && got.data.tls.caPath).toBe(CA);
      expect(got.ok && got.data.tls.clientCertPath).toBe(CLIENT);
      expect(got.ok && got.data.ssh?.privateKeyPath).toBe(KEY);
    });

    it('rejects a path picked for a different purpose', async () => {
      await pick('ssh-key', CA);
      const res = await create(withTls({ caPath: CA }));
      expect(res.ok).toBe(false);
    });

    it('rejects a path picked only as a data import', async () => {
      await pick('data-import', CA);
      const res = await create(withTls({ caPath: CA }));
      expect(res.ok).toBe(false);
    });

    it('rejects a path that differs from the picked one by anything', async () => {
      await pick('tls-ca', CA);
      expect((await create(withTls({ caPath: `${CA}/` }))).ok).toBe(false);
      expect((await create(withTls({ caPath: '/certs/../certs/ca.pem' }))).ok).toBe(false);
    });

    it('accepts a connection with no credential paths and with empty ones', async () => {
      expect((await create(withTls({}))).ok).toBe(true);
      expect((await create({ ...withTls({ caPath: '' }), name: 'Empty' })).ok).toBe(true);
    });
  });

  describe('conn:update', () => {
    let id: string;
    beforeEach(async () => {
      await pick('tls-ca', CA);
      const res = await create(withTls({ caPath: CA }));
      if (!res.ok) throw new Error('setup create failed');
      id = res.data.id;
      // A fresh session: nothing picked any more.
      handlers.clear();
      const repo = new ConnectionRepo(tmp.db);
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
      vi.spyOn(pool, 'disconnect').mockResolvedValue(undefined);
      const router = createRouter(
        { handle: (c: string, fn: Handler) => void handlers.set(c, fn) },
        testSenderCheck,
      );
      const picked = createPickedCredentialPaths();
      registerAppChannels(router, () => null, new Set(), picked);
      registerConnChannels(router, new ConnectionService({ repo, vault, pool }), picked);
    });

    it('saves other fields when the stored path is sent back unchanged without a re-pick', async () => {
      const res = await call(IPC_CHANNELS.connUpdate, {
        id,
        patch: { name: 'Renamed', ...withTls({ caPath: CA }) },
      });
      expect(res.ok).toBe(true);
    });

    it('rejects a changed path that was not picked', async () => {
      const res = await call(IPC_CHANNELS.connUpdate, {
        id,
        patch: withTls({ caPath: '/certs/other.pem' }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.details).toEqual({
        issues: [{ path: ['tls', 'caPath'], message: expect.any(String) }],
      });
    });

    it('accepts a changed path once it is picked', async () => {
      await pick('tls-ca', '/certs/other.pem');
      const res = await call(IPC_CHANNELS.connUpdate, {
        id,
        patch: withTls({ caPath: '/certs/other.pem' }),
      });
      expect(res.ok).toBe(true);
    });

    it('does not treat the stored CA path as valid for another field', async () => {
      const res = await call(IPC_CHANNELS.connUpdate, {
        id,
        patch: withTls({ clientCertPath: CA }),
      });
      expect(res.ok).toBe(false);
    });

    it('always allows clearing a stored path', async () => {
      const res = await call(IPC_CHANNELS.connUpdate, { id, patch: withTls({ caPath: '' }) });
      expect(res.ok).toBe(true);
    });

    it('answers NOT_FOUND for an unknown connection id', async () => {
      const res = await call(IPC_CHANNELS.connUpdate, { id: 'nope', patch: withTls({ caPath: CA }) });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('NOT_FOUND');
    });
  });

  describe('conn:test', () => {
    it('rejects an unpicked path and never probes', async () => {
      const res = await call(IPC_CHANNELS.connTest, input(withTls({ caPath: CA })));
      expect(res.ok).toBe(false);
      expect(probeSpy).not.toHaveBeenCalled();
    });

    it('probes with a picked path', async () => {
      await pick('tls-ca', CA);
      const res = await call(IPC_CHANNELS.connTest, input(withTls({ caPath: CA })));
      expect(res.ok).toBe(true);
      expect(probeSpy).toHaveBeenCalledTimes(1);
    });

    it('probes with a path stored on any connection', async () => {
      await pick('tls-ca', CA);
      await create({ ...withTls({ caPath: CA }), name: 'Holder' });
      handlers.clear();
      // Re-register against a fresh picked set: only the stored path remains.
      const repo = new ConnectionRepo(tmp.db);
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
      vi.spyOn(pool, 'probe').mockResolvedValue({ ok: true, serverVersion: '7.0.0', topology: 'Single' } as ProbeResult);
      const router = createRouter(
        { handle: (c: string, fn: Handler) => void handlers.set(c, fn) },
        testSenderCheck,
      );
      registerConnChannels(router, new ConnectionService({ repo, vault, pool }), createPickedCredentialPaths());
      expect((await call(IPC_CHANNELS.connTest, input(withTls({ caPath: CA })))).ok).toBe(true);
      expect((await call(IPC_CHANNELS.connTest, input(withTls({ clientCertPath: CA })))).ok).toBe(false);
      expect((await call(IPC_CHANNELS.connTest, input(withTls({ caPath: '/certs/other.pem' })))).ok).toBe(false);
    });
  });
});
