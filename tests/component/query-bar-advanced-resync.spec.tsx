import { describe, it, expect } from 'vitest';
import { render, fireEvent, within, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { QueryBar } from '../../src/pages/Workspace/QueryBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceActions, CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { BuilderState, CollectionTabState } from '@shared/types';

/**
 * W14 §1 — the advanced row's open state was `useState(hasAdvanced)`,
 * i.e. an initial value only. `<QueryBar>` has no `key` at its mount site and
 * no resync, so the row stayed frozen at whatever the first tab looked like
 * for the lifetime of the Workspace.
 *
 * The fixture rerenders the provider with a different `state` + `meta` pair,
 * which is exactly what a tab switch does at `Workspace.tsx` — `QueryBar`
 * itself stays mounted through it, same as in the app.
 */

const b = (over: Partial<BuilderState> = {}): BuilderState => ({
  projection: [],
  sort: '',
  limit: '',
  ...over,
});

// Takes the builder by reference so a test can hold one identity across
// rerenders — `actions.patch({ queryRaw })` merges a partial and leaves
// `state.builder` pointing at the same object, and a fixture that minted a
// fresh one would let an identity-keyed effect look guilty for free.
function makeState(builder: BuilderState = b(), queryRaw = '{}'): CollectionTabState {
  return {
    view: 'Tree',
    builder,
    queryRaw,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  };
}

const makeActions = emptyWorkspaceActions;

function makeMeta(tabId: string, collection: string): CollectionWorkspaceMeta {
  return emptyWorkspaceMeta({ tabId, collection });
}

// `actions` is optional so the earlier fixtures stay as they were; the
// later tests pass one in to assert on `patch`.
function Bar({
  state,
  meta,
  actions = makeActions(),
}: {
  state: CollectionTabState;
  meta: CollectionWorkspaceMeta;
  actions?: CollectionWorkspaceActions;
}) {
  return (
    <CollectionWorkspaceProvider state={state} actions={actions} meta={meta}>
      <QueryBar suggestionContext={null} />
    </CollectionWorkspaceProvider>
  );
}

const advancedRegion = (container: HTMLElement) =>
  container.querySelector('#query-bar-advanced');

const trigger = (container: HTMLElement) =>
  container.querySelector('[aria-controls="query-bar-advanced"]') as HTMLElement;

// The count badge, scoped to the trigger. Matched by shape rather than a
// testid so dropping the number from it (`set`) fails as loudly as removing
// it — `text-transform` is CSS-only, so jsdom still sees "3 set".
const indicator = (container: HTMLElement) =>
  within(trigger(container)).queryByText(/^\d+ set$/);

// Tab A: nothing advanced set. Tab B: a sort.
const tabA = () => ({ state: makeState(), meta: makeMeta('tA', 'users') });
const tabB = () => ({
  state: makeState(b({ sort: '{"name":1}' })),
  meta: makeMeta('tB', 'orders'),
});

describe('QueryBar — advanced row resyncs across tabs', () => {
  it('opens on switching to a tab with a sort, and closes on switching back', () => {
    const a = tabA();
    const { container, rerender } = render(<Bar {...a} />);
    expect(advancedRegion(container)).toBeNull();

    // A → B: tab B has a sort, so its advanced row must be open.
    const b = tabB();
    rerender(<Bar {...b} />);
    expect(advancedRegion(container)).not.toBeNull();

    // B → A: back to a tab with nothing set — collapsed again.
    rerender(<Bar {...tabA()} />);
    expect(advancedRegion(container)).toBeNull();
  });

  it('keeps an explicit collapse through same-tab re-renders', () => {
    const withSort = makeMeta('tB', 'orders');
    const sortB = b({ sort: '{"a":1}' });
    const { container, rerender } = render(
      <Bar state={makeState(sortB)} meta={withSort} />,
    );
    // Sort is set, so it starts open. The user collapses it.
    expect(advancedRegion(container)).not.toBeNull();
    fireEvent.click(trigger(container));
    expect(advancedRegion(container)).toBeNull();

    // Typing in the query bar must not undo that — same `builder` reference,
    // exactly what `patch({ queryRaw })` leaves behind.
    rerender(<Bar state={makeState(sortB, '{ x: 1 }')} meta={withSort} />);
    expect(advancedRegion(container)).toBeNull();

    // Neither must a builder value changing while it stays set — the table
    // header's quick-sort flipping the direction while the row is collapsed.
    // This is the step a naive resync on `hasAdvanced`/`builder` reopens.
    rerender(<Bar state={makeState(b({ sort: '{"a":-1}' }), '{ x: 1 }')} meta={withSort} />);
    expect(advancedRegion(container)).toBeNull();
  });

  it('opens when a saved query with a limit is loaded into the tab', () => {
    const meta = makeMeta('tA', 'users');
    const { container, rerender } = render(<Bar state={makeState()} meta={meta} />);
    expect(advancedRegion(container)).toBeNull();

    // Saved-run-here patches the same tab's builder + queryRaw in place.
    rerender(
      <Bar state={makeState(b({ limit: '20' }), '{"a":1}')} meta={meta} />,
    );
    expect(advancedRegion(container)).not.toBeNull();
  });

  // Projection lives in the Fields control now (W14 §4): the row has no cell
  // for it, so a projection alone must neither open the row nor count in it.
  it('neither opens nor counts for a projection, and has no projection input', () => {
    const meta = makeMeta('tA', 'users');
    const { container, rerender } = render(<Bar state={makeState()} meta={meta} />);
    rerender(
      <Bar state={makeState(b({ projection: ['name'], projectionRaw: '{"_id":0}' }))} meta={meta} />,
    );
    expect(advancedRegion(container)).toBeNull();
    expect(indicator(container)).toBeNull();

    fireEvent.click(trigger(container));
    const region = advancedRegion(container) as HTMLElement;
    expect(within(region).getByTestId('query-bar-sort')).toBeTruthy();
    expect(within(region).queryByText(/projection/i)).toBeNull();
    expect(container.querySelector('[data-testid*="projection"]')).toBeNull();
  });
});

/**
 * W14 §2 — collapsed, the trigger's only hint that sort / limit were set was a hover tooltip, which doesn't exist for touch or for a
 * user who never hovers. `advancedCount` existed but rendered nowhere.
 *
 * Both a one-value and a two-value fixture are asserted on purpose: a
 * hardcoded count would survive either one alone.
 */
describe('QueryBar — collapsed advanced count indicator', () => {
  const meta = makeMeta('t1', 'users');
  // A tab with advanced values mounts expanded, so reaching the
  // collapsed-with-values state means the user collapsed it — the exact
  // case where the values go invisible.
  const collapsed = (builder: BuilderState) => {
    const r = render(<Bar state={makeState(builder)} meta={meta} />);
    fireEvent.click(trigger(r.container));
    expect(advancedRegion(r.container)).toBeNull();
    return r;
  };

  it('states how many are set when collapsed — one value', () => {
    const { container } = collapsed(b({ sort: '{"a":1}' }));
    expect(indicator(container)?.textContent).toBe('1 set');
  });

  it('states how many are set when collapsed — both', () => {
    const { container } = collapsed(b({ sort: '{"a":1}', limit: '20' }));
    expect(indicator(container)?.textContent).toBe('2 set');
  });

  it('shows no indicator when collapsed with nothing set', () => {
    const { container } = render(<Bar state={makeState()} meta={meta} />);
    expect(advancedRegion(container)).toBeNull();
    expect(indicator(container)).toBeNull();
  });

  it('shows no indicator while expanded — the values are on screen', () => {
    const { container } = render(
      <Bar state={makeState(b({ limit: '20', sort: '{"a":1}' }))} meta={meta} />,
    );
    expect(advancedRegion(container)).not.toBeNull();
    expect(indicator(container)).toBeNull();
  });

  it('leaves the trigger operable by keyboard with its aria wiring intact', () => {
    const { container } = render(
      <Bar state={makeState(b({ limit: '20' }))} meta={meta} />,
    );
    const t = trigger(container);
    expect(t.getAttribute('aria-controls')).toBe('query-bar-advanced');
    expect(t.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(t, { key: 'Enter' });
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(advancedRegion(container)).toBeNull();
    // The badge is decoration: it must not become a second tab stop.
    const badge = indicator(container);
    expect(badge?.textContent).toBe('1 set');
    expect(badge?.getAttribute('tabindex')).toBeNull();

    fireEvent.keyDown(t, { key: ' ' });
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(advancedRegion(container)).not.toBeNull();
  });
});
