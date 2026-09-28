import { describe, it, expect, vi } from 'vitest';

// A dedicated file, not a describe block in import-parse.spec.ts: mocking
// `parseEjsonDocument` applies to every test in the file it's declared in, and
// every other import-parse test needs the real EJSON parser.
vi.mock('../../electron/mongo/ejson.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/mongo/ejson.ts')>();
  return {
    ...actual,
    parseEjsonDocument: vi.fn(() => {
      throw new TypeError('boom — not a ValidationError');
    }),
  };
});

// `toRecord`'s `if (!(err instanceof ValidationError)) throw err;` guard is a
// deliberate fail-fast: `parseEjsonDocument` only ever throws `ValidationError`
// today (every path inside it wraps whatever `ejsonParse` throws), so this is
// unreachable via any real input — same reasoning `useRovingFocus.ts` and
// `useMenuFocus.ts` document for their own currently-unreachable-but-load-bearing
// guards. Mocking `parseEjsonDocument` to throw something else is the only way
// to actually exercise the rethrow rather than force-kill it as equivalent.
describe('toRecord (via parseJsonlLine) — fail-fast on an unexpected error', () => {
  it('rethrows an error that is not a ValidationError instead of swallowing it into a per-line error record', async () => {
    const { parseJsonlLine } = await import('../../electron/mongo/importParse');
    expect(() => parseJsonlLine('{"a":1}', 1)).toThrow(TypeError);
    expect(() => parseJsonlLine('{"a":1}', 1)).toThrow('boom — not a ValidationError');
  });
});
