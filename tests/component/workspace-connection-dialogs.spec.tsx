// Phase 1 characterization tests (specs/PLAN-workspace-decomposition.md §5,
// T3) for the connection-dialog wiring in Workspace.tsx: `connectionFormTarget`
// (~461), `deleteConnectionTarget` (~472), `connectionTable` (~503),
// `tableReturnFocus` (~516), `confirmDeleteConnection` (~1755),
// `handleConnectionSaved` (~1807).
//
// `connection-switcher.spec.tsx` already mounts the full `<Workspace />` and
// covers most of this wiring in depth:
//   - "+ Add connection" (in the table) opens create mode, and a save
//     connects the new Connection and refreshes the Switcher's list (its
//     "ConnectionSwitcher — add/edit" describe block).
//   - Confirming a per-row delete destroys the Connection, removes it from
//     the Switcher, and closes only *that* Connection's tabs, leaving another
//     Connection's alone (its "ConnectionSwitcher — manage/disconnect/delete
//     row actions" describe block).
// Those two are therefore NOT repeated here (see the report for exact test
// names) — this file covers only what that suite does not:
//   1. the disconnect/delete snapshot invariant (name + tabCount captured at open
//      time, not read live while the dialog is up), and
//   2. focus return from a dialog opened off an expanded-table ROW, which
//      that suite's own "Edit" case explicitly documents as NOT returning to
//      the trigger (a different code path — Edit hands off to a modal with
//      its own focus trap) but never exercises for Delete, whose dialog uses
//      `returnFocusTo` directly.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, titleBar } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';

const NOW = '2026-08-01T12:00:00.000Z';

function collectionTab(overrides: Partial<CollectionTab> = {}): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
    },
    ...overrides,
  };
}

/** A tab store that actually mutates, mirroring connection-switcher.spec.tsx's own. */
function tabStore(initial: CollectionTab[]) {
  let rows = [...initial];
  return {
    list: async () => rows,
    close: async (id: string) => {
      rows = rows.filter((t) => t.id !== id);
      return { newActiveId: rows.find((t) => t.isActive)?.id ?? null };
    },
    setActive: async (id: string) => {
      rows = rows.map((t) => ({ ...t, isActive: t.id === id }));
      return { id };
    },
  };
}

function mountWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('workspace connection dialogs (T3)', () => {
  it(
    "the per-row delete confirm's name and tab count are snapshotted at open time — a connections/tabs refresh underneath it does not change what it shows",
    async () => {
      const backingConnections = [
        connectionFixture({ id: 'c1', name: 'Alpha', status: 'connected' }),
      ];
      const store = tabStore([
        collectionTab({ id: 't1', collection: 'orders', isActive: true, position: 0 }),
        collectionTab({ id: 't2', collection: 'invoices', isActive: false, position: 1 }),
      ]);
      installAtelierMock({
        conn: { list: async () => backingConnections },
        tabs: store,
      });
      mountWorkspace();

      await screen.findByLabelText('Close orders');
      // Captured before the dialog opens: Mantine's `Modal` gives its own
      // content a plain `<header>`, which — portalled straight under
      // `<body>`, outside any sectioning element — computes the same
      // implicit "banner" landmark role as AppShell's real header. Querying
      // `titleBar()` (unscoped `getByRole('banner')`) again once the dialog
      // is open would throw on that ambiguity, so the trigger reference is
      // grabbed once, up front, and reused directly below instead.
      const trigger = await titleBar().findByRole('button', { name: /^Connection: /i });
      await userEvent.click(trigger);
      const listbox = await screen.findByRole('listbox', { name: 'Connections' });
      await userEvent.click(within(listbox).getByRole('button', { name: 'Delete Alpha' }));

      const dialog = await screen.findByRole('dialog', { name: 'Delete "Alpha"?' });
      expect(within(dialog).getByText(/closes 2 open tabs/)).toBeTruthy();

      // Mutate what each live source would return next, and trigger both of
      // their real refetch paths while the dialog is still open: a window
      // focus event (useConnections' own refetch trigger) and closing the
      // *other* tab on this Connection through the tab strip's own button
      // (a real state change, not a mock poke) — exactly the two races the
      // snapshot invariant guards against.
      backingConnections[0]!.name = 'Renamed';
      fireEvent(window, new Event('focus'));
      fireEvent.click(screen.getByLabelText('Close invoices'));

      // Prove the refetch actually landed — otherwise the assertions below
      // would pass vacuously against a mock that never changed anything.
      await waitFor(() => expect(within(trigger).queryByText('Alpha')).toBeNull());
      await waitFor(() => expect(screen.queryByLabelText('Close invoices')).toBeNull());

      // The already-open dialog still shows what it opened with.
      expect(screen.getByRole('dialog', { name: 'Delete "Alpha"?' })).toBeTruthy();
      expect(within(dialog).getByText(/closes 2 open tabs/)).toBeTruthy();
    },
  );

  it(
    'deleting from a row in the expanded table returns focus to the Switcher trigger that opened the table, not the (now-detached) row button',
    async () => {
      const deleteSpy = vi.fn(async (id: string) => ({ id }));
      installAtelierMock({
        conn: {
          list: async () => [connectionFixture({ id: 'c1', name: 'Alpha', status: 'connected' })],
          delete: deleteSpy,
        },
        tabs: { list: async () => [] },
      });
      mountWorkspace();

      const trigger = await titleBar().findByRole('button', { name: /^Connection: /i });
      await userEvent.click(trigger);
      await screen.findByRole('listbox', { name: 'Connections' });
      await userEvent.click(screen.getByRole('button', { name: 'Manage connections…' }));
      const table = await screen.findByRole('dialog', { name: 'Connections' });

      const row = within(table).getByText('Alpha').closest('tr');
      if (!row) throw new Error('no table row found for "Alpha"');
      await userEvent.click(row);
      await userEvent.click(within(table).getByRole('button', { name: 'Delete Alpha' }));

      expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
      const confirm = await screen.findByRole('dialog', { name: 'Delete "Alpha"?' });
      await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Delete "Alpha"?' })).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(deleteSpy).not.toHaveBeenCalled();
    },
  );
});
