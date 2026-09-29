// N4.7 — the app had four "are you sure?" patterns for one interaction.
// These pin the two behaviours that must hold at every converted site: the
// confirm actually appears, and cancelling does not perform the action.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { modals } from '@mantine/modals';
import { SavedTab } from '../../src/pages/Workspace/views/SavedTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { SavedQuerySummary } from '@shared/types';
import { confirmDestructive } from '../../src/utils/confirm';

afterEach(() => {
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
    updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function renderSaved() {
  return render(
    <SavedTab
      connectionId="c1"
      dbName="shop"
      collection="orders"
      onRunHere={() => {}}
      onOpenInTab={() => {}}
    />,
  );
}

describe('SavedTab delete goes through the standard confirm', () => {
  it('asks before deleting, and does not delete until confirmed', async () => {
    const del = vi.fn(async () => {});
    installAtelierMock({
      saved: { list: async () => [summary()], delete: del },
    });
    renderSaved();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete "Unpaid orders"' }));

    // The confirm is a real dialog, not a native `window.confirm` — which is
    // what made this untestable and unthemeable before.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete "Unpaid orders"?');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(del).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: 'q1' }));
  });

  it('cancelling leaves the saved query alone', async () => {
    const del = vi.fn(async () => {});
    installAtelierMock({
      saved: { list: async () => [summary()], delete: del },
    });
    renderSaved();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete "Unpaid orders"' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(del).not.toHaveBeenCalled();
    // The row is still there.
    expect(screen.getByText('Unpaid orders')).toBeTruthy();
  });
});

describe('confirmDestructive resolves honestly', () => {
  // The promise shape is the whole reason the helper exists — `window.confirm`
  // call sites read `if (!confirm(…)) return;` mid-function, and a callback API
  // would force each one inside out. If it ever failed to settle, a tab close
  // or a delete would hang silently rather than fail loudly.
  function Harness({ onResult }: { onResult: (v: boolean) => void }) {
    return (
      <button
        onClick={() => {
          void confirmDestructive({
            title: 'Discard it?',
            body: 'This cannot be undone.',
            confirmLabel: 'Discard',
          }).then(onResult);
        }}
      >
        go
      </button>
    );
  }

  it('resolves true on confirm', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false on cancel', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  // Escape and the backdrop bypass both callbacks and only fire `onClose`.
  // Without that branch the promise never settles and the caller hangs
  // forever — the failure mode a hand-rolled overlay makes easy to miss.
  it('resolves false when dismissed rather than answered', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await screen.findByRole('dialog');

    modals.closeAll();

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('settles once — a confirm is not later overwritten by its own close', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalledWith(false);
  });
});
