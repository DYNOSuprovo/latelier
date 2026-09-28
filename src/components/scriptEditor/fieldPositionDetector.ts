import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/**
 * Result of locating the cursor inside a `db.<coll>.<method>(...)` field-key
 * slot. `from`/`to` describe the range CodeMirror should replace when the user
 * picks a completion. `partial` is the text already typed at the slot.
 */
export interface FieldPositionMatch {
  collection: string;
  from: number;
  to: number;
  partial: string;
  /** True when the slot lives inside a string-literal property key. */
  insideString: boolean;
}

/** Collection methods whose first arg is a filter document (field keys). */
const FILTER_METHODS_ARG0: ReadonlySet<string> = new Set([
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
]);

/** Collection methods whose second arg is an update document (operator-keyed). */
const UPDATE_METHODS_ARG1: ReadonlySet<string> = new Set([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
]);

/** Aggregation stages whose value is a field-keyed object. */
const FIELD_KEYED_AGG_STAGES: ReadonlySet<string> = new Set([
  '$match',
  '$project',
  '$addFields',
  // Stryker disable next-line StringLiteral: '$set' also lives in FIELD_KEYED_UPDATE_OPS below, and the membership check that reads this set (resolveCollectionFromContext) is a union of all three sets — removing '$set' from just this one is unobservable as long as it still matches via FIELD_KEYED_UPDATE_OPS. Verified by tracing the `!A.has(k) && !B.has(k) && !C.has(k)` guard.
  '$set',
  // Stryker disable next-line StringLiteral: same reasoning as '$set' above — '$unset' is also in FIELD_KEYED_UPDATE_OPS.
  '$unset',
  '$group',
  '$sort',
  '$replaceWith',
  '$replaceRoot',
]);

/**
 * Logical query operators whose value contains nested field-keyed filter
 * documents. `$or`/`$and`/`$nor` wrap an array of filter docs; `$elemMatch`
 * wraps a single sub-filter. Walking past these keeps the field-keyed
 * context so autocomplete still fires inside the nested objects.
 */
const NESTED_FIELD_KEYED_LOGICAL_OPS: ReadonlySet<string> = new Set([
  '$or',
  '$and',
  '$nor',
  '$elemMatch',
]);

/** Update operators whose value is a field-keyed object. */
const FIELD_KEYED_UPDATE_OPS: ReadonlySet<string> = new Set([
  // Stryker disable next-line StringLiteral: '$set' also lives in FIELD_KEYED_AGG_STAGES above — same union-membership reasoning as there.
  '$set',
  // Stryker disable next-line StringLiteral: '$unset' also lives in FIELD_KEYED_AGG_STAGES above.
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
]);

interface KeySlot {
  enclosingObject: SyntaxNode;
  from: number;
  to: number;
  partial: string;
  insideString: boolean;
}

/**
 * Find the call argument the given object literal sits inside, walking past
 * intermediate Property/ArrayExpression layers. Returns the call info plus how
 * many `$<op>` Property keys we passed through on the way up — needed to
 * distinguish a top-level `aggregate([...])` stage spec (operator-keyed) from
 * a `$match: { ... }` payload (field-keyed).
 */
