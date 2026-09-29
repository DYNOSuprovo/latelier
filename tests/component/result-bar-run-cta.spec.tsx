import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState } from '@shared/types';

// Before the first run, "No run yet" led nowhere. This covers
// the Run action ResultBar now offers in its place.

function makeState(queryRaw = '{}'): CollectionTabState {
  return {
    view: 'Tree',
    builder: {
      projection: [],
      sort: '',
      limit: '',
    },
    queryRaw,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    // No `lastRun` — the pre-first-run state under test.
  };
}

function renderBar(o: { queryRaw?: string; isLoading?: boolean; isReadOnly?: boolean } = {}) {
  const actions = emptyWorkspaceActions();
  const meta = emptyWorkspaceMeta({ isLoading: o.isLoading ?? false, isReadOnly: o.isReadOnly });
  render(
    <CollectionWorkspaceProvider state={makeState(o.queryRaw)} actions={actions} meta={meta}>
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
  return { actions };
}

describe('ResultBar - pre-run Run action', () => {
  it('offers a Run action with its shortcut instead of a dead-end label', () => {
    renderBar();
    const btn = screen.getByTestId('resultbar-run-cta') as HTMLButtonElement;
    expect(btn.textContent).toContain('Run');
    expect(btn.textContent).toMatch(/Cmd\+Enter/);
    expect(btn.disabled).toBe(false);
  });

  it('clicking it runs the query', () => {
    const { actions } = renderBar();
    fireEvent.click(screen.getByTestId('resultbar-run-cta'));
    expect(actions.run).toHaveBeenCalledOnce();
  });

  it('disables the action while the filter is unrunnable', () => {
    renderBar({ queryRaw: 'not json' });
    const btn = screen.getByTestId('resultbar-run-cta') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('read-only consumers (e.g. a script-tab snapshot) keep the plain label', () => {
    renderBar({ isReadOnly: true });
    expect(screen.queryByTestId('resultbar-run-cta')).toBeNull();
    expect(screen.getByText('No run yet')).toBeTruthy();
  });
});
