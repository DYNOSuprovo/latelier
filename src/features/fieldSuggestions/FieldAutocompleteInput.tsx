import React from 'react';
import { useSuggestions } from './useSuggestions';
import { SuggestionPopover } from './SuggestionPopover';
import { DEFAULT_FIELD_SOURCES } from './sources';
import type { Suggestion, SuggestionContext } from './types';

/**
 * How the input value is sliced into a search token:
 *   • 'whole' — entire value is the token; accepting replaces the value.
 *   • 'csv'   — last comma-separated segment around the caret; accepting
 *               replaces just that segment, leaving siblings intact.
 *   • 'brace' — text inside `{…}` placeholders. Popover is suppressed when
 *               the caret isn't sitting inside an open brace.
 *   • 'token' — the bare field-name word around the caret, ignoring the
 *               punctuation an MQL document is made of (`{`, `"`, `:`, `,`).
 *               Suits the projection and sort inputs, where a field
 *               name sits inside a document rather than owning the value.
 */
export type AutocompleteMode = 'whole' | 'csv' | 'brace' | 'token';

interface FieldAutocompleteInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fields are pulled from this collection; null disables suggestions. */
  context: SuggestionContext | null;
  mode?: AutocompleteMode;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  ariaLabel?: string;
  /**
   * W15 §5 — the query bar names its inputs off the visible label
   * cells it already renders, so the name can't drift from the text on
   * screen the way a duplicated `ariaLabel` would.
   */
  ariaLabelledBy?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /**
   * Attributes the query bar needs on top of the autocomplete behavior:
   * commit-on-blur / commit-on-Enter, the invalid state its inline `Notice`
   * is wired to, and a test hook. Kept as named props rather than a spread —
   * `data-*` can't be typed through `InputHTMLAttributes`.
   */
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  dataTestid?: string;
}

interface TokenInfo {
  token: string;
  start: number;
  end: number;
  /** False for 'brace' mode when caret is outside a placeholder. */
  active: boolean;
}

function computeToken(
  value: string,
  caret: number,
  mode: AutocompleteMode,
): TokenInfo {
  if (mode === 'whole') {
    return { token: value, start: 0, end: value.length, active: true };
  }
  if (mode === 'csv') {
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const startBefore = before.lastIndexOf(',') + 1;
    const afterIdx = after.indexOf(',');
    const end = afterIdx === -1 ? value.length : caret + afterIdx;
    const raw = value.slice(startBefore, end);
    // `trimStart`/`trimEnd` rather than `/^\s*/` and `/\s*$/`: the trailing
    // one has an unanchored start over `\s*`, so a run of spaces in a typed
    // field costs O(n^2) (S8786). These are linear and say the same thing.
    const lpad = raw.length - raw.trimStart().length;
    const rpad = raw.length - raw.trimEnd().length;
    return {
      token: raw.slice(lpad, raw.length - rpad),
      start: startBefore + lpad,
      end: end - rpad,
      active: true,
    };
  }
  if (mode === 'token') {
    // Dotted paths are one token: `user.address.` must complete as a prefix,
    // not restart at the last segment.
    const WORD = /[A-Za-z0-9_$.]/;
    let start = caret;
    while (start > 0 && WORD.test(value[start - 1]!)) start -= 1;
    let end = caret;
    while (end < value.length && WORD.test(value[end]!)) end += 1;
    return { token: value.slice(start, end), start, end, active: true };
  }
  // brace
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const lastOpen = before.lastIndexOf('{');
  if (lastOpen === -1) {
    return { token: '', start: caret, end: caret, active: false };
  }
  const lastClose = before.lastIndexOf('}');
  if (lastClose > lastOpen) {
    return { token: '', start: caret, end: caret, active: false };
  }
  const closeAfter = after.indexOf('}');
  const end = closeAfter === -1 ? caret : caret + closeAfter;
  return {
    token: value.slice(lastOpen + 1, end),
    start: lastOpen + 1,
    end,
    active: true,
  };
}

/**
 * Single-line `<input>` with a field-name autocomplete popover anchored to it.
 * Reuses the shared `useSuggestions` + `SuggestionPopover` infrastructure so
 * ranking, async source fan-in, and keyboard navigation match the rest of the
 * app (BuilderPane, textarea autocomplete).
 */
export function FieldAutocompleteInput({
  value,
  onChange,
  context,
  mode = 'whole',
  placeholder,
  disabled,
  style,
  ariaLabel,
  ariaLabelledBy,
  inputRef,
  onBlur,
  onKeyDown,
  ariaInvalid,
  ariaDescribedBy,
  dataTestid,
}: FieldAutocompleteInputProps) {
  const localRef = React.useRef<HTMLInputElement>(null);
  const ref = (inputRef as React.RefObject<HTMLInputElement>) ?? localRef;
  const [open, setOpen] = React.useState(false);
  const [caret, setCaret] = React.useState(0);
  const blurTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenInfo = React.useMemo(
    () => computeToken(value, caret, mode),
    [value, caret, mode],
  );

  const popoverContext = open && tokenInfo.active && !disabled ? context : null;

  const { items } = useSuggestions(popoverContext, tokenInfo.token, {
    fieldSources: DEFAULT_FIELD_SOURCES,
  });

  const syncCaret = () => {
    const el = ref.current;
    if (!el) return;
    setCaret(el.selectionStart ?? value.length);
  };

  const handleSelect = (s: Suggestion) => {
    if (s.kind !== 'field') return;
    const insert = s.path;
    const before = value.slice(0, tokenInfo.start);
    const after = value.slice(tokenInfo.end);
    const next = before + insert + after;
    onChange(next);
    setOpen(false);
    // Restore caret right after the inserted token, on the next frame so the
    // controlled <input> has rendered the new value first.
    const cursor = tokenInfo.start + insert.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.setSelectionRange(cursor, cursor);
      el.focus();
    });
  };

  React.useEffect(
    () => () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [],
  );

  return (
    <>
      <input
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
          // selectionStart isn't yet updated when onChange fires; defer.
          requestAnimationFrame(syncCaret);
        }}
        onFocus={() => {
          setOpen(true);
          syncCaret();
        }}
        onBlur={() => {
          blurTimerRef.current = setTimeout(() => setOpen(false), 100);
          // Selecting from the popover doesn't blur (it preventDefaults its
          // own mousedown), so a caller committing here never eats a pick.
          onBlur?.();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestid}
        style={style}
      />
      <SuggestionPopover
        open={open && tokenInfo.active && !disabled}
        items={items}
        anchorRef={ref}
        onSelect={handleSelect}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// Exposed so tests can pin down token-extraction behavior without rendering.
// eslint-disable-next-line react-refresh/only-export-components
export const __test__ = { computeToken };
