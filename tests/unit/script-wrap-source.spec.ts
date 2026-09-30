import { describe, it, expect } from 'vitest';
import { wrapSource } from '../../electron/script-runner/scriptSource';

describe('wrapSource (last-expression rewrite)', () => {
  it('wraps a single expression with `return`', () => {
    const out = wrapSource('1 + 2');
    expect(out).toContain('return 1 + 2');
    expect(out).toMatch(/^\(async \(\) => \{[\s\S]*\}\)\(\)$/);
  });

  it('only rewrites the LAST top-level statement', () => {
    const out = wrapSource('const x = 5;\nx + 1');
    expect(out).toContain('const x = 5;');
    expect(out).toContain('return x + 1');
  });

  it('does not add `return` when the last statement is not an expression', () => {
    const out = wrapSource('const x = 5;');
    expect(out).not.toContain('return');
  });

  it('does not add `return` to a function declaration', () => {
    const out = wrapSource('function f() {}');
    expect(out).not.toContain('return');
  });

  it('preserves leading whitespace and comments before the last expression', () => {
    const src = 'const a = 1;\n// note\n  a + 2';
    const out = wrapSource(src);
    expect(out).toContain('// note');
    expect(out).toContain('return a + 2');
  });

  it('handles top-level await without choking', () => {
    const out = wrapSource('await Promise.resolve(7)');
    expect(out).toContain('return await Promise.resolve(7)');
  });

  it('falls through unchanged when the source is unparseable', () => {
    const out = wrapSource('const = ;'); // syntax error
    expect(out).toContain('const = ;');
    expect(out).not.toContain('return');
  });

  it('returns an IIFE for empty source', () => {
    const out = wrapSource('');
    expect(out).toMatch(/^\(async \(\) => \{[\s\S]*\}\)\(\)$/);
  });

  it('splices `return ` in at the last statement, leaving everything before it intact', () => {
    expect(wrapSource('const x = 5;\nx + 1')).toBe('(async () => {\nconst x = 5;\nreturn x + 1\n})()');
  });
});
