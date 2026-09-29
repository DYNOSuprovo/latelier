/* eslint-disable react-refresh/only-export-components */
// Test-only helper: Fast-Refresh's "one component per file" rule doesn't
// apply to test infrastructure that isn't loaded by Vite.
import { type ReactNode } from 'react';
import { expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import {
  act,
  fireEvent,
  render as rtlRender,
  renderHook as rtlRenderHook,
  screen,
  within,
  type RenderHookOptions,
  type RenderHookResult,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { mantineTheme } from '../../src/theme/mantineTheme';
import type {
  CollectionWorkspaceActions,
  CollectionWorkspaceMeta,
} from '../../src/pages/Workspace/context';

// X12 Phase 1: component tests render bare components that now reach for
// MantineProvider via Mantine's primitives. Wrap every render in the same
// theme provider App.tsx mounts so tests match the runtime tree.
// X12 Phase 2: also mount Notifications so notify.error/success calls
// render their toast DOM and tests can assert on the surfaced message.
// X12 Phase 5: env="test" makes Mantine's <Transition> render mounted
// content synchronously instead of waiting on rAF, so Spotlight's Modal
// (and any other transitioned overlay) shows up before the test asserts.
// W15 §13: ModalsProvider too — App.tsx mounts it and the drawer's
// Reset confirm goes through `modals.openConfirmModal`, which is a no-op
// without the provider's context.
function MantineTestProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={mantineTheme} env="test">
      <ModalsProvider>
        <Notifications />
        {children}
      </ModalsProvider>
    </MantineProvider>
  );
}

export function render(
  ui: Parameters<typeof rtlRender>[0],
  options?: RenderOptions,
): RenderResult {
  return rtlRender(ui, { wrapper: MantineTestProvider, ...options });
}

/**
 * Same providers as `render`, for hooks.
 *
 * RTL's own `renderHook` used to arrive through the `export *` below, wrapped
 * in nothing — which is invisible until a hook reaches for a provider. A change
 * moved `closeForNamespace`'s confirm onto the modal manager, and its spec
 * failed with "Unable to find role=dialog" rather than anything pointing at the
 * missing `ModalsProvider`. The named export below shadows the star re-export,
 * so every hook spec gets the runtime tree without opting in.
 */
export function renderHook<Result, Props>(
  hook: (initialProps: Props) => Result,
  options?: RenderHookOptions<Props>,
): RenderHookResult<Result, Props> {
  return rtlRenderHook(hook, { wrapper: MantineTestProvider, ...options });
}

/**
 * Queries scoped to the TitleBar — the first row of the AppShell header.
 *
 * The row and not the whole banner: since X16.2 the tab strip lives in
 * the same header and carries a chip naming each Connection, so a banner-wide
 * query for a Connection name matches a chip as readily as the TitleBar, and a
 * negative assertion ("this Connection is not the one we are browsing") would
 * pass or fail for the wrong reason.
 */
export function titleBar(): ReturnType<typeof within> {
  const row = screen.getByRole('banner').firstElementChild;
  if (!(row instanceof HTMLElement)) {
    throw new Error(
      'titleBar(): the AppShell header has no first-row element. If a row was ' +
        'added above TitleBar, scope to that row instead.',
    );
  }
  return within(row);
}

/**
 * X19 #54 — asserts the shared `DisclosureToggle` shape used by IndexesTab
 * and UsersTab: `aria-expanded` toggles on both Enter and Space, the detail
 * content behind `detailMatcher` follows it, and focus never leaves the
 * toggle across either interaction. One helper rather than copying this
 * block into both spec files — see indexes-tab-render.spec.tsx and
 * users-tab-render.spec.tsx.
 */
export async function expectKeyboardDisclosureToggle(
  toggleName: string,
  detailMatcher: RegExp,
): Promise<void> {
  const toggle = await screen.findByRole('button', { name: toggleName });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  toggle.focus();
  await userEvent.keyboard('{Enter}');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(detailMatcher)).toBeTruthy();
  expect(document.activeElement).toBe(toggle);

  await userEvent.keyboard('[Space]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(detailMatcher)).toBeNull();
  expect(document.activeElement).toBe(toggle);
}

/**
 * X19 #56 — the two `role="separator"` assertions that three resize specs
 * (output-panel, script-tab, resize-handle-edges) had written out verbatim.
 *
 * Both take the *physical* arrow keys, never an `edge` or an axis. Which
 * arrow grows and which shrinks is exactly what went wrong twice on this
 * ticket; if these helpers derived the keys the way `ResizeHandle` does,
 * the two would share a derivation and no test could ever catch an
 * inversion again. The call site states the keys, the helper owns only the
 * clamp/step/focus mechanics.
 */
