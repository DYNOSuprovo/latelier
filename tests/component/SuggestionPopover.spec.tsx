import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { SuggestionPopover } from '../../src/features/fieldSuggestions/SuggestionPopover';
import type { Suggestion } from '../../src/features/fieldSuggestions/types';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function Harness({
  items,
  onSelect = () => {},
  open = true,
}: {
  items: Suggestion[];
  onSelect?: (s: Suggestion) => void;
  open?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={inputRef} data-testid="anchor" />
      <SuggestionPopover
        items={items}
        anchorRef={inputRef}
        open={open}
        onSelect={onSelect}
        onClose={() => {}}
      />
    </div>
  );
}

describe('SuggestionPopover side panel', () => {
  beforeEach(() => {
    installAtelierMock();
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  it('renders the side doc panel when the highlighted item is an operator with docs', () => {
    const items: Suggestion[] = [
      {
        kind: 'operator',
        name: '$match',
        class: 'stage',
        source: 'operators',
        description: 'Filters the pipeline so that only documents matching the query pass.',
        syntax: '{ $match: <query> }',
        example: '{ $match: { status: "active" } }',
        url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
      },
    ];
    render(<Harness items={items} />);
    expect(screen.getByLabelText('Documentation for $match')).toBeTruthy();
  });

  it('does not render the side doc panel for field suggestions', () => {
    const items: Suggestion[] = [
      { kind: 'field', path: 'name', source: 'schema' },
      { kind: 'field', path: 'age', source: 'schema' },
    ];
    render(<Harness items={items} />);
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();
  });

  it('mounts and unmounts the panel when the highlight moves between operator and field', () => {
    const items: Suggestion[] = [
      { kind: 'field', path: 'status', source: 'schema' },
      {
        kind: 'operator',
        name: '$match',
        class: 'stage',
        source: 'operators',
        description: 'Filters documents.',
        syntax: '{ $match: <query> }',
        example: '{ $match: {} }',
        url: 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/',
      },
    ];
    render(<Harness items={items} />);

    // First item (field) highlighted by default — no panel.
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();

    // Hover the second (operator) row → highlight moves → panel appears.
    const operatorRow = screen.getByText('$match').closest('[role="option"]')!;
    fireEvent.mouseEnter(operatorRow);
    expect(screen.getByLabelText('Documentation for $match')).toBeTruthy();

    // Hover back to the field row → panel unmounts.
    const fieldRow = screen.getByText('status').closest('[role="option"]')!;
    fireEvent.mouseEnter(fieldRow);
    expect(screen.queryByLabelText(/Documentation for/)).toBeNull();
  });
});

/**
 * The auto-highlight must not swallow Enter.
 *
 * The popover binds its keys to the anchor input, so every caller (the query
 * bar's projection/sort inputs, the drawer's cond rows, the filter textarea)
 * shares this rule. Before the fix, a user typing a complete `{ name: 1 }`
 * and pressing Enter to commit got `{ name: 1 }_id`: the popover took the key
 * and inserted whatever ranked first in a list the user never looked at.
 *
 * Both directions are asserted deliberately. "Enter doesn't select" alone
 * would also pass against a popover that had stopped handling Enter at all,
 * which would break the one flow keyboard users actually rely on.
 */
describe('SuggestionPopover — Enter only selects an actively chosen item', () => {
  beforeEach(() => {
    installAtelierMock();
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  const items: Suggestion[] = [
    { kind: 'field', path: 'name', source: 'schema' },
    { kind: 'field', path: 'nickname', source: 'schema' },
  ];

  it('leaves Enter to the input when the list was never walked', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    // The first row is tinted for display, but it does NOT claim to be
    // selected — W15 §5. An earlier revision left `aria-selected="true"` here
    // while Enter deliberately refused to act on it, which told a screen-reader
    // user an option was selected that pressing Enter would not take.
    expect(screen.getByText('name').closest('[role="option"]')?.getAttribute('aria-selected'))
      .toBe('false');

    const anchor = screen.getByTestId('anchor');
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    // … but it isn't a selection: nothing inserted, and the key is left
    // unprevented so the input's own commit-on-Enter still runs.
    expect(picked).toEqual([]);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('selects the highlighted item once the user has arrowed to it', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    expect(picked.map((s) => (s.kind === 'field' ? s.path : ''))).toEqual(['nickname']);
    expect(evt.defaultPrevented).toBe(true);
  });

  // ⌘/Ctrl+Enter is Run, never Select. The popover used to take it
  // as a pick, and the key then bubbled on to the Run handler, so one press
  // both inserted the suggestion and ran the query.
  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
  ])('leaves %s+Enter to the Run handler even after arrowing', (_name, mod) => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod });
    anchor.dispatchEvent(evt);

    expect(picked).toEqual([]);
    expect(evt.defaultPrevented).toBe(false);
  });

  it('claims aria-selected exactly when Enter would take the row', () => {
    // The other half of the acceptance criterion. Asserting only "false before
    // ArrowDown" would also pass against a popover that had stopped setting
    // `aria-selected` at all, which is a different bug with the same shape.
    render(<Harness items={items} onSelect={() => {}} />);
    const selected = () =>
      screen.getAllByRole('option').map((el) => el.getAttribute('aria-selected'));

    expect(selected()).toEqual(['false', 'false']);

    fireEvent.keyDown(screen.getByTestId('anchor'), { key: 'ArrowDown' });
    expect(selected()).toEqual(['false', 'true']);
  });

  it('stands the engagement down when the list is rebuilt under it', () => {
    // The user arrows to a row, then types another character: `useSuggestions`
    // re-ranks and hands back a new list, so the row they chose is no longer
    // the row they chose. Enter has to go back to the input.
    const picked: Suggestion[] = [];
    const { rerender } = render(<Harness items={items} onSelect={(s) => picked.push(s)} />);
    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });

    rerender(<Harness items={[...items]} onSelect={(s) => picked.push(s)} />);
    fireEvent.keyDown(anchor, { key: 'Enter' });

    expect(picked).toEqual([]);
  });

  it('stands the engagement down when the popover closes and reopens', () => {
    // Escape (or a blur) and then refocus with the same text: `items` keeps
    // its identity, so `open` is the only thing that says "this is a fresh
    // popover". Without that half, Enter would select on reopen.
    const picked: Suggestion[] = [];
    const props = { items, onSelect: (s: Suggestion) => picked.push(s) };
    const { rerender } = render(<Harness {...props} />);
    const anchor = screen.getByTestId('anchor');
    fireEvent.keyDown(anchor, { key: 'ArrowDown' });

    rerender(<Harness {...props} open={false} />);
    rerender(<Harness {...props} open />);
    fireEvent.keyDown(anchor, { key: 'Enter' });

    expect(picked).toEqual([]);
  });

  it('still selects on Tab without arrowing — Tab means "complete this"', () => {
    const picked: Suggestion[] = [];
    render(<Harness items={items} onSelect={(s) => picked.push(s)} />);

    fireEvent.keyDown(screen.getByTestId('anchor'), { key: 'Tab' });

    expect(picked.map((s) => (s.kind === 'field' ? s.path : ''))).toEqual(['name']);
  });
});

