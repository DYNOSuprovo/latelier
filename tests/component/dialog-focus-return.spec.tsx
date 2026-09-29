import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { CreateCollectionDrawer } from '../../src/pages/Workspace/CreateCollectionDrawer';
import { DocumentEditor } from '../../src/pages/Workspace/DocumentEditor';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

/**
 * X15 T2 — `useDialogFocusReturn`.
 *
 * Mantine's own `returnFocus` is inert for every dialog here: it hangs off
 * `useDidUpdate` keyed on `opened`, and these dialogs mount with `opened`
 * hardcoded, so it never transitions and the trigger is never captured. These
 * tests use a real trigger button and conditional mounting because that is the
 * shape that reproduces it — rendering the dialog directly never has a trigger
 * to return to.
 *
 * `CreateCollectionDrawer` is here for a second reason: its name field carries
 * `autoFocus`, which React applies during the commit's layout phase, before any
 * `useEffect`. A mount-effect capture reads the *input* as the trigger there and
 * "restores" focus into a node being unmounted. The hook captures during render
 * instead, which is what this covers.
 *
 * The mutation targets:
 *  - delete `trigger?.focus?.()` → the first two tests go red;
 *  - drop the `ours` guard (restore unconditionally) → the third goes red.
 *
 * The fourth test is a path test, not a mutation target — see its own note.
 */

/** Trigger + a control outside the dialog, mounted the way the app mounts these. */
function Harness({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <button>Elsewhere</button>
      {open && children(() => setOpen(false))}
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Open dialog' });
const elsewhere = () => screen.getByRole('button', { name: 'Elsewhere' });

const insertDrawer = (close: () => void) => (
  <DocumentEditor
    mode="insert"
    collection="coll"
    connectionId="c1"
    dbName="db"
    onClose={close}
    onInserted={() => undefined}
  />
);

const createDrawer = (close: () => void) => (
  <CreateCollectionDrawer connectionId="c1" onCancel={close} onCreated={() => undefined} />
);

/** Open the dialog from a real click and wait for the focus trap to settle. */
async function open(dialogName: string) {
  const user = userEvent.setup();
  await user.click(trigger());
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return user;
}

describe('dialog focus return (X15 T2)', () => {
  it('the Document Editor (insert mode) returns focus to the trigger when it closes', async () => {
    installAtelierMock({});
    render(<Harness>{insertDrawer}</Harness>);
    await open('Insert document');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('CreateCollectionDrawer returns focus to the trigger, not to its autoFocused field', async () => {
    installAtelierMock({});
    render(<Harness>{createDrawer}</Harness>);
    const user = await open('New collection');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('leaves focus alone when a control outside the dialog already has it', async () => {
    installAtelierMock({});
    render(<Harness>{insertDrawer}</Harness>);
    await open('Insert document');

    // The user has moved on to a control elsewhere on the page. Closing must
    // not drag focus off it and back to the trigger — the difference between
    // this hook and Mantine's unconditional `returnFocus`.
    elsewhere().focus();
    expect(document.activeElement).toBe(elsewhere());

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(elsewhere());
  });

  /**
   * The nested-overlay path: the Document Editor's dismissal goes through a
   * *second* portal, the discard prompt, before `close()` runs.
   *
   * The wait past 10ms is load-bearing. `confirmDestructive` runs through
   * `ModalsProvider`, where `opened` really does transition, so Mantine's own
   * `useFocusReturn` *is* live on the prompt and schedules a restore on a 10ms
   * timer. Asserting at t=0 would pass without ever observing it.
   *
   * Measured, so it is not over-claimed: at the moment `close()` runs here,
   * `document.activeElement` is already `<body>` — the prompt's Discard button
   * unmounted with it. So this path exercises the guard's `body` clause, and it
   * does not on its own distinguish the shipped role-scoped check from a check
   * scoped to the editor's own root. The role check is chosen because it is a
   * strict superset of that one and needs no `ref` threaded through 13 dialogs.
   */
  it('returns focus to the trigger after the discard prompt, not to <body>', async () => {
    installAtelierMock({});
    render(
      <Harness>
        {(close) => (
          <DocumentEditor
            mode="edit"
            connectionId="c1"
            dbName="db"
            collection="coll"
            doc={{ _id: 42, sku: 'abc' }}
            onClose={close}
            onSaved={() => undefined}
          />
        )}
      </Harness>,
    );
    await open('Edit document');

    fireEvent.change(screen.getByRole('textbox', { name: 'sku' }), { target: { value: 'edited' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit document' })).toBeNull(),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(trigger());
  });
});
