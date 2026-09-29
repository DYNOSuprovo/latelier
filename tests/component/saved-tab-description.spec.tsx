import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import { SavedTab } from '../../src/pages/Workspace/views/SavedTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { SavedQuerySummary } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function makeSummary(overrides: Partial<SavedQuerySummary>): SavedQuerySummary {
  return {
    id: 'q1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    name: 'My Query',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SavedTab — description rendering', () => {
  it('renders the description for an item that has one', async () => {
    installAtelierMock({
      saved: {
        list: async () => [
          makeSummary({ id: 'q1', name: 'With Note', description: 'note text' }),
        ],
      },
    });

    render(
      <SavedTab
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onRunHere={() => {}}
        onOpenInTab={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('With Note')).toBeTruthy());
    const description = screen.getByText('note text');
    expect(description).toBeTruthy();
    expect(description.getAttribute('title')).toBe('note text');
  });

  it('renders no stray description text for an item without one', async () => {
    installAtelierMock({
      saved: {
        list: async () => [
          makeSummary({ id: 'q2', name: 'No Note', description: undefined }),
        ],
      },
    });

    render(
      <SavedTab
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onRunHere={() => {}}
        onOpenInTab={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('No Note')).toBeTruthy());
    expect(screen.queryByText('undefined')).toBeNull();
  });
});
