import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import { act, fireEvent, render, screen, waitFor, within } from '../helpers/render';
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

function setupMocks(createSpy: IpcApi['index']['create']) {
  installAtelierMock({
    index: {
      list: async () => [ID_INDEX],
      create: createSpy,
    },
  });
}

function renderTab() {
  return render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" />
  );
}

describe('IndexesTab — create drawer', () => {
  it('opens the drawer, submits the typed payload, and refetches the list', async () => {
    const calls: unknown[] = [];
    setupMocks(async (input) => {
      calls.push(input);
      return { name: 'email_unique' };
    });

    renderTab();
    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New index'));
    await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());

    await userEvent.type(screen.getByLabelText('Field 1'), 'email');
    await userEvent.click(screen.getByLabelText('Unique'));
    await userEvent.type(screen.getByLabelText('Index name'), 'email_unique');

    await userEvent.click(screen.getByText('Create index'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      connectionId: 'c1',
      dbName: 'alpha',
      collection: 'people',
      fields: [{ field: 'email', direction: 1 }],
      options: { unique: true, name: 'email_unique' },
    });
  });

  it('keeps the drawer open and shows an inline error on CONFLICT', async () => {
    setupMocks(async () => {
      throw { code: 'CONFLICT', message: 'duplicate index name' };
    });

    renderTab();
    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New index'));
    await userEvent.type(screen.getByLabelText('Field 1'), 'a');
    await userEvent.type(screen.getByLabelText('Index name'), 'a_1');
    await userEvent.click(screen.getByText('Create index'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/duplicate/);
    });
    // Drawer still mounted.
    expect(screen.getByLabelText('Index name')).toBeTruthy();
  });

  it('rejects TTL on multi-field key locally before calling the API', async () => {
    const calls: unknown[] = [];
    setupMocks(async (input) => {
      calls.push(input);
      return { name: 'never' };
    });

    renderTab();
    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New index'));
    await userEvent.type(screen.getByLabelText('Field 1'), 'a');
    await userEvent.click(screen.getByText('+ Add field'));
    await userEvent.type(screen.getByLabelText('Field 2'), 'b');
    await userEvent.click(screen.getByLabelText(/TTL — expire after/));
    await userEvent.type(screen.getByLabelText('expireAfterSeconds'), '600');
    await userEvent.click(screen.getByText('Create index'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/exactly one field/);
    });
    expect(calls.length).toBe(0);
  });
});

/**
 * X15 T7 — the dialog shell and the unsaved-changes guard.
 *
 * The behavioural specs for this drawer are the three cases above; this block
 * covers only what the Mantine migration is responsible for — the a11y set the
 * hand-rolled panel never had (Escape, a focus trap, focus return, a labelled
 * ✕) and the guard that stops a dismissal from discarding a half-typed index.
 *
 * Note the panel had **no backdrop at all** before the migration: it was a bare
 * `position: absolute` panel inside the tab. Mantine's Escape and overlay are
 * both new surfaces here, which is precisely why the guard travels with them.
 *
 * Two of these tests are the ticket's mutation targets and are named as such.
 */

const drawer = () => screen.getByRole('dialog', { name: 'New index — alpha.people' });
const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });
/** The overlay carries no role by design, so it has no accessible handle. */
const overlay = () => document.body.querySelector('.mantine-Drawer-overlay') as HTMLElement;

/** Let a click's async handler settle so a *negative* assertion means something. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Renders the tab and opens the drawer off the real trigger. */
async function openDrawer() {
  setupMocks(async () => ({ name: 'never' }));
  renderTab();
  await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());
  const trigger = screen.getByText('+ New index').closest('button')!;
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByLabelText('Field 1')).toBeTruthy());
  return trigger;
}

describe('CreateIndexDrawer — dialog shell (X15 T7)', () => {
  it('puts role="dialog" on the panel — the element holding the form, not the backdrop', async () => {
    await openDrawer();
    expect(within(drawer()).getByLabelText('Field 1')).toBeTruthy();
    expect(overlay()).not.toBeNull();
    expect(overlay().getAttribute('role')).toBeNull();
  });

  it('names the dialog and gives the close control an aria-label', async () => {
    await openDrawer();
    // `getByRole('dialog', { name: … })` above already proves the accessible
    // name; the ✕ did not exist at all before the migration.
    expect(within(drawer()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open', async () => {
    await openDrawer();
    await waitFor(() => expect(drawer().contains(document.activeElement)).toBe(true));
  });

  it('Escape closes a clean drawer without prompting, and returns focus to the trigger', async () => {
    const trigger = await openDrawer();
    await waitFor(() => expect(drawer().contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('Field 1')).toBeNull());
    expect(discardPrompt()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('closing an untouched drawer from Cancel does not prompt', async () => {
    await openDrawer();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(discardPrompt()).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText('Field 1')).toBeNull());
  });
});

describe('CreateIndexDrawer — unsaved-changes guard (X15 T7)', () => {
  /**
   * MUTATION TARGET 1 — delete `closeOnClickOutside={false}` from
   * CreateIndexDrawer and the last assertion must go red: the backdrop starts
   * routing through `requestClose` and raises a prompt the user never asked
   * for. The other assertions stay green under that mutation, which is exactly
   * why "no prompt" has to be asserted rather than "text survived".
   *
   * Do not "fix" this test into expecting a prompt. An inert backdrop is the
   * point: `closeOnClickOutside={false}` is what stops one stray click from
   * reaching the close path at all.
   */
  it('a backdrop click with a dirty field is inert — no close, no prompt, text intact', async () => {
    await openDrawer();
    fireEvent.change(screen.getByLabelText('Field 1'), { target: { value: 'email' } });

    fireEvent.click(overlay());
    await settle();

    expect((screen.getByLabelText('Field 1') as HTMLInputElement).value).toBe('email');
    expect(drawer()).toBeTruthy();
    expect(discardPrompt()).toBeNull();
  });

  it('Escape with dirty fields prompts, and Cancel leaves every field intact', async () => {
    await openDrawer();
    fireEvent.change(screen.getByLabelText('Field 1'), { target: { value: 'email' } });
    fireEvent.click(screen.getByLabelText('Unique'));
    fireEvent.change(screen.getByLabelText('Index name'), { target: { value: 'email_unique' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect((screen.getByLabelText('Field 1') as HTMLInputElement).value).toBe('email');
    expect((screen.getByLabelText('Unique') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Index name') as HTMLInputElement).value).toBe('email_unique');
  });

  it('Escape with a dirty field closes once Discard is confirmed', async () => {
    await openDrawer();
    fireEvent.change(screen.getByLabelText('Field 1'), { target: { value: 'email' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByLabelText('Field 1')).toBeNull());
  });

  /**
   * MUTATION TARGET 2 — narrow `isDirty` in CreateIndexDrawer to the key spec
   * alone (`JSON.stringify(fields) !== JSON.stringify(DEFAULT_FIELDS)`, the
   * obvious narrowing) and this must go red. `Field 1` is deliberately left
   * EMPTY: the work at risk is the index name and the option toggles, and a
   * per-field check reports the form clean while discarding them.
   */
  it('dirtying a field other than the first still prompts', async () => {
    await openDrawer();

    fireEvent.change(screen.getByLabelText('Index name'), { target: { value: 'email_unique' } });
    expect((screen.getByLabelText('Field 1') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(drawer()).toBeTruthy();
  });
});
