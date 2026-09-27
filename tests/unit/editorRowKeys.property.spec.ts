import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deleteAtSegments, getAtSegments } from '../../src/pages/Workspace/documentDiff';
import { keyOf, rekeyMapAfterRemoval } from '../../src/pages/Workspace/editorRowKeys';

// A draft holding one array under a (possibly nested, possibly unsafe) path,
// each element tagged with its original index, and pending text keyed at
// some of those elements (and at paths under them). Removing one element
// through `deleteAtSegments` and re-keying the texts the way the editor does
// must leave every surviving text addressing the element it was typed into.
const pathKey = fc.constantFrom('a', 'b', 'x.y', '__proto__', '0');

describe('rekeyMapAfterRemoval — properties', () => {
  it('every surviving pending text still addresses the element it was typed into', () => {
    fc.assert(
      fc.property(
        fc.array(pathKey, { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 1, max: 12 }),
        fc.nat(),
        fc.uniqueArray(fc.tuple(fc.nat(11), fc.boolean()), { selector: ([i, deep]) => `${i}:${deep}`, maxLength: 8 }),
        (arrayPath, length, removeSeed, pending) => {
          const removeIdx = removeSeed % length;
          const elements = Array.from({ length }, (_, i) => ({ tag: i }));
          // Built with defineProperty so `__proto__` is an ordinary own key.
          let draft: Record<string, unknown> = elements as unknown as Record<string, unknown>;
          for (const seg of [...arrayPath].reverse()) {
            const wrap = Object.create(null) as Record<string, unknown>;
            Object.defineProperty(wrap, seg, { value: draft, enumerable: true, writable: true, configurable: true });
            draft = wrap;
          }

          const texts = new Map<string, number>();
          for (const [i, deep] of pending) {
            if (i >= length) continue;
            const segs = [...arrayPath, String(i), ...(deep ? ['tag'] : [])];
            texts.set(keyOf(segs), i);
          }

          const removed = [...arrayPath, String(removeIdx)];
          const after = deleteAtSegments(draft, removed);
          const rekeyed = rekeyMapAfterRemoval(texts, removed);

          for (const [key, originalIdx] of rekeyed) {
            const segs = JSON.parse(key) as string[];
            const element = getAtSegments(after, segs.slice(0, arrayPath.length + 1));
            expect(element).not.toBeNull();
            expect((element!.value as { tag: number }).tag).toBe(originalIdx);
          }
          // Nothing but the removed element's own entries was dropped.
          const dropped = [...texts.values()].filter((i) => i === removeIdx).length;
          expect(rekeyed.size).toBe(texts.size - dropped);
        },
      ),
    );
  });
});
