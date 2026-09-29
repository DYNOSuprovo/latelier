import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { TableView } from '../../src/pages/Workspace/views/TableView';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionTabState, TableColumnConfig } from '@shared/types';

function emptyState(): CollectionTabState {
  return {
    view: 'Table',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  };
}

function renderTable(
  sort: string,
  onSortField?: (f: string) => void,
  columnConfig?: TableColumnConfig,
) {
  return render(
      <CollectionWorkspaceProvider
        state={emptyState()}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta()}
      >
        <TableView
          documents={[
            { _id: '1', name: 'a', age: 1 },
            { _id: '2', name: 'b', age: 2 },
          ]}
          onColumnResize={vi.fn()}
          onSortField={onSortField}
          sort={sort}
          columnConfig={columnConfig}
        />
      </CollectionWorkspaceProvider>
  );
}

describe('TableView — quick sort', () => {
  it('clicking a header calls onSortField with the column name', () => {
    const onSortField = vi.fn();
    renderTable('', onSortField);

    // The sort click handler lives on the nested <button> now (S6848 —
    // native element gets native Enter/Space for free), not on the
    // data-testid'd cell wrapper itself.
    fireEvent.click(within(screen.getByTestId('table-header-name')).getByRole('button'));
    expect(onSortField).toHaveBeenCalledWith('name');
  });

  it('renders ↑ indicator on ascending field', () => {
    renderTable('{"name":1}', vi.fn());
    const header = screen.getByTestId('table-header-name');
    expect(header.textContent).toContain('↑');
  });

  it('renders ↓ indicator on descending field', () => {
    renderTable('{"name":-1}', vi.fn());
    const header = screen.getByTestId('table-header-name');
    expect(header.textContent).toContain('↓');
  });

  it('renders no indicator when no sort is set for the field', () => {
    renderTable('', vi.fn());
    const header = screen.getByTestId('table-header-name');
    expect(header.textContent).not.toContain('↑');
    expect(header.textContent).not.toContain('↓');
  });

  it('omits the cursor:pointer / click handler when onSortField is not supplied', () => {
    renderTable('', undefined);
    const header = screen.getByTestId('table-header-name');
    expect(header.style.cursor).toBe('default');
  });
});

/**
 * W15 §3.2 — the header never silently claims "unsorted".
 *
 * The per-column arrows are drawn from `parseSortString`, which answers `{}`
 * for every shape it can't model. Each case here is a sort that is running
 * (or about to error) while no arrow appears anywhere in the header.
 *
 * Asserted through the accessible name, not the glyph: `↕` alone tells a
 * screen-reader user nothing, and the point of the slot is that the state is
 * *stated*.
 */
describe('TableView — table-level sort state (W15 §3.2)', () => {
  const note = () => screen.queryByTestId('table-header-sort-note');

  it('says nothing when there is no sort', () => {
    renderTable('', vi.fn());
    expect(note()).toBeNull();
  });

  it('says nothing when every sort key already has its own arrow', () => {
    renderTable('{"name":1}', vi.fn());
    expect(note()).toBeNull();
  });

  it('reports a sort the arrows cannot draw at all', () => {
    renderTable('{"score":{"$meta":"textScore"}}', vi.fn());
    // Pre-#324 this header was indistinguishable from an unsorted one.
    expect(screen.getByLabelText('Sorted by a rule this header cannot show')).toBeTruthy();
  });

  it('reports a sort the arrows only half draw', () => {
    renderTable('{"name":1,"score":{"$meta":"textScore"}}', vi.fn());
    expect(screen.getByTestId('table-header-name').textContent).toContain('↑');
    expect(
      screen.getByLabelText('Sorted — some of the sort fields cannot be shown in this header'),
    ).toBeTruthy();
  });

  it('reports sort text that will not run', () => {
    renderTable('{"name":1', vi.fn());
    expect(screen.getByLabelText('The sort is not valid — this query will not run')).toBeTruthy();
  });

  // the inverse of the defect above, and the one this header shipped
  // with. `null` and `[1,2]` do not error: the driver ignores them and
  // returns rows in insertion order. The header called that "Sorted by a rule
  // this header cannot show" — announcing a sort over unsorted results.
  // Asserted positively *and* negatively: "the wrong label is absent" alone
  // would also pass if the note stopped rendering entirely.
  for (const raw of ['null', '[1,2]', '42']) {
    it(`never claims a sort for ${raw}, which runs unsorted`, () => {
      renderTable(raw, vi.fn());
      expect(screen.queryByLabelText('Sorted by a rule this header cannot show')).toBeNull();
      expect(screen.getByLabelText('The sort is not valid — this query will not run')).toBeTruthy();
      // No per-column arrow is claiming one either.
      expect(screen.getByTestId('table-header-name').textContent).not.toContain('↑');
      expect(screen.getByTestId('table-header-name').textContent).not.toContain('↓');
    });
  }

  it('the note carries a hover title as well as a name', () => {
    renderTable('{"score":{"$meta":"textScore"}}', vi.fn());
    expect(note()?.getAttribute('title')).toBe('Sorted by a rule this header cannot show');
  });
});

