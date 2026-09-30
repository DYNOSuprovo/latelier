import { describe, it, expect } from 'vitest';
import { parseInline } from '../../src/troubleshooting/parseInline';

describe('parseInline links', () => {
  it('turns an https target into a link node', () => {
    expect(parseInline('see [docs](https://github.com/x) now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', label: 'docs', href: 'https://github.com/x' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('leaves an http target as plain text, not a link', () => {
    const nodes = parseInline('see [docs](http://github.com/x) now');
    expect(nodes.some((n) => n.kind === 'link')).toBe(false);
    expect(nodes).toEqual([{ kind: 'text', value: 'see [docs](http://github.com/x) now' }]);
  });

  it('leaves other schemes as plain text', () => {
    const nodes = parseInline('[x](javascript:alert(1))');
    expect(nodes.some((n) => n.kind === 'link')).toBe(false);
  });
});
