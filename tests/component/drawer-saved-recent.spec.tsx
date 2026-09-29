// W15 §13.4 / §13.5 / §13.7 — the Saved tab and the Recent tab: honest
// labels, a query you can identify, copy actions that report, and chrome
// that survives loading and error.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { SavedTab } from '../../src/pages/Workspace/views/SavedTab';
import { RecentTab } from '../../src/pages/Workspace/views/RecentTab';
import { notifications } from '@mantine/notifications';
import { modals } from '@mantine/modals';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { RecentQuery, SavedQuerySummary } from '@shared/types';

afterEach(() => {
  // Mantine's notification store is module-global and outlives RTL's
  // unmount, so a toast raised by one test would still be on screen for the
  // next one's "did it *not* claim success?" assertion.
  notifications.clean();
  // Same reason, one layer over: the delete/clear confirms live in the
  // modal manager's global store, so a test that fails mid-dialog would
  // leave it mounted for the next one.
  modals.closeAll();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function summary(overrides: Partial<SavedQuerySummary> = {}): SavedQuerySummary {
  return {
    id: 'q1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    name: 'Unpaid orders',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function recent(overrides: Partial<RecentQuery> = {}): RecentQuery {
  return {
    id: 'r1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    payload: {
      kind: 'find',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{"status":{"$eq":"paid"}}',
    },
    ranAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    durationMs: 12,
    resultCount: 4,
    ...overrides,
  };
}

/**
 * A recent row as it was written before `queryRaw` existed. The live
 * `SavedFindPayload` type requires `queryRaw`, but the wire's IPC schema
 * validates recent payloads loosely (`z.record`), so a pre-W13 row really can
 * arrive shaped like this — the double cast mirrors that mismatch instead of
 * typechecking it away, the same way `saved-legacy-payload.spec.tsx` does.
 */
const LEGACY_PAYLOAD = {
  kind: 'find',
  builder: { projection: [], sort: '', limit: '' },
} as unknown as RecentQuery['payload'];

function renderRecent() {
  return render(
    <RecentTab connectionId="c1" dbName="shop" collection="orders" onRunHere={() => {}} />,
  );
}

function renderSaved(overrides: { onRunHere?: () => void; onOpenInTab?: (s: SavedQuerySummary) => void } = {}) {
  return render(
    <SavedTab
      connectionId="c1"
      dbName="shop"
      collection="orders"
      onRunHere={overrides.onRunHere ?? (() => {})}
      onOpenInTab={overrides.onOpenInTab ?? (() => {})}
    />,
  );
}

// ─── §13.4 Recent rows ───────────────────────────────────────────────────────

describe('W15 §13.4 — a Recent row shows what was queried', () => {
  it('renders the filter and a timestamp that disambiguates days', async () => {
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    await screen.findByText('{"status":{"$eq":"paid"}}');
    // A bare `toLocaleTimeString()` made a run from three days ago read
    // `14:32`, indistinguishable from one an hour ago.
    expect(screen.getByText(/3d ago/)).toBeTruthy();
  });

  it('says so on a legacy row that stored no query', async () => {
    installAtelierMock({
      recent: {
        list: async () => [
          recent({
            payload: LEGACY_PAYLOAD,
          }),
        ],
      },
    });
    renderRecent();

    expect(await screen.findByText('no stored query')).toBeTruthy();
    // And it says so instead of rendering an empty or invented filter: the
    // row carries no `$`-prefixed operator text at all.
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

describe('W15 §13.7 — Recent\'s Copy MQL reports, and never silently no-ops', () => {
  it('copies and says so', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    fireEvent.click(await screen.findByRole('button', { name: /^Copy MQL to the clipboard$/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"status":{"$eq":"paid"}}'));
    await screen.findByText(/Query copied to the clipboard/);
  });

  it('reports a rejected copy rather than claiming success', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    fireEvent.click(await screen.findByRole('button', { name: /^Copy MQL to the clipboard$/ }));

    await screen.findByText(/Could not copy to the clipboard/);
    expect(screen.queryByText(/Query copied to the clipboard/)).toBeNull();
  });

  it('is unavailable, with the reason stated, on a row with no stored query', async () => {
    installAtelierMock({
      recent: {
        list: async () => [
          recent({
            payload: LEGACY_PAYLOAD,
          }),
        ],
      },
    });
    renderRecent();

    const copy = await screen.findByRole('button', { name: /Copy MQL — this run has no stored query/ });
    expect(copy).toHaveProperty('disabled', true);
  });
});

// ─── §13.5 chrome survives loading / error, and icon buttons have names ──────

describe('W15 §13.5 — Saved and Recent keep their chrome through loading and error', () => {
  it('Recent keeps its header while loading and after a failure', async () => {
    let reject!: (e: Error) => void;
    installAtelierMock({
      recent: {
        list: (() => new Promise((_res, rej) => { reject = rej; })) as unknown as IpcApi['recent']['list'],
      },
    });
    renderRecent();

    // Loading: the header is there, not a bare centered message.
    await screen.findByText('Loading…');
    expect(screen.getByText(/Recent ·/)).toBeTruthy();

    reject(new Error('boom'));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    // Error: still there, and the refresh control is still reachable.
    expect(screen.getByText(/Recent ·/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh recent queries' })).toBeTruthy();
  });

  it('Saved keeps its header while loading and after a failure', async () => {
    let reject!: (e: Error) => void;
    installAtelierMock({
      saved: {
        list: (() => new Promise((_res, rej) => { reject = rej; })) as unknown as IpcApi['saved']['list'],
      },
    });
    renderSaved();

    await screen.findByText('Loading…');
    expect(screen.getByText(/Saved ·/)).toBeTruthy();

    reject(new Error('boom'));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByText(/Saved ·/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh saved queries' })).toBeTruthy();
  });

  it('Saved\'s icon-only delete has a real accessible name, not just a title', async () => {
    installAtelierMock({ saved: { list: async () => [summary({ name: 'Unpaid orders' })] } });
    renderSaved();

    const del = await screen.findByRole('button', { name: 'Delete "Unpaid orders"' });
    // `title` is kept for the hover tooltip; it is not what names the button.
    expect(del.getAttribute('title')).toBe('Delete');
    // Row actions are distinguishable from one another, per row.
    expect(screen.getByRole('button', { name: 'Run "Unpaid orders" in this tab' })).toBeTruthy();
  });
});

// SavedTab is the only surface listing saved aggregation/script items now
// that SavedStrip is gone, so it has to be able to open them, not just find
// queries.
describe('SavedTab opens every saved kind, not just find', () => {
  it('a find row runs in place via onRunHere', async () => {
    const onRunHere = vi.fn();
    installAtelierMock({
      saved: {
        list: async () => [summary({ kind: 'find', name: 'Unpaid orders' })],
        get: async () => ({ ...summary({ kind: 'find' }), payload: { kind: 'find', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}' } } as never),
      },
    });
    renderSaved({ onRunHere });

    fireEvent.click(await screen.findByRole('button', { name: 'Run "Unpaid orders" in this tab' }));

    await waitFor(() => expect(onRunHere).toHaveBeenCalledTimes(1));
  });

  it('an aggregation row opens as its own tab via onOpenInTab, not onRunHere', async () => {
    const onRunHere = vi.fn();
    const onOpenInTab = vi.fn();
    const agg = summary({ kind: 'aggregation', name: 'Top spenders' });
    installAtelierMock({ saved: { list: async () => [agg] } });
    renderSaved({ onRunHere, onOpenInTab });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Top spenders" in a new tab' }));

    expect(onOpenInTab).toHaveBeenCalledWith(agg);
    expect(onRunHere).not.toHaveBeenCalled();
  });

  it('a script row opens as its own tab via onOpenInTab, not onRunHere', async () => {
    const onRunHere = vi.fn();
    const onOpenInTab = vi.fn();
    const script = summary({ kind: 'script', name: 'Backfill emails' });
    installAtelierMock({ saved: { list: async () => [script] } });
    renderSaved({ onRunHere, onOpenInTab });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Backfill emails" in a new tab' }));

    expect(onOpenInTab).toHaveBeenCalledWith(script);
    expect(onRunHere).not.toHaveBeenCalled();
  });

  it('labels each row by kind so find, aggregation and script are distinguishable', async () => {
    installAtelierMock({
      saved: {
        list: async () => [
          summary({ id: 'q1', kind: 'find', name: 'Unpaid orders' }),
          summary({ id: 'q2', kind: 'aggregation', name: 'Top spenders' }),
          summary({ id: 'q3', kind: 'script', name: 'Backfill emails' }),
        ],
      },
    });
    renderSaved();

    await screen.findByText('Unpaid orders');
    expect(screen.getByText('Find')).toBeTruthy();
    expect(screen.getByText('Aggregation')).toBeTruthy();
    expect(screen.getByText('Script')).toBeTruthy();
  });
});

// Recent's delete and clear-history.
describe(' Recent can delete a row and clear its history', () => {
  const PREVIEW = '{"status":{"$eq":"paid"}}';

  it('per-row delete asks first, and is bounded by the tab’s scope', async () => {
    const clear = vi.fn(async () => ({ deleted: 1 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${PREVIEW} from recent history` }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete this run?');
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    // The id alone used to be the whole filter. A review finding
    // pointed out that a stale `recent.list` can put another collection's rows
    // under this header, and a bare id would then delete that collection's
    // history. The scope travels with it so the delete ANDs down to nothing
    // rather than to the wrong thing.
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        id: 'r1',
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        kind: 'find',
      }),
    );
  });

  it('cancelling the per-row delete deletes nothing', async () => {
    const clear = vi.fn(async () => ({ deleted: 1 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${PREVIEW} from recent history` }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(clear).not.toHaveBeenCalled();
  });

  it('clear history confirms with the collection named, then clears the full four-part scope', async () => {
    const clear = vi.fn(async () => ({ deleted: 3 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear recent find history for orders' }),
    );

    const dialog = await screen.findByRole('dialog');
    // The scope decision has to be legible before the user commits to it.
    expect(dialog.textContent).toContain('orders');
    expect(dialog.textContent).toContain('shop');
    expect(dialog.textContent).toContain('Aggregation history');
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    // `kind: 'find'` is the guard: without it this wipes aggregation history
    // the tab never listed. `dbName` keeps it off `analytics.orders`.
    await waitFor(() => expect(clear).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      kind: 'find',
    }));
  });

  it('cancelling clear history clears nothing', async () => {
    const clear = vi.fn(async () => ({ deleted: 3 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear recent find history for orders' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(clear).not.toHaveBeenCalled();
  });
});
