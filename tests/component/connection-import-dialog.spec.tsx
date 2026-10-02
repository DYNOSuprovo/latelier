import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ConnectionImportDialog } from '../../src/features/connections/ConnectionImportDialog';
import * as connectionsState from '../../src/state/connections';
import type { ImportCommitInput, ImportCommitResult, ImportPreview } from '@shared/types';

type Preview = Extract<ImportPreview, { token: string }>;

const PREVIEW: Preview = {
  token: 'tok-1',
  hasSecrets: true,
  entries: [
    { index: 0, name: 'Prod', savedAs: 'Prod (2)', repick: ['tlsCa', 'tlsClientCert'], hasSecrets: true },
    { index: 1, name: 'Staging', savedAs: 'Staging', repick: ['sshKey'], hasSecrets: false },
    { index: 2, name: 'Dev', savedAs: 'Dev', repick: [], hasSecrets: false },
  ],
};
const COMMIT: ImportCommitResult = {
  created: [
    { id: 'n1', name: 'Prod (2)' },
    { id: 'n2', name: 'Staging' },
    { id: 'n3', name: 'Dev' },
  ],
  secretsNotStored: [{ name: 'Prod (2)', reason: 'secure storage is unavailable' }],
};

function setup(opts: {
  preview?: ImportPreview | Error;
  commit?: (i: ImportCommitInput) => Promise<ImportCommitResult>;
} = {}) {
  const importPreview = vi.fn<() => Promise<ImportPreview>>(async () => {
    if (opts.preview instanceof Error) throw opts.preview;
    return opts.preview ?? PREVIEW;
  });
  const importCommit = vi.fn<(i: ImportCommitInput) => Promise<ImportCommitResult>>(
    opts.commit ?? (async () => COMMIT),
  );
  installAtelierMock({ conn: { importPreview, importCommit } });
  const onClose = vi.fn();
  render(<ConnectionImportDialog onClose={onClose} />);
  return { importPreview, importCommit, onClose };
}

