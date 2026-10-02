import { Parser, type Node } from 'acorn';

/**
 * The async IIFE wrapper prepends one synthetic line (`(async () => {`),
 * which shifts every subsequent line by 1 in vm-reported errors. We feed
 * this as a negative `lineOffset` to `vm.runInContext` and also subtract
 * it from line numbers we extract from messages/stacks before showing
 * them to the user.
 */
export const WRAPPER_LINE_OFFSET = 1;

/**
 * Wrap the user's source so it runs as an async IIFE. If the final
 * top-level statement is an ExpressionStatement (per acorn), prefix it
 * with `return ` so the IIFE's resolved value carries it back to the
 * caller — mirroring how Node's REPL surfaces the value of the last
 * expression. If parsing fails, fall through with the source unmodified
 * so the vm reports the user's syntax error verbatim.
 */
export function wrapSource(source: string): string {
  const rewritten = tryRewriteLastExpression(source);
  return `(async () => {\n${rewritten}\n})()`;
}

function tryRewriteLastExpression(source: string): string {
  let ast: { body: Node[] };
  try {
    ast = Parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Node[] };
  } catch {
    return source;
  }
  const body = ast.body;
  if (body.length === 0) return source;
  const last = body[body.length - 1] as Node & { type: string; start: number; end: number };
  if (last.type !== 'ExpressionStatement') return source;
  // Splice `return ` in front of the last expression. Use the AST `start`
  // offset so leading whitespace / comments stay intact.
  return source.slice(0, last.start) + 'return ' + source.slice(last.start);
}

/**
 * Subtract `WRAPPER_LINE_OFFSET` from line numbers that vm reports against
 * `script.js`, so error messages and stack traces show line numbers that
 * match the user's editor. Examples of patterns rewritten:
 *
 *   "script.js:5"            → "script.js:4"
 *   "at script.js:5:12"      → "at script.js:4:12"
 *   "at <anonymous>:5:12"    → "at <anonymous>:4:12"
 *
 * Lines that would land at 0 or below (because they refer to the wrapper
 * itself) are left untouched — they shouldn't appear in user-visible
 * traces in practice.
 */
export function shiftLineNumbers(text: string): string {
  if (typeof text !== 'string') return text;
  return text.replace(
    /(script\.js|<anonymous>):(\d+)/g,
    (whole, file: string, num: string) => {
      const shifted = Number(num) - WRAPPER_LINE_OFFSET;
      return shifted >= 1 ? `${file}:${shifted}` : whole;
    },
  );
}
