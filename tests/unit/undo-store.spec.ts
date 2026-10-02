import { describe, it, expect } from 'vitest';
import { UndoStore, UNDO_ENTRIES_PER_CONNECTION, UNDO_MAX_TOTAL_BYTES } from '../../electron/services/UndoStore';

describe('UndoStore', () => {
  it('holds and returns what was put, and answers for an unknown id', () => {
    const s = new UndoStore();
    s.put('a', 'c1', '{"x":1}');
    expect(s.get('a')).toBe('{"x":1}');
    expect(s.has('a')).toBe(true);
    expect(s.get('nope')).toBeUndefined();
    expect(s.has('nope')).toBe(false);
  });

  it('delete removes the entry and ignores an unknown id', () => {
    const s = new UndoStore({ maxBytes: 10 });
    s.put('a', 'c1', '12345');
    s.delete('a');
    s.delete('never-held');
    expect(s.has('a')).toBe(false);
    // The freed bytes are really freed: a 10-byte entry fits beside nothing.
    s.put('b', 'c1', '1234567890');
    s.put('c', 'c1', '1');
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(true);
  });

  it('defaults to 200 entries per Connection and a 64 MiB total', () => {
    expect(UNDO_ENTRIES_PER_CONNECTION).toBe(200);
    expect(UNDO_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    const s = new UndoStore();
    for (let i = 0; i < 201; i++) s.put(`e${i}`, 'c1', '{}');
    s.put('other', 'c2', '{}');
    expect(s.has('e0')).toBe(false);
    expect(s.has('e1')).toBe(true);
    expect(s.has('e200')).toBe(true);
    expect(s.has('other')).toBe(true);
  });

  it('evicts the oldest of the same Connection past its cap, never another Connection\'s', () => {
    const s = new UndoStore({ perConnection: 2 });
    s.put('b1', 'B', '{}');
    s.put('a1', 'A', '{}');
    s.put('a2', 'A', '{}');
    s.put('a3', 'A', '{}');
    expect(['b1', 'a1', 'a2', 'a3'].map((id) => s.has(id))).toEqual([true, false, true, true]);
  });

  it('keeps exactly the per-Connection cap, no fewer', () => {
    const s = new UndoStore({ perConnection: 3 });
    for (const id of ['1', '2', '3']) s.put(id, 'A', '{}');
    expect(['1', '2', '3'].every((id) => s.has(id))).toBe(true);
  });

  it('evicts oldest first past the total byte cap, counting bytes not characters', () => {
    const s = new UndoStore({ maxBytes: 10 });
    s.put('a', 'A', '1234');
    s.put('b', 'B', '1234');
    expect(s.has('a') && s.has('b')).toBe(true);
    s.put('c', 'A', '123');
    expect(['a', 'b', 'c'].map((id) => s.has(id))).toEqual([false, true, true]);
    // Two bytes per character here: 3 characters is 6 bytes.
    s.put('d', 'A', '\u00e9\u00e9\u00e9');
    expect(['b', 'c', 'd'].map((id) => s.has(id))).toEqual([false, true, true]);
  });

  it('never drops the entry just added, even when it alone exceeds the byte cap', () => {
    const s = new UndoStore({ maxBytes: 4 });
    s.put('a', 'A', '12');
    s.put('big', 'A', '1234567890');
    expect(s.has('big')).toBe(true);
    expect(s.has('a')).toBe(false);
  });

  it('putting an id again replaces it without double-counting its bytes', () => {
    const s = new UndoStore({ maxBytes: 10, perConnection: 1 });
    s.put('a', 'A', '123456');
    s.put('a', 'A', '654321');
    expect(s.get('a')).toBe('654321');
    s.put('b', 'B', '1234');
    expect(s.has('a') && s.has('b')).toBe(true);
  });
});