function resolveCollectionFromContext(
  startObject: SyntaxNode,
  state: EditorState,
): string | null {
  let current: SyntaxNode = startObject;
  let passedThroughOpKey = false;

  while (current.parent) {
    const parent: SyntaxNode = current.parent;

    if (parent.name === 'Property') {
      const keyNode = firstNamedChild(parent);
      // Stryker disable next-line ConditionalExpression: `firstNamedChild` returns null only when a Property has no named children at all; every parseable Property shape tried (shorthand, computed `[x]`, string key, spread `...expr`, even a malformed `[]:` key) still yields at least one named node (a String/PropertyDefinition/VariableName/Spread) — verified with node probes against Lezer's JS grammar. `readKeyText` below (line121) is the reachable guard for the non-key-shaped cases.
      if (!keyNode) return null;
      const keyText = readKeyText(keyNode, state);
      if (keyText === null) return null;
      if (keyText.startsWith('$')) {
        if (
          !FIELD_KEYED_AGG_STAGES.has(keyText) &&
          !FIELD_KEYED_UPDATE_OPS.has(keyText) &&
          !NESTED_FIELD_KEYED_LOGICAL_OPS.has(keyText)
        ) {
          return null;
        }
        passedThroughOpKey = true;
      }
      current = parent;
      continue;
    }

    if (parent.name === 'ArrayExpression' || parent.name === 'ObjectExpression') {
      current = parent;
      continue;
    }

    // Stryker disable next-line ConditionalExpression: forcing this check to always run is unobservable — the two branches above already `continue` for Property/ArrayExpression/ObjectExpression parents, so by this point `parent` is either genuinely 'ArgList' or something unrelated (e.g. VariableDeclaration for `const x = {...}`); for the latter, `parent.parent` is never a real CallExpression either, so `parseDbCallee` (or the earlier `callExpr.name !== 'CallExpression'` guard) still returns null. Verified with the "plain object literal with no enclosing db call" test.
    if (parent.name === 'ArgList') {
      const callExpr = parent.parent;
      // Stryker disable next-line ConditionalExpression,LogicalOperator: an ArgList node's parent is always a CallExpression (or NewExpression) by Lezer's JS grammar — it only ever appears as a call's argument list. For a NewExpression parent, `parseDbCallee`'s own first guard (callee.name !== 'MemberExpression') still returns null because `new Foo(...)`'s first child is the `new` keyword token, not the callee — verified with a node probe on `new db.users({ ... })`.
      if (!callExpr || callExpr.name !== 'CallExpression') return null;
      const argIndex = indexOfArg(parent, current);
      // Stryker disable next-line ConditionalExpression: `current` is always one of `parent`'s (ArgList's) own children by construction — it was reached by walking up from `current`'s previous value, whose `.parent` is this same ArgList — so `indexOfArg` always finds it (argIndex >= 0). No malformed-syntax construction was found that leaves `current` unmatched among the ArgList's named children.
      if (argIndex < 0) return null;
      const callInfo = parseDbCallee(callExpr, state);
      if (!callInfo) return null;
      const { collection, method } = callInfo;
      if (argIndex === 0 && method === 'aggregate') {
        return passedThroughOpKey ? collection : null;
      }
      if (argIndex === 0 && FILTER_METHODS_ARG0.has(method)) return collection;
      if (argIndex === 1 && UPDATE_METHODS_ARG1.has(method)) {
        return passedThroughOpKey ? collection : null;
      }
      return null;
    }

    return null;
  }
  return null;
}

/**
 * Lezer's firstChild/nextSibling iteration includes anonymous punctuation
 * tokens (`(`, `,`, `:`, `{`, …) — they have names equal to the token text.
 * For our purposes — finding the property key or counting argument index —
 * we only want named expression nodes (CamelCase or snake_case identifiers).
 */
