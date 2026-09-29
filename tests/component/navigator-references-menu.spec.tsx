import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import {
  DbCollectionNavigator,
  type DbCollectionNavigatorProps,
} from '../../src/pages/Workspace/DbCollectionNavigator';
import {
  connectionFixture,
  installAtelierMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';

function mountNavigator(props: Partial<DbCollectionNavigatorProps> = {}) {
  const baseProps: DbCollectionNavigatorProps = {
    connectionsWithTabs: new Set(),
    connections: [connectionFixture({ id: 'c1', name: 'Prod', color: '#1A6835' })],
    focusedConnectionId: 'c1',
    activeDbName: 'shop',
    activeCollection: 'orders',
    onOpenCollection: vi.fn(),
    onOpenAggregation: vi.fn(),
    ...props,
  };
  return render(<DbCollectionNavigator {...baseProps} />);
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function baseMocks(overrides: Parameters<typeof installAtelierMock>[0] = {}) {
  return installAtelierMock({
    meta: {
      listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
      listCollections: async () => [
        { name: 'orders', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
        { name: 'invoices', type: 'collection' as const, documentCount: 0, sizeBytes: 0, indexCount: 0, capped: false },
      ],
    },
    ...overrides,
  });
}

// The header's References button was retired to this menu item (six-chrome-
// strips cleanup) plus a command-palette entry (already wired). Scoped to
// the Focused Tab's own collection — the drawer it opens reads rules off
// that collection, not off whichever row the menu was opened from.
describe('DbCollectionNavigator — References… menu item', () => {
  it('is enabled on the active row and calls onOpenReferences', async () => {
    baseMocks();
    const onOpenReferences = vi.fn();
    mountNavigator({ onOpenReferences });
    await screen.findByTestId('nav-coll-shop-orders');

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-orders'));
    const item = screen.getByRole('menuitem', { name: 'References…' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);

    expect(onOpenReferences).toHaveBeenCalledTimes(1);
  });

  it('is disabled on a row that is not the Focused Tab’s active collection', async () => {
    baseMocks();
    const onOpenReferences = vi.fn();
    mountNavigator({ onOpenReferences });
    await screen.findByTestId('nav-coll-shop-invoices');

    fireEvent.contextMenu(screen.getByTestId('nav-coll-shop-invoices'));
    const item = screen.getByRole('menuitem', { name: 'References…' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);

    expect(onOpenReferences).not.toHaveBeenCalled();
  });
});
