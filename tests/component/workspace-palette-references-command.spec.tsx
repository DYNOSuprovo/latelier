// The header's "References (n)" button was retired (six-chrome-strips
// cleanup); the command palette's existing `references.configure` command
// is now its only keyboard-reachable home besides the navigator's context
// menu. This drives that command end to end against a real mounted
// `<Workspace/>`, the same harness `workspace-palette-connection-commands.spec.tsx`
// uses for other Workspace-registered commands.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import type { CollectionTab, CollectionTabState } from '@shared/types';

const NOW = '2026-08-01T12:00:00.000Z';

function tab(stateOverrides: Partial<CollectionTabState> = {}): CollectionTab {
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
      lastRun: { documents: [{ _id: '1', sku: 'widget' }], durationMs: 1, ranAt: NOW },
      ...stateOverrides,
    },
  };
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function app() {
  return (
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Workspace />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  vi.restoreAllMocks();
});

describe('Workspace palette — Configure references', () => {
  it('opens the reference rules editor for the Focused Tab’s collection', async () => {
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    });

    render(app());
    await screen.findByText(/widget/);

    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(await screen.findByText('Configure references'));

    expect(await screen.findByRole('dialog', { name: 'Reference rules' })).toBeTruthy();
  });
});
