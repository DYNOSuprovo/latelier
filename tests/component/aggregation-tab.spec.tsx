import React from 'react';
import type { IpcApi } from '@shared/ipc';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import { DarkCtx } from '../../src/ThemeContext';
import { AggregationTab } from '../../src/pages/Workspace/Aggregation/AggregationTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import type { AggregationTabState, AggStagePreview } from '@shared/types';

/**
 * Unlike `renderTab` below (a static `state` prop + a noop `onPatch` spy —
 * fine for smoke tests), T2.1's stale/write-warning coverage needs
 * `onChangeOp` -> `onPatch` -> `setOp` to actually flow back into rendered
 * props, since the DOM only reflects `state.stages` as owned by this
 * wrapper's own `useState`.
 */
function renderStatefulTab(initial: AggregationTabState) {
  function StatefulTab() {
    const [state, setState] = React.useState<AggregationTabState>(initial);
    const onPatch = (patch: Partial<AggregationTabState>) =>
      setState((s) => ({ ...s, ...patch }));
    return (
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={state}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>
    );
  }
  return render(<StatefulTab />);
}

function opTrigger(index = 1) {
  return screen.getByRole('button', {
    name: new RegExp(`Change operator for stage ${index}`),
  });
}

function optionFor(op: string) {
  const opt = screen.getAllByRole('option').find((el) => el.textContent?.startsWith(op));
  if (!opt) throw new Error(`no option found starting with ${op}`);
  return opt;
}

beforeEach(() => installAtelierMock());
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderTab(state: AggregationTabState = DEFAULT_AGGREGATION_TAB_STATE) {
  const onPatch = vi.fn();
  const result = render(
    <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={state}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
    </DarkCtx.Provider>,
  );
  return { ...result, onPatch };
}

/**
 * P1-12 smoke coverage for AggregationTab. Verifies the component mounts
 * with empty + populated pipelines and renders the OutputPanel + StageAccordion
 * subtrees. Deeper interaction coverage lives in those components' own
 * spec files.
 */
describe('AggregationTab — smoke', () => {
  it('mounts with the default empty pipeline state', () => {
    const { container } = renderTab();
    expect(container.textContent).toContain('orders');
    expect(container.textContent).toContain('Pipeline output');
  });

  it('renders existing stages from state', () => {
    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [
        { id: 1, op: '$match', body: '{ status: "active" }', enabled: true },
        { id: 2, op: '$limit', body: '10', enabled: true },
      ],
    };
    const { container } = renderTab(state);
    expect(container.textContent).toContain('$match');
    expect(container.textContent).toContain('$limit');
  });

  /**
   * Regression guard for the ExplainDrawer prop-shape refactor (X-Ticket
   * 98 / T0.1): Aggregation's Explain flow must still call api.agg.explain
   * with stages/verbosity/cancelToken and surface writeStageOmitted, exactly
   * as before the drawer was generalized to accept an injected fetcher.
   */
  it('Explain still calls api.agg.explain with stages/verbosity/cancelToken', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: true,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderTab(state);

    const explainBtn = await screen.findByRole('button', { name: 'Explain' });
    fireEvent.click(explainBtn);

    await waitFor(() => {
      expect(explainSpy).toHaveBeenCalledTimes(1);
    });
    const args = explainSpy.mock.calls[0]?.[0];
    expect(args?.stages).toEqual(state.stages);
    expect(args?.verbosity).toBe('queryPlanner');
    expect(typeof args?.cancelToken).toBe('string');

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => {
      expect(dialog.textContent).toContain('Stages with write ops were omitted');
    });
  });

  // W16 Tier 4 acceptance: "a COLLSCAN explain for a find shows the action;
  // an aggregation explain does not". AggregationTab passes no
  // `onCreateIndex` to ExplainDrawer — only a find has a filter
  // `suggestIndex` can read — so the button must never render here, even on
  // a COLLSCAN with an otherwise-identical summary strip to the find case.
  it('a COLLSCAN explain shows no "Create an index for this query" action', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: false,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderTab(state);

    fireEvent.click(await screen.findByRole('button', { name: 'Explain' }));

    const dialog = await screen.findByRole('dialog', { name: 'Explain plan' });
    await waitFor(() => expect(dialog.textContent).toContain('COLLSCAN'));
    expect(screen.queryByTestId('explain-create-index')).toBeNull();
  });
});

