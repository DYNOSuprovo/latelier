import { expect, type Page } from '@playwright/test';
import { baseConnInput, startMemoryServer, withApp } from '../../helpers/e2eApp';
import { ConnectionSwitcherPage } from '../pages/ConnectionSwitcherPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { expectConsoleClean, expectStatusDot } from './uiAsserts';

type ConnInput = ReturnType<typeof baseConnInput>;

interface BridgeApi {
  conn: {
    create: (input: ConnInput) => Promise<{ id: string; name: string }>;
    list: () => Promise<Array<{ id: string; name: string }>>;
  };
  mongo: {
    connect: (id: string) => Promise<{ status: string }>;
  };
  doc: {
    insert: (input: {
      connectionId: string;
      dbName: string;
      collection: string;
      docJson: string;
    }) => Promise<{ insertedId: unknown }>;
  };
  meta: {
    listDatabases: (input: { connectionId: string }) => Promise<Array<{ name: string }>>;
  };
}

/**
 * Seed a connection through the IPC bridge so a UI test can skip the
 * create-connection dance when its real subject is something else.
 *
 * Why the focus dispatch: useConnections() only refetches on window focus or
 * `mongo.onStatus` events — there is no push event for IPC-side `conn.create`.
 * Dispatching a focus event runs the same refresh path a real alt-tab would,
 * so callers can assert against the rendered list immediately.
 */
export async function seedConnection(
  win: Page,
  conn: ConnInput,
): Promise<{ id: string; name: string }> {
  return win.evaluate(async (input) => {
    const api = (window as unknown as { atelier: BridgeApi }).atelier;
    const created = await api.conn.create(input);
    window.dispatchEvent(new Event('focus'));
    return created;
  }, conn) as Promise<{ id: string; name: string }>;
}

/**
 * Open a just-created Connection by choosing it in the Switcher — the same
 * click a user makes. The row click runs `mongo.connect`
 * (`openConnection` in `Workspace.tsx`), so nothing needs to connect
 * separately afterwards.
 *
 * X16.1 — this used to write `app_state` and reload, because the choice
 * was a persisted pref. That pref is retired: Connection identity is the
 * Focused Tab's, and these seeds want a Connection with *no* tab open.
 *
 * X16.4 — and the wait moved off the TitleBar trigger onto the row's
 * own status. A Switcher click opens **no** tab (§4.6), so with nothing else
 * open the trigger reads "Connection: none selected" forever and waiting on
 * it would hang every seed. The row going `connected` is what this actually
 * wanted all along.
 */
async function chooseInSwitcher(win: Page, name: string): Promise<void> {
  const switcher = new ConnectionSwitcherPage(win);
  await switcher.select(name);
  await expectStatusDot(win, name, 'connected', 10_000);
}

/**
 * Seed a connection, point the Data View at it, AND drive `mongo.connect`.
 * The renderer's `mongo.onStatus` subscription updates the dot live, but
 * callers should still follow with `expectStatusDot(win, name, 'connected')`
 * to wait for the transition.
 */
export async function seedActiveConnection(
  win: Page,
  conn: ConnInput,
): Promise<{ id: string; name: string }> {
  const created = await seedConnection(win, conn);
  await chooseInSwitcher(win, created.name);
  return created;
}

/**
 * Insert documents through the IPC bridge so a UI test starts with a
 * non-empty collection without driving the Document Editor's insert mode
 * first.
 *
 * `docs` are stringified to canonical EJSON by the caller (the bridge expects
 * `docJson: string`). Returns the inserted IDs in the order they were sent.
 */
export async function seedDocuments(
  win: Page,
  args: { connectionId: string; dbName: string; collection: string; docs: unknown[] },
): Promise<unknown[]> {
  return win.evaluate(async (input) => {
    const api = (window as unknown as { atelier: BridgeApi }).atelier;
    const ids: unknown[] = [];
    for (const d of input.docs) {
      const r = await api.doc.insert({
        connectionId: input.connectionId,
        dbName: input.dbName,
        collection: input.collection,
        docJson: JSON.stringify(d),
      });
      ids.push(r.insertedId);
    }
    return ids;
  }, args) as Promise<unknown[]>;
}

