import { describe, it, expect } from 'vitest';
import { carryResultFields, stripResultPatch } from '../../src/state/tabResultCarry';
import type {
  AggregationLastRun,
  AggregationTabState,
  CollectionTab,
  LastRun,
  ScriptTab,
} from '../../shared/types';

const now = '2026-04-21T12:00:00.000Z';
const run: LastRun = { documents: [{ a: 1 }], durationMs: 1, ranAt: now };
const aggRun: AggregationLastRun = {
  rows: [{ a: 1 }],
  durationMs: 1,
  ranAt: now,
  stageCounts: {},
  stageSamples: {},
};
const agg: AggregationTabState = { stages: [], activeStageId: null, outputHeight: 200, outputView: 'Tree' };

function coll(id: string, state: Partial<CollectionTab['state']> = {}): CollectionTab {
  return {
    id,
    kind: 'collection',
    connectionId: 'c',
    dbName: 'd',
    collection: 'x',
    position: 0,
    isActive: false,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      ...state,
    },
  };
}

function script(id: string, state: Partial<ScriptTab['state']> = {}): ScriptTab {
  return {
    id,
    kind: 'script',
    connectionId: 'c',
    dbName: '',
    collection: '',
    position: 0,
    isActive: false,
    openedAt: now,
    pinned: false,
    state: { title: 'T', source: '', ...state },
  };
}

describe('carryResultFields', () => {
  it('copies lastRun and aggregation.lastRun onto the listed collection tab with the same id', () => {
    const prev = [coll('a', { lastRun: run, aggregation: { ...agg, lastRun: aggRun } })];
    const next = [coll('a', { aggregation: agg, page: 3 })];
    const [out] = carryResultFields(prev, next) as CollectionTab[];
    expect(out!.state.lastRun).toBe(run);
    expect(out!.state.aggregation?.lastRun).toBe(aggRun);
    expect(out!.state.page).toBe(3);
    expect(next[0]!.state.lastRun).toBeUndefined();
  });

  it('carries only the aggregation run when the tab has no find run', () => {
    const prev = [coll('a', { aggregation: { ...agg, lastRun: aggRun } })];
    const [out] = carryResultFields(prev, [coll('a', { aggregation: agg })]) as CollectionTab[];
    expect('lastRun' in out!.state).toBe(false);
    expect(out!.state.aggregation?.lastRun).toBe(aggRun);
  });

  it('leaves the listed aggregation object as is when only the find run is carried', () => {
    const next = [coll('a', { aggregation: agg })];
    const [out] = carryResultFields([coll('a', { lastRun: run })], next) as CollectionTab[];
    expect(out!.state.lastRun).toBe(run);
    expect(out!.state.aggregation).toBe(agg);
  });

  it('does not invent an aggregation object the listed tab does not have', () => {
    const prev = [coll('a', { aggregation: { ...agg, lastRun: aggRun } })];
    const [out] = carryResultFields(prev, [coll('a')]) as CollectionTab[];
    expect(out!.state.aggregation).toBeUndefined();
  });

  it('copies lastResult and lastError onto a script tab', () => {
    const result = { valueJson: '[1]', printBuffer: '', durationMs: 1 };
    const err = { code: 'X', message: 'm' };
    const [a] = carryResultFields([script('s', { lastResult: result })], [script('s')]) as ScriptTab[];
    expect(a!.state.lastResult).toBe(result);
    expect('lastError' in a!.state).toBe(false);
    const [b] = carryResultFields([script('s', { lastError: err })], [script('s')]) as ScriptTab[];
    expect(b!.state.lastError).toBe(err);
    expect('lastResult' in b!.state).toBe(false);
  });

  it('returns tabs unchanged when the previous tab had no results, is absent, or changed kind', () => {
    const fresh = coll('a');
    expect(carryResultFields([coll('a')], [fresh])[0]).toBe(fresh);
    expect(carryResultFields([], [fresh])[0]).toBe(fresh);
    expect(carryResultFields([script('a', { lastError: { code: 'X', message: 'm' } })], [fresh])[0]).toBe(fresh);
    const s = script('a');
    expect(carryResultFields([coll('a', { lastRun: run })], [s])[0]).toBe(s);
    expect(carryResultFields([script('a')], [s])[0]).toBe(s);
  });

  it('drops tabs that are no longer listed and keeps the listed order', () => {
    const out = carryResultFields([coll('a', { lastRun: run }), coll('b', { lastRun: run })], [coll('b'), coll('c')]);
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
    expect((out[0] as CollectionTab).state.lastRun).toBe(run);
    expect((out[1] as CollectionTab).state.lastRun).toBeUndefined();
  });
});

describe('stripResultPatch', () => {
  it('removes result keys, including a nested aggregation.lastRun', () => {
    const patch = { page: 1, lastRun: run, lastResult: 1, lastError: 2, aggregation: { ...agg, lastRun: aggRun } };
    const out = stripResultPatch(patch);
    expect(out).toEqual({ page: 1, aggregation: agg });
    expect(patch.aggregation.lastRun).toBe(aggRun);
  });

  it('returns an empty object for a result-only patch', () => {
    expect(stripResultPatch({ lastRun: run })).toEqual({});
  });

  it('leaves a non-object aggregation value alone', () => {
    expect(stripResultPatch({ aggregation: null } as object)).toEqual({ aggregation: null });
  });
});
