// An earlier revision widened `recent:clear`'s input from `{ connectionId?, collection? }` to
// `{ id?, connectionId?, dbName?, collection?, kind? }`. Every other test on
// that path calls `svc.clear(...)` directly, so `ClearInputSchema` — the piece
// that actually changed — was never parsed by anything. A dropped field there
// silently widens a scoped clear into a connection-wide one, which on this
// channel means deleting history nobody asked to lose.
import { describe, it, expect, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerRecentChannels } from '../../electron/ipc/handlers/recent';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { Envelope } from '../../shared/ipc';
import type { RecentQueryService } from '../../electron/services/RecentQueryService';
import type { RecentFieldValueService } from '../../electron/services/RecentFieldValueService';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// The router never reads the event (`_evt` in router.ts).

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

function setup() {
  const clear = vi.fn(() => ({ deleted: 1 }));
  const listForField = vi.fn(() => []);
  const recordMany = vi.fn(() => ({ recorded: 1 }));
  const clearAll = vi.fn(() => ({ deleted: 1 }));
  const shim = createShim();
  registerRecentChannels(
    createRouter(shim.ipcMain, testSenderCheck),
    { clear } as unknown as RecentQueryService,
    { listForField, recordMany, clearAll } as unknown as RecentFieldValueService,
  );
  return { shim, clear, listForField, recordMany, clearAll };
}

describe('recent:clear input validation', () => {
  it('passes the full four-part scope through to the service', async () => {
    const { shim, clear } = setup();
    const scope = { connectionId: 'c1', dbName: 'shop', collection: 'orders', kind: 'find' };

    const res = await shim.invoke(IPC_CHANNELS.recentClear, scope);

    expect(res.ok).toBe(true);
    expect(clear).toHaveBeenCalledWith(scope);
  });

  it('passes a single id through for the per-row delete', async () => {
    const { shim, clear } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentClear, { id: 'r1' });

    expect(res.ok).toBe(true);
    expect(clear).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('rejects an unknown kind rather than widening the clear', async () => {
    const { shim, clear } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentClear, {
      connectionId: 'c1',
      kind: 'everything',
    });

    expect(res.ok).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('recent:valuesForField / recordFieldValues / clearFieldValues input validation', () => {
  it('valuesForField passes the four-part scope and field through', async () => {
    const { shim, listForField } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentValuesForField, {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      field: 'status',
    });

    expect(res.ok).toBe(true);
    expect(listForField).toHaveBeenCalledWith('c1', 'shop', 'orders', 'status', undefined);
  });

  it('valuesForField rejects a limit above 100', async () => {
    const { shim, listForField } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentValuesForField, {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      field: 'status',
      limit: 500,
    });

    expect(res.ok).toBe(false);
    expect(listForField).not.toHaveBeenCalled();
  });

  it('recordFieldValues rejects an entry missing op', async () => {
    const { shim, recordMany } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentRecordFieldValues, {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      entries: [{ field: 'status', value: 'shipped', valType: 'string' }],
    });

    expect(res.ok).toBe(false);
    expect(recordMany).not.toHaveBeenCalled();
  });

  it('recordFieldValues rejects an empty entries array', async () => {
    const { shim, recordMany } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentRecordFieldValues, {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      entries: [],
    });

    expect(res.ok).toBe(false);
    expect(recordMany).not.toHaveBeenCalled();
  });

  it('recordFieldValues passes valid entries through to the service', async () => {
    const { shim, recordMany } = setup();
    const entries = [{ field: 'status', value: 'shipped', valType: 'string', op: '$eq' }];

    const res = await shim.invoke(IPC_CHANNELS.recentRecordFieldValues, {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      entries,
    });

    expect(res.ok).toBe(true);
    expect(recordMany).toHaveBeenCalledWith('c1', 'shop', 'orders', entries);
  });

  it('clearFieldValues takes no input and calls the service', async () => {
    const { shim, clearAll } = setup();

    const res = await shim.invoke(IPC_CHANNELS.recentClearFieldValues, {});

    expect(res.ok).toBe(true);
    expect(clearAll).toHaveBeenCalled();
  });
});
