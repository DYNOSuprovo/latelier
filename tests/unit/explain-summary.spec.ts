import { describe, it, expect } from 'vitest';
import { summarizeExplain } from '../../src/utils/explainSummary';

describe('summarizeExplain', () => {
  it('(a) find COLLSCAN → collscan:true, usesIndex:false', () => {
    const plan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
    expect(summary?.collscan).toBe(true);
    expect(summary?.usesIndex).toBe(false);
    expect(summary?.indexName).toBeUndefined();
  });

  it('(b) find IXSCAN → usesIndex:true + indexName/keyPattern', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'FETCH',
          inputStage: {
            stage: 'IXSCAN',
            indexName: 'email_1',
            keyPattern: { email: 1 },
          },
        },
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.collscan).toBe(false);
    expect(summary?.usesIndex).toBe(true);
    expect(summary?.indexName).toBe('email_1');
    expect(summary?.keyPattern).toEqual({ email: 1 });
  });

  it('(c) aggregation {stages:[{$cursor:{queryPlanner:…}}]} → normalized stage chain', () => {
    const plan = {
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
          },
        },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
    expect(summary?.collscan).toBe(true);
  });

  it('(d) executionStats present → metric fields populated', () => {
    const plan = {
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 100,
        totalKeysExamined: 0,
        executionTimeMillis: 12,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBe(5);
    expect(summary?.docsExamined).toBe(100);
    expect(summary?.keysExamined).toBe(0);
    expect(summary?.executionTimeMillis).toBe(12);
  });

  it('(d2) executionStats nested under aggregation $cursor → metric fields populated', () => {
    const plan = {
      stages: [
        {
          $cursor: {
            queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
            executionStats: {
              nReturned: 3,
              totalDocsExamined: 3,
              totalKeysExamined: 0,
              executionTimeMillis: 1,
            },
          },
        },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBe(3);
    expect(summary?.docsExamined).toBe(3);
  });

  it('(e) queryPlanner-only → metrics undefined', () => {
    const plan = { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBeUndefined();
    expect(summary?.docsExamined).toBeUndefined();
    expect(summary?.keysExamined).toBeUndefined();
    expect(summary?.executionTimeMillis).toBeUndefined();
  });

  it('(f) sharded shards[] → does not crash, extracts what it can', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'SINGLE_SHARD',
          shards: [
            {
              shardName: 'shard01',
              winningPlan: {
                stage: 'FETCH',
                inputStage: {
                  stage: 'IXSCAN',
                  indexName: 'a_1',
                  keyPattern: { a: 1 },
                },
              },
            },
          ],
        },
      },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 5,
        totalKeysExamined: 5,
        executionTimeMillis: 12,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.usesIndex).toBe(true);
    expect(summary?.indexName).toBe('a_1');
    expect(summary?.nReturned).toBe(5);
  });

  it('(g) SBE / queryPlan-nested → no crash', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'FETCH',
            inputStage: {
              stage: 'IXSCAN',
              indexName: 'x_1',
              keyPattern: { x: 1 },
            },
          },
          slotBasedPlan: { stages: 'irrelevant string form' },
        },
      },
      executionStats: {
        nReturned: 1,
        totalDocsExamined: 1,
        totalKeysExamined: 1,
        executionTimeMillis: 0,
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['FETCH', 'IXSCAN']);
    expect(summary?.indexName).toBe('x_1');
  });

  it('(h) unknown/empty {} → null', () => {
    expect(summarizeExplain({})).toBeNull();
  });

  it('(h) unrecognized shape → null', () => {
    expect(summarizeExplain({ weird: 1 })).toBeNull();
  });

  it('(h) non-object → null', () => {
    expect(summarizeExplain(null)).toBeNull();
    expect(summarizeExplain(undefined)).toBeNull();
    expect(summarizeExplain(42)).toBeNull();
    expect(summarizeExplain('foo')).toBeNull();
    expect(summarizeExplain([1, 2, 3])).toBeNull();
  });

  it('(i) inputStages[] fallback is only used when inputStage is absent, and only its first element is read', () => {
    // No `inputStage`, so nextStage must fall through to the `inputStages`
    // array branch — and it must actually return element 0, not skip it.
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'A', inputStages: [{ stage: 'B' }] },
      },
    };
    expect(summarizeExplain(plan)?.stages).toEqual(['A', 'B']);
  });

  it('(j) a stage node with no `stage` string of its own contributes nothing to the chain', () => {
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'A', inputStage: { indexName: 'no-stage-field' } },
      },
    };
    // The inner node has no `.stage` string, so it must not appear (not even
    // as `undefined`) in the collected chain.
    expect(summarizeExplain(plan)?.stages).toEqual(['A']);
  });

  it('(k) IXSCAN indexName is only read when it is actually a string', () => {
    const plan = {
      queryPlanner: {
        winningPlan: { stage: 'IXSCAN', indexName: 42, keyPattern: { a: 1 } },
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.indexName).toBeUndefined();
    expect(summary?.keyPattern).toEqual({ a: 1 });
  });

  it('(l) the aggregation $cursor lookup skips a non-cursor entry ahead of the real one', () => {
    const plan = {
      stages: [
        { tag: 'noise' },
        { $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } },
      ],
    };
    const summary = summarizeExplain(plan);
    expect(summary).not.toBeNull();
    expect(summary?.stages).toEqual(['COLLSCAN']);
  });

  it('(m) an aggregation stages[] with no $cursor entry at all → null, not a crash', () => {
    expect(summarizeExplain({ stages: [{ tag: 'noise' }] })).toBeNull();
  });

  it('(n) a non-record queryPlanner (e.g. carrying its own stray winningPlan property) is rejected, not read through', () => {
    const fakeQueryPlanner = (() => undefined) as unknown as Record<string, unknown> & {
      winningPlan?: unknown;
    };
    fakeQueryPlanner.winningPlan = { stage: 'IXSCAN', indexName: 'ghost_1' };
    expect(summarizeExplain({ queryPlanner: fakeQueryPlanner })).toBeNull();
  });

  it('(o) a winning plan with no recognizable `stage` anywhere in its chain → null', () => {
    expect(summarizeExplain({ queryPlanner: { winningPlan: { foo: 1 } } })).toBeNull();
  });

  it('(p) executionStats fields are only copied when they are actually numbers', () => {
    const plan = {
      queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
      executionStats: {
        nReturned: 'five',
        totalDocsExamined: 'lots',
        totalKeysExamined: 'none',
        executionTimeMillis: 'slow',
      },
    };
    const summary = summarizeExplain(plan);
    expect(summary?.nReturned).toBeUndefined();
    expect(summary?.docsExamined).toBeUndefined();
    expect(summary?.keysExamined).toBeUndefined();
    expect(summary?.executionTimeMillis).toBeUndefined();
  });

  it('(q) a sharded winningPlan with a non-array shards holder is not treated as shards[]', () => {
    // `shards` here is array-*like* (has a numeric '0' key) but is not a real
    // array, so `Array.isArray` must reject it — isolates that guard from the
    // `isRecord(shard0) && isRecord(shard0.winningPlan)` check just below it.
    const winningPlan: Record<string, unknown> = { stage: 'FETCH' };
    (winningPlan as Record<string, unknown>).shards = {
      0: { winningPlan: { stage: 'IXSCAN', indexName: 'z_1' } },
    };
    const summary = summarizeExplain({ queryPlanner: { winningPlan } });
    expect(summary?.stages).toEqual(['FETCH']);
    expect(summary?.usesIndex).toBe(false);
  });

  it('(q2) a non-record winningPlan (e.g. carrying its own stray queryPlan property) is rejected before the SBE-nesting check ever sees it', () => {
    const rootPlan = (() => undefined) as unknown as Record<string, unknown> & {
      queryPlan?: unknown;
    };
    rootPlan.queryPlan = { stage: 'IXSCAN', indexName: 'y_1' };
    expect(summarizeExplain({ queryPlanner: { winningPlan: rootPlan } })).toBeNull();
  });

  it('(r) shards[0] is only followed when it is a record whose own winningPlan is also a record', () => {
    const plan = {
      queryPlanner: {
        winningPlan: {
          stage: 'FETCH',
          shards: [{ shardName: 'shard0', winningPlan: 'not-a-record' }],
        },
      },
    };
    // shard0.winningPlan fails isRecord, so the outer winningPlan must be left
    // alone — not replaced by the string.
    expect(summarizeExplain(plan)?.stages).toEqual(['FETCH']);
  });
});