const choose = () => userEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
const importButton = () => screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
const badPassphrase = () => Object.assign(new Error('Wrong passphrase'), { code: 'BAD_PASSPHRASE' });

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ConnectionImportDialog', () => {
  it('previews every entry ticked with renames, files to re-pick and the passwords badge', async () => {
    setup();
    await choose();
    const table = await screen.findByRole('table', { name: 'Connections in the file' });
    for (const n of ['Prod', 'Staging', 'Dev']) {
      expect((within(table).getByRole('checkbox', { name: `Import ${n}` }) as HTMLInputElement).checked).toBe(true);
    }
    expect(within(table).getByText('Prod → Prod (2)')).toBeTruthy();
    expect(within(table).queryByText(/Staging →/)).toBeNull();
    expect(within(table).getByText('re-pick CA file, re-pick client certificate')).toBeTruthy();
    expect(within(table).getByText('re-pick SSH key')).toBeTruthy();
    expect(within(table).getAllByText('passwords')).toHaveLength(1);
  });

  it('stays as it was when the file picker is cancelled', async () => {
    const { importPreview } = setup({ preview: { cancelled: true } });
    await choose();
    await waitFor(() => expect(importPreview).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Choose file…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a validation failure from main and lets the user pick another file', async () => {
    setup({ preview: Object.assign(new Error('Not a Connection Export file'), { code: 'VALIDATION' }) });
    await choose();
    expect((await screen.findByRole('alert')).textContent).toBe('Not a Connection Export file');
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
  });

  it('retries after a wrong passphrase with the same token, then reports the result', async () => {
    const commit = vi
      .fn<(i: ImportCommitInput) => Promise<ImportCommitResult>>()
      .mockRejectedValueOnce(badPassphrase())
      .mockResolvedValueOnce(COMMIT);
    const { importCommit } = setup({ commit });
    const changed = vi.spyOn(connectionsState, 'notifyConnectionsChanged');
    await choose();
    await screen.findByRole('table');
    expect(importButton().disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'wrong one');
    await userEvent.click(importButton());
    expect(await screen.findByText('Wrong Export Passphrase.')).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    const field = screen.getByLabelText('Export Passphrase');
    await userEvent.clear(field);
    expect(screen.queryByText('Wrong Export Passphrase.')).toBeNull();
    await userEvent.type(field, 'right one');
    await userEvent.click(importButton());

    expect((await screen.findByRole('status')).textContent).toBe('3 Connections imported.');
    expect(importCommit).toHaveBeenCalledTimes(2);
    expect(importCommit).toHaveBeenNthCalledWith(1, { token: 'tok-1', indices: [0, 1, 2], passphrase: 'wrong one' });
    expect(importCommit).toHaveBeenNthCalledWith(2, { token: 'tok-1', indices: [0, 1, 2], passphrase: 'right one' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('imports without passwords from the same preview, never sending a passphrase', async () => {
    const { importCommit } = setup();
    await choose();
    await screen.findByRole('table');
    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'typed but unused');
    await userEvent.click(screen.getByRole('button', { name: 'Import without passwords' }));
    await waitFor(() => expect(importCommit).toHaveBeenCalledWith({ token: 'tok-1', indices: [0, 1, 2], withoutSecrets: true }));
  });

  it('imports only the ticked entries', async () => {
    const { importCommit } = setup();
    await choose();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Import Staging' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import without passwords' }));
    await waitFor(() => expect(importCommit.mock.calls[0]![0].indices).toEqual([0, 2]));
  });

  it('asks for no passphrase and offers no secrets option when the file has none', async () => {
    const { importCommit } = setup({
      preview: { ...PREVIEW, hasSecrets: false, entries: PREVIEW.entries.map((e) => ({ ...e, hasSecrets: false })) },
    });
    await choose();
    await screen.findByRole('table');
    expect(screen.queryByLabelText('Export Passphrase')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import without passwords' })).toBeNull();
    await userEvent.click(importButton());
    await waitFor(() => expect(importCommit).toHaveBeenCalledWith({ token: 'tok-1', indices: [0, 1, 2] }));
  });

  it('repeats renames, re-picks and secrets not stored on the result screen', async () => {
    setup();
    await choose();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Import without passwords' }));
    await screen.findByRole('status');
    expect(within(screen.getByLabelText('Renamed Connections')).getByText('Prod → Prod (2)')).toBeTruthy();
    const repicks = within(screen.getByLabelText('Files to pick again'));
    expect(repicks.getByText('Prod (2): re-pick CA file, re-pick client certificate')).toBeTruthy();
    expect(repicks.getByText('Staging: re-pick SSH key')).toBeTruthy();
    expect(repicks.queryByText(/^Dev:/)).toBeNull();
    expect(
      within(screen.getByLabelText('Secrets not stored')).getByText('Prod (2): secure storage is unavailable'),
    ).toBeTruthy();
  });

  it('does not list a rename or re-pick for an entry that was not imported', async () => {
    setup({ commit: async () => ({ created: [{ id: 'n3', name: 'Dev' }], secretsNotStored: [] }) });
    await choose();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Import Prod' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Import Staging' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import without passwords' }));
    expect((await screen.findByRole('status')).textContent).toBe('1 Connection imported.');
    expect(screen.queryByLabelText('Renamed Connections')).toBeNull();
    expect(screen.queryByLabelText('Files to pick again')).toBeNull();
    expect(screen.queryByLabelText('Secrets not stored')).toBeNull();
  });

  it('writes nothing when cancelled, and Enter in the passphrase field submits', async () => {
    const { importCommit, onClose } = setup();
    await choose();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(importCommit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Export Passphrase'), 'right one{Enter}');
    await waitFor(() => expect(importCommit).toHaveBeenCalledTimes(1));
  });
});
