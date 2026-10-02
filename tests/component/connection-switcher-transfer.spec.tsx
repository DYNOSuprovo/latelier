import { describe, it, expect, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import Workspace from '../../src/pages/Workspace';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import type { ConnectionSummary } from '@shared/types';

const row = (id: string, name: string): ConnectionSummary => ({
  id, name, color: '#1A6835', host: 'localhost', port: 27017,
  connectionType: 'standard', readOnly: false, status: 'unknown',
});

function mount(connections: ConnectionSummary[]) {
  installAtelierMock({ conn: { list: async () => connections }, tabs: { list: async () => [] } });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <ConnectionTransferProvider>
        <Workspace />
      </ConnectionTransferProvider>
    </MemoryRouter>,
  );
}

async function openTable() {
  const titleBar = within(await screen.findByRole('banner'));
  await userEvent.click(await titleBar.findByRole('button', { name: /^Connection: / }));
  await userEvent.click(await screen.findByRole('button', { name: 'Manage connections…' }));
  return screen.findByRole('dialog', { name: 'Connections' });
}

afterEach(uninstallAtelierMock);

describe('Connections table: Export / Import entry points', () => {
  it.each([
    ['Export…', 'Export Connections'],
    ['Import…', 'Import Connections'],
  ])('%s closes the table and opens its dialog', async (label, dialogName) => {
    mount([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: label }));
    expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
  });

  it('hides Export with zero Connections but still offers Import', async () => {
    mount([]);
    const table = await openTable();
    expect(within(table).getByRole('button', { name: 'Import…' })).toBeTruthy();
    expect(within(table).queryByRole('button', { name: 'Export…' })).toBeNull();
  });
});
