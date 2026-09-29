import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '../helpers/render';
import { IndexesTab, type IndexCreateRequest } from '../../src/pages/IndexesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IndexInfo } from '@shared/types';

/**
 * `IndexesTab`'s `initialCreate` prop (W16 Tier 4) — `ExplainDrawer`'s
 * "Create an index for this query" lands here via `StructureView`. See
 * `query-bar-create-index.spec.tsx` for the button itself and the full
 * ExplainDrawer → Structure hop; this file is `IndexesTab` in isolation,
 * the same split `indexes-create-drawer.spec.tsx` uses for the drawer shell.
 */

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

function setupMocks() {
  installAtelierMock({
    index: {
      list: async () => [ID_INDEX],
      create: async () => ({ name: 'status_1_createdAt_-1' }),
    },
  });
}

const drawer = () => screen.getByRole('dialog', { name: 'New index — alpha.people' });
const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });

describe('IndexesTab — initialCreate prefill', () => {
  // Submitting (and that it never happens automatically) is covered by the
  // full ExplainDrawer → Structure flow in query-bar-create-index.spec.tsx —
  // this is IndexesTab in isolation, so it only pins the prefill itself.
  it('opens the drawer prefilled in ESR order, with the rationale line', async () => {
    setupMocks();
    const request: IndexCreateRequest = {
      requestId: 'r1',
      suggestion: {
        keys: [
          { field: 'status', direction: 1 },
          { field: 'createdAt', direction: -1 },
        ],
        reason: "Equality on `status`, then sort on `createdAt` — MongoDB's ESR order.",
      },
    };

    render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" initialCreate={request} />,
    );

    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
    expect((screen.getByLabelText('Field 1') as HTMLInputElement).value).toBe('status');
    expect((screen.getByLabelText('Direction 1') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Field 2') as HTMLInputElement).value).toBe('createdAt');
    expect((screen.getByLabelText('Direction 2') as HTMLSelectElement).value).toBe('-1');

    expect(screen.getByTestId('create-index-reason').textContent).toBe(
      "Equality on `status`, then sort on `createdAt` — MongoDB's ESR order.",
    );
  });

  it('every suggestIndex refusal still opens the drawer, with the fields empty and no rationale', async () => {
    setupMocks();
    const request: IndexCreateRequest = { requestId: 'r1', suggestion: null };

    render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" initialCreate={request} />,
    );

    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
    expect((screen.getByLabelText('Field 1') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('create-index-reason')).toBeNull();
  });

  it('closing an untouched prefilled drawer does not prompt "Discard changes?"', async () => {
    setupMocks();
    const request: IndexCreateRequest = {
      requestId: 'r1',
      suggestion: { keys: [{ field: 'status', direction: 1 }], reason: "Equality on `status` — MongoDB's ESR order." },
    };

    render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" initialCreate={request} />,
    );

    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('Field 1')).toBeNull());
    expect(discardPrompt()).toBeNull();
  });

  it('calls onInitialCreateConsumed once the drawer has opened, so a remount does not reopen it', async () => {
    setupMocks();
    const onInitialCreateConsumed = vi.fn();
    const request: IndexCreateRequest = {
      requestId: 'r1',
      suggestion: { keys: [{ field: 'status', direction: 1 }], reason: "Equality on `status` — MongoDB's ESR order." },
    };

    render(
      <IndexesTab
        connectionId="c1"
        dbName="alpha"
        collection="people"
        initialCreate={request}
        onInitialCreateConsumed={onInitialCreateConsumed}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
    await waitFor(() => expect(onInitialCreateConsumed).toHaveBeenCalledTimes(1));
  });

  it('a second click (new requestId) reopens the drawer even with the same (null) suggestion', async () => {
    setupMocks();
    const first: IndexCreateRequest = { requestId: 'r1', suggestion: null };

    const view = render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" initialCreate={first} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Field 1')).toBeNull());

    const second: IndexCreateRequest = { requestId: 'r2', suggestion: null };
    view.rerender(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" initialCreate={second} />,
    );

    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
  });
});