/**
 * W15 §3.2 — the fourth silence, and the one this shipped with.
 *
 * `{"name":1}` maps perfectly, so `classifySort` called it `'mapped'` and the
 * gutter stayed quiet by design. Hide the `name` column and the arrow goes
 * with it: no arrow, no note, a header identical to an unsorted one — over
 * rows that are still sorted.
 *
 * The fixture is deliberately a *mappable* field with *other columns still
 * visible*. Both halves matter: an unmappable field would produce a note
 * either way, and hiding every column would empty the header for reasons of
 * its own. Neither would fail if the fix were reverted.
 */
describe('TableView — a sort on a hidden column (W15 §3.2)', () => {
  it('announces the sort when its only column is hidden', () => {
    renderTable('{"name":1}', vi.fn(), { hidden: ['name'] });

    // The repro: the arrow is gone with the column.
    expect(screen.queryByTestId('table-header-name')).toBeNull();
    expect(screen.getByTestId('table-header-age')).toBeTruthy();
    expect(
      screen.getByLabelText('Sorted by a hidden column — show it again to see the direction'),
    ).toBeTruthy();
  });

  it('goes quiet again as soon as the column comes back', () => {
    renderTable('{"name":1}', vi.fn(), { hidden: [] });
    expect(screen.getByTestId('table-header-name').textContent).toContain('↑');
    expect(screen.queryByTestId('table-header-sort-note')).toBeNull();
  });

  it('hiding one key of a two-key sort reports it as partly drawn', () => {
    renderTable('{"name":1,"age":-1}', vi.fn(), { hidden: ['name'] });
    expect(screen.getByTestId('table-header-age').textContent).toContain('↓');
    expect(
      screen.getByLabelText('Sorted — some of the sort fields cannot be shown in this header'),
    ).toBeTruthy();
  });

  // the defect this test guards against. `columns` are derived from the returned
  // documents, so a sort key the projection excluded is undrawn exactly like
  // a hidden one, and got "show it again" for a column `FieldsControl` — built
  // from that same derived list — does not list. Advice that cannot be
  // followed is the §3.2 defect class wearing a different hat.
  it('does not send the user to the chooser for a field the chooser has never heard of', () => {
    // `createdAt` is on no returned document: the projection excluded it.
    render(
      <CollectionWorkspaceProvider
        state={emptyState()}
        actions={emptyWorkspaceActions()}
        meta={emptyWorkspaceMeta()}
      >
        <TableView
          documents={[{ _id: '1', name: 'a' }, { _id: '2', name: 'b' }]}
          onColumnResize={vi.fn()}
          onSortField={vi.fn()}
          sort={'{"createdAt":-1}'}
        />
      </CollectionWorkspaceProvider>,
    );

    expect(screen.getByLabelText('Sorted by a field that is not one of these columns')).toBeTruthy();
    // Positively *and* negatively: the wrong advice must be gone, and the
    // absence of a note would satisfy only half of that.
    expect(
      screen.queryByLabelText('Sorted by a hidden column — show it again to see the direction'),
    ).toBeNull();
  });

  it('a genuinely hidden column keeps the actionable advice', () => {
    // The discriminator, from the other side: `name` *is* in the derived
    // schema, so unhiding really does bring the arrow back.
    renderTable('{"name":1}', vi.fn(), { hidden: ['name'] });
    expect(
      screen.getByLabelText('Sorted by a hidden column — show it again to see the direction'),
    ).toBeTruthy();
  });

  it('does not blame the column chooser for a sort no column could draw', () => {
    // `$meta` with every column visible is still `'unrepresentable'`. If the
    // two collapsed into one state, this user would be sent to unhide a
    // column that would not help.
    renderTable('{"score":{"$meta":"textScore"}}', vi.fn(), { hidden: [] });
    expect(screen.getByLabelText('Sorted by a rule this header cannot show')).toBeTruthy();
  });
});

