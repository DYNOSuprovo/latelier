/**
 * Tiny inline-markdown tokenizer supporting **bold**, *italic*, `code`, and
 * [label](https://...). Only https targets become links: the main process
 * refuses every other scheme, so an `http://` target stays plain text rather
 * than rendering a link that does nothing. Block-level constructs (headings, paragraphs, lists)
 * are out of scope — recipe step bodies are single paragraphs by convention.
 *
 * Order matters in the loop: code first (literal — anything inside backticks
 * is not re-parsed), then links, then bold, then italic.
 */

export type InlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; label: string; href: string };

export function parseInline(source: string): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      out.push({ kind: 'text', value: source.slice(textStart, end) });
    }
  };
  while (i < source.length) {
    const c = source[i]!;
    // `code`
    if (c === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i) {
        flushText(i);
        out.push({ kind: 'code', value: source.slice(i + 1, end) });
        i = end + 1;
        textStart = i;
        continue;
      }
    }
    // [label](href)
    if (c === '[') {
      const closeBracket = source.indexOf(']', i + 1);
      if (closeBracket > i && source[closeBracket + 1] === '(') {
        const closeParen = source.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          const href = source.slice(closeBracket + 2, closeParen);
          if (href.startsWith('https://')) {
            flushText(i);
            out.push({
              kind: 'link',
              label: source.slice(i + 1, closeBracket),
              href,
            });
            i = closeParen + 1;
            textStart = i;
            continue;
          }
        }
      }
    }
    // **bold**
    if (c === '*' && source[i + 1] === '*') {
      const end = source.indexOf('**', i + 2);
      if (end > i + 1) {
        flushText(i);
        out.push({ kind: 'bold', value: source.slice(i + 2, end) });
        i = end + 2;
        textStart = i;
        continue;
      }
    }
    // *italic*
    if (c === '*') {
      const end = source.indexOf('*', i + 1);
      if (end > i) {
        flushText(i);
        out.push({ kind: 'italic', value: source.slice(i + 1, end) });
        i = end + 1;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(source.length);
  return out;
}
