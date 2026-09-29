import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

/**
 * X14 §2 — the Filter Bar accepts Shell Syntax.
 *
 * These mount the whole Workspace rather than QueryBar alone, deliberately:
 * the thing under test is the round trip from the textarea through
 * `patchCollectionState` to the debounced `api.tabs.update`, and the
 * "`queryRaw` in persisted tab state never holds Shell Syntax" criterion is
 * only observable at that outer edge.
 */

const now = '2026-04-21T12:00:00.000Z';
const OID = '6512a3f19d3b2c0012a4b8e1';

function makeCollectionTab(queryRaw: string): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw,
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      // Seeded so the tab doesn't read as pristine and auto-run a find
      // before the test drives one itself.
      lastRun: { documents: [], durationMs: 0, ranAt: now },
    },
  };
}

const CONNECTIONS = [
  {
    id: 'c1',
    name: 'Local',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard' as const,
    readOnly: false,
    status: 'connected' as const,
  },
];

function setup(queryRaw: string, extra: Parameters<typeof installAtelierMock>[0] = {}) {
  const updateSpy = vi.fn<IpcApi['tabs']['update']>(async () => makeCollectionTab(queryRaw));
  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(queryRaw)],
      setActive: async (id) => ({ id }),
      update: updateSpy,
    },
    conn: { list: async () => CONNECTIONS },
    ...extra,
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { updateSpy };
}

/** Type `text` into the filter textarea and blur it, as a user would. */
async function typeAndBlur(text: string) {
  const ta = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.blur(ta);
  return ta;
}

/** The `queryRaw` of the last debounced `api.tabs.update` that carried one. */
function lastPersistedQueryRaw(updateSpy: ReturnType<typeof vi.fn>): string | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const state = updateSpy.mock.calls[i]?.[1]?.state as { queryRaw?: string } | undefined;
    if (state?.queryRaw !== undefined) return state.queryRaw;
  }
  return undefined;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('QueryBar — Shell Syntax input (X14 T2)', () => {
  it('repairs unquoted keys on blur and enables Run', async () => {
    setup('{}');

    const ta = await typeAndBlur('{age: {$gt: 60}}');

    await waitFor(() => expect(ta.value).toBe('{"age": {"$gt": 60}}'));
    expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', false);
  });

  it('repairs single-quoted strings on blur and runs them', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 3,
      hasMore: false,
    }));
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const ta = await typeAndBlur("{status: 'active'}");
    await waitFor(() => expect(ta.value).toBe('{"status": "active"}'));

    fireEvent.click(await screen.findByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].filter).toBe('{"status": "active"}');
  });

  it('repairs ObjectId(…) and returns the matching document', async () => {
    const doc = { _id: { $oid: OID }, name: 'Alice' };
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [doc],
      durationMs: 4,
      hasMore: false,
    }));
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 1 }) } });

    const ta = await typeAndBlur(`{_id: ObjectId("${OID}")}`);
    await waitFor(() => expect(ta.value).toBe(`{"_id": {"$oid":"${OID}"}}`));

    fireEvent.click(await screen.findByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].filter).toBe(`{"_id": {"$oid":"${OID}"}}`);
    expect(await screen.findByText(/Alice/)).toBeTruthy();
  });

  // The repair is a repair, not a formatter. This fixture differs from its
  // canonical re-print on two axes at once — inner spacing *and* key order —
  // so an implementation that reformatted instead of leaving well alone
  // could not coincidentally produce the same string.
  it('leaves text that already parses strictly byte-identical after a blur', async () => {
    const HAND_ARRANGED = '{ "b" : 1,   "a" : 2 }';
    const { updateSpy } = setup('{}');

    const ta = await typeAndBlur(HAND_ARRANGED);

    expect(ta.value).toBe(HAND_ARRANGED);
    // And nothing was written back over it afterwards.
    await new Promise((r) => setTimeout(r, 320));
    expect(ta.value).toBe(HAND_ARRANGED);
    expect(lastPersistedQueryRaw(updateSpy)).toBe(HAND_ARRANGED);
  });

  it('leaves a failed transform exactly as typed, with Run disabled', async () => {
    // A regex literal itself now repairs; the `g` flag is what MongoDB
    // has no equivalent for, so this is the refusal case that survived.
    const TYPED = '{name: /^acme/gi}';
    setup('{}');

    const ta = await typeAndBlur(TYPED);

    expect(ta.value).toBe(TYPED);
    await new Promise((r) => setTimeout(r, 320));
    expect(ta.value).toBe(TYPED);
    expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', true);
  });

  it('repairs a regex literal on blur, and Run opens', async () => {
    setup('{}');

    const ta = await typeAndBlur('{name: /^acme/i}');

    expect(ta.value).toBe('{"name": {"$regularExpression":{"pattern":"^acme","options":"i"}}}');
    expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', false);
  });

  it('persists Canonical EJSON — not Shell Syntax — into tab state', async () => {
    const { updateSpy } = setup('{}');

    await typeAndBlur('{age: {$gt: 60}}');

    await waitFor(() => {
      expect(lastPersistedQueryRaw(updateSpy)).toBe('{"age": {"$gt": 60}}');
    });
  });

  // `[1,2]`, `null` and blank text are all *valid JSON*, so the transform
  // returns `unchanged` and never touches them — which is exactly what keeps
  // `currentFilterJson`'s document rule intact. X14 §2: the transform runs
  // before that rule, it does not soften it.
  it.each([['[1,2]'], ['null'], ['   ']])(
    'still refuses %s after a blur',
    async (text) => {
      setup('{}');

      const ta = await typeAndBlur(text);

      expect(ta.value).toBe(text);
      expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', true);
    },
  );

  // Cmd+Enter never blurs the textarea, so without a repair ahead of the Run
  // gate the shortcut would silently do nothing on the very syntax T2 exists
  // to accept.
  it('repairs and runs on Cmd+Enter without a blur', async () => {
    const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
      documents: [],
      durationMs: 2,
      hasMore: false,
    }));
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 0 }) } });

    const ta = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{age: {$gt: 60}}' } });
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].filter).toBe('{"age": {"$gt": 60}}');
    await waitFor(() => expect(ta.value).toBe('{"age": {"$gt": 60}}'));
  });

  // ADR 0004 — a destructive operation shows the Canonical EJSON it will
  // actually run, never a friendlier rendering. It gets that for free: by the
  // time delete-all can open, `queryRaw` is already canonical.
  it('scopes delete-all to the Canonical EJSON the filter repaired to', async () => {
    const confirmSpy = vi.fn<IpcApi['doc']['confirmDeleteMany']>(async () => ({
      count: 7,
      confirmToken: 'tok',
    }));
    setup('{}', {
      query: {
        find: async () => ({ documents: [{ _id: { $oid: OID } }], durationMs: 1, hasMore: false }),
        count: async () => ({ count: 7 }),
      },
      doc: { confirmDeleteMany: confirmSpy },
    });

    await typeAndBlur('{age: {$gt: 60}}');
    fireEvent.click(await screen.findByTestId('query-run-btn'));

    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    fireEvent.click(await screen.findByText(/Delete all matching/));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]?.[0].filterJson).toBe('{"age": {"$gt": 60}}');
  });
});

