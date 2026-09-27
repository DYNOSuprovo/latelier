import { isPlainDocument } from '../../utils/ejson';
import { arrayIndexOf, isUnsafeFieldName } from './documentDiff';

type Doc = Record<string, unknown>;

/** One field row's identity, and the map key the editor's `texts`/`collapsed` state is keyed by. */
export const keyOf = (segments: readonly string[]): string => JSON.stringify(segments);

export function decodeKey(key: string): string[] | null {
  try {
    const segments = JSON.parse(key) as unknown;
    return Array.isArray(segments) && segments.every((s) => typeof s === 'string') ? (segments as string[]) : null;
  } catch {
    return null;
  }
}

/** Whether `key` addresses `prefix` itself or anything nested under it. */
export function isUnderSegments(key: string, prefix: readonly string[]): boolean {
  const segments = decodeKey(key);
  // A key shorter than `prefix` fails on its own: its missing segments read
  // as `undefined`, which never equals a string.
  return segments !== null && prefix.every((p, i) => segments[i] === p);
}

/** Drops any entry addressing `segments` or anything nested under it. */
export function purgeUnder<T>(m: ReadonlyMap<string, T>, segments: readonly string[]): Map<string, T> {
  const next = new Map(m);
  for (const key of m.keys()) if (isUnderSegments(key, segments)) next.delete(key);
  return next;
}

/** Same as `purgeUnder`, for the collapsed-row `Set` rather than the texts `Map`. */
export function purgeCollapsedUnder(s: ReadonlySet<string>, segments: readonly string[]): Set<string> {
  const next = new Set(s);
  for (const key of s) if (isUnderSegments(key, segments)) next.delete(key);
  return next;
}

/**
 * Where `key` lives once the array element at `removed` (its full segments,
 * the last one an index) is spliced out: `null` for the element itself and
 * anything under it, one index lower for a later sibling or anything under
 * one, unchanged for everything else — so pending state stays on the same
 * logical element rather than sliding onto its neighbour.
 */
export function rekeyAfterRemoval(key: string, removed: readonly string[]): string | null {
  const depth = removed.length - 1;
  // `String()` because either side can be short: `removed` empty, or a key
  // that stops at or above the array. `'undefined'` never parses as an index.
  const removedIdx = arrayIndexOf(String(removed[depth]));
  const segments = decodeKey(key);
  if (removedIdx === null || !segments) return key;
  if (!removed.slice(0, depth).every((p, i) => segments[i] === p)) return key;
  const idx = arrayIndexOf(String(segments[depth]));
  if (idx === null || idx < removedIdx) return key;
  if (idx === removedIdx) return null;
  const next = [...segments];
  next[depth] = String(idx - 1);
  return keyOf(next);
}

/** `rekeyAfterRemoval` applied to every entry of the texts `Map`. */
export function rekeyMapAfterRemoval<T>(m: ReadonlyMap<string, T>, removed: readonly string[]): Map<string, T> {
  const next = new Map<string, T>();
  for (const [key, value] of m) {
    const moved = rekeyAfterRemoval(key, removed);
    if (moved !== null) next.set(moved, value);
  }
  return next;
}

/** `rekeyAfterRemoval` applied to every entry of the collapsed-row `Set`. */
export function rekeySetAfterRemoval(s: ReadonlySet<string>, removed: readonly string[]): Set<string> {
  const next = new Set<string>();
  for (const key of s) {
    const moved = rekeyAfterRemoval(key, removed);
    if (moved !== null) next.add(moved);
  }
  return next;
}

/**
 * The first position in `segments` that indexes into an array in `draft`, or
 * -1 if none does. `diff` (§5a) always sends an array whole, never by
 * element, so an edited marker below that point would never match anything
 * the diff actually contains.
 */
export function firstArraySegment(draft: Doc, segments: readonly string[]): number {
  let node: unknown = draft;
  for (let i = 0; i < segments.length; i++) {
    if (Array.isArray(node)) return i;
    if (!isPlainDocument(node)) break;
    node = (node as Doc)[segments[i]!];
  }
  return -1;
}

/**
 * The dotted path to check with `isEdited` (and the W17 warning) for a row at
 * `segments`. A field name with a `.` or a leading `$` can't be its own
 * update path — `diff` (§5a) falls back to resending the nearest ancestor
 * whose own path is safe, so that's what has to be checked here too. A
 * top-level unsafe name has no such ancestor; the row is locked read-only in
 * that case, so its address is never actually used to decide anything
 * save-relevant. The same fallback applies to an element under an array: the
 * array itself (and its ancestors) carry the "edited" marker, never one of
 * its elements individually.
 */
export function editAddress(draft: Doc, segments: readonly string[]): string {
  const unsafeCut = segments.findIndex((s) => isUnsafeFieldName(s));
  const arrayCut = firstArraySegment(draft, segments);
  // `Infinity` when neither cut applies, and slicing to it keeps every segment.
  const cut = Math.min(...[unsafeCut, arrayCut].filter((c) => c !== -1));
  const safe = segments.slice(0, cut);
  return (safe.length > 0 ? safe : segments).join('.');
}
