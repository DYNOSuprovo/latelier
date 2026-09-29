import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { detectAggGrammar } from '../../features/fieldSuggestions/aggGrammar';
import { DEFAULT_FIELD_SOURCES, operatorSource } from '../../features/fieldSuggestions/sources';
import type {
  FieldSuggestion,
  OperatorSuggestion,
  SuggestionContext,
} from '../../features/fieldSuggestions/types';

/**
 * Mirrors `useTextareaAutocomplete`'s `KEY_POSITION_SOURCES`: a stage body's
 * bare-key position is the one spot where both a schema field name and a
 * `$operator` key are valid completions — reusing the same composition
 * preserves the exact ranking the textarea had.
 */
const KEY_POSITION_SOURCES = [...DEFAULT_FIELD_SOURCES, operatorSource];

export interface StageBodyCompletionOpts {
  /**
   * Reads the latest connection/db/collection context. Returning null (no
   * active connection yet) disables suggestions entirely.
   */
  getContext: () => SuggestionContext | null;
  /**
   * Reads the latest stage op so operator ranking follows an in-place op
   * change without rebuilding the editor (mirrors the `getCollections` ref
   * pattern in `ScriptEditor`).
   */
  getStageOp: () => string | undefined;
}

function fieldToCompletion(s: FieldSuggestion): Completion {
  return {
    label: s.path,
    type: 'property',
    detail: s.type,
    boost: Math.min(s.frequency ?? 0, 50) / 50,
  };
}

function operatorToCompletion(s: OperatorSuggestion): Completion {
  return {
    label: s.name,
    type: 'keyword',
    detail: s.class,
    info: s.summary ?? s.description ?? undefined,
    // Operators outside the caret's operatorContext still surface (so an
    // unrecognized/custom stage, or a bare object with no context, doesn't
    // hide the catalog) but rank behind in-context ones.
    boost: s.offContext ? -1 : 1,
  };
}

/**
 * Runs every key-position source and merges the results into CodeMirror
 * `Completion[]`, deduping by path (fields) / name (operators) — a field or
 * operator name can be emitted by more than one source, and some operator
 * names (e.g. `$eq`, both a query operator and an aggregation expression)
 * appear more than once in the catalog with different `validIn` sets.
 */
async function collectOptions(ctx: SuggestionContext): Promise<Completion[]> {
  const batches = await Promise.all(KEY_POSITION_SOURCES.map((src) => src(ctx)));

  const fields = new Map<string, FieldSuggestion>();
  const operators = new Map<string, OperatorSuggestion>();
  for (const batch of batches) {
    for (const s of batch) {
      if (s.kind === 'field') {
        const existing = fields.get(s.path);
        fields.set(
          s.path,
          existing
            ? {
                ...existing,
                frequency: (existing.frequency ?? 0) + (s.frequency ?? 0),
                type: existing.type ?? s.type,
              }
            : s,
        );
      } else {
        const existing = operators.get(s.name);
        // A catalog name with duplicate entries (different `class`/`validIn`)
        // is in-context if ANY entry is valid at the caret's context — e.g.
        // `$eq` is both a `matchKey` query op and a `groupValue`/`projectValue`
        // expression, and both uses are legitimate. Prefer the entry that
        // carries a description for the richer popover info.
        operators.set(
          s.name,
          existing
            ? {
                ...existing,
                offContext: existing.offContext && s.offContext,
                description: existing.description ?? s.description,
                summary: existing.summary ?? s.summary,
              }
            : s,
        );
      }
    }
  }

  const options: Completion[] = [];
  for (const f of fields.values()) options.push(fieldToCompletion(f));
  for (const o of operators.values()) options.push(operatorToCompletion(o));
  return options;
}

/**
 * CodeMirror completion source for aggregation stage bodies (T2.4). Stage
 * bodies are top-level `{ … }` objects, not `db.<coll>.<method>(…)` calls, so
 * `mongoCompletions`'s tree-based `detectFieldPosition` never fires there —
 * this source runs the bracket-counting `detectAggGrammar` detector instead
 * (it parses off plain text + caret offset, so it's unaffected by the object
 * literal parsing as a bare JS block).
 *
 * Only the `fieldName` grammar hit is handled: it's the sole position where
 * both a schema field name and a `$operator` key are valid — the exact
 * behavior `useTextareaAutocomplete`'s key-position branch had. Value
 * positions (`fieldRef`/`valueFor`) are out of scope for this ticket.
 */
export function stageBodyCompletionSource(opts: StageBodyCompletionOpts): CompletionSource {
  return (ctx: CompletionContext): Promise<CompletionResult | null> | null => {
    const suggestionCtx = opts.getContext();
    if (!suggestionCtx) return null;

    const doc = ctx.state.doc.toString();
    const hit = detectAggGrammar(doc, ctx.pos, opts.getStageOp());
    if (!hit || hit.kind !== 'fieldName') return null;

    const scopedCtx: SuggestionContext = hit.operatorContext
      ? { ...suggestionCtx, operatorContext: hit.operatorContext }
      : suggestionCtx;

    // Inside a quoted key (`"na|"`) only non-quote characters can extend the
    // token; a bare/unquoted key allows the same identifier charset the
    // grammar detector itself scans with ($, ., word chars).
    //
    // `hit.replaceStart` is always a valid non-negative index into `doc`
    // (0..doc.length) by construction in aggGrammar.ts — it's derived from
    // scanning `doc` itself and never exceeds its bounds. So `> 0` vs `>= 0`
    // vs an unconditional `true` guard here are all observationally
    // identical (verified by exhaustively sweeping every doc/replaceStart
    // combination for short docs with a Node probe: 0 mismatches across all
    // three), and the `?? ''` fallback on `doc[hit.replaceStart - 1]` is
    // dead — that index is only read once the guard has confirmed
    // `replaceStart > 0`, at which point `replaceStart - 1` is always a
    // valid in-bounds index and never `undefined`.
    // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: see comment above — replaceStart is never negative, and doc[replaceStart-1] is never out of bounds when the guard passes.
    const quoteBefore = hit.replaceStart > 0 && /["']/.test(doc[hit.replaceStart - 1] ?? '');
    const validFor = quoteBefore ? /^[^"'\n]*$/ : /^[\w$.]*$/;

    return collectOptions(scopedCtx).then((options): CompletionResult | null => {
      if (options.length === 0) return null;
      return { from: hit.replaceStart, to: hit.replaceEnd, options, validFor };
    });
  };
}
