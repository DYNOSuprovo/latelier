import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { IndexesTab } from '../../src/pages/IndexesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IndexInfo } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const ID_INDEX: IndexInfo = {
  name: '_id_',
  key: [{ field: '_id', direction: 1 }],
  isIdIndex: true,
  unique: false,
  sparse: false,
  hidden: false,
  version: 2,
};

const UNIQUE: IndexInfo = {
  name: 'email_unique',
  key: [{ field: 'email', direction: 1 }],
  isIdIndex: false,
  unique: true,
  sparse: false,
  hidden: false,
  version: 2,
};

function renderTab() {
  return render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" />
  );
}

describe('IndexesTab — drop confirm', () => {
  it('Drop is disabled until the typed name matches; success refetches', async () => {
    const dropCalls: string[] = [];
    installAtelierMock({
      index: {
        list: async () => (dropCalls.length === 0 ? [ID_INDEX, UNIQUE] : [ID_INDEX]),
        drop: async ({ name }) => {
          dropCalls.push(name);
          return { dropped: true as const };
        },
      },
    });

    renderTab();

    await waitFor(() => expect(screen.getByText('email_unique')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Drop index email_unique'));

    const confirmInput = await screen.findByLabelText('Confirm index name');
    const dropBtn = screen.getByText('Drop').closest('button')!;
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(confirmInput, 'wrong');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(confirmInput);
    await userEvent.type(confirmInput, 'email_unique');
    expect((dropBtn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(dropBtn);

    await waitFor(() => expect(dropCalls).toEqual(['email_unique']));
    await waitFor(() => expect(screen.queryByText('email_unique')).toBeNull());
  });

  it('does not render a Drop button on the _id_ row', async () => {
    installAtelierMock({
      index: { list: async () => [ID_INDEX] },
    });
    renderTab();
    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());
    expect(screen.queryByLabelText('Drop index _id_')).toBeNull();
  });
});
