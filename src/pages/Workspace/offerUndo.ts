import { api } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { undoFailureMessage, undoneMessage } from '../../utils/auditUndo';

/**
 * Success toast for a write that was recorded Reversible, carrying an Undo
 * that puts it back. `onUndone` runs after a successful Undo — re-run the tab
 * the write came from, captured now, since the toast outlives whatever
 * dialog made the write. No `auditId` means nothing can be undone, and no
 * toast is shown.
 */
export function offerUndo(message: string, auditId: string | undefined, onUndone: () => void): void {
  if (auditId === undefined) return;
  notify.success(message, {
    action: {
      label: 'Undo',
      onClick: () => {
        api.audit.undo({ entryId: auditId }).then(
          (r) => {
            notify.success(undoneMessage(r));
            onUndone();
          },
          (e: unknown) => notify.error(undoFailureMessage(e), { title: 'Undo failed' }),
        );
      },
    },
  });
}
