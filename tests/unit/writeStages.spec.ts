import { describe, it, expect } from 'vitest';
import { WRITE_STAGES, isWriteStage } from '../../electron/mongo/writeStages';

describe('WRITE_STAGES / isWriteStage', () => {
  it('contains exactly $out and $merge', () => {
    expect([...WRITE_STAGES].sort()).toEqual(['$merge', '$out']);
  });

  it('flags $out and $merge as write stages', () => {
    expect(isWriteStage('$out')).toBe(true);
    expect(isWriteStage('$merge')).toBe(true);
  });

  it('does not flag read-only stage operators', () => {
    expect(isWriteStage('$match')).toBe(false);
    expect(isWriteStage('$project')).toBe(false);
    expect(isWriteStage('$group')).toBe(false);
  });

  it('does not flag an empty or unrelated string', () => {
    expect(isWriteStage('')).toBe(false);
    expect(isWriteStage('out')).toBe(false);
    expect(isWriteStage('$OUT')).toBe(false);
  });
});
