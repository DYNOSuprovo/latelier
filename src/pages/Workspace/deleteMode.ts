// Resolves which of the three mutually-exclusive delete dialogs should be open, and what docs/filter to hand DeleteConfirm.
import { buildDeleteSelectedFilterJson } from './selection';

export type DeleteDialogState =
  | { open: false }
  | { open: true; docs: unknown[]; filter: string | undefined };

// deleteAllOpen is folded into deleteAllFilterJson by the caller rather than passed separately, to avoid a Stryker-equivalent null-check collapse.
export function resolveDeleteDialog(input: {
  deleteDoc: unknown | null;
  deleteSelected: unknown[] | null;
  deleteAllFilterJson: string | null;
}): DeleteDialogState {
  const { deleteDoc, deleteSelected, deleteAllFilterJson } = input;

  // Must stay inactive (not fall through to '{}') when no selected doc has an _id, else it'd delete the whole collection.
  const deleteSelectedFilterJson = deleteSelected
    ? buildDeleteSelectedFilterJson(deleteSelected)
    : null;
  // Stryker disable next-line ConditionalExpression: deleteSelectedFilterJson can only be non-null when the ternary above saw deleteSelected truthy (arrays are always truthy, so the only falsy value of this `unknown[] | null` type is null itself) — deleteSelectedFilterJson !== null already implies deleteSelected !== null, so the left conjunct is redundant by construction of the ternary two lines up.
  const deleteSelectedActive = deleteSelected !== null && deleteSelectedFilterJson !== null;

  // Same hazard: null filter must not fall through to '{}' (delete-the-whole-collection).
  const deleteAllActive = deleteAllFilterJson !== null;

  if (!(deleteDoc !== null || deleteAllActive || deleteSelectedActive)) {
    return { open: false };
  }

  // docs prefers deleteDoc, filter prefers deleteSelected; the two are never simultaneously active (same modal overlay blocks both triggers).
  return {
    open: true,
    docs: deleteDoc !== null ? [deleteDoc] : deleteSelectedActive ? deleteSelected! : [],
    filter: deleteSelectedActive
      ? deleteSelectedFilterJson!
      : deleteAllActive
        ? deleteAllFilterJson!
        : undefined,
  };
}