/**
 * T2.1 — the stage op is now editable in place, which raises the primary
 * correctness risk: the run/stale signature used to be keyed on `body`
 * alone (AggregationTab.tsx:74,164), so an op-only change would silently
 * keep reading as "fresh". These tests drive a real op change through a
 * stateful onPatch to prove the fix (stageSig, keyed on op+body).
 */
describe('AggregationTab — editable stage operator (T2.1)', () => {
  it('AC6: changing a stage op after a run marks it stale even though its body is unchanged', async () => {
    const runSpy = vi.fn(async () => ({
      rows: [],
      durationMs: 5,
      stageCounts: { 1: 10 },
      stageSamples: { 1: [] },
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    const { container } = renderStatefulTab(state);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('10').length).toBeGreaterThan(0));

    // Freshly run: no stale marker yet.
    expect(container.querySelector('[title="Stale (edited since last run)"]')).toBeNull();

    // Change the op only — body is untouched.
    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$sort'));

    await waitFor(() => {
      expect(container.querySelector('[title="Stale (edited since last run)"]')).not.toBeNull();
    });
  });

  it('AC5: changing a stage op to $out shows the write-warning strip; changing away hides it', async () => {
    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
    };
    renderStatefulTab(state);

    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$out'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This stage writes to MongoDB');

    fireEvent.click(opTrigger());
    fireEvent.click(optionFor('$match'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

/**
 * N0.4 — per-stage aggregation preview has no in-flight guard: firing
 * "Run to here" twice for the same stage in quick succession used to let
 * whichever `previewUpToStage` response landed LAST win, even if it was the
 * older (first) call resolving after the newer (second) one. This is a
 * SAME-STAGE race — a monotonic per-stage token must drop the stale
 * response. The cross-stage case (two different stages resolving
 * back-to-back) is a separate, pre-existing, out-of-scope issue.
 */
describe('AggregationTab — per-stage preview race guard (N0.4)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('drops a stale (older) preview response when a newer call for the same stage resolves first', async () => {
    const deferreds: ReturnType<typeof deferred<AggStagePreview>>[] = [];
    const previewSpy = vi.fn(() => {
      const d = deferred<AggStagePreview>();
      deferreds.push(d);
      return d.promise;
    });
    installAtelierMock({
      agg: { previewUpToStage: previewSpy, cancel: async () => undefined },
    });

    const state: AggregationTabState = {
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: [{ id: 1, op: '$match', body: '{}', enabled: true }],
      activeStageId: 1,
    };
    renderStatefulTab(state);

    const runToHereBtn = await screen.findByRole('button', { name: 'Run to here' });

    // Fire "Run to here" twice for the SAME stage — tokens 1 and 2. Both
    // dispatches are wrapped in a single outer `act()` so React's automatic
    // batching defers the re-render (and thus the button's `disabled`
    // attribute) until after both clicks land — otherwise the in-flight
    // guard's own disabled-button UX would mask the underlying race this
    // test exists to catch (a real double-click can still beat a render).
    act(() => {
      fireEvent.click(runToHereBtn);
      fireEvent.click(runToHereBtn);
    });

    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2));

    const sampleA = [{ marker: 'STALE_TOKEN_1' }];
    const sampleB = [{ marker: 'FRESH_TOKEN_2' }];

    // Resolve the NEWER call (token 2) first...
    deferreds[1].resolve({ stageId: 1, count: 222, sample: sampleB });
    await waitFor(() => {
      expect(screen.getByText(/FRESH_TOKEN_2/)).toBeTruthy();
    });

    // ...then resolve the OLDER call (token 1). Without the token guard this
    // clobbers the freshly-committed newer preview with stale data.
    deferreds[0].resolve({ stageId: 1, count: 111, sample: sampleA });

    // Flush microtasks so a (buggy) unconditional commit would have applied.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(/STALE_TOKEN_1/)).toBeNull();
    expect(screen.getByText(/FRESH_TOKEN_2/)).toBeTruthy();
  });
});

