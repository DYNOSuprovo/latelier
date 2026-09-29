import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs, seedDocuments } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * W14 §8 case 9 — the advanced row's open/closed state used to be
 * computed once at first mount and never resync: QueryBar has no `key` at its
 * mount site, so after the first tab whether the row was open bore no relation
 * to whether the Focused Tab had advanced values set.
 *
 * One flow: two collection tabs, a sort on the second, switch away and
 * back. Asserts on the presence of the `#query-bar-advanced` region and its
 * sort input — not on the advanced grid's internal markup, which W13
 * reshaped once and W14 reshaped again.
 */
test('advanced row follows the Focused Tab: open where a sort is set, collapsed where none is', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const conn = await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Advanced Row Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ sku: 'apple-001', status: 'paid' }],
        },
      );
      // Second collection in the same DB, seeded before the navigator ever
      // expands `shop` — `loadColls` only runs on expand, so this lands in
      // the first (and only) listCollections the tree issues.
      await seedDocuments(win, {
        connectionId: conn.id,
        dbName: 'shop',
        collection: 'customers',
        docs: [{ name: 'ada', tier: 'gold' }],
      });
      await expectStatusDot(win, 'Advanced Row Target', 'connected');

      const ws = new WorkspacePage(win);

      // Tab A — orders. Never gets an advanced value.
      await ws.openCollectionFromNavigator('shop', 'orders');
      // Opening a tab auto-runs the base query. Let it land before
      // driving anything else in the bar.
      await expect(win.getByText('apple-001')).toBeVisible({ timeout: 8000 });
      await expect(ws.queryBarAdvanced).toHaveCount(0);

      // Tab B — customers. `shop` is already expanded, so click the row
      // directly: re-clicking the DB row would toggle it *shut*.
      await ws.collectionRow('shop', 'customers').click();
      await expect(ws.tabByName('customers')).toHaveAttribute('aria-selected', 'true', {
        timeout: 5000,
      });
      await expect(win.getByText('ada')).toBeVisible({ timeout: 8000 });
      // Both tabs must coexist — if opening B replaced A, the switch below
      // would land on a *fresh* orders tab whose row is collapsed for the
      // wrong reason, and this spec would pass against the bug.
      await expect(ws.tabByName('orders')).toHaveCount(1);

      // Set a sort on B: expand the row and type — sort patches on change.
      await expect(ws.queryBarAdvanced).toHaveCount(0);
      await ws.queryBarAdvancedToggle.click();
      await expect(ws.queryBarAdvanced).toBeVisible();
      await ws.queryBarSort.fill('{"name":1}');
      await expect(ws.queryBarSort).toHaveValue('{"name":1}');

      // Switch away to A — which has no advanced values. Pre-#296 the row
      // stayed open here, showing B's sort over A's query.
      await ws.tabByName('orders').click();
      await expect(ws.tabByName('orders')).toHaveAttribute('aria-selected', 'true');
      await expect(ws.queryBarAdvanced).toHaveCount(0);

      // Switch back to B — the row re-opens with its sort intact.
      await ws.tabByName('customers').click();
      await expect(ws.tabByName('customers')).toHaveAttribute('aria-selected', 'true');
      await expect(ws.queryBarAdvanced).toBeVisible();
      await expect(ws.queryBarSort).toHaveValue('{"name":1}');
    });
  });
});
