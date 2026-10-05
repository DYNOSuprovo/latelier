import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import { PreSigningNotice } from '../../src/features/connections/PreSigningNotice';
import type { ConnectionSummary } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/38';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/38';

const PROD: ConnectionSummary = {
  id: 'c1', name: 'Prod', color: '#1A6835', host: 'prod.example.com', port: 27017,
  connectionType: 'standard', readOnly: false, status: 'unknown',
};

function mount({ connections = [PROD], dismissed = null as boolean | null } = {}) {
  const set = vi.fn(async (_k: string, v: unknown) => v);
  installAtelierMock({
    conn: { list: async () => connections },
    prefs: {
      get: (async (key: string) => (key === 'ui.notices.preSigningDismissed' ? dismissed : null)) as IpcApi['prefs']['get'],
      set: set as unknown as IpcApi['prefs']['set'],
    },
  });
  render(
    <ConnectionTransferProvider>
      <PreSigningNotice />
    </ConnectionTransferProvider>,
  );
  return { set };
}

/** The notice decides once, after its two reads; give them a tick before asserting it stayed away. */
const settle = () => new Promise((r) => setTimeout(r, 20));

let userAgent: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC);
});
afterEach(() => {
  userAgent.mockRestore();
  uninstallAtelierMock();
});

describe('PreSigningNotice', () => {
  it('tells a macOS user with saved Connections to export them before the signed update', async () => {
    mount();
    const notice = await screen.findByRole('dialog', { name: 'Export your connections before the next update' });
    expect(within(notice).getByText(/won't be able to read the passwords saved by this one/)).toBeTruthy();
    expect(within(notice).getByText(/signed by Apple .* and updates itself/)).toBeTruthy();
  });

  it('Export opens the export with passwords included, and stops the reminder', async () => {
    const { set } = mount();
    const notice = await screen.findByRole('dialog', { name: 'Export your connections before the next update' });
    await userEvent.click(within(notice).getByRole('button', { name: 'Export connections' }));

    const exp = await screen.findByRole('dialog', { name: 'Export Connections' });
    expect((within(exp).getByRole('checkbox', { name: 'Include passwords' }) as HTMLInputElement).checked).toBe(true);
    expect(set).toHaveBeenCalledWith('ui.notices.preSigningDismissed', true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export your connections before the next update' })).toBeNull());
  });

  it('"Don\'t show again" stops the reminder; closing only defers it', async () => {
    const first = mount();
    await screen.findByRole('dialog', { name: 'Export your connections before the next update' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export your connections before the next update' })).toBeNull());
    expect(first.set).not.toHaveBeenCalled();
    uninstallAtelierMock();

    const second = mount();
    const notice = await screen.findByRole('dialog', { name: 'Export your connections before the next update' });
    await userEvent.click(within(notice).getByRole('button', { name: "Don't show again" }));
    expect(second.set).toHaveBeenCalledWith('ui.notices.preSigningDismissed', true);
    expect(screen.queryByRole('dialog', { name: 'Export Connections' })).toBeNull();
  });

  it.each([
    ['once dismissed', { dismissed: true }],
    ['with no saved Connections', { connections: [] }],
  ])('stays away %s', async (_label, opts) => {
    mount(opts);
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Export your connections before the next update' })).toBeNull();
  });

  it('stays away off macOS, where the update changes nothing about saved passwords', async () => {
    userAgent.mockReturnValue(WINDOWS);
    mount();
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Export your connections before the next update' })).toBeNull();
  });
});
