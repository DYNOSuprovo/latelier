import { describe, it, expect } from 'vitest';
import { render, screen, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState, ResultViewMode } from '@shared/types';

function makeState(view: ResultViewMode): CollectionTabState {
  return {
    view,
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [{ _id: 1, name: 'alpha' }],
      durationMs: 5,
      ranAt: new Date().toISOString(),
    },
  };
}

function renderBar(view: ResultViewMode) {
  return render(
    <CollectionWorkspaceProvider
      state={makeState(view)}
      actions={emptyWorkspaceActions()}
      meta={emptyWorkspaceMeta()}
    >
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
}

// The Fields control used to be gated on `view === 'Table'`; it now
// renders for every view (Tree/JSON don't consume the config yet, but the
// control itself is shared, one list for every view).
describe('ResultBar - Fields control visibility', () => {
  it.each(['Tree', 'JSON', 'Table'] as const)('renders the Fields control in the %s view', (view) => {
    renderBar(view);
    expect(screen.getByRole('button', { name: /fields/i })).toBeTruthy();
  });
});
