import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

function makeState(): CollectionTabState {
  return {
    view: 'Tree',
    builder: {
      projection: [],
      sort: '',
      limit: '',
    },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [{}],
      durationMs: 5,
      ranAt: new Date().toISOString(),
    },
  };
}

function renderBar(metaOverrides: Partial<CollectionWorkspaceMeta> = {}) {
  const actions = emptyWorkspaceActions();
  const meta = emptyWorkspaceMeta(metaOverrides);
  render(
    <CollectionWorkspaceProvider state={makeState()} actions={actions} meta={meta}>
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
  return { actions };
}

async function openOverflowMenu() {
  const trigger = await screen.findByRole('button', { name: 'Documents' });
  fireEvent.click(trigger);
}

describe('ResultBar — delete-all-matching overflow action', () => {
  it('calls actions.openDeleteAll() when "Delete all matching…" is clicked (writable provider)', async () => {
    const { actions } = renderBar();
    await openOverflowMenu();
    const item = await screen.findByRole('menuitem', { name: /Delete all matching/ });
    fireEvent.click(item);
    expect(actions.openDeleteAll).toHaveBeenCalledTimes(1);
  });

  it('does not offer delete-all in a read-only provider', () => {
    renderBar({ isReadOnly: true });
    expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull();
  });
});

describe('ResultBar — update-all-matching overflow action', () => {
  it('calls actions.openUpdateAll() when "Update all matching…" is clicked (writable provider)', async () => {
    const { actions } = renderBar();
    await openOverflowMenu();
    const item = await screen.findByRole('menuitem', { name: /Update all matching/ });
    fireEvent.click(item);
    expect(actions.openUpdateAll).toHaveBeenCalledTimes(1);
  });

  it('does not offer update-all in a read-only provider', () => {
    renderBar({ isReadOnly: true });
    expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull();
  });
});
