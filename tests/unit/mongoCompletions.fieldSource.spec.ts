import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';

// mongoCompletionSource's field-position branch pipes sampleSchemaSource's
// result through `.filter(s => s.kind === 'field')` before turning it into
// completions, then falls back to `null` if the promise it wraps around
// rejects. In practice sampleSchemaSource only ever resolves with
// field-kind suggestions (it digests raw docs), so exercising the filter's
// "keeps only field-kind" behavior and the reject branch both need the
// module mocked directly rather than going through the real fetch/cache
// pipeline.

function realCtx(doc: string, cursor: string = '█'): CompletionContext {
  const pos = doc.indexOf(cursor);
  if (pos < 0) throw new Error(`cursor token ${cursor} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + cursor.length);
  const state = EditorState.create({ doc: stripped, extensions: [javascript()] });
  ensureSyntaxTree(state, stripped.length, 5_000);
  return new CompletionContext(state, pos, false);
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? [];
}

describe('mongoCompletionSource — field-position branch, mocked sampleSchemaSource', () => {
  afterEach(() => {
    vi.doUnmock('../../src/features/fieldSuggestions/sources');
    vi.resetModules();
  });

  it('keeps only kind: "field" suggestions, dropping operator/value entries', async () => {
    vi.resetModules();
    vi.doMock('../../src/features/fieldSuggestions/sources', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/features/fieldSuggestions/sources')>();
      return {
        ...actual,
        sampleSchemaSource: vi.fn(async () => [
          { kind: 'field', path: 'name', source: 'test' },
          { kind: 'operator', name: '$eq', class: 'query', source: 'test' },
          { kind: 'value', value: 1, display: '1', source: 'test' },
        ]),
      };
    });
    const { mongoCompletionSource } = await import(
      '../../src/components/scriptEditor/mongoCompletions'
    );
    const source = mongoCompletionSource({
      getCollections: () => [],
      getFieldContext: () => ({ connectionId: 'c1', dbName: 'mydb' }),
    });
    const result = (await source(realCtx('db.users.find({ █ })'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('name');
    // Exact option count pins the filter: 1 surviving field ("name") plus
    // the 4 always-merged FIELD_SLOT_OPERATOR_COMPLETIONS ($or/$and/$nor/
    // $expr). A broken (no-op) filter would let the operator- and
    // value-kind mock entries through too — since they lack `.path`, they'd
    // map to a `label: undefined` completion rather than surfacing their
    // real name, so asserting on the label text alone can't catch that;
    // the count does.
    expect(result!.options).toHaveLength(5);
    expect(result!.options.every((o) => o.label !== undefined)).toBe(true);
  });

  it('resolves to null when sampleSchemaSource rejects', async () => {
    vi.resetModules();
    vi.doMock('../../src/features/fieldSuggestions/sources', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/features/fieldSuggestions/sources')>();
      return {
        ...actual,
        sampleSchemaSource: vi.fn(async () => {
          throw new Error('boom');
        }),
      };
    });
    const { mongoCompletionSource } = await import(
      '../../src/components/scriptEditor/mongoCompletions'
    );
    const source = mongoCompletionSource({
      getCollections: () => [],
      getFieldContext: () => ({ connectionId: 'c1', dbName: 'mydb' }),
    });
    const result = await source(realCtx('db.users.find({ █ })'));
    expect(result).toBeNull();
  });
});
