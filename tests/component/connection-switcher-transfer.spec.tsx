import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ConnectionSwitcher } from '../../src/features/connections/ConnectionSwitcher';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import type { ConnectionSummary } from '@shared/types';

const row = (id: string, name: string): ConnectionSummary => ({
  id, name, color: '#1A6835', host: 'localhost', port: 27017,
  connectionType: 'standard', readOnly: false, status: 'unknown',
});

function setup(connections: ConnectionSummary[]) {
  installAtelierMock({ conn: { list: async () => connections } });
  const onSwitch = vi.fn();
  render(
    <ConnectionTransferProvider>
      <ConnectionSwitcher
        connections={connections}
        focusedConnectionId={null}
        onSwitch={onSwitch}
        onManage={vi.fn()}
        onDisconnect={vi.fn()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onExpand={vi.fn()}
      />
    </ConnectionTransferProvider>,
  );
  return { onSwitch };
}

const openSwitcher = () => userEvent.click(screen.getByRole('button', { name: /^Connection/ }));

afterEach(uninstallAtelierMock);

describe('Connection Switcher: Export / Import entry points', () => {
  it.each([
    ['Export connections…', 'Export Connections'],
    ['Import connections…', 'Import Connections'],
  ])('%s closes the switcher and opens its dialog', async (label, dialogName) => {
    setup([row('c1', 'Prod')]);
    await openSwitcher();
    await userEvent.click(await screen.findByRole('button', { name: label }));
    expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('is reachable by Tab after "Add connection" and Enter opens it without switching', async () => {
    const { onSwitch } = setup([row('c1', 'Prod'), row('c2', 'Staging')]);
    await openSwitcher();
    await screen.findByRole('combobox');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add connection' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export connections…' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import connections…' }));
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Import Connections' })).toBeTruthy();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('keeps the list arrows and Enter-to-connect working', async () => {
    const { onSwitch } = setup([row('c1', 'Prod'), row('c2', 'Staging')]);
    await openSwitcher();
    await screen.findByRole('combobox');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('c2'));
  });

  it('hides Export with zero Connections but still offers Import', async () => {
    setup([]);
    await openSwitcher();
    expect(await screen.findByRole('button', { name: 'Import connections…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export connections…' })).toBeNull();
  });
});
