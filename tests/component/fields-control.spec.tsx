import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, fireEvent, waitFor, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { itReturnsFocusToPopoverTrigger } from '../helpers/popoverFocusReturn';
import { FieldsControl } from '../../src/pages/Workspace/FieldsControl';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceActions, CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

function baseState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Table',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [
        { _id: 1, apple: 'a', banana: 'b' },
        { _id: 2, apple: 'a2', banana: 'b2' },
      ],
      durationMs: 1,
      ranAt: '2026-01-01T00:00:00Z',
    },
    ...overrides,
  };
}

function renderChooser(
  state: CollectionTabState,
  actionOverrides: Partial<CollectionWorkspaceActions> = {},
) {
  const actions = emptyWorkspaceActions(actionOverrides);
  return {
    ...render(
      <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta()}>
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    ),
    actions,
  };
}

describe('FieldsControl', () => {
  it('toggling a field checkbox calls patchWith with the field added to hidden', () => {
    const patchWith = vi.fn();
    const { getByRole } = renderChooser(baseState(), { patchWith });

    // Open the popover.
    fireEvent.click(getByRole('button', { name: /fields/i }));

    const appleCheckbox = getByRole('checkbox', { name: 'apple' });
    fireEvent.click(appleCheckbox);

    expect(patchWith).toHaveBeenCalledTimes(1);
    const fn = patchWith.mock.calls[0][0] as (s: CollectionTabState) => Partial<CollectionTabState>;
    const patch = fn(baseState());
    expect(patch.columnConfig?.hidden).toContain('apple');
  });

  it('unchecking an already-hidden field removes it from hidden', () => {
    const patchWith = vi.fn();
    const state = baseState({ columnConfig: { hidden: ['apple'] } });
    const { getByRole } = renderChooser(state, { patchWith });

    fireEvent.click(getByRole('button', { name: /fields/i }));
    const appleCheckbox = getByRole('checkbox', { name: 'apple' }) as HTMLInputElement;
    expect(appleCheckbox.checked).toBe(false);

    fireEvent.click(appleCheckbox);
    const fn = patchWith.mock.calls[0][0] as (s: CollectionTabState) => Partial<CollectionTabState>;
    const patch = fn(state);
    expect(patch.columnConfig?.hidden).not.toContain('apple');
  });

  it('add-computed-column input is disabled for an empty/whitespace path', () => {
    const { getByRole } = renderChooser(baseState());
    fireEvent.click(getByRole('button', { name: /fields/i }));

    const addButton = getByRole('button', { name: /add column/i }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    const input = getByRole('textbox', { name: /computed column path/i });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(addButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'address.city' } });
    expect(addButton.disabled).toBe(false);
  });

  it('adding a computed column trims the path and calls patchWith', () => {
    const patchWith = vi.fn();
    const { getByRole } = renderChooser(baseState(), { patchWith });
    fireEvent.click(getByRole('button', { name: /fields/i }));

    const input = getByRole('textbox', { name: /computed column path/i });
    fireEvent.change(input, { target: { value: '  address.city  ' } });
    fireEvent.click(getByRole('button', { name: /add column/i }));

    expect(patchWith).toHaveBeenCalledTimes(1);
    const fn = patchWith.mock.calls[0][0] as (s: CollectionTabState) => Partial<CollectionTabState>;
    const patch = fn(baseState());
    expect(patch.columnConfig?.computed).toEqual([
      expect.objectContaining({ path: 'address.city' }),
    ]);
  });

  it('adding a duplicate computed path is a no-op (de-duped)', () => {
    const patchWith = vi.fn();
    const state = baseState({
      columnConfig: { computed: [{ id: 'c1', path: 'address.city' }] },
    });
    const { getByRole } = renderChooser(state, { patchWith });
    fireEvent.click(getByRole('button', { name: /fields/i }));

    const input = getByRole('textbox', { name: /computed column path/i });
    fireEvent.change(input, { target: { value: 'address.city' } });
    const addButton = getByRole('button', { name: /add column/i }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
  });

  it('removing a computed column calls patchWith without it', () => {
    const patchWith = vi.fn();
    const state = baseState({
      columnConfig: { computed: [{ id: 'c1', path: 'address.city', label: 'City' }] },
    });
    const { getByRole } = renderChooser(state, { patchWith });
    fireEvent.click(getByRole('button', { name: /fields/i }));

    fireEvent.click(getByRole('button', { name: /remove city/i }));
    const fn = patchWith.mock.calls[0][0] as (s: CollectionTabState) => Partial<CollectionTabState>;
    const patch = fn(state);
    expect(patch.columnConfig?.computed).toEqual([]);
  });

  it.each(['Tree', 'JSON'] as const)(
    'renders in the %s view, with hide/reorder available but no computed-column UI',
    (view) => {
      const patchWith = vi.fn();
      const state = baseState({ view });
      const { getByRole, queryByRole } = renderChooser(state, { patchWith });
      fireEvent.click(getByRole('button', { name: /fields/i }));

      // Hide/reorder (the shared field list) still works outside Table.
      fireEvent.click(getByRole('checkbox', { name: 'apple' }));
      expect(patchWith).toHaveBeenCalled();

      // Computed columns only ever feed TableView's rendering — the
      // add-column form is Table-only (see FieldsControl's doc comment).
      expect(queryByRole('textbox', { name: /computed column path/i })).toBeNull();
      expect(queryByRole('button', { name: /add column/i })).toBeNull();
    },
  );

  it('renders "No fields available" when there are no documents yet', () => {
    const { getByRole, getByText } = renderChooser(baseState({ lastRun: undefined }));
    fireEvent.click(getByRole('button', { name: /fields/i }));
    expect(getByText(/no fields available/i)).toBeTruthy();
  });

  it('resets the drag index on dragEnd, so a later stray drop is a no-op', () => {
    // Review finding: `dragIndex.current` was only cleared on
    // `onDrop`. A drag cancelled without a drop (Escape, dropped outside a
    // valid target) left the stale index around for a later, unrelated drop
    // to consume. `onDragEnd` must clear it too.
    const patchWith = vi.fn();
    const { getByRole, getAllByTitle } = renderChooser(baseState(), { patchWith });
    fireEvent.click(getByRole('button', { name: /fields/i }));

    // orderedFields for baseState() is ['_id', 'apple', 'banana'].
    const handles = getAllByTitle(/drag to reorder/i);
    expect(handles).toHaveLength(3);

    fireEvent.dragStart(handles[0]);
    fireEvent.dragEnd(handles[0]);

    // A drop with no preceding dragStart for *this* gesture must not reorder.
    fireEvent.drop(handles[2]);

    expect(patchWith).not.toHaveBeenCalled();
  });

  // #57 — keyboard reorder path. orderedFields for baseState() is
  // ['_id', 'apple', 'banana'].

  it('exposes a Move up/down button pair per field, labelled with the field name', () => {
    const { getByRole } = renderChooser(baseState());
    fireEvent.click(getByRole('button', { name: /fields/i }));

    expect(getByRole('button', { name: 'Move apple up' })).toBeTruthy();
    expect(getByRole('button', { name: 'Move apple down' })).toBeTruthy();
  });

  it('disables the first field\'s "up" and the last field\'s "down", not just no-ops them', () => {
    const { getByRole } = renderChooser(baseState());
    fireEvent.click(getByRole('button', { name: /fields/i }));

    expect((getByRole('button', { name: 'Move _id up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: 'Move banana down' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((getByRole('button', { name: 'Move _id down' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((getByRole('button', { name: 'Move banana up' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // Both directions reach `moveField` and produce the order the user asked
  // for. Parameterised rather than written out twice — two 15-line near-copies
  // is what took SonarCloud's new-duplication gate to 12.7% here, the same
  // shape that blocked #56.
  const MOVE_CASES: ReadonlyArray<{ button: string; order: string[] }> = [
    { button: 'Move _id down', order: ['apple', '_id', 'banana'] },
    { button: 'Move banana up', order: ['_id', 'banana', 'apple'] },
  ];

  MOVE_CASES.forEach(({ button, order }) => {
    it(`"${button}" patches the order to ${order.join(', ')}`, () => {
      const patchWith = vi.fn();
      const state = baseState();
      const { getByRole } = renderChooser(state, { patchWith });
      fireEvent.click(getByRole('button', { name: /fields/i }));

      fireEvent.click(getByRole('button', { name: button }));

      expect(patchWith).toHaveBeenCalledTimes(1);
      const fn = patchWith.mock.calls[0][0] as (
        s: CollectionTabState,
      ) => Partial<CollectionTabState>;
      expect(fn(state).columnConfig?.order).toEqual(order);
    });
  });

  it('announces the move outcome via a polite live region', async () => {
    const patchWith = vi.fn();
    const state = baseState();
    const { getByRole, getByText } = renderChooser(state, { patchWith });
    fireEvent.click(getByRole('button', { name: /fields/i }));

    await userEvent.click(getByRole('button', { name: 'Move apple down' }));

    const region = getByText(/apple moved to position 3 of 3/i);
    expect(region).toBeTruthy();
    // The text alone proves nothing: without the attribute the region is
    // silent and the whole announcement is dead, with every other test here
    // still green. Assert the mechanism, not just the string.
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('does not carry a stale announcement into the next time the chooser is opened', async () => {
    // The dropdown unmounts on close (Mantine's Popover is not keepMounted
    // here), but `announcement` lives in FieldsControl, which stays mounted.
    // So the region comes back already holding the last move's sentence.
    // `aria-live` announces *mutations*, never the content a region is born
    // with, so that text is never spoken — it just sits in the accessibility
    // tree describing something the user did before they closed the panel.
    const patchWith = vi.fn();
    const state = baseState();
    const { getByRole, queryByText } = renderChooser(state, { patchWith });
    const trigger = getByRole('button', { name: /fields/i });

    fireEvent.click(trigger);
    await userEvent.click(getByRole('button', { name: 'Move apple down' }));
    expect(queryByText(/apple moved to position 3 of 3/i)).toBeTruthy();

    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // reopen

    expect(queryByText(/apple moved to position/i)).toBeNull();
  });

  // Applies a mocked patchWith's captured updater to `state` and re-renders
  // with the result — the two focus-trap tests below both need a *real*
  // reorder committed to props, since FieldsControl derives order from
  // props alone and the mocked patchWith never updates anything on its own.
  function rerenderAfterMove(
    ctx: ReturnType<typeof renderChooser>,
    state: CollectionTabState,
    patchWith: ReturnType<typeof vi.fn>,
  ) {
    const fn = patchWith.mock.calls[patchWith.mock.calls.length - 1][0] as (
      s: CollectionTabState,
    ) => Partial<CollectionTabState>;
    const nextState = { ...state, ...fn(state) };
    ctx.rerender(
      <CollectionWorkspaceProvider state={nextState} actions={ctx.actions} meta={emptyWorkspaceMeta()}>
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    );
  }

  it('is operable with the keyboard alone: Tab reaches the buttons and Enter moves repeatedly', async () => {
    // Acceptance criterion 1 is "every field can be moved up and down with
    // the keyboard alone", and every other test here drives the buttons with
    // a click. #20 shipped a critical focus defect precisely because all 48
    // of its tests used the wrong event, so this one uses only keys: Tab to
    // reach the control, Enter to press it, and a *second* Enter without
    // re-focusing — which only works if the focus redirect leaves the user
    // standing on a button that still moves the same field.
    const patchWith = vi.fn();
    const state = baseState();
    const ctx = renderChooser(state, { patchWith });
    fireEvent.click(ctx.getByRole('button', { name: /fields/i }));

    const target = ctx.getByRole('button', { name: 'Move _id down' });
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await userEvent.tab();
      reached = document.activeElement === target;
    }
    expect(reached).toBe(true);

    await userEvent.keyboard('{Enter}');
    expect(patchWith).toHaveBeenCalledTimes(1);
    rerenderAfterMove(ctx, state, patchWith);

    // _id is now at index 1 of ['apple', '_id', 'banana']. A second Enter
    // with no intervening Tab or click must move it again.
    const moved = { ...state, ...(patchWith.mock.calls[0][0] as
      (s: CollectionTabState) => Partial<CollectionTabState>)(state) };
    await userEvent.keyboard('{Enter}');
    expect(patchWith).toHaveBeenCalledTimes(2);
    const second = (patchWith.mock.calls[1][0] as
      (s: CollectionTabState) => Partial<CollectionTabState>)(moved);
    expect(second.columnConfig?.order).toEqual(['apple', 'banana', '_id']);
  });

  /**
   * The end-of-list focus trap. Pressing the button that carries a field to an
   * end disables that very button, and a disabled button cannot hold focus —
   * without a redirect `document.activeElement` really does become `<body>`
   * (verified by disabling the redirect and watching both cases redden), which
   * is the defect #55 and #70 fixed elsewhere.
   *
   * `pressed` and `keepsFocus` are named per case rather than derived, so the
   * fact that "up to the top hands focus to *down*" stays stated in the test
   * instead of being recomputed the same way the component computes it.
   */
  const FOCUS_CASES: ReadonlyArray<{ end: string; pressed: string; keepsFocus: string }> = [
    { end: 'top', pressed: 'Move apple up', keepsFocus: 'Move apple down' },
    { end: 'bottom', pressed: 'Move apple down', keepsFocus: 'Move apple up' },
  ];

  FOCUS_CASES.forEach(({ end, pressed, keepsFocus }) => {
    it(`moving a field to the ${end} leaves focus on "${keepsFocus}", never on <body>`, async () => {
      const patchWith = vi.fn();
      const state = baseState();
      const ctx = renderChooser(state, { patchWith });
      fireEvent.click(ctx.getByRole('button', { name: /fields/i }));

      await userEvent.click(ctx.getByRole('button', { name: pressed }));
      rerenderAfterMove(ctx, state, patchWith);

      expect(document.activeElement).toBe(ctx.getByRole('button', { name: keepsFocus }));
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  // #79 — closing the popover on a click that lands on a non-focusable area
  // used to drop focus to <body>. `returnFocus` fixes it here because
  // nothing in this dropdown autofocuses on open (see the prop's comment).
  // Shared with preview-picker/table-view specs — see the helper's docstring.
  describe('focus return on close (#79)', () => {
    itReturnsFocusToPopoverTrigger(async () => {
      const ctx = renderChooser(baseState());
      const trigger = ctx.getByRole('button', { name: /fields/i });
      await userEvent.click(trigger);
      return {
        trigger,
        focusInside: () => userEvent.click(ctx.getByRole('button', { name: 'Move apple down' })),
      };
    });
  });
});

/**
 * The fetch section — the projection, moved here from the query bar's
 * advanced row (W14 §4). Everything the advanced row promised about the
 * draft (W14 §3, W15 §2.1, X14 §3/§5) still holds, now inside the control.
 */
describe('FieldsControl — fetch only these fields from the server', () => {
  const tabState = (builder: Partial<CollectionTabState['builder']> = {}) =>
    baseState({ view: 'Tree', builder: { projection: [], sort: '', limit: '', ...builder } });

  function openFetch(
    state: CollectionTabState = tabState(),
    actionOverrides: Partial<CollectionWorkspaceActions> = {},
    metaOverrides: Partial<CollectionWorkspaceMeta> = {},
  ) {
    const actions = emptyWorkspaceActions(actionOverrides);
    const utils = render(
      <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta(metaOverrides)}>
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(utils.getByRole('button', { name: /fields/i }));
    return {
      ...utils,
      actions,
      input: () => utils.queryByTestId('fields-projection') as HTMLInputElement | null,
      alerts: () => utils.queryAllByRole('alert'),
    };
  }

  const type = (input: HTMLInputElement, text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  };

  it('says what each section does: hiding is display-only, fetching changes the server reply', () => {
    const r = openFetch();
    expect(r.getByText('Show in results')).toBeTruthy();
    expect(r.getByText(/display only — instant, nothing is re-fetched/i)).toBeTruthy();
    expect(r.getByText('Fetch only these fields from the server')).toBeTruthy();
    const help = r.getByText(/changes what the server returns — applied on the next run/i);
    // The explanation is the input's description, not just nearby text.
    expect(r.input()?.getAttribute('aria-describedby')).toBe(help.id);
  });

  it('is offered even before a first run, when there are no fields to hide', () => {
    const r = openFetch(baseState({ view: 'JSON', lastRun: undefined }));
    expect(r.getByText(/no fields available/i)).toBeTruthy();
    expect(r.input()).not.toBeNull();
  });

  it('is absent for a read-only consumer, which has no Run to apply it', () => {
    const r = openFetch(tabState(), {}, { isReadOnly: true });
    expect(r.getByText('Show in results')).toBeTruthy();
    expect(r.input()).toBeNull();
    expect(r.queryByText('Fetch only these fields from the server')).toBeNull();
  });

  it('shows the committed projection, modelled or raw', () => {
    expect(openFetch(tabState({ projection: ['name'] })).input()?.value).toBe('{ name: 1 }');
  });

  it('shows a raw projection verbatim', () => {
    expect(openFetch(tabState({ projectionRaw: '{"_id":0}' })).input()?.value).toBe('{"_id":0}');
  });

  it('commits a valid projection to the builder, clears the draft, and shows no alert', () => {
    const r = openFetch(tabState({ sort: '{"a":1}' }));
    type(r.input()!, '{ name: 1 }');
    expect(r.actions.patch).toHaveBeenCalledWith({
      builder: { projection: ['name'], projectionRaw: undefined, sort: '{"a":1}', limit: '' },
    });
    // `patch` is mocked, so state doesn't move; the input falling back to the
    // (still empty) committed display is exactly "the draft was cleared".
    expect(r.input()?.value).toBe('');
    expect(r.alerts()).toHaveLength(0);
  });

  it('escapes $slice to the raw projection instead of refusing it', () => {
    const r = openFetch(tabState({ projection: ['name'] }));
    type(r.input()!, '{"a":{"$slice":5}}');
    expect(r.actions.patch).toHaveBeenCalledWith({
      builder: { projection: [], projectionRaw: '{"a":{"$slice":5}}', sort: '', limit: '' },
    });
    expect(r.alerts()).toHaveLength(0);
  });

  it('retains malformed text and explains it, rather than discarding it', () => {
    const r = openFetch();
    type(r.input()!, '{a: }');
    expect(r.input()?.value).toBe('{a: }');
    expect(r.actions.patch).not.toHaveBeenCalled();
    const msg = r.alerts()[0]?.textContent ?? null;
    expect(msg).toMatch(/comma-separated field list/);
    expect(r.input()?.getAttribute('aria-invalid')).toBe('true');
    expect(r.input()?.getAttribute('aria-describedby')).toBe(r.alerts()[0]?.id);
  });

  // Three refusals, three different messages: a typo, text the Shell Syntax
  // transform refused (its own located reason), and well-formed text that is
  // neither modellable nor an EJSON document.
  it('gives malformed, transform-refused and unmodelable input different messages', () => {
    const messageFor = (text: string) => {
      const r = openFetch();
      type(r.input()!, text);
      const msg = r.alerts()[0]?.textContent ?? null;
      r.unmount();
      return msg;
    };
    const malformed = messageFor('{a: }');
    const refused = messageFor('{a: 0');
    const unmodelable = messageFor('{"a": {"$oid": "nothex"}}');
    expect(malformed).toMatch(/comma-separated field list/);
    expect(refused).toMatch(/^Line 1, column 6: /);
    expect(unmodelable).toMatch(/only as an EJSON document/);
    expect(new Set([malformed, refused, unmodelable]).size).toBe(3);
  });

  it('repairs Shell Syntax before judging it: {_id: 0} commits as a raw projection', () => {
    const r = openFetch();
    type(r.input()!, '{_id: 0}');
    expect(r.actions.patch).toHaveBeenCalledWith({
      builder: { projection: [], projectionRaw: '{"_id": 0}', sort: '', limit: '' },
    });
  });

  it('settles the draft when the control closes, since no blur is guaranteed', () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{ name: 1 }' } });
    fireEvent.click(r.getByRole('button', { name: /^fields/i }));
    expect(r.actions.patch).toHaveBeenCalledWith({
      builder: { projection: ['name'], projectionRaw: undefined, sort: '', limit: '' },
    });
  });

  // Escape belongs to the innermost thing on screen: the first one dismisses
  // the suggestion list and nothing else, the second closes the control.
  it('Escape closes an open suggestion list first, and only then the control', async () => {
    const r = openFetch();
    const input = r.input()!;
    fireEvent.change(input, { target: { value: '{ name: 1 }' } });
    expect(await r.findAllByRole('option')).not.toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(r.queryAllByRole('option')).toHaveLength(0));
    expect(r.input()).not.toBeNull();
    expect(r.input()?.value).toBe('{ name: 1 }');
    expect(r.actions.patch).not.toHaveBeenCalled();

    fireEvent.keyDown(r.input()!, { key: 'Escape' });
    await waitFor(() => expect(r.input()).toBeNull());
    expect(r.actions.patch).toHaveBeenCalledWith({
      builder: { projection: ['name'], projectionRaw: undefined, sort: '', limit: '' },
    });
  });

  it('Escape with no suggestion list showing closes the control at once', async () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{ zzz' } });
    // The caret syncs a frame later; until then the empty token matches all.
    await waitFor(() => expect(r.queryAllByRole('option')).toHaveLength(0));
    fireEvent.keyDown(r.input()!, { key: 'Escape' });
    await waitFor(() => expect(r.input()).toBeNull());
  });

  it('keeps a refused draft across close and reopen', async () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{a: }' } });
    fireEvent.click(r.getByRole('button', { name: /^fields/i }));
    await waitFor(() => expect(r.input()).toBeNull());
    // Closed: the button still warns that the projection won't run as typed.
    expect(r.getByText('projection')).toBeTruthy();
    fireEvent.click(r.getByRole('button', { name: /fields/i }));
    expect(r.input()?.value).toBe('{a: }');
    expect(r.alerts()[0]?.textContent).toMatch(/comma-separated field list/);
  });

  it('does not leak a retained bad draft into another tab', () => {
    const actions = emptyWorkspaceActions();
    const r = render(
      <CollectionWorkspaceProvider state={tabState()} actions={actions} meta={emptyWorkspaceMeta({ tabId: 'tA' })}>
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(r.getByRole('button', { name: /fields/i }));
    const input = r.getByTestId('fields-projection') as HTMLInputElement;
    type(input, '{a: 0');
    expect(input.value).toBe('{a: 0');
    expect(r.queryAllByRole('alert')).toHaveLength(1);

    r.rerender(
      <CollectionWorkspaceProvider
        state={tabState({ projection: ['name'] })}
        actions={actions}
        meta={emptyWorkspaceMeta({ tabId: 'tB' })}
      >
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    );
    // Asserted positively: tab B's own value, not merely "not tab A's text".
    expect((r.getByTestId('fields-projection') as HTMLInputElement).value).toBe('{ name: 1 }');
    expect(r.queryAllByRole('alert')).toHaveLength(0);
  });

  it('says why a committed raw projection cannot run', () => {
    const r = openFetch(tabState({ projectionRaw: '{"_id":0' }));
    expect(r.getByText(/Can't parse this projection/)).toBeTruthy();
    expect(r.input()?.getAttribute('aria-invalid')).toBe('true');
  });

  // The panel-level ⌘↵ skips anything inside a dialog, and this dropdown is
  // one, so the input runs it itself — with the settled builder, since the
  // patch it just made has not landed in state yet.
  it('⌘↵ settles the draft and runs with it', () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{sku: 1}' } });
    fireEvent.keyDown(r.input()!, { key: 'Enter', metaKey: true });
    expect(r.actions.run).toHaveBeenCalledWith({
      builder: { projection: ['sku'], projectionRaw: undefined, sort: '', limit: '' },
    });
  });

  it('⌘↵ on a refused draft does not run', () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{a: }' } });
    fireEvent.keyDown(r.input()!, { key: 'Enter', ctrlKey: true });
    expect(r.actions.run).not.toHaveBeenCalled();
    expect(r.alerts()).toHaveLength(1);
  });

  it('plain Enter commits without running', () => {
    const r = openFetch();
    fireEvent.change(r.input()!, { target: { value: '{sku: 1}' } });
    fireEvent.keyDown(r.input()!, { key: 'Enter' });
    expect(r.actions.patch).toHaveBeenCalledTimes(1);
    expect(r.actions.run).not.toHaveBeenCalled();
  });

  it('badges the closed control while a projection is set', () => {
    const { getByRole } = render(
      <CollectionWorkspaceProvider
        state={tabState({ projection: ['apple'] })}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta()}
      >
        <FieldsControl />
      </CollectionWorkspaceProvider>,
    );
    expect(getByRole('button', { name: /fields/i }).textContent).toContain('projection');
  });

  it('shows no projection badge with no projection', () => {
    const { getByRole } = renderChooser(tabState());
    expect(getByRole('button', { name: /fields/i }).textContent).not.toContain('projection');
  });

  describe('fields the projection keeps off the wire are named, not silently missing', () => {
    it('marks an excluded _id in place and lists other excluded fields as not fetched', () => {
      const r = openFetch(
        baseState({
          view: 'Tree',
          builder: { projection: [], projectionRaw: '{"_id":0,"secret":0}', sort: '', limit: '' },
          lastRun: { documents: [{ apple: 'a' }], durationMs: 1, ranAt: '2026-01-01T00:00:00Z' },
        }),
      );
      expect(r.getByRole('checkbox', { name: /^_id — not fetched$/ })).toBeTruthy();
      expect(r.getByRole('checkbox', { name: 'apple' })).toBeTruthy();
      expect(r.getByTestId('fields-not-fetched').textContent).toBe('secret — not fetched');
    });

    it('lists a remembered field an inclusion projection left out', () => {
      const r = openFetch(
        baseState({
          view: 'Table',
          builder: { projection: ['apple'], sort: '', limit: '' },
          columnConfig: { order: ['_id', 'apple', 'banana'] },
          lastRun: { documents: [{ _id: 1, apple: 'a' }], durationMs: 1, ranAt: '2026-01-01T00:00:00Z' },
        }),
      );
      expect(r.getByRole('checkbox', { name: 'apple' })).toBeTruthy();
      expect(r.getByTestId('fields-not-fetched').textContent).toBe('banana — not fetched');
      // Only the fields in hand are reorderable; a not-fetched one is not.
      expect(r.queryByRole('button', { name: 'Move banana up' })).toBeNull();
    });

    // "Applied on the next Run": a projection committed but not yet run has
    // not removed anything, so a field still in the results is not marked.
    it('does not mark a field the results in hand still carry', () => {
      const r = openFetch(tabState({ projection: ['apple'] }));
      expect(r.getByRole('checkbox', { name: 'banana' })).toBeTruthy();
      expect(r.getByRole('checkbox', { name: '_id' })).toBeTruthy();
      expect(r.queryByText(/not fetched/)).toBeNull();
    });

    it('marks nothing without a projection', () => {
      const r = openFetch(baseState({ columnConfig: { order: ['_id', 'apple', 'banana', 'gone'] } }));
      expect(r.queryByTestId('fields-not-fetched')).toBeNull();
      expect(r.queryByText(/not fetched/)).toBeNull();
    });
  });
});
