import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { detectFieldPosition } from '../../src/components/scriptEditor/fieldPositionDetector';

/**
 * Builds a real EditorState (JS language, syntax tree forced) from a
 * document containing exactly one cursor marker, and returns the state plus
 * the resolved cursor position. Mirrors `realCtx` in
 * script-mongo-completions.spec.ts — `detectFieldPosition` reads the syntax
 * tree directly, so a stub state won't exercise the real grammar shapes.
 */
function at(doc: string, marker = '█'): { state: EditorState; pos: number } {
  const pos = doc.indexOf(marker);
  if (pos < 0) throw new Error(`cursor token ${marker} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + marker.length);
  const state = EditorState.create({ doc: stripped, extensions: [javascript()] });
  ensureSyntaxTree(state, stripped.length, 5_000);
  return { state, pos };
}

describe('detectFieldPosition', () => {
  it('matches an empty key slot inside db.<coll>.find filter', () => {
    const { state, pos } = at('db.users.find({ █ })');
    const result = detectFieldPosition(state, pos);
    expect(result).toEqual({
      collection: 'users',
      from: pos,
      to: pos,
      partial: '',
      insideString: false,
    });
  });

  it('replaces a partial bare identifier key', () => {
    const { state, pos } = at('db.users.find({ na█ })');
    const result = detectFieldPosition(state, pos);
    expect(result).not.toBeNull();
    expect(result!.collection).toBe('users');
    expect(result!.partial).toBe('na');
    expect(result!.insideString).toBe(false);
    expect(result!.from).toBe('db.users.find({ '.length);
    expect(result!.to).toBe(pos);
  });

  it('replaces a partial double-quoted string key, excluding the quotes', () => {
    const { state, pos } = at('db.users.find({ "na█" })');
    const result = detectFieldPosition(state, pos);
    expect(result).not.toBeNull();
    expect(result!.collection).toBe('users');
    expect(result!.partial).toBe('na');
    expect(result!.insideString).toBe(true);
    expect(result!.from).toBe('db.users.find({ "'.length);
    expect(result!.to).toBe(pos);
  });

  it('replaces a partial single-quoted string key', () => {
    const { state, pos } = at("db.users.find({ 'na█' })");
    const result = detectFieldPosition(state, pos);
    expect(result).not.toBeNull();
    expect(result!.partial).toBe('na');
    expect(result!.insideString).toBe(true);
  });

  it('returns null in a value slot (cursor after the colon)', () => {
    const { state, pos } = at('db.users.find({ name:█ 1 })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null for a computed property key', () => {
    const { state, pos } = at('db.users.find({ [█x]: 1 })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('resolves the collection through a nested $set update payload', () => {
    const { state, pos } = at('db.users.updateOne({ a: 1 }, { $set: { █ } })');
    const result = detectFieldPosition(state, pos);
    expect(result?.collection).toBe('users');
  });

  it('returns null for a top-level aggregate stage spec (operator-keyed, not field-keyed)', () => {
    const { state, pos } = at('db.orders.aggregate([{ █ }])');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('resolves the collection inside an aggregate $match stage', () => {
    const { state, pos } = at('db.orders.aggregate([{ $match: { █ } }])');
    const result = detectFieldPosition(state, pos);
    expect(result?.collection).toBe('orders');
  });

  it('resolves the collection through a nested $or array element', () => {
    const { state, pos } = at('db.users.find({ $or: [{ █ }] })');
    const result = detectFieldPosition(state, pos);
    expect(result?.collection).toBe('users');
  });

  it('resolves the collection through a nested $elemMatch sub-filter', () => {
    const { state, pos } = at('db.users.find({ tags: { $elemMatch: { █ } } })');
    const result = detectFieldPosition(state, pos);
    expect(result?.collection).toBe('users');
  });

  it('returns null when the $-prefixed key is not a recognized field-keyed operator', () => {
    const { state, pos } = at('db.orders.aggregate([{ $unknownOp: { █ } }])');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('resolves the collection for a filter-arg0 method directly (updateOne arg0)', () => {
    const { state, pos } = at('db.users.updateOne({ █ }, {})');
    const result = detectFieldPosition(state, pos);
    expect(result?.collection).toBe('users');
  });

  it('returns null for the top-level update payload (operator-keyed, not field-keyed)', () => {
    const { state, pos } = at('db.users.updateOne({}, { █ })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null for a method with no field-keyed argument (insertOne)', () => {
    const { state, pos } = at('db.users.insertOne({ █ })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null when the callee is not `db.<coll>.<method>`', () => {
    const { state, pos } = at('someAlias.find({ █ })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null for a plain object literal with no enclosing db call', () => {
    const { state, pos } = at('const x = { █ }');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('falls back to walking up to the enclosing object from a punctuation token (comma)', () => {
    const { state, pos } = at('db.users.find({ a: 1,█ })');
    const result = detectFieldPosition(state, pos);
    expect(result).toEqual({
      collection: 'users',
      from: pos,
      to: pos,
      partial: '',
      insideString: false,
    });
  });

  it('returns null when walking up from inside an empty ArgList reaches no object', () => {
    const { state, pos } = at('db.users.find(█)');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null when walking up from inside an ArrayExpression reaches no object', () => {
    const { state, pos } = at('db.users.find([█])');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null when the walk-up loop reaches a Property node before any ObjectExpression', () => {
    // The value `-1` here is a UnaryExpression; walking up from inside it
    // hits the enclosing Property node before any ObjectExpression, which
    // must stop the walk (rather than skip past it to the grandparent
    // object and wrongly resolve a collection there).
    const { state, pos } = at('db.users.find({ a: -█1 })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('includes the full string content when the cursor sits right after the closing quote', () => {
    const { state, pos } = at('db.users.find({ "name"█ })');
    const result = detectFieldPosition(state, pos);
    expect(result).not.toBeNull();
    expect(result!.partial).toBe('name');
    expect(result!.to).toBe(pos - 1);
  });

  it('treats the cursor right after the opening quote as a valid empty-partial string slot', () => {
    const { state, pos } = at('db.users.find({ "█" })');
    const result = detectFieldPosition(state, pos);
    expect(result).toEqual({
      collection: 'users',
      from: pos,
      to: pos,
      partial: '',
      insideString: true,
    });
  });

  it('returns null for the second positional arg to aggregate even when it looks field-keyed', () => {
    // argIndex 1, method 'aggregate' — neither the arg0-aggregate branch nor
    // the arg1-update branch (aggregate isn't in UPDATE_METHODS_ARG1) apply.
    const { state, pos } = at('db.orders.aggregate([{}], { $match: { █ } })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null for a third positional arg even when it looks like an update payload', () => {
    const { state, pos } = at('db.users.updateOne({}, {}, { $set: { █ } })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  it('returns null for a second positional arg to a non-update method, even when field-keyed', () => {
    const { state, pos } = at('db.users.find({}, { $set: { █ } })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });

  describe('parseDbCallee guard clauses', () => {
    it('returns null when the callee is not a member expression at all', () => {
      const { state, pos } = at('find({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });

    it('returns null when the method slot is a computed member access', () => {
      const { state, pos } = at('db.users[x]({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });

    it('returns null when the callee is only a single-level member expression', () => {
      const { state, pos } = at('users.find({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });

    it('returns null when the collection slot is a computed member access', () => {
      const { state, pos } = at('db[x].find({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });

    it('returns null when the root is more than one member access away (not a plain VariableName)', () => {
      const { state, pos } = at('this.db.users.find({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });

    it('returns null when the root identifier is not literally `db`', () => {
      const { state, pos } = at('notdb.users.find({ █ })');
      expect(detectFieldPosition(state, pos)).toBeNull();
    });
  });

  describe.each([
    'find',
    'findOne',
    'countDocuments',
    'count',
    'distinct',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
  ])('FILTER_METHODS_ARG0: %s', (method) => {
    it(`resolves the collection for db.<coll>.${method}(filter)`, () => {
      const { state, pos } = at(`db.users.${method}({ █ })`);
      expect(detectFieldPosition(state, pos)?.collection).toBe('users');
    });
  });

  describe.each(['updateOne', 'updateMany', 'findOneAndUpdate'])(
    'UPDATE_METHODS_ARG1: %s',
    (method) => {
      it(`resolves the collection for the $set payload of db.<coll>.${method}`, () => {
        const { state, pos } = at(`db.users.${method}({}, { $set: { █ } })`);
        expect(detectFieldPosition(state, pos)?.collection).toBe('users');
      });
    },
  );

  describe.each([
    '$match',
    '$project',
    '$addFields',
    '$set',
    '$unset',
    '$group',
    '$sort',
    '$replaceWith',
    '$replaceRoot',
  ])('FIELD_KEYED_AGG_STAGES: %s', (stage) => {
    it(`resolves the collection inside an aggregate ${stage} stage`, () => {
      const { state, pos } = at(`db.orders.aggregate([{ ${stage}: { █ } }])`);
      expect(detectFieldPosition(state, pos)?.collection).toBe('orders');
    });
  });

  describe.each(['$or', '$and', '$nor'])('NESTED_FIELD_KEYED_LOGICAL_OPS (array): %s', (op) => {
    it(`resolves the collection through a nested ${op} array element`, () => {
      const { state, pos } = at(`db.users.find({ ${op}: [{ █ }] })`);
      expect(detectFieldPosition(state, pos)?.collection).toBe('users');
    });
  });

  it('resolves the collection through a nested $elemMatch sub-filter (NESTED_FIELD_KEYED_LOGICAL_OPS)', () => {
    const { state, pos } = at('db.users.find({ tags: { $elemMatch: { █ } } })');
    expect(detectFieldPosition(state, pos)?.collection).toBe('users');
  });

  describe.each([
    '$set',
    '$unset',
    '$inc',
    '$mul',
    '$min',
    '$max',
    '$rename',
    '$currentDate',
    '$setOnInsert',
    '$push',
    '$pull',
    '$pullAll',
    '$addToSet',
    '$pop',
    '$bit',
  ])('FIELD_KEYED_UPDATE_OPS: %s', (op) => {
    it(`resolves the collection inside a ${op} update payload`, () => {
      const { state, pos } = at(`db.users.updateOne({}, { ${op}: { █ } })`);
      expect(detectFieldPosition(state, pos)?.collection).toBe('users');
    });
  });

  it('resolves the collection through a quoted ancestor key ("$set")', () => {
    // Exercises `readKeyText`'s String branch (and `stripQuotes`) for an
    // ancestor Property key, not just the cursor's own key slot.
    const { state, pos } = at('db.users.updateOne({}, { "$set": { █ } })');
    expect(detectFieldPosition(state, pos)?.collection).toBe('users');
  });

  it('resolves the collection through a single-quoted ancestor key', () => {
    const { state, pos } = at("db.users.updateOne({}, { '$set': { █ } })");
    expect(detectFieldPosition(state, pos)?.collection).toBe('users');
  });

  it('returns null when the $-prefixed ancestor key resolves via readKeyText to a non-key node (spread)', () => {
    // `...{ }` makes the Property's key node a `Spread` node — neither
    // `String` nor `PropertyDefinition` — so `readKeyText` returns null and
    // the walk must stop instead of treating it as a field-keyed ancestor.
    const { state, pos } = at('db.users.find({ $set: { ...{ █ } } })');
    expect(detectFieldPosition(state, pos)).toBeNull();
  });
});

describe('detectFieldPosition — property: never throws', () => {
  it('never throws for any source string and any cursor position in range', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.nat(), (source, rawPos) => {
        const state = EditorState.create({ doc: source, extensions: [javascript()] });
        ensureSyntaxTree(state, source.length, 5_000);
        const pos = source.length === 0 ? 0 : rawPos % (source.length + 1);
        expect(() => detectFieldPosition(state, pos)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('a returned match always has a range within the document and to >= from', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.nat(), (source, rawPos) => {
        const state = EditorState.create({ doc: source, extensions: [javascript()] });
        ensureSyntaxTree(state, source.length, 5_000);
        const pos = source.length === 0 ? 0 : rawPos % (source.length + 1);
        const result = detectFieldPosition(state, pos);
        if (result) {
          expect(result.from).toBeGreaterThanOrEqual(0);
          expect(result.to).toBeLessThanOrEqual(source.length);
          expect(result.to).toBeGreaterThanOrEqual(result.from);
        }
      }),
      { numRuns: 200 },
    );
  });
});
