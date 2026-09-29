import type { ReactNode } from 'react';
import { modals } from '@mantine/modals';

/**
 * Ask before something destructive, and answer `true` only if the user said so.
 *
 * N4.7: the app had four different "are you sure?" patterns —
 * `window.confirm`, a hand-rolled `role="alertdialog"` overlay, Mantine's modal
 * manager, and bespoke `Modal` components — for what is one interaction. This
 * is the standard the first three converge on.
 *
 * Promise-returning rather than callback-taking on purpose. `window.confirm`
 * blocks and returns a boolean, so its call sites read
 * `if (!confirm(…)) return;` in the middle of a function. A callback API forces
 * every one of those to be turned inside out, moving the rest of the function
 * into `onConfirm` — a large diff with real scope for error on paths that close
 * tabs and delete saved work. `await confirmDestructive(…)` preserves the
 * control flow exactly.
 *
 * `onClose` resolves `false` as the catch-all for Escape and backdrop clicks.
 * Mantine fires it after `onConfirm` too, which is harmless: the promise has
 * already settled `true` by then and a second `resolve` is a no-op.
 *
 * Two dialogs deliberately do NOT use this:
 *
 *   - `Workspace/DeleteConfirm.tsx` — deleting documents. It is not a confirm
 *     with a scarier label; it round-trips `doc.confirmDeleteMany` for a count
 *     before committing, binds a server-minted `confirmToken` to the exact
 *     filter, and gates on typing the collection name. None of that
 *     survives being flattened into a two-button dialog.
 *   - `features/connections/ConnectionDeleteDialog.tsx` — extracted so the
 *     manager and the switcher cannot drift on copy. Re-inlining it at
 *     two call sites to save a component would undo that. It also now gates
 *     on typing the connection name (docs/adr/0013), which a two-button
 *     confirm can't express either.
 */
export function confirmDestructive(opts: {
  title: string;
  /** What is lost, in the user's terms. Shown above the buttons. */
  body: ReactNode;
  /** The destructive verb — "Delete", "Discard", "Reset". Never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    modals.openConfirmModal({
      title: opts.title,
      children: opts.body,
      labels: { confirm: opts.confirmLabel, cancel: opts.cancelLabel ?? 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
}
