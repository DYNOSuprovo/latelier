import type { UndoResult } from '@shared/types';
import { getErrorMessage, isIpcError } from '../api/atelier';

/**
 * X13 §5's bulk Pre-image capture ceiling (`MAX_BULK_CAPTURE_DOCS` in
 * `electron/mongo/undo.ts`), mirrored here so a confirm dialog can state
 * whether a pending bulk delete/update is within it without a round trip —
 * `shared/` is types-only, so the two copies can't share one module.
 */
export const AUDIT_UNDO_DOC_LIMIT = 1000;

/**
 * Why an Undo was refused, in words the user can act on. The refusal codes
 * are X13's; each names what happened rather than the code, and a changed
 * target says plainly when there is nothing to unwind from here.
 */
export function undoFailureMessage(e: unknown): string {
  switch (isIpcError(e) ? e.code : null) {
    case 'AUDIT_TARGET_CHANGED':
      return "The document has changed since, so undoing would overwrite the newer change. Undo that change first if it was made here; a change made outside L'Atelier can't be unwound from here.";
    case 'AUDIT_ALREADY_UNDONE':
      return 'This change has already been undone.';
    case 'AUDIT_UNDO_EXPIRED':
      return 'This change is too old to undo — its earlier version is no longer kept.';
    case 'AUDIT_NOT_REVERSIBLE':
      return "This change can't be undone — its earlier version was never kept.";
    case 'CONFLICT':
      return "A document with the same _id exists again, so the deleted one can't be put back.";
    default:
      return getErrorMessage(e, 'Undo failed');
  }
}

/**
 * A skip is neutral on purpose (X13 §6 example: "restored 47 of 50, 3
 * already exist") — it covers both a document a bulk undo found already
 * recreated (`deleteMany`/`insertMany`) and one it found changed again
 * (`updateMany`), and this message doesn't know which.
 */
export function undoneMessage(r: UndoResult): string {
  if (r.skipped === 0) {
    return `Restored ${r.restored} document${r.restored === 1 ? '' : 's'}`;
  }
  const total = r.restored + r.skipped;
  return `Restored ${r.restored} of ${total} document${total === 1 ? '' : 's'} (${r.skipped} skipped)`;
}
