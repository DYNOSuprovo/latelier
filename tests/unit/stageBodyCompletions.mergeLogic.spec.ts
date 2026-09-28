import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { FieldSuggestion, OperatorSuggestion } from '../../src/features/fieldSuggestions/types';

// `collectOptions` (stageBodyCompletions.ts) merges every KEY_POSITION_SOURCES
// batch by path (fields) / name (operators), and the merge preference rules
// (frequency sum, `existing.type ?? s.type`, `existing.offContext &&
// s.offContext`, `existing.description ?? s.description`, `existing.summary
// ?? s.summary`) only fire when two batches emit the SAME path/name — which
// the real DEFAULT_FIELD_SOURCES/operatorSource composition rarely does in a
// single deterministic way for a plain unit test. Mock both sources directly
// so each merge branch can be driven with values chosen to distinguish it
// from every neighboring mutant (e.g. `&&` vs `||`, `??` vs `&&`).

function fakeFieldSource(suggestions: FieldSuggestion[]) {
  return vi.fn(async () => suggestions);
}

function fakeOperatorSource(suggestions: OperatorSuggestion[]) {
  return vi.fn(async () => suggestions);
}

async function loadWithSources(
  fieldSources: ReturnType<typeof fakeFieldSource>[],
  operatorSrc: ReturnType<typeof fakeOperatorSource>,
) {
  vi.resetModules();
  vi.doMock('../../src/features/fieldSuggestions/sources', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../../src/features/fieldSuggestions/sources')>();
    return {
      ...actual,
      DEFAULT_FIELD_SOURCES: fieldSources,
      operatorSource: operatorSrc,
    };
  });
  const { stageBodyCompletionSource } = await import(
    '../../src/components/scriptEditor/stageBodyCompletions'
  );
  return stageBodyCompletionSource({
    getContext: () => ({ connectionId: 'c1', dbName: 'db', collection: 'users' }),
    getStageOp: () => '$match',
  });
}

