// pins all three dependency-array fixes at Workspace.tsx against a
// regression back to depending on the whole `queryRunner` object.
// `useQueryRunner` returns a fresh `{ run, isLoading }` literal every render
// even though `run` itself is stable (its own `useCallback` deps are just
// `[loadingDelayMs]`), so any callback depending on `queryRunner` instead of
// `run` gets a new identity on every render.
//
// `runActiveCollection` and `updateField` feed the `workspaceActions`
// `useMemo`, whose own comment states the intent this pins:
//
//   "Bundle the action lambdas into a single stable reference so the
//   provider value below doesn't churn on every render."
//
// `handleSortField` (the issue's third site) does NOT feed that memo — it's
// passed straight through as `ResultViewer.Body`'s `onSortField` prop — so a
// regression there has no effect on `workspaceActions` and needs its own
// assertion.
//
// There is no behavioral tell for any of this — `run` was always the right
// function, only the closures wrapping it were needlessly re-created. A
// two-render identity check is the only thing that catches a regression;
// see the precedent at tests/component/use-document-dialogs.spec.tsx.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import type { CollectionTab, CollectionTabState } from '@shared/types';
import type { CollectionWorkspaceActions } from '../../src/pages/Workspace/context';
import type { ResultViewer as ResultViewerType } from '../../src/pages/Workspace/ResultViewer';

const NOW = '2026-08-01T12:00:00.000Z';
const DOC = { _id: '1', sku: 'widget' };

const capturedActions: CollectionWorkspaceActions[] = [];

// Wraps the real `CollectionWorkspaceProvider` to record the `actions`
// object it's given on every render, without altering what it renders.
// Workspace.tsx has exactly one call site for this provider (grep it before
// changing this if that ever stops being true).
vi.mock('../../src/pages/Workspace/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pages/Workspace/context')>();
  return {
    ...actual,
    CollectionWorkspaceProvider: (props: Parameters<typeof actual.CollectionWorkspaceProvider>[0]) => {
      capturedActions.push(props.actions);
      return createElement(actual.CollectionWorkspaceProvider, props);
    },
  };
});

type OnSortField = NonNullable<Parameters<(typeof ResultViewerType)['Body']>[0]['onSortField']>;
const capturedOnSortField: OnSortField[] = [];

// Same technique, aimed at `ResultViewer.Body`'s `onSortField` prop —
// `handleSortField` is passed straight through as a leaf prop rather than
// through a memoised provider value, so it needs its own capture point.
// Workspace.tsx has exactly one call site for `ResultViewer.Body`.
vi.mock('../../src/pages/Workspace/ResultViewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pages/Workspace/ResultViewer')>();
  const OriginalBody = actual.ResultViewer.Body;
  const CapturingBody = (props: Parameters<typeof OriginalBody>[0]) => {
    if (props.onSortField) capturedOnSortField.push(props.onSortField);
    return createElement(OriginalBody, props);
  };
  Object.assign(actual.ResultViewer, { Body: CapturingBody });
  return actual;
});

function tab(
  stateOverrides: Partial<CollectionTabState> = {},
  tabOverrides: Partial<CollectionTab> = {},
): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      // Seeded so the row renders without a Run click — same reason
      // workspace-doc-dialogs.spec.tsx seeds it — and skips the auto-run
      // effect, which would otherwise add an extra unrelated render.
      lastRun: { documents: [DOC], durationMs: 1, ranAt: NOW },
      ...stateOverrides,
    },
    ...tabOverrides,
  };
}

function mount(overrides: Parameters<typeof installAtelierMock>[0] = {}) {
  installAtelierMock({
    tabs: { list: async () => [tab()] },
    conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    ...overrides,
  });
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  capturedActions.length = 0;
  capturedOnSortField.length = 0;
});

describe('workspaceActions provider-value identity', () => {
  it('keeps the same actions identity across a re-render unrelated to run/updateField', async () => {
    mount();
    await screen.findByText(/widget/);
    const before = capturedActions.at(-1);
    expect(before).toBeDefined();

    // Opening the insert dialog flips local dialog state inside
    // `useDocumentDialogs`, forcing WorkspaceInner to re-render — a render
    // that touches none of `workspaceActions`' own dependencies.
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    await screen.findByRole('dialog', { name: 'Insert document' });

    expect(capturedActions.length).toBeGreaterThan(1);
    expect(capturedActions.at(-1)).toBe(before);
  });

  it('keeps the same actions identity across the render(s) a query run triggers', async () => {
    const find = vi.fn(async () => ({ documents: [DOC], durationMs: 1, hasMore: false }));
    mount({ query: { find } });
    await screen.findByText(/widget/);
    const before = capturedActions.at(-1);
    expect(before).toBeDefined();

    // Running a query lands a new `lastRun` in tab state (and may flip
    // `isLoading` in between) — neither is a dependency of `workspaceActions`
    // or of `runActiveCollection`.
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    expect(capturedActions.length).toBeGreaterThan(1);
    expect(capturedActions.at(-1)).toBe(before);
  });
});

describe('handleSortField identity', () => {
  it('keeps the same onSortField identity across a re-render unrelated to run', async () => {
    mount();
    await screen.findByText(/widget/);
    const before = capturedOnSortField.at(-1);
    expect(before).toBeDefined();

    // Same unrelated-render trigger as the workspaceActions cases above.
    // `handleSortField` isn't in that memo's dependency array, so it needs
    // its own pin — nothing else in this file would catch it churning.
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    await screen.findByRole('dialog', { name: 'Insert document' });

    expect(capturedOnSortField.length).toBeGreaterThan(1);
    expect(capturedOnSortField.at(-1)).toBe(before);
  });
});
