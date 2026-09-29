import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

// `OPERATOR_COMPLETIONS` (mongoCompletions.ts) collapses the OPERATORS
// catalog by name at module-load time, preferring whichever duplicate entry
// carries a `description`. The real OPERATORS catalog doesn't currently
// have a duplicate pair exercising every branch of that preference logic,
// so it's tested here against a synthetic catalog instead. Because the
// dedup runs once at import time, each scenario needs its own fresh module
// instance (`vi.resetModules` + dynamic `import()`) with its own mock.

function fakeCtx(line: string): CompletionContext {
  const pos = line.length;
  return {
    pos,
    explicit: false,
    matchBefore(re: RegExp) {
      const sticky = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let match: RegExpExecArray | null = null;
      let probe: RegExpExecArray | null;
      sticky.lastIndex = 0;
      while ((probe = sticky.exec(line))) {
        if (probe.index + probe[0].length === pos) match = probe;
        if (probe.index === sticky.lastIndex) sticky.lastIndex++;
      }
      if (!match || match[0].length === 0) return null;
      return { from: match.index, to: match.index + match[0].length, text: match[0] };
    },
  } as unknown as CompletionContext;
}

async function loadWithOperators(
  operators: ReadonlyArray<{ name: string; class: string; summary?: string; description?: string }>,
) {
  vi.resetModules();
  vi.doMock('../../src/features/fieldSuggestions/operators', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../../src/features/fieldSuggestions/operators')>();
    return { ...actual, OPERATORS: operators };
  });
  const { mongoCompletionSource } = await import(
    '../../src/components/scriptEditor/mongoCompletions'
  );
  return mongoCompletionSource({ getCollections: () => [] });
}

describe('OPERATOR_COMPLETIONS dedup (mocked OPERATORS catalog)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/features/fieldSuggestions/operators');
    vi.resetModules();
  });

  it('collapses duplicates and prefers the entry with a description when it comes second', async () => {
    const source = await loadWithOperators([
      { name: '$dup', class: 'query', summary: 'first summary, no description' },
      { name: '$dup', class: 'evaluation', description: 'second entry has a description' },
      { name: '$onlyOnce', class: 'logical', summary: 'appears once' },
    ]);
    const result = source(fakeCtx('$')) as CompletionResult | null;
    expect(result).not.toBeNull();
    const names = result!.options.map((o) => o.label);
    expect(names.filter((n) => n === '$dup')).toHaveLength(1);
    expect(result!.options.find((o) => o.label === '$dup')).toEqual({
      label: '$dup',
      type: 'keyword',
      detail: 'evaluation',
      info: 'second entry has a description',
    });
    expect(result!.options.find((o) => o.label === '$onlyOnce')).toEqual({
      label: '$onlyOnce',
      type: 'keyword',
      detail: 'logical',
      info: 'appears once',
    });
  });

  it('keeps the first entry when it already has a description and the second does not', async () => {
    // Distinguishes the guard from an "always take the latest" bug: without
    // the `!existing.description` check, this would wrongly drop the first
    // entry's description for the second (description-less) one.
    const source = await loadWithOperators([
      { name: '$dup', class: 'query', description: 'first entry has a description' },
      { name: '$dup', class: 'evaluation', summary: 'second summary, no description' },
    ]);
    const result = source(fakeCtx('$')) as CompletionResult | null;
    expect(result!.options.find((o) => o.label === '$dup')).toEqual({
      label: '$dup',
      type: 'keyword',
      detail: 'query',
      info: 'first entry has a description',
    });
  });

  it('keeps the first entry when both duplicates have a description', async () => {
    // Distinguishes `&&` from `||` in `!existing.description && op.description`:
    // with `||`, a later entry with its own description would wrongly
    // overwrite an already-described first entry too.
    const source = await loadWithOperators([
      { name: '$dup', class: 'query', description: 'first description wins' },
      { name: '$dup', class: 'evaluation', description: 'second description should not win' },
    ]);
    const result = source(fakeCtx('$')) as CompletionResult | null;
    expect(result!.options.find((o) => o.label === '$dup')).toEqual({
      label: '$dup',
      type: 'keyword',
      detail: 'query',
      info: 'first description wins',
    });
  });
});
