import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerDocChannels } from '../../electron/ipc/handlers/doc';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ValidationError } from '../../electron/errors';
import type { DocumentService } from '../../electron/mongo/DocumentService';
import type { Envelope } from '../../shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// The router never reads the event (`_evt` in router.ts), so the shim stands
// one in rather than constructing a real Electron event.

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

const TARGET = { connectionId: 'c1', dbName: 'shop', collection: 'orders' };

/**
 * `doc:*` had router-level coverage nowhere: `document-service.spec.ts`
 * exercises `DocumentService` directly against a real `mongodb-memory-server`,
 * never through `createRouter`/`registerDocChannels`, so Zod validation and
 * `AppError` → `IpcError.code` mapping for this domain were unverified. `svc`
 * is stubbed (a plain object shaped like `DocumentService`, cast to it) so
 * each test isolates the handler/router behavior, matching the pattern in
 * `conn-handlers.spec.ts`.
 */
describe('doc:* handlers via router', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: DocumentService;

  beforeEach(() => {
    shim = createShim();
  });

  function setupWith(overrides: Partial<DocumentService> = {}) {
    const base: Partial<DocumentService> = {
      insert: async () => ({ insertedId: 'oid-1' }),
      insertMany: async () => ({ insertedCount: 2, insertedIds: ['oid-1', 'oid-2'] }),
      updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
      deleteOne: async () => ({ deletedCount: 1 }),
      confirmDeleteMany: async () => ({ count: 3, confirmToken: 'tok-1' }),
      deleteMany: async () => ({ deletedCount: 3 }),
      confirmUpdateMany: async () => ({ count: 3, confirmToken: 'tok-2' }),
      updateMany: async () => ({ matchedCount: 3, modifiedCount: 3 }),
    };
    svc = { ...base, ...overrides } as DocumentService;
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerDocChannels(router, svc);
  }

  it('doc:insert returns the service result through the envelope', async () => {
    setupWith({ insert: async () => ({ insertedId: 'oid-42' }) });
    const env = await shim.invoke<{ insertedId: unknown }>(IPC_CHANNELS.docInsert, {
      ...TARGET,
      docJson: '{"a":1}',
    });
    expect(env).toEqual({ ok: true, data: { insertedId: 'oid-42' } });
  });

  it('doc:insert with a missing docJson fails Zod (VALIDATION)', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.docInsert, { ...TARGET });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:insertMany forwards the service result', async () => {
    const insertManySpy = vi.fn(async () => ({ insertedCount: 3, insertedIds: ['a', 'b', 'c'] }));
    setupWith({ insertMany: insertManySpy });
    const env = await shim.invoke(IPC_CHANNELS.docInsertMany, {
      ...TARGET,
      docsJson: '[{"a":1},{"a":2}]',
    });
    expect(env).toEqual({ ok: true, data: { insertedCount: 3, insertedIds: ['a', 'b', 'c'] } });
    expect(insertManySpy).toHaveBeenCalledTimes(1);
  });

  it('doc:updateOne maps ValidationError (e.g. an empty filter) to VALIDATION', async () => {
    setupWith({
      updateOne: async () => {
        throw new ValidationError('filterJson must not be empty', { field: 'filterJson' });
      },
    });
    const env = await shim.invoke(IPC_CHANNELS.docUpdateOne, {
      ...TARGET,
      filterJson: '{}',
      updateJson: '{"$set":{"a":1}}',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:updateOne with a missing updateJson fails Zod (VALIDATION)', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.docUpdateOne, {
      ...TARGET,
      filterJson: '{"_id":"x"}',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:deleteOne forwards the service result', async () => {
    setupWith({ deleteOne: async () => ({ deletedCount: 1 }) });
    const env = await shim.invoke(IPC_CHANNELS.docDeleteOne, {
      ...TARGET,
      filterJson: '{"_id":"x"}',
    });
    expect(env).toEqual({ ok: true, data: { deletedCount: 1 } });
  });

  it('doc:confirmDeleteMany returns the count + token pair the deleteMany flow depends on', async () => {
    setupWith({ confirmDeleteMany: async () => ({ count: 7, confirmToken: 'abc-123' }) });
    const env = await shim.invoke(IPC_CHANNELS.docConfirmDeleteMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
    });
    expect(env).toEqual({ ok: true, data: { count: 7, confirmToken: 'abc-123' } });
  });

  it('doc:deleteMany with a missing confirmToken fails Zod (VALIDATION), never reaching the service', async () => {
    const deleteManySpy = vi.fn(async () => ({ deletedCount: 3 }));
    setupWith({ deleteMany: deleteManySpy });
    const env = await shim.invoke(IPC_CHANNELS.docDeleteMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it('doc:deleteMany maps an invalid/expired confirmToken (ValidationError) to VALIDATION', async () => {
    setupWith({
      deleteMany: async () => {
        throw new ValidationError('confirmToken is invalid or expired', { field: 'confirmToken' });
      },
    });
    const env = await shim.invoke(IPC_CHANNELS.docDeleteMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      confirmToken: 'expired-token',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:deleteMany with a valid confirmToken forwards the service result', async () => {
    setupWith({ deleteMany: async () => ({ deletedCount: 3 }) });
    const env = await shim.invoke(IPC_CHANNELS.docDeleteMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      confirmToken: 'tok-1',
    });
    expect(env).toEqual({ ok: true, data: { deletedCount: 3 } });
  });

  it('doc:confirmUpdateMany returns the count + token pair the updateMany flow depends on', async () => {
    setupWith({ confirmUpdateMany: async () => ({ count: 5, confirmToken: 'upd-token' }) });
    const env = await shim.invoke(IPC_CHANNELS.docConfirmUpdateMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      updateJson: '{"$set":{"status":"archived"}}',
    });
    expect(env).toEqual({ ok: true, data: { count: 5, confirmToken: 'upd-token' } });
  });

  it('doc:confirmUpdateMany with a missing updateJson fails Zod (VALIDATION)', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.docConfirmUpdateMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:updateMany with a missing confirmToken fails Zod (VALIDATION), never reaching the service', async () => {
    const updateManySpy = vi.fn(async () => ({ matchedCount: 3, modifiedCount: 3 }));
    setupWith({ updateMany: updateManySpy });
    const env = await shim.invoke(IPC_CHANNELS.docUpdateMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      updateJson: '{"$set":{"status":"archived"}}',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it('doc:updateMany maps an invalid/expired confirmToken (ValidationError) to VALIDATION', async () => {
    setupWith({
      updateMany: async () => {
        throw new ValidationError('confirmToken is invalid or expired', { field: 'confirmToken' });
      },
    });
    const env = await shim.invoke(IPC_CHANNELS.docUpdateMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      updateJson: '{"$set":{"status":"archived"}}',
      confirmToken: 'expired-token',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('doc:updateMany with a valid confirmToken forwards the service result', async () => {
    setupWith({ updateMany: async () => ({ matchedCount: 5, modifiedCount: 4 }) });
    const env = await shim.invoke(IPC_CHANNELS.docUpdateMany, {
      ...TARGET,
      filterJson: '{"status":"stale"}',
      updateJson: '{"$set":{"status":"archived"}}',
      confirmToken: 'tok-2',
    });
    expect(env).toEqual({ ok: true, data: { matchedCount: 5, modifiedCount: 4 } });
  });
});
