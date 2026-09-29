import { I } from '../../../icons';

interface SelectToggleProps {
  selected: boolean;
  /** Short, human-scannable document id (`getDocId`) folded into the
   * aria-label/title so multiple checkboxes in the same list are
   * distinguishable to assistive tech. */
  docLabel: string;
  onToggle: () => void;
}

/**
 * Per-row selection checkbox shared by Table, Tree and JSON. A plain click
 * on a row/card only makes it the active row now; this (plus ⌘/Ctrl+click)
 * is the one visible way to add a row to the bulk-action selection.
 *
 * `aria-pressed` on a `<button>`, not a real `<input type="checkbox">` — the
 * toggle-button pattern — so it can sit inside a `role="group"`/`"row"`/
 * `"treeitem"` container that already holds other buttons (Copy/Edit/
 * Delete) without becoming a form control nested in one.
 */
export function SelectToggle({ selected, docLabel, onToggle }: SelectToggleProps) {
  const label = `${selected ? 'Deselect' : 'Select'} document ${docLabel}`;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      style={{
        background: selected ? 'var(--atelier-accent-soft)' : 'var(--atelier-surface)',
        border: `1px solid ${selected ? 'var(--atelier-accent-border)' : 'var(--atelier-border)'}`,
        borderRadius: 'var(--atelier-radius-xs)',
        padding: '2px 5px',
        margin: 0,
        font: 'inherit',
        cursor: 'pointer',
        color: selected ? 'var(--atelier-accent)' : 'var(--atelier-text-ghost)',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      {I.check}
    </button>
  );
}