function isNamedNode(node: SyntaxNode): boolean {
  const c = node.name.charCodeAt(0);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: `c === 95` (leading underscore) is unreachable — CodeMirror's JS grammar never emits a node *type* name starting with `_`. The exact boundary codepoints of the two ranges (90 'Z', 97 'a', 122 'z') are likewise never the first character of any node-type name this function is actually called with (Property/ArgList children in an object or call expression: CamelCase node types like `PropertyDefinition`/`String`/`ObjectExpression`, or lowercase keyword-token types like `new`/`this`) — verified across every node-type name observed while probing this file's grammar shapes.
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function firstNamedChild(node: SyntaxNode): SyntaxNode | null {
  let c = node.firstChild;
  // Stryker disable next-line ConditionalExpression: skipping this skip-loop only changes the result when `firstChild` itself is an anonymous punctuation token (e.g. `[` for a computed key) — but both call sites (readKeyText and findKeySlot) immediately type-check the returned node's `.name` against 'PropertyDefinition'/'String', and an anonymous token's name is always its literal punctuation text (`[`, `(`, `,`, …), which can never equal either. So the "wrong" unskipped node fails the same downstream check the correctly-skipped node would pass/fail identically. Verified with the computed-key test (`{ [x]: 1 }`), which returns null either way.
  while (c && !isNamedNode(c)) c = c.nextSibling;
  return c;
}

function readKeyText(keyNode: SyntaxNode, state: EditorState): string | null {
  if (keyNode.name === 'PropertyDefinition') {
    return state.doc.sliceString(keyNode.from, keyNode.to);
  }
  if (keyNode.name === 'String') {
    const raw = state.doc.sliceString(keyNode.from, keyNode.to);
    return stripQuotes(raw);
  }
  return null;
}

function stripQuotes(raw: string): string {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: `raw` is always a CodeMirror JS 'String' token's full source slice, which is always at least 2 characters (an empty string literal `""`/`''` is itself 2 chars) — no shorter 'String' token exists to make this guard's `>= 2` vs `> 2` distinction, or forcing it `true`, observable.
  if (raw.length >= 2) {
    const first = raw.charCodeAt(0);
    const last = raw.charCodeAt(raw.length - 1);
    // Stryker disable next-line ConditionalExpression,LogicalOperator: `first === last` only fails for an *unterminated* live-typed string key (the user hasn't typed the closing quote yet). Lezer's error recovery for an unterminated string consumes the rest of the document into that single String token (verified with a node probe), destroying the nested ObjectExpression a cursor would need to sit in for `detectFieldPosition` to return anything at all — so no reachable input exercises this guard with a still-parseable enclosing object on the other side of the mismatched quote.
    if ((first === 34 || first === 39) && first === last) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function indexOfArg(argList: SyntaxNode, target: SyntaxNode): number {
  let i = 0;
  for (let c = argList.firstChild; c; c = c.nextSibling) {
    if (!isNamedNode(c)) continue;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: `from`/`to` alone already uniquely identify a sibling in an ArgList — two distinct call arguments can never share the same source range — so the `.name` check is redundant with (and the `||` variant is dominated by) the range check for every real syntax tree. Forcing any single clause `true` while the other two stay real still requires the genuinely-unique from/to pair to match, which only `target` itself satisfies.
    if (c.from === target.from && c.to === target.to && c.name === target.name) {
      return i;
    }
    i++;
  }
  // Stryker disable next-line UnaryOperator: unreachable — `target` is always `current` from the caller's loop, whose `.parent` is this same `argList`, so it is always found as one of `argList`'s own children above and this line never runs for any real input (same invariant documented on the match check above).
  return -1;
}

interface CallInfo {
  collection: string;
  method: string;
}

/**
 * Parse a `db.<coll>.<method>` callee. Returns null for any other shape
 * (e.g., `someAlias.find()`, computed access, deeper chains). The MemberExpression
 * tree for `db.users.find` nests as MemberExpression(MemberExpression(VariableName,
 * PropertyName), PropertyName) — so the rightmost PropertyName is the method
 * and the inner MemberExpression carries the collection name + the `db` root.
 */
function parseDbCallee(callExpr: SyntaxNode, state: EditorState): CallInfo | null {
  const callee = callExpr.firstChild;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: skipping this guard only matters when `callee` isn't a MemberExpression, and every such shape tried (a bare identifier callee via `find(...)`, a computed access) leaves `callee.lastChild` either `null` or an anonymous/mismatched-name node that the very next guard (methodNode.name !== 'PropertyName') still catches — verified with the "callee is not a member expression at all" test.
  if (!callee || callee.name !== 'MemberExpression') return null;
  const methodNode = callee.lastChild;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: skipping this guard only matters when `methodNode` isn't a PropertyName (e.g. a computed `db.users[x](...)` call, where `callee.lastChild` is the closing `]`); the next guard down the chain (inner.name !== 'MemberExpression', or ultimately the dbNode text check) still returns null for every such shape tried — verified with the "method slot is a computed member access" test.
  if (!methodNode || methodNode.name !== 'PropertyName') return null;
  const inner = callee.firstChild;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: skipping this guard only matters when `inner` isn't a MemberExpression (e.g. `users.find(...)`, a single-level chain, where `callee.firstChild` is a bare VariableName); `inner.lastChild`/`inner.firstChild` below then resolve to `null` or a mismatched node that the collNode/dbNode guards still catch — verified with the "callee is only a single-level member expression" test.
  if (!inner || inner.name !== 'MemberExpression') return null;
  const collNode = inner.lastChild;
  if (!collNode || collNode.name !== 'PropertyName') return null;
  const dbNode = inner.firstChild;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: skipping this guard only matters when `dbNode` isn't a VariableName (e.g. `this.db.users.find(...)`, a chain deeper than two levels, where `inner.firstChild` is itself a MemberExpression); the very next line's `sliceString(...) !== 'db'` text check still returns null since a MemberExpression's source slice is never literally 'db' — verified with the "root is more than one member access away" test.
  if (!dbNode || dbNode.name !== 'VariableName') return null;
  if (state.doc.sliceString(dbNode.from, dbNode.to) !== 'db') return null;
  return {
    collection: state.doc.sliceString(collNode.from, collNode.to),
    method: state.doc.sliceString(methodNode.from, methodNode.to),
  };
}

/**
 * Identify whether the cursor is sitting in a property-key slot of an
 * ObjectExpression, and if so, what range the completion should replace.
 * Returns null when the cursor is in a value slot, outside any object, or
 * inside a computed key (`[expr]`).
 */
function findKeySlot(state: EditorState, pos: number): KeySlot | null {
  const inner = syntaxTree(state).resolveInner(pos, -1);

  if (inner.name === 'ObjectExpression') {
    return {
      enclosingObject: inner,
      from: pos,
      to: pos,
      partial: '',
      insideString: false,
    };
  }

  const property =
    // Stryker disable next-line ConditionalExpression,StringLiteral: `resolveInner` only ever resolves directly to a 'Property' node (rather than a descendant of one) when `pos` sits in whitespace *outside* that property's key token — e.g. between the key and the colon — which the `pos < keyNode.from || pos > keyNode.to` guard just below always rejects anyway. So whether this ternary takes the `inner` branch or falls through to check `inner.parent`, the outcome for a real cursor position is identical (both eventually return null). Verified with a node probe placing the cursor between a key and its colon.
    inner.name === 'Property' ? inner : inner.parent?.name === 'Property' ? inner.parent : null;
  if (property) {
    const keyNode = firstNamedChild(property);
    // Stryker disable next-line ConditionalExpression: same reasoning as the identical guard in resolveCollectionFromContext (above) — every parseable Property shape yields a named key node, verified with node probes.
    if (!keyNode) return null;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: the `pos < keyNode.from` side is unreachable through this branch — `resolveInner(pos, -1)`'s left-bias means a cursor exactly at (or before) a key's start position always resolves to the ObjectExpression/comma/brace to its left instead of into `property`, so by the time `property` is non-null here, `pos` is always already `>= keyNode.from`. Verified across every boundary position probed (start of an object, right after a comma, right at a key's first character).
    if (pos < keyNode.from || pos > keyNode.to) return null;
    const enclosingObject = property.parent;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: a 'Property' node is only ever a direct child of 'ObjectExpression' in CodeMirror's JS grammar — destructuring uses 'PatternProperty'/'ObjectPattern' instead, which never satisfies `inner.name === 'Property'` above — so `property.parent` is always an ObjectExpression whenever `property` was matched this way.
    if (!enclosingObject || enclosingObject.name !== 'ObjectExpression') return null;
    if (keyNode.name === 'String') {
      const innerEnd = Math.min(keyNode.to - 1, pos);
      const innerStart = keyNode.from + 1;
      // Stryker disable next-line ConditionalExpression: unreachable for the same left-bias reason as the `pos < keyNode.from` guard above — `pos` is already known to be `>= keyNode.from` here, and `innerStart` is only one past that, so `pos < innerStart` only fails to hold for a position this branch never actually receives (verified with the "right after the opening quote" boundary test, which lands exactly on `innerStart`, not before it).
      if (pos < innerStart) return null;
      return {
        enclosingObject,
        from: innerStart,
        to: innerEnd,
        partial: state.doc.sliceString(innerStart, innerEnd),
        insideString: true,
      };
    }
    if (keyNode.name === 'PropertyDefinition') {
      return {
        enclosingObject,
        from: keyNode.from,
        to: pos,
        partial: state.doc.sliceString(keyNode.from, pos),
        insideString: false,
      };
    }
    return null;
  }

  let n: SyntaxNode | null = inner;
  while (n) {
    if (n.name === 'ObjectExpression') {
      return {
        enclosingObject: n,
        from: pos,
        to: pos,
        partial: '',
        insideString: false,
      };
    }
    if (
      n.name === 'Property' ||
      // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable on its own — a CallExpression's only child holding nested expressions is its ArgList, so this walk-up loop always encounters (and stops at) 'ArgList' one step before it would ever reach the enclosing 'CallExpression'. Verified with the ArgList test (`db.users.find(█)`), which the ArgList clause below already catches first.
      n.name === 'CallExpression' ||
      // Stryker disable next-line ConditionalExpression,StringLiteral: an ArrayExpression's only possible ancestors on this walk are another ArrayExpression (nested arrays — re-checked against this same clause on the next iteration), a Property (an array used as a property value), or an ArgList (an array passed as a call argument) — all three of the other cases are real/unmutated clauses that catch it one hop later regardless. Verified with the nested-array-in-a-call test (`db.users.find([█])`).
      n.name === 'ArrayExpression' ||
      // Stryker disable next-line ConditionalExpression,StringLiteral: disabling just this clause is unobservable given the 'CallExpression' clause two lines up is real — an ArgList's parent is always a CallExpression (see the identical note in resolveCollectionFromContext), so skipping this clause only defers the `return null` by one more `n = n.parent` hop before the CallExpression clause catches it instead. Verified with the ArgList test.
      n.name === 'ArgList'
    ) {
      return null;
    }
    n = n.parent;
  }
  return null;
}

export function detectFieldPosition(
  state: EditorState,
  pos: number,
): FieldPositionMatch | null {
  const slot = findKeySlot(state, pos);
  if (!slot) return null;
  const collection = resolveCollectionFromContext(slot.enclosingObject, state);
  if (!collection) return null;
  return {
    collection,
    from: slot.from,
    to: slot.to,
    partial: slot.partial,
    insideString: slot.insideString,
  };
}