function fakeCtx(doc: string, cursor: string = '█'): CompletionContext {
  const pos = doc.indexOf(cursor);
  if (pos < 0) throw new Error(`cursor token ${cursor} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + cursor.length);
  return {
    pos,
    state: { doc: { toString: () => stripped } },
  } as unknown as CompletionContext;
}

afterEach(() => {
  vi.doUnmock('../../src/features/fieldSuggestions/sources');
  vi.resetModules();
});

describe('stageBodyCompletionSource — field-merge branch (mocked field sources)', () => {
  it('sums frequency and prefers an existing defined type over a later undefined one', async () => {
    const source = await loadWithSources(
      [
        fakeFieldSource([{ kind: 'field', path: 'name', source: 'a', frequency: 3, type: 'string' }]),
        fakeFieldSource([{ kind: 'field', path: 'name', source: 'b', frequency: 2 }]),
      ],
      fakeOperatorSource([]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    const nameOption = result!.options.find((o) => o.label === 'name');
    // `existing.type ?? s.type`: the first batch's 'string' must survive
    // even though the second batch's entry has no type at all — an `&&`
    // mutant here would instead evaluate to the second (undefined) type.
    expect(nameOption).toEqual({ label: 'name', type: 'property', detail: 'string', boost: 0.1 });
  });

  it('falls back to a later type when the existing one is undefined', async () => {
    const source = await loadWithSources(
      [
        fakeFieldSource([{ kind: 'field', path: 'age', source: 'a', frequency: 1 }]),
        fakeFieldSource([{ kind: 'field', path: 'age', source: 'b', frequency: 1, type: 'number' }]),
      ],
      fakeOperatorSource([]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const ageOption = result!.options.find((o) => o.label === 'age');
    expect(ageOption).toEqual({ label: 'age', type: 'property', detail: 'number', boost: 0.04 });
  });

  it('clamps a summed frequency above 50 to a boost of 1', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([{ kind: 'field', path: 'huge', source: 'a', frequency: 80 }])],
      fakeOperatorSource([]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const hugeOption = result!.options.find((o) => o.label === 'huge');
    expect(hugeOption!.boost).toBe(1);
  });

  it('treats a missing frequency as 0', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([{ kind: 'field', path: 'noFreq', source: 'a' }])],
      fakeOperatorSource([]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const option = result!.options.find((o) => o.label === 'noFreq');
    expect(option!.boost).toBe(0);
  });
});

describe('stageBodyCompletionSource — operator completion shape (mocked operator source, no duplicates)', () => {
  it('surfaces a summary as info when there is no description', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$onlySummary', class: 'query', summary: 'has summary', source: 'a' },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$onlySummary');
    expect(op).toEqual({
      label: '$onlySummary',
      type: 'keyword',
      detail: 'query',
      info: 'has summary',
      boost: 1,
    });
  });

  it('falls back to description as info when there is no summary', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        {
          kind: 'operator',
          name: '$onlyDescription',
          class: 'evaluation',
          description: 'has description',
          source: 'a',
        },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$onlyDescription');
    expect(op).toEqual({
      label: '$onlyDescription',
      type: 'keyword',
      detail: 'evaluation',
      info: 'has description',
      boost: 1,
    });
  });

  it('leaves info undefined when neither summary nor description is set', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([{ kind: 'operator', name: '$bare', class: 'stage', source: 'a' }]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$bare');
    expect(op).toEqual({ label: '$bare', type: 'keyword', detail: 'stage', info: undefined, boost: 1 });
  });

  it('boosts an off-context operator to -1', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$off', class: 'query', source: 'a', offContext: true },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$off');
    expect(op!.boost).toBe(-1);
  });
});

describe('stageBodyCompletionSource — operator-merge branch (duplicate names)', () => {
  it('is off-context only when EVERY duplicate entry is off-context (AND, not OR)', async () => {
    // existing.offContext=true, s.offContext=false → real (&&) is false
    // (on-context, boost 1). An `||` mutant would instead yield true.
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$dup', class: 'query', source: 'a', offContext: true },
        { kind: 'operator', name: '$dup', class: 'expression', source: 'b', offContext: false },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$dup');
    expect(op!.boost).toBe(1);
  });

  it('is off-context when both duplicate entries are off-context', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$dup2', class: 'query', source: 'a', offContext: true },
        { kind: 'operator', name: '$dup2', class: 'expression', source: 'b', offContext: true },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$dup2');
    expect(op!.boost).toBe(-1);
  });

  it('keeps the first description and does not let a later description win (?? not &&)', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$descDup', class: 'query', source: 'a', description: 'first' },
        { kind: 'operator', name: '$descDup', class: 'expression', source: 'b', description: 'second' },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$descDup');
    expect(op!.info).toBe('first');
  });

  it('takes the second description when the first has none', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$descDup2', class: 'query', source: 'a' },
        { kind: 'operator', name: '$descDup2', class: 'expression', source: 'b', description: 'second' },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$descDup2');
    expect(op!.info).toBe('second');
  });

  it('keeps the first summary and does not let a later summary win (?? not &&)', async () => {
    const source = await loadWithSources(
      [fakeFieldSource([])],
      fakeOperatorSource([
        { kind: 'operator', name: '$sumDup', class: 'query', source: 'a', summary: 'firstSum' },
        { kind: 'operator', name: '$sumDup', class: 'expression', source: 'b', summary: 'secondSum' },
      ]),
    );
    const result = (await source(fakeCtx('{ █ }'))) as CompletionResult | null;
    const op = result!.options.find((o) => o.label === '$sumDup');
    expect(op!.info).toBe('firstSum');
  });
});

describe('stageBodyCompletionSource — empty result', () => {
  it('returns null when every source resolves with no suggestions', async () => {
    const source = await loadWithSources([fakeFieldSource([])], fakeOperatorSource([]));
    const result = await source(fakeCtx('{ █ }'));
    expect(result).toBeNull();
  });
});