/**
 * `seedActiveConnection` + `seedDocuments`, but with the documents inserted
 * *before* the Data View is pointed at the Connection.
 *
 * That order is what closes the race against `DbCollectionNavigator`'s first
 * DB-list fetch: the navigator has no root until the Switcher click below, and
 * by then the database is already visible server-side (confirmed by the poll
 * further down), so there is no window for the tree to run ahead of the data.
 *
 * The Switcher click does issue `mongo.connect`, which opens a *new*
 * `MongoClient` over the one `doc.insert` already warmed (`MongoPool.connect()`
 * does not short-circuit an already-connected entry the way `getClient()`
 * does). That reconnect is only safe because of the poll below: the database
 * is confirmed visible server-side before the navigator exists to ask for it.
 *
 * Also polls `listDatabases` until it actually reports the new database
 * before pointing the Data View at the Connection. A successful `doc.insert`
 * is not sufficient — MongoDB creates a database's catalog entry lazily, and
 * a `listDatabases` admin command issued immediately after can still observe
 * a stale snapshot that predates it (reproduced directly: a `listDatabases`
 * call made right after seeding returned `[]`, while the identical call a few
 * seconds later returned `[{name: 'shop', ...}]`). Confirming visibility
 * server-side first, rather than just trusting the write resolved, is what
 * actually closes the race.
 */
export async function seedActiveConnectionWithDocs(
  win: Page,
  conn: ConnInput,
  docsInput: { dbName: string; collection: string; docs: unknown[] },
): Promise<{ id: string; name: string }> {
  const created = (await win.evaluate(async ({ conn: input, docsInput: docsArgs }) => {
    const api = (window as unknown as { atelier: BridgeApi }).atelier;
    const c = await api.conn.create(input);
    // Sequential, not Promise.all: some callers address rows by insertion
    // order (e.g. `.nth(1)` for "the second doc") — a MongoDB find() with no
    // explicit sort tends to return documents in insertion order, but only
    // when they're actually inserted one at a time. Concurrent inserts don't
    // resolve in array order, so the natural-order assumption would break.
    for (const d of docsArgs.docs) {
      await api.doc.insert({
        connectionId: c.id,
        dbName: docsArgs.dbName,
        collection: docsArgs.collection,
        docJson: JSON.stringify(d),
      });
    }
    const deadline = Date.now() + 5000;
    for (;;) {
      const dbs = await api.meta.listDatabases({ connectionId: c.id });
      if (dbs.some((d) => d.name === docsArgs.dbName)) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return c;
  }, { conn, docsInput })) as { id: string; name: string };
  // `conn.create` has no push event, so the renderer's `useConnections()` has
  // to be nudged before the Switcher can list the new row.
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await chooseInSwitcher(win, created.name);
  return created;
}


/**
 * The opening most Data View tests repeat: a fresh memory server and app,
 * `docs` seeded into `shop.orders`, that collection opened, and its auto-run
 * rendered (`readyText` visible) before `body` drives anything — a manual Run
 * overlapping the auto-run is dropped by the runner's single-flight guard.
 * `body` runs inside `expectConsoleClean`.
 */
export async function withOpenOrders(
  connName: string,
  docs: unknown[],
  readyText: string,
  body: (win: Page, ws: WorkspacePage) => Promise<void>,
): Promise<void> {
  const { host, port } = await startMemoryServer();
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: connName },
        { dbName: 'shop', collection: 'orders', docs },
      );
      await expectStatusDot(win, connName, 'connected');
      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      await expect(win.getByText(readyText)).toBeVisible({ timeout: 8000 });
      await body(win, ws);
    });
  });
}
