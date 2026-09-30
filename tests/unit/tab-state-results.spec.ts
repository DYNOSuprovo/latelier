import { describe, it, expect } from 'vitest';
import { serializeTabState, stripResultFields } from '../../electron/services/tabStateResults';

describe('stripResultFields', () => {
  it('removes lastRun, lastResult, lastError and aggregation.lastRun, keeping everything else', () => {
    const out = stripResultFields({
      queryRaw: '{}',
      lastRunHasMore: true,
      totalCount: 7,
      lastRun: { documents: [1] },
      lastResult: { value: 1 },
      lastError: { code: 'X' },
      schema: { entries: [{ path: 'a' }] },
      aggregation: { stages: [1], dirty: true, lastRun: { rows: [1] } },
    });
    expect(out).toEqual({
      queryRaw: '{}',
      lastRunHasMore: true,
      totalCount: 7,
      schema: { entries: [{ path: 'a' }] },
      aggregation: { stages: [1], dirty: true },
    });
  });

  it('does not mutate its input, including the nested aggregation object', () => {
    const agg = { stages: [1], lastRun: { rows: [1] } };
    const input = { lastRun: { documents: [1] }, aggregation: agg };
    stripResultFields(input);
    expect(input.lastRun).toEqual({ documents: [1] });
    expect(input.aggregation).toBe(agg);
    expect(agg.lastRun).toEqual({ rows: [1] });
  });

  it('leaves a non-object aggregation value untouched', () => {
    expect(stripResultFields({ aggregation: 'x' })).toEqual({ aggregation: 'x' });
    expect(stripResultFields({ aggregation: null })).toEqual({ aggregation: null });
    expect(stripResultFields({ aggregation: [{ lastRun: 1 }] })).toEqual({
      aggregation: [{ lastRun: 1 }],
    });
  });

  it('keeps an aggregation object that has no lastRun as the same reference', () => {
    const agg = { stages: [] };
    expect(stripResultFields({ aggregation: agg }).aggregation).toBe(agg);
  });

  it('is idempotent', () => {
    const once = stripResultFields({ lastRun: 1, aggregation: { lastRun: 2, k: 3 } });
    expect(stripResultFields(once)).toEqual(once);
  });
});

describe('serializeTabState', () => {
  it('serializes the stripped state', () => {
    const json = serializeTabState({ page: 1, lastRun: { documents: [{ a: 1 }] } });
    expect(JSON.parse(json)).toEqual({ page: 1 });
    expect(json).not.toContain('documents');
  });
});