/**
 * X14 §3 — the sort and raw-projection fields, same conversion
 * point and the same `repairOnCommit` glue.
 *
 * Every one of these blurs the field explicitly before touching Run: in jsdom
 * a `fireEvent.click` on the button does not blur the focused input the way a
 * real mousedown does, so a test that skipped the blur would be asserting on
 * a conversion that never ran.
 */

/**
 * The advanced row is collapsed while nothing is set (W14 §1), so a tab with
 * a default builder has to open it before the sort/projection inputs exist.
 */
async function openAdvanced(): Promise<void> {
  await screen.findByTestId('query-bar-input');
  const trigger = document.querySelector('[aria-controls="query-bar-advanced"]');
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(trigger);
  }
}

async function fieldAndBlur(testid: string, text: string) {
  const el = (await screen.findByTestId(testid)) as HTMLInputElement;
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
  return el;
}

/** The `builder` of the last debounced `api.tabs.update` that carried one. */
function lastPersistedBuilder(
  updateSpy: ReturnType<typeof vi.fn>,
): { sort?: string; projectionRaw?: string } | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const state = updateSpy.mock.calls[i]?.[1]?.state as
      | { builder?: { sort?: string; projectionRaw?: string } }
      | undefined;
    if (state?.builder !== undefined) return state.builder;
  }
  return undefined;
}

function findMock() {
  return vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 1,
    hasMore: false,
  }));
}

