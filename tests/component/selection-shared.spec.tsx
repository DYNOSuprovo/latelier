import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import { useRowSelection } from '../../src/pages/Workspace/resultSelection';
import type { CollectionTabState, LastRun } from '@shared/types';

const noop = () => {};

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

function makeState(view: CollectionTabState['view'], lastRun: LastRun): CollectionTabState {
  return {
    view,
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun,
  };
}

const makeMeta = emptyWorkspaceMeta;

function Viewer({ state }: { state: CollectionTabState }) {
  return (
    <CollectionWorkspaceProvider state={state} actions={emptyWorkspaceActions()} meta={makeMeta()}>
      <ResultViewer>
        <ResultViewer.SelectionBar onDeleteSelected={vi.fn()} />
        <ResultViewer.Body onClearFilter={noop} onColumnResize={noop} onRowExpand={noop} />
      </ResultViewer>
    </CollectionWorkspaceProvider>
  );
}

describe('Result selection — cross-view persistence and reset (AC5/AC6)', () => {
  it('AC5 — a selection made in Table survives switching to Tree (same documents reference)', () => {
    const docs = [
      { _id: 1, name: 'alpha' },
      { _id: 2, name: 'beta' },
    ];
    const lastRun: LastRun = { documents: docs, durationMs: 5, ranAt: new Date().toISOString() };
    const { rerender, container } = render(<Viewer state={makeState('Table', lastRun)} />);

    // Select the "alpha" row in Table view — a plain click no longer
    // selects, so this goes through the row's own checkbox.
    fireEvent.click(screen.getByRole('button', { name: 'Select document 1' }));
    expect(container.textContent).toContain('1 selected');

    // Switch to Tree — a *new* CollectionTabState object, but the same
    // `lastRun` (and thus `documents`) reference, so the selection context
    // (keyed on that reference) is not reset.
    rerender(<Viewer state={makeState('Tree', lastRun)} />);
    expect(container.textContent).toContain('1 selected');

    // Same row (by index) actually repaints as selected in Tree — the row's
    // own `data-selected`, not just the action bar's independent count.
    const rows = Array.from(container.querySelectorAll('[data-selected]'));
    const alphaRow = rows.find((el) => el.textContent?.includes('alpha'));
    const betaRow = rows.find((el) => el.textContent?.includes('beta'));
    expect(alphaRow?.getAttribute('data-selected')).toBe('true');
    expect(betaRow?.getAttribute('data-selected')).toBe('false');
  });

  it('AC6 — selection resets when the documents reference changes (new query run / page / tab)', () => {
    const docs = [
      { _id: 1, name: 'alpha' },
      { _id: 2, name: 'beta' },
    ];
    const lastRun1: LastRun = { documents: docs, durationMs: 5, ranAt: new Date().toISOString() };
    const { rerender, container } = render(<Viewer state={makeState('Table', lastRun1)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Select document 1' }));
    expect(container.textContent).toContain('1 selected');

    // A fresh `documents` array — the shape of a new query run / page change
    // / tab switch / post-delete re-run.
    const lastRun2: LastRun = {
      documents: [...docs],
      durationMs: 5,
      ranAt: new Date().toISOString(),
    };
    rerender(<Viewer state={makeState('Table', lastRun2)} />);
    expect(container.textContent).not.toContain('selected');
  });
});

describe('useRowSelection — resets in the same render as the key change (no stale-selection flash)', () => {
  it('returns an empty Set immediately on the render that observes the new resetKey', () => {
    const { result, rerender } = renderHook(({ resetKey }) => useRowSelection(resetKey), {
      initialProps: { resetKey: 'run-1' as unknown },
    });

    act(() => {
      result.current.toggle(0);
      result.current.toggle(2);
    });
    expect(result.current.indices.size).toBe(2);

    // A new resetKey (new query run / page change / tab switch / post-delete
    // re-run) — this should read back as an empty Set with no intermediate
    // render exposing the stale two-item selection.
    rerender({ resetKey: 'run-2' });
    expect(result.current.indices.size).toBe(0);
    expect(result.current.indices.has(0)).toBe(false);
    expect(result.current.indices.has(2)).toBe(false);
  });
});
