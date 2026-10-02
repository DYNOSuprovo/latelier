import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ConnectionAddDialog } from '../../src/features/connections/ConnectionAddDialog';
import type { UriCommitInput, UriPreviewEntry } from '@shared/types';

const ok = (index: number, over: Partial<Extract<UriPreviewEntry, { ok: true }>> = {}): UriPreviewEntry => ({
  index,
  ok: true,
  savedAs: `host${index}`,
  host: `host${index}`,
  port: 27017,
  srv: false,
  hasPassword: true,
  needsCredentials: false,
  repick: [],
  warnings: [],
  ...over,
});

function setup(entries: (lines: string[]) => UriPreviewEntry[]) {
  const previewUris = vi.fn(async (lines: string[]) => ({ entries: entries(lines) }));
  const createFromUris = vi.fn(async (input: UriCommitInput) => ({
    created: input.uris.map((_, i) => ({ index: i, id: `id${i}`, name: `host${i}` })),
    failed: [],
    secretsNotStored: [],
  }));
  installAtelierMock({ conn: { previewUris, createFromUris } });
  const onClose = vi.fn();
  render(<ConnectionAddDialog onClose={onClose} />);
  return { previewUris, createFromUris, onClose };
}

// `fireEvent.change`, not `userEvent.type`: a connection string is pasted, and
// typing one keystroke at a time through the debounce is not what is under test.
const paste = (text: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection strings' }), { target: { value: text } });

afterEach(uninstallAtelierMock);

describe('ConnectionAddDialog — paste and preview', () => {
  it('previews the trimmed, non-empty lines, with each saved name and any skipped line', async () => {
    const { previewUris } = setup(() => [ok(0, { savedAs: 'db (2)', host: 'db' }), { index: 1, ok: false, reason: 'not a uri' }]);
    paste('  mongodb://db  \n\nnope\n');

    const table = await screen.findByRole('table', { name: 'Connections to add' });
    expect(previewUris).toHaveBeenCalledWith(['mongodb://db', 'nope']);
    expect(within(table).getByText('db (2)')).toBeTruthy();
    expect(within(table).getByText('db:27017')).toBeTruthy();
    expect(within(table).getByText('Line 2')).toBeTruthy();
    expect(within(table).getByText('Skipped: not a uri')).toBeTruthy();
  });

  it('shows SRV hosts without a port, and notes credentials, re-picks and warnings', async () => {
    setup(() => [ok(0, { srv: true, host: 'c.net', needsCredentials: true, repick: ['tlsClientCert'], warnings: ['w'] })]);
    paste('mongodb+srv://c.net');
    const table = await screen.findByRole('table', { name: 'Connections to add' });
    expect(within(table).getByText('c.net')).toBeTruthy();
    expect(within(table).getByText('SRV')).toBeTruthy();
    expect(within(table).getByText('asks for credentials next · re-pick client certificate · w')).toBeTruthy();
  });

  it('refuses more than 100 lines without asking main', async () => {
    const { previewUris } = setup(() => []);
    paste(Array.from({ length: 101 }, (_, i) => `mongodb://h${i}`).join('\n'));
    expect(await screen.findByText('Up to 100 connection strings at a time.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(previewUris).not.toHaveBeenCalled();
  });

  it('refuses an over-long line without asking main', async () => {
    const { previewUris } = setup(() => []);
    paste(`mongodb://ok\nmongodb://${'x'.repeat(4096)}`);
    expect(await screen.findByText('Line 2 is longer than 4,096 characters.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(previewUris).not.toHaveBeenCalled();
  });

  it('shows a preview failure as the field error', async () => {
    installAtelierMock({
      conn: { previewUris: vi.fn(async () => Promise.reject({ code: 'VALIDATION', message: 'too long' })) },
    });
    render(<ConnectionAddDialog onClose={vi.fn()} />);
    paste('mongodb://h');
    expect(await screen.findByText('too long')).toBeTruthy();
  });

  it('never acts on a preview of older text', async () => {
    setup((lines) => lines.map((_, i) => ok(i)));
    paste('mongodb://a');
    await screen.findByRole('button', { name: 'Add 1 connection' });
    paste('mongodb://a\nmongodb://b');
    // Until the new preview lands, nothing can be added.
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByRole('button', { name: 'Add 2 connections' })).toBeTruthy();
  });

  it('offers a plain, disabled "Add" until something is pasted', () => {
    setup(() => []);
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ConnectionAddDialog — adding', () => {
  it('adds straight away when no line needs credentials, sending the batch defaults', async () => {
    const { createFromUris } = setup((lines) => lines.map((_, i) => ok(i)));
    paste('mongodb://a\nmongodb://b');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Read-only' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add 2 connections' }));

    await waitFor(() =>
      expect(createFromUris).toHaveBeenCalledWith({
        uris: ['mongodb://a', 'mongodb://b'],
        defaults: { readOnly: true, directConnection: false },
        credentials: [],
      }),
    );
    expect(await screen.findByText('2 Connections added.')).toBeTruthy();
  });

  it('sends direct connection when ticked', async () => {
    const { createFromUris } = setup(() => [ok(0)]);
    paste('mongodb://a');
    await userEvent.click(screen.getByRole('checkbox', { name: /Direct connection/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add 1 connection' }));
    await waitFor(() =>
      expect(createFromUris.mock.calls[0]![0].defaults).toEqual({ readOnly: false, directConnection: true }),
    );
  });

  it('names the server under a credentials row only when the name does not already', async () => {
    setup(() => [
      ok(0, { savedAs: 'db (2)', host: 'db', needsCredentials: true, hasPassword: false }),
      ok(1, { savedAs: 'c.net', host: 'c.net', srv: true, needsCredentials: true, hasPassword: false }),
    ]);
    paste('mongodb://db\nmongodb+srv://c.net');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(screen.getByText('db:27017')).toBeTruthy();
    expect(screen.getAllByText('c.net')).toHaveLength(1);
  });

  it('asks for credentials only for the lines missing them, prefilled from the string', async () => {
    const { createFromUris } = setup(() => [
      ok(0),
      ok(1, { needsCredentials: true, authUsername: 'alice', hasPassword: false }),
      ok(2, { needsCredentials: true, hasPassword: false }),
    ]);
    paste('mongodb://a\nmongodb://alice@b\nmongodb://c');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect(screen.queryByRole('textbox', { name: 'Username for host0' })).toBeNull();
    const alice = screen.getByRole('textbox', { name: 'Username for host1' }) as HTMLInputElement;
    expect(alice.value).toBe('alice');
    await userEvent.type(screen.getByLabelText('Password for host1'), 'pw1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for host2' }), '  bob ');
    await userEvent.click(screen.getByRole('button', { name: 'Add 3 connections' }));

    await waitFor(() =>
      expect(createFromUris.mock.calls[0]![0].credentials).toEqual([
        { index: 1, username: 'alice', password: 'pw1' },
        { index: 2, username: 'bob' },
      ]),
    );
  });

  it('never moves typed credentials onto another host when lines are edited', async () => {
    // Preview entries follow the current lines; each line asks for credentials.
    const { createFromUris } = setup((lines) =>
      lines.map((l, i) => ok(i, { savedAs: l.replace('mongodb://', ''), needsCredentials: true, hasPassword: false })),
    );
    paste('mongodb://hostA\nmongodb://hostB');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for hostA' }), 'alice');
    await userEvent.type(screen.getByLabelText('Password for hostA'), 'secretA');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    paste('mongodb://hostB');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect((screen.getByRole('textbox', { name: 'Username for hostB' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Password for hostB') as HTMLInputElement).value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 connection' }));
    await waitFor(() => expect(createFromUris.mock.calls[0]![0].credentials).toEqual([]));
  });

  it('keeps typed credentials with their line when another line is removed', async () => {
    const { createFromUris } = setup((lines) =>
      lines.map((l, i) => ok(i, { savedAs: l.replace('mongodb://', ''), needsCredentials: true, hasPassword: false })),
    );
    paste('mongodb://hostA\nmongodb://hostB');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for hostB' }), 'bob');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    paste('mongodb://hostB');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect((screen.getByRole('textbox', { name: 'Username for hostB' }) as HTMLInputElement).value).toBe('bob');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 connection' }));
    await waitFor(() => expect(createFromUris.mock.calls[0]![0].credentials).toEqual([{ index: 0, username: 'bob' }]));
  });

  it('moves focus to the first credentials field on Next, and back to the strings on Back', async () => {
    setup(() => [ok(0, { needsCredentials: true, hasPassword: false })]);
    paste('mongodb://a');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Username for host0' })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Connection strings' })),
    );
  });

  it('blocks a password typed without a username, and says why', async () => {
    setup(() => [ok(0, { needsCredentials: true, hasPassword: false })]);
    paste('mongodb://a');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Password for host0'), 'pw');

    expect(screen.getByText('Add a username for this password.')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add 1 connection' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for host0' }), 'u');
    expect(add.disabled).toBe(false);
  });

  it('accepts blank credentials and keeps what was typed when going back', async () => {
    const { createFromUris } = setup(() => [ok(0, { needsCredentials: true, hasPassword: false })]);
    paste('mongodb://a');
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Username for host0' }), 'u');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((screen.getByRole('textbox', { name: 'Username for host0' }) as HTMLInputElement).value).toBe('u');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Username for host0' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 connection' }));
    await waitFor(() => expect(createFromUris.mock.calls[0]![0].credentials).toEqual([{ index: 0 }]));
  });

  it('reports what failed and what was renamed, then closes on Done', async () => {
    installAtelierMock({
      conn: {
        previewUris: vi.fn(async () => ({ entries: [ok(0, { savedAs: 'db' }), ok(1)] })),
        createFromUris: vi.fn(async () => ({
          created: [{ index: 0, id: 'x', name: 'db (2)' }],
          failed: [{ index: 1, name: 'host1', reason: 'taken' }],
          secretsNotStored: [],
        })),
      },
    });
    const onClose = vi.fn();
    render(<ConnectionAddDialog onClose={onClose} />);
    paste('mongodb://db\nmongodb://host1');
    await userEvent.click(await screen.findByRole('button', { name: 'Add 2 connections' }));

    expect(await screen.findByText('1 Connection added.')).toBeTruthy();
    expect(screen.getByText('host1: taken')).toBeTruthy();
    expect(screen.getByText('db → db (2)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a commit failure and stays on the step', async () => {
    installAtelierMock({
      conn: {
        previewUris: vi.fn(async () => ({ entries: [ok(0)] })),
        createFromUris: vi.fn(async () => Promise.reject({ code: 'VALIDATION', message: 'nope' })),
      },
    });
    render(<ConnectionAddDialog onClose={vi.fn()} />);
    paste('mongodb://a');
    await userEvent.click(await screen.findByRole('button', { name: 'Add 1 connection' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'nope');
    expect(screen.getByRole('button', { name: 'Add 1 connection' })).toBeTruthy();
  });
});