/**
 * W15 §3.3 — `cycleSortField` replaces the whole sort on a header
 * click. With a multi-field sort live that silently destroys the other keys,
 * so the header's own tooltip says so and names where to compose one instead.
 */
describe('TableView — a header click owns up to replacing a multi-field sort', () => {
  it('warns while more than one field is sorted', () => {
    renderTable('{"name":1,"age":-1}', vi.fn());
    expect(screen.getByTestId('table-header-name').getAttribute('title')).toContain(
      'replaces the whole multi-field sort',
    );
  });

  it('stays quiet on a single-field sort, where there is nothing to lose', () => {
    renderTable('{"name":1}', vi.fn());
    expect(screen.getByTestId('table-header-age').getAttribute('title')).not.toContain(
      'replaces the whole',
    );
  });
});

/**
 * A column literally named `constructor` collides with `Object.prototype`.
 * `sortMap[col.field]` (a bare bracket read) resolves that name to the
 * inherited `Function` instead of `undefined`/`1`/`-1`, so the header would
 * draw neither arrow for an active ascending sort — a misread indistinguishable
 * from "not sorted" from the render alone.
 */
describe('TableView — a sort on a column named after an Object.prototype member', () => {
  function renderHostileColumn(sort: string) {
    return render(
      <CollectionWorkspaceProvider state={emptyState()} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
        <TableView
          documents={[
            { _id: '1', constructor: 'a' },
            { _id: '2', constructor: 'b' },
          ]}
          onColumnResize={vi.fn()}
          onSortField={vi.fn()}
          sort={sort}
        />
      </CollectionWorkspaceProvider>,
    );
  }

  it('renders the ascending indicator, not a misread blank state', () => {
    renderHostileColumn('{"constructor":1}');
    const header = screen.getByTestId('table-header-constructor');
    expect(header.textContent).toContain('↑');
  });

  it('renders the descending indicator', () => {
    renderHostileColumn('{"constructor":-1}');
    const header = screen.getByTestId('table-header-constructor');
    expect(header.textContent).toContain('↓');
  });

  it('renders no indicator when unsorted', () => {
    renderHostileColumn('');
    const header = screen.getByTestId('table-header-constructor');
    expect(header.textContent).not.toContain('↑');
    expect(header.textContent).not.toContain('↓');
  });
});

// S6848 — the resize handle is a drag-only affordance with no discrete
// click action, so its keyboard equivalent is arrow-key resize (the ARIA
// "window splitter" pattern) rather than an Enter/Space action.
describe('TableView — header column resize handle keyboard equivalent', () => {
  it('ArrowRight/ArrowLeft on the resize handle grow/shrink the column, clamped to the same 60px floor as the mouse drag', () => {
    const onColumnResize = vi.fn();
    render(
      <CollectionWorkspaceProvider state={emptyState()} actions={emptyWorkspaceActions()} meta={emptyWorkspaceMeta()}>
        <TableView
          documents={[{ _id: '1', name: 'a' }]}
          onColumnResize={onColumnResize}
          columns={{ name: { width: 65 } }}
        />
      </CollectionWorkspaceProvider>,
    );
    const handle = within(screen.getByTestId('table-header-name')).getByRole('separator');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onColumnResize).toHaveBeenCalledWith('name', 75);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onColumnResize).toHaveBeenCalledWith('name', 60); // clamped, not 55
  });
});