export async function expectSeparatorClampedAtBounds(
  handle: HTMLElement,
  opts: { min: string; max: string; shrinkKey: string; growKey: string },
): Promise<void> {
  await userEvent.keyboard('{Home}');
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.min);
  await userEvent.keyboard(opts.shrinkKey);
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.min);
  expect(document.activeElement).toBe(handle);

  await userEvent.keyboard('{End}');
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.max);
  await userEvent.keyboard(opts.growKey);
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.max);
  expect(document.activeElement).toBe(handle);
}

/**
 * One press of `growKey`, then two of `shrinkKey`, asserting `aria-valuenow`
 * and the panel's real inline height stay in step with each other — a value
 * that moves without the panel following it is the failure this catches.
 */
export async function expectSeparatorResizesPanel(
  handle: HTMLElement,
  panel: HTMLElement,
  opts: { growKey: string; shrinkKey: string; afterGrow: string; afterShrink: string },
): Promise<void> {
  await userEvent.keyboard(opts.growKey);
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.afterGrow);
  expect(panel.style.height).toBe(`${opts.afterGrow}px`);
  expect(document.activeElement).toBe(handle);

  await userEvent.keyboard(`${opts.shrinkKey}${opts.shrinkKey}`);
  expect(handle.getAttribute('aria-valuenow')).toBe(opts.afterShrink);
  expect(panel.style.height).toBe(`${opts.afterShrink}px`);
  expect(document.activeElement).toBe(handle);
}

/**
 * X19 #60 — the active-row outline lifecycle common to every roving-focus
 * widget's spec (`TableView`'s grid, `TreeView`'s tree, `DocFieldTree`'s own
 * tree): no row carries the outline before the container has focus, the row
 * at `from` gains it once the container does, `key` moves it from `from` to
 * `to`, and blurring the container clears it again.
 *
 * Asserts the real inline style (`el.style.outline`), never an attribute —
 * an attribute-only assertion cannot go red when the paint itself is
 * deleted, which is exactly how #56 shipped. Takes `key`/`from`/`to` as
 * explicit parameters rather than deriving them from the widget under test,
 * so the test states what it expects instead of recomputing the code's own
 * index arithmetic and agreeing with a bug.
 */
export function expectActiveRowOutlineLifecycle(
  container: HTMLElement,
  rows: () => HTMLElement[],
  opts: { key: string; from: number; to: number },
): void {
  expect(rows().some((r) => r.style.outline.includes('2px'))).toBe(false);

  act(() => container.focus());
  expect(document.activeElement).toBe(container);
  expect(rows()[opts.from].style.outline).toContain('2px');

  fireEvent.keyDown(container, { key: opts.key });
  expect(rows()[opts.from].style.outline).not.toContain('2px');
  expect(rows()[opts.to].style.outline).toContain('2px');

  act(() => container.blur());
  expect(rows()[opts.to].style.outline).not.toContain('2px');
}

/**
 * #72 — byte-identical in `tree-view.spec.tsx` and `table-view.spec.tsx`
 * (SonarCloud flagged the pair as duplicated). Every field is a stub;
 * override individual actions with `overrides` the way both call sites did.
 */
export function emptyWorkspaceActions(
  overrides: Partial<CollectionWorkspaceActions> = {},
): CollectionWorkspaceActions {
  return {
    patch: vi.fn(),
    patchWith: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    openEdit: vi.fn(),
    openDelete: vi.fn(),
    openDeleteAll: vi.fn(),
    openUpdateAll: vi.fn(),
    openInsert: vi.fn(),
    openSave: vi.fn(),
    ...overrides,
  };
}

/**
 * #72 — see `emptyWorkspaceActions` above; same duplicate pair. `overrides`
 * carries the same defaults every local copy of this stub had picked
 * (`c1`/`app`/`orders`/`t1`), so a call site that varied one field keeps
 * varying exactly that field.
 */
export function emptyWorkspaceMeta(
  overrides: Partial<CollectionWorkspaceMeta> = {},
): CollectionWorkspaceMeta {
  return {
    connectionId: 'c1',
    dbName: 'app',
    collection: 'orders',
    tabId: 't1',
    isLoading: false,
    ...overrides,
  };
}

/**
 * #72 — `DbCollectionNavigator`'s root row, by the name a person reads on
 * it. Byte-identical in `navigator-accordion.spec.tsx` and
 * `navigator-disconnect.spec.tsx` (SonarCloud flagged the pair).
 */
export function navigatorRoot(name: string): HTMLElement {
  const rows = screen.getAllByTestId('nav-connection');
  const hit = rows.find((r) => within(r).queryByText(name));
  if (!hit) throw new Error(`no navigator root named ${name}`);
  return hit;
}

export * from '@testing-library/react';
