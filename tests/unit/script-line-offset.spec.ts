import { describe, it, expect } from 'vitest';
import { shiftLineNumbers } from '../../electron/script-runner/scriptSource';

describe('shiftLineNumbers', () => {
  it('decrements `script.js:N` by the wrapper offset', () => {
    expect(shiftLineNumbers('script.js:5')).toBe('script.js:4');
    expect(shiftLineNumbers('SyntaxError at script.js:2:7')).toBe(
      'SyntaxError at script.js:1:7',
    );
  });

  it('rewrites stack-frame lines for both filename forms', () => {
    const stack = [
      'Error: boom',
      '    at script.js:3:5',
      '    at <anonymous>:7:9',
    ].join('\n');
    expect(shiftLineNumbers(stack)).toBe(
      ['Error: boom', '    at script.js:2:5', '    at <anonymous>:6:9'].join('\n'),
    );
  });

  it('leaves wrapper-internal references (would map to ≤0) untouched', () => {
    expect(shiftLineNumbers('script.js:1')).toBe('script.js:1');
    expect(shiftLineNumbers('at <anonymous>:1:1')).toBe('at <anonymous>:1:1');
  });

  it('passes empty / non-matching strings through unchanged', () => {
    expect(shiftLineNumbers('')).toBe('');
    expect(shiftLineNumbers('no line refs here')).toBe('no line refs here');
  });

  it('rewrites multiple occurrences in one pass', () => {
    expect(shiftLineNumbers('script.js:5 -> script.js:10 -> script.js:1')).toBe(
      'script.js:4 -> script.js:9 -> script.js:1',
    );
  });

  it('passes a non-string through untouched', () => {
    expect(shiftLineNumbers(undefined as unknown as string)).toBeUndefined();
    expect(shiftLineNumbers('')).toBe('');
  });
});