/**
 * X14 §4 — a stage the user never clicked into has never blurred,
 * so the editor's own repair never fired. `addStage` writes a Shell Syntax
 * template straight into state and the validator now passes it, which is
 * exactly how Run and Explain become enabled on text `ejsonParse` would refuse
 * in the main process. Deliberately no `fireEvent.blur` anywhere below.
 */
describe('AggregationTab — Shell Syntax on the button-less run paths (X14 §4)', () => {
  const SHELL_STAGES: AggregationTabState['stages'] = [
    { id: 1, op: '$group', body: '{\n  _id: "$field",\n  count: { $sum: 1 }\n}', enabled: true },
    { id: 2, op: '$sort', body: '{ field: 1 }', enabled: true },
  ];
  const CANONICAL = [
    '{\n  "_id": "$field",\n  "count": { "$sum": 1 }\n}',
    '{ "field": 1 }',
  ];

  it('Run repairs every stage body before it crosses IPC, with no editor blur', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES });

    const runBtn = screen.getByRole('button', { name: 'Run' });
    expect(runBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(runBtn);

    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    expect(runSpy.mock.calls[0]![0].stages.map((s) => s.body)).toEqual(CANONICAL);
    // The line count and per-line indentation of the multi-line body survive
    // the trip — a reprint would flatten them, and no shape check would notice.
    const first = runSpy.mock.calls[0]![0].stages[0]!.body;
    expect(first.split('\n')).toHaveLength(4);
    expect(first.split('\n').map((l) => /^[ \t]*/.exec(l)![0])).toEqual(['', '  ', '  ', '']);
  });

  it('Explain repairs every stage body before it crosses IPC, with no editor blur', async () => {
    const explainSpy = vi.fn<IpcApi['agg']['explain']>(async () => ({
      plan: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
      verbosity: 'queryPlanner',
      writeStageOmitted: false,
    }));
    installAtelierMock({ agg: { explain: explainSpy, cancel: async () => undefined } });

    renderStatefulTab({ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES });

    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));

    await waitFor(() => expect(explainSpy).toHaveBeenCalledTimes(1));
    expect(explainSpy.mock.calls[0]![0].stages.map((s) => s.body)).toEqual(CANONICAL);
  });

  it('the repaired bodies are written back into the tab state, not only sent', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const onPatch = vi.fn();
    render(
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={{ ...DEFAULT_AGGREGATION_TAB_STATE, stages: SHELL_STAGES }}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    const patched = onPatch.mock.calls
      .map(([p]) => p as Partial<AggregationTabState>)
      .find((p) => p.stages);
    expect(patched?.stages?.map((s) => s.body)).toEqual(CANONICAL);
  });

  it('leaves stages that are already Canonical EJSON untouched — no patch at all', async () => {
    const runSpy = vi.fn<IpcApi['agg']['run']>(async () => ({
      rows: [],
      durationMs: 1,
      stageCounts: {},
      stageSamples: {},
      hasMore: false,
    }));
    installAtelierMock({ agg: { run: runSpy, cancel: async () => undefined } });

    const stages: AggregationTabState['stages'] = [
      { id: 1, op: '$match', body: '{ "a"  : 1 }', enabled: true },
    ];
    const onPatch = vi.fn();
    render(
      <DarkCtx.Provider value={false}>
        <AggregationTab
          connectionId="c1"
          dbName="app"
          collection="orders"
          state={{ ...DEFAULT_AGGREGATION_TAB_STATE, stages }}
          darkMode={false}
          sourceCount={42}
          onPatch={onPatch}
        />
      </DarkCtx.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));

    expect(runSpy.mock.calls[0]![0].stages).toEqual(stages);
    expect(onPatch.mock.calls.some(([p]) => (p as Partial<AggregationTabState>).stages)).toBe(false);
  });

  // Save is the last path that reads `stages` without a blur first.
  // Reached from the command palette, nothing focuses the editor, so this
  // whole block deliberately never calls `fireEvent.blur`: a test that blurs
  // cannot see the bug.
  it('Save persists repaired bodies, with no editor blur', async () => {
    const updateSpy = vi.fn<IpcApi['saved']['update']>(async () => ({
      id: 's1',
      connectionId: 'c1',
      name: 'p',
      dbName: 'app',
      collection: 'orders',
      kind: 'aggregation',
      payload: { kind: 'aggregation', stages: [] },
      createdAt: '',
      updatedAt: '',
    }));
    installAtelierMock({ saved: { update: updateSpy } });

    renderStatefulTab({
      ...DEFAULT_AGGREGATION_TAB_STATE,
      stages: SHELL_STAGES,
      savedId: 's1',
      name: 'p',
      dirty: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const payload = updateSpy.mock.calls[0]![0].patch.payload;
    if (payload?.kind !== 'aggregation') throw new Error('expected an aggregation payload');
    expect(payload.stages.map((s) => s.body)).toEqual(CANONICAL);
  });

  // docs/adr/0013 — stage delete is local editor state: no confirm, an Undo
  // toast instead. `renderStatefulTab`, not `renderTab`: the restore has to
  // round-trip through `onPatch` and come back as props for the accordion to
  // show the stage again.
  describe('remove stage — Undo toast (docs/adr/0013)', () => {
    function opAt(index: number) {
      return screen.getByRole('button', {
        name: new RegExp(`Change operator for stage ${index + 1} \\(currently \\$`),
      }).getAttribute('aria-label');
    }

    it('restores the removed stage at its index', async () => {
      renderStatefulTab({
        ...DEFAULT_AGGREGATION_TAB_STATE,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$sort', body: '{}', enabled: true },
        ],
      });

      expect(opAt(0)).toMatch(/\$match/);
      expect(opAt(1)).toMatch(/\$sort/);

      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]!);

      // $match is gone; $sort shifted up to index 0.
      expect(opAt(0)).toMatch(/\$sort/);
      expect(screen.queryByRole('button', { name: 'Change operator for stage 2 (currently $sort)' })).toBeNull();

      const undo = await screen.findByRole('button', { name: 'Undo' });
      fireEvent.click(undo);

      await waitFor(() => expect(opAt(0)).toMatch(/\$match/));
      expect(opAt(1)).toMatch(/\$sort/);
    });

    /**
     * MUTATION TARGET — drop the `index` argument in `onRemoveStage`'s Undo
     * `onClick` (always restore at 0, say) and this goes red: $limit ends up
     * first instead of last.
     */
    it('a second delete replaces the first toast\'s Undo target', async () => {
      renderStatefulTab({
        ...DEFAULT_AGGREGATION_TAB_STATE,
        stages: [
          { id: 1, op: '$match', body: '{}', enabled: true },
          { id: 2, op: '$sort', body: '{}', enabled: true },
          { id: 3, op: '$limit', body: '5', enabled: true },
        ],
      });

      // Remove $match (index 0).
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]!);
      await screen.findByRole('button', { name: 'Undo' });

      // Remove what is now index 1 ($limit) — only one Undo toast survives.
      // A non-zero index matters here: restoring at 0 instead of the
      // captured index would put $limit first instead of last.
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[1]!);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      // $limit came back at the end, not at 0; $match stays gone.
      await waitFor(() => expect(opAt(1)).toMatch(/\$limit/));
      expect(opAt(0)).toMatch(/\$sort/);
      expect(screen.queryByRole('button', { name: /currently \$match\)/ })).toBeNull();
    });
  });
});
