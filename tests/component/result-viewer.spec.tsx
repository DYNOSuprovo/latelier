import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

const noop = () => {};

// jsdom doesn't implement clipboard by default; some view children
// (TableView, JsonView) install clipboard handlers — stub so the tests
// don't trip over an undefined navigator.clipboard.
let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});
afterEach(() => {
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...overrides,
  };
}

const makeMeta = emptyWorkspaceMeta;

function renderViewer(
  state: CollectionTabState,
  meta: Partial<CollectionWorkspaceMeta> = {},
  children: React.ReactNode,
) {
  return render(
      <CollectionWorkspaceProvider
        state={state}
        actions={emptyWorkspaceActions()}
        meta={makeMeta(meta)}
      >
        {children}
      </CollectionWorkspaceProvider>
  );
}

describe('ResultViewer compound', () => {
  it('Body shows the empty-collection CTA when the committed filter is {} on page 0', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('This collection is empty');
    expect(screen.getByRole('button', { name: /import documents/i })).toBeTruthy();
  });

  it('keeps the import dialog open when the import refresh fills the empty collection', () => {
    const empty = makeState({
      queryRaw: '{}',
      page: 0,
      lastRun: { documents: [], durationMs: 0, ranAt: new Date().toISOString() },
    });
    const body = (
      <ResultViewer>
        <ResultViewer.Body onClearFilter={noop} onColumnResize={noop} onRowExpand={noop} />
      </ResultViewer>
    );
    const { rerender } = renderViewer(empty, {}, body);
    fireEvent.click(screen.getByRole('button', { name: /import documents/i }));
    expect(screen.getByRole('dialog', { name: /import into/i })).toBeTruthy();

    // The import's own refresh lands rows, which unmounts the empty state.
    rerender(
      <CollectionWorkspaceProvider
        state={makeState({
          queryRaw: '{}',
          page: 0,
          lastRun: { documents: [{ _id: 1 }], durationMs: 0, ranAt: new Date().toISOString() },
        })}
        actions={emptyWorkspaceActions()}
        meta={makeMeta({})}
      >
        {body}
      </CollectionWorkspaceProvider>,
    );
    expect(screen.queryByText('This collection is empty')).toBeNull();
    expect(screen.getByRole('dialog', { name: /import into/i })).toBeTruthy();
  });

  it('Body hides the import CTA for a read-only consumer, but still shows the empty-collection message', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      { isReadOnly: true },
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('This collection is empty');
    expect(screen.queryByRole('button', { name: /import documents/i })).toBeNull();
  });

  it('Body renders "No matching documents" for an empty result behind a non-default filter', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{ "status": "archived" }',
      page: 0,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const onClearFilter = vi.fn();
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={onClearFilter}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('No matching documents');
    expect(container.textContent).toContain('Clear filter');
    fireEvent.click(screen.getByRole('button', { name: /clear filter/i }));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('Body renders "No matching documents" for an empty result on a later page of an unfiltered query', () => {
    const state = makeState({
      view: 'Tree',
      queryRaw: '{}',
      page: 1,
      lastRun: {
        documents: [],
        durationMs: 0,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('No matching documents');
  });

  it('Body switches to the Table slot when state.view is "Table"', () => {
    const state = makeState({
      view: 'Table',
      lastRun: {
        documents: [{ _id: 1, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    // Table-specific markers: column header testid + cell value
    expect(container.querySelector('[data-testid="table-header-name"]')).toBeTruthy();
    expect(container.textContent).toContain('alpha');
  });

  it('Body switches to the Json slot when state.view is "JSON"', () => {
    const state = makeState({
      view: 'JSON',
      lastRun: {
        documents: [{ _id: 1, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    // JsonView pretty-prints with two-space indents — look for indented key
    // and the EJSON-aware output (no $oid here because _id is a plain number).
    expect(container.textContent).toContain('"name"');
    expect(container.textContent).toContain('alpha');
  });

  it('Body renders a Loading overlay when meta.isLoading is true', () => {
    const state = makeState({ view: 'Tree' });
    const { container } = renderViewer(
      state,
      { isLoading: true },
      <ResultViewer>
        <ResultViewer.Body
          onClearFilter={noop}
          onColumnResize={noop}
          onRowExpand={noop}
        />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('Loading…');
  });

  it('Pagination slot renders ResultBar against the same provider', () => {
    const state = makeState({
      view: 'Tree',
      page: 0,
      pageSize: 10,
      totalCount: 100,
      lastRunHasMore: true,
      lastRun: {
        documents: new Array(10).fill({}),
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Pagination />
      </ResultViewer>,
    );
    // 100 / 10 = 10 pages — pager shows "1 / 10"
    expect(container.textContent).toContain('1 / 10');
  });

  it('individual Tree slot can be used without Body for custom composition', () => {
    const state = makeState({
      view: 'Tree',
      lastRun: {
        documents: [{ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'alpha' }],
        durationMs: 5,
        ranAt: new Date().toISOString(),
      },
    });
    const { container } = renderViewer(
      state,
      {},
      <ResultViewer>
        <ResultViewer.Tree onRowExpand={noop} />
      </ResultViewer>,
    );
    expect(container.textContent).toContain('99439011');
    expect(container.textContent).toContain('alpha');
  });
});
