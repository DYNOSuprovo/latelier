import { describe, it, expect, vi } from 'vitest';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { FieldSuggestion } from '../../src/features/fieldSuggestions/types';
import { stageBodyCompletionSource } from '../../src/components/scriptEditor/stageBodyCompletions';

// `stageBodyCompletionSource` composes `DEFAULT_FIELD_SOURCES` (lastRun +
// sampleSchema) with `operatorSource` — the same `KEY_POSITION_SOURCES` mix
// `useTextareaAutocomplete` used, so the ranking the textarea had is
// preserved. Swap `DEFAULT_FIELD_SOURCES` for a single deterministic fake so
// the field-completion assertions don't depend on the (network-backed)
// `sampleSchemaSource`; keep the real `operatorSource` + `OPERATORS` catalog
// so the operator-context assertions exercise real `validIn` data.
const { fakeFieldSource } = vi.hoisted(() => ({
  fakeFieldSource: vi.fn(
    async (): Promise<FieldSuggestion[]> => [
      { kind: 'field' as const, path: 'name', source: 'fake', frequency: 5 },
      { kind: 'field' as const, path: 'age', source: 'fake', frequency: 1 },
    ],
  ),
}));

vi.mock('../../src/features/fieldSuggestions/sources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/features/fieldSuggestions/sources')>();
  return {
    ...actual,
    DEFAULT_FIELD_SOURCES: [fakeFieldSource],
  };
});

/**
 * The source only reads `state.doc` and `pos` off CompletionContext — build
 * the smallest stub that satisfies that surface (mirrors the fakeCtx used in
 * script-mongo-completions.spec.ts, minus `matchBefore`, which this source
 * never calls).
 */
function fakeCtx(doc: string, cursor: string = '█'): CompletionContext {
  const pos = doc.indexOf(cursor);
  if (pos < 0) throw new Error(`cursor token ${cursor} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + cursor.length);
  return {
    pos,
    state: { doc: { toString: () => stripped } },
  } as unknown as CompletionContext;
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? [];
}

function boostOf(result: CompletionResult | null, label: string): number | undefined {
  return result?.options.find((o) => o.label === label)?.boost;
}

describe('stageBodyCompletionSource', () => {
  it('returns field completions from the sampled schema source at a field-key position', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
    expect(result!.from).toBe('{ '.length);
    expect(result!.to).toBe('{ '.length);
  });

  it('ranks a match-only operator ahead of a group-only accumulator for a $match stage', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['$exists', '$sum']));
    // $exists is valid only at `matchKey`; $sum is a `$group`-only
    // accumulator — it should rank behind $exists once the caret's
    // operatorContext is 'matchKey'.
    expect(boostOf(result, '$exists')!).toBeGreaterThan(boostOf(result, '$sum')!);
  });

  it('flips the ranking for a $group accumulator-value position', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$group',
    });

    // Depth 2 ("total: { █ }") is the accumulator-value slot inside $group,
    // which `detectAggGrammar` tags with the `groupValue` operator context.
    const result = (await source(
      fakeCtx('{ _id: null, total: { █ } }'),
    )) as CompletionResult | null;

    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['$exists', '$sum']));
    expect(boostOf(result, '$sum')!).toBeGreaterThan(boostOf(result, '$exists')!);
  });

  it('returns null when there is no field-key grammar hit (caret in a value slot)', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ name: █ }'));
    expect(result).toBeNull();
  });

  it('returns null when there is no active connection/db context', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => null,
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ █ }'));
    expect(result).toBeNull();
  });

  it('returns null on a fieldRef grammar hit ($-prefixed string value)', async () => {
    // `detectAggGrammar` returns a truthy hit here (kind: 'fieldRef', not
    // 'fieldName') — distinct from the "no hit at all" case above. Only the
    // `hit.kind !== 'fieldName'` half of the guard rejects it.
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = await source(fakeCtx('{ status: "$█" }'));
    expect(result).toBeNull();
  });

  it('uses the quote-safe validFor when completing an already-quoted key', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ "na█" }'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.validFor).toEqual(/^[^"'\n]*$/);
  });

  it('uses the bare-identifier validFor when completing an unquoted key', async () => {
    const source = stageBodyCompletionSource({
      getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
      getStageOp: () => '$match',
    });

    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.validFor).toEqual(/^[\w$.]*$/);
  });
});