describe('QueryBar sort / projection — Shell Syntax input (X14 T3)', () => {
  it('repairs an unquoted sort key on blur, and runs the repaired sort', async () => {
    const findSpy = findMock();
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 0 }) } });
    await openAdvanced();

    const sort = await fieldAndBlur('query-bar-sort', '{name: 1}');

    await waitFor(() => expect(sort.value).toBe('{"name": 1}'));
    const run = await screen.findByTestId('query-run-btn');
    expect(run).toHaveProperty('disabled', false);

    fireEvent.click(run);
    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].sort).toBe('{"name": 1}');
  });

  // `{_id: 0}` was unreachable before T3 from both ends at once: the
  // inclusion model refuses an exclusion, and `isRawProjection` refused the
  // text too because an unquoted key is not JSON.
  it('repairs {_id: 0} in the raw projection on blur, and runs it', async () => {
    const findSpy = findMock();
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 0 }) } });
    // The projection lives in the Fields control (W14 §4).
    fireEvent.click(await screen.findByRole('button', { name: /^fields/i }));

    const proj = await fieldAndBlur('fields-projection', '{_id: 0}');

    await waitFor(() => expect(proj.value).toBe('{"_id": 0}'));
    const run = await screen.findByTestId('query-run-btn');
    expect(run).toHaveProperty('disabled', false);

    fireEvent.click(run);
    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].projection).toBe('{"_id": 0}');
  });

  // The ordering criterion. `[1, 2]` is already valid JSON, so the transform
  // returns `unchanged` and the document test still refuses it — with the
  // shape message, which names a different fix from the parse message.
  it('still refuses [1, 2] in the sort field, with the shape message not the parse one', async () => {
    setup('{}');
    await openAdvanced();

    const sort = await fieldAndBlur('query-bar-sort', '[1, 2]');

    expect(sort.value).toBe('[1, 2]');
    const notice = document.getElementById('query-bar-sort-error');
    expect(notice?.textContent).toMatch(/must be a document/i);
    expect(notice?.textContent).not.toMatch(/parse/i);
    expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', true);
  });

  // The transform reports empty input as `failed`; the blank check that turns
  // that into "no sort" rather than an error has to stay ahead of it.
  it('leaves a blank sort meaning "no sort", with no error and Run enabled', async () => {
    const findSpy = findMock();
    setup('{}', { query: { find: findSpy, count: async () => ({ count: 0 }) } });
    await openAdvanced();

    const sort = await fieldAndBlur('query-bar-sort', '');

    expect(sort.value).toBe('');
    expect(sort.getAttribute('aria-invalid')).not.toBe('true');
    expect(document.getElementById('query-bar-sort-error')).toBeNull();

    fireEvent.click(await screen.findByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalled());
    expect(findSpy.mock.calls[0]?.[0].sort).toBeUndefined();
  });

  // A repair, not a formatter. The fixture differs from its canonical
  // re-print on two axes at once — inner spacing *and* key order — so an
  // implementation that reformatted could not coincidentally match.
  it('leaves a strictly-parsing sort byte-identical after a blur', async () => {
    const HAND_ARRANGED = '{ "b" : 1,   "a" : 2 }';
    const { updateSpy } = setup('{}');
    await openAdvanced();

    const sort = await fieldAndBlur('query-bar-sort', HAND_ARRANGED);

    expect(sort.value).toBe(HAND_ARRANGED);
    // And nothing was written back over it afterwards.
    await new Promise((r) => setTimeout(r, 320));
    expect(sort.value).toBe(HAND_ARRANGED);
    expect(lastPersistedBuilder(updateSpy)?.sort).toBe(HAND_ARRANGED);
  });

  it('leaves a sort the transform cannot read exactly as typed, with Run disabled', async () => {
    const TYPED = '{name: /^acme/gi}';
    setup('{}');
    await openAdvanced();

    const sort = await fieldAndBlur('query-bar-sort', TYPED);

    expect(sort.value).toBe(TYPED);
    await new Promise((r) => setTimeout(r, 320));
    expect(sort.value).toBe(TYPED);
    // X14 §5 — the notice now carries the *transform's* reason rather
    // than `sortProblem`'s generic "can't parse this sort". For a rejected flag
    // that is the difference between learning what to delete and not.
    const notice = document.getElementById('query-bar-sort-error')?.textContent;
    expect(notice).toContain('"g"');
    expect(notice).toContain('global');
    expect(notice).toMatch(/^Line 1, column 8: /);
    expect(await screen.findByTestId('query-run-btn')).toHaveProperty('disabled', true);
  });
});