// Escape belongs to the innermost thing on screen. The list claims it only
// while it is showing — `defaultPrevented` for a bubble-phase host (the
// Fields control's popover), and `data-mantine-stop-propagation` on the input
// for a Mantine Modal/Drawer, whose capture-phase window listener runs first
// and skips a target carrying that attribute.
describe('SuggestionPopover — Escape layering', () => {
  const ITEMS: Suggestion[] = [{ kind: 'field', path: 'name', source: 'schema' }];

  it('claims Escape and marks the input while the list is showing', () => {
    render(<Harness items={ITEMS} />);
    const anchor = screen.getByTestId('anchor');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(anchor.getAttribute('data-mantine-stop-propagation')).toBe('true');
    expect(fireEvent.keyDown(anchor, { key: 'Escape' })).toBe(false); // prevented
  });

  it('leaves Escape to the host, and the input unmarked, when nothing is showing', () => {
    render(<Harness items={[]} />);
    const anchor = screen.getByTestId('anchor');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(anchor.hasAttribute('data-mantine-stop-propagation')).toBe(false);
    expect(fireEvent.keyDown(anchor, { key: 'Escape' })).toBe(true); // not prevented
  });

  it('unmarks the input when the list closes', () => {
    const { rerender } = render(<Harness items={ITEMS} />);
    const anchor = screen.getByTestId('anchor');
    expect(anchor.getAttribute('data-mantine-stop-propagation')).toBe('true');
    rerender(<Harness items={ITEMS} open={false} />);
    expect(anchor.hasAttribute('data-mantine-stop-propagation')).toBe(false);
  });
});
