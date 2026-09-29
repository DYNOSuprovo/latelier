import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean, expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * (W08/updateMany) — bulk update-by-query. The results overflow menu's
 * "Update all matching…" action scopes the same two-step confirm flow
 * delete-all uses (type-collection-name + `doc:confirmUpdateMany` → token →
 * `doc:updateMany`) to the tab's *current* query filter, plus an explicit
 * Review step that counts and hashes the update body before the name gate
 * unlocks.
 */
test('update all matching: overflow action updates only the filtered rows and re-runs', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Bulk Update Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [
            { sku: 'stale-001', status: 'pending' },
            { sku: 'stale-002', status: 'pending' },
            { sku: 'keep-001', status: 'shipped' },
          ],
        },
      );
      await expectStatusDot(win, 'Bulk Update Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // Auto-run lands the unfiltered base query first; wait for it
      // before typing a filter (see w09b-doc-delete-all for the same guard).
      await expect(win.getByText('keep-001')).toBeVisible({ timeout: 8000 });

      // Scope the tab to the "pending" rows via the raw query bar.
      await ws.queryBarTextarea.fill('{"status":"pending"}');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('stale-001')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('stale-002')).toBeVisible();
      await expect(win.getByText('keep-001')).not.toBeVisible();

      // Open the results overflow menu and trigger update-all.
      await ws.resultOverflowMenuButton.click();
      await ws.updateAllMatchingMenuItem.click();

      // Type the update body and Review it.
      await win.getByLabel('Update document').fill('{ "$set": { "status": "archived" } }');
      await win.getByRole('button', { name: 'Review' }).click();

      // Dialog shows the *actual* matched count (2), not a placeholder.
      await expect(win.getByText('2 matching documents')).toBeVisible({ timeout: 5000 });

      // Destructive button stays disabled until the collection name is typed.
      const updateBtn = win.getByRole('button', { name: 'Update', exact: true });
      await expect(updateBtn).toBeDisabled();
      await win.getByPlaceholder('orders').fill('orders');
      await expect(updateBtn).toBeEnabled({ timeout: 5000 });
      await updateBtn.click();

      // Re-run happens via onUpdated; the query still filters on
      // status:"pending", so both updated rows drop out of the result.
      await expect(win.getByText('stale-001')).not.toBeVisible({ timeout: 8000 });
      await expect(win.getByText('stale-002')).not.toBeVisible();

      // Switch to the new status to confirm both matched rows were updated,
      // and the non-matching row was left alone.
      await ws.queryBarTextarea.fill('{"status":"archived"}');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('stale-001')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('stale-002')).toBeVisible();
      await expect(win.getByText('keep-001')).not.toBeVisible();

      await ws.queryBarTextarea.fill('{}');
      await ws.queryBarRunButton.click();
      await expect(win.getByText('keep-001')).toBeVisible({ timeout: 8000 });
    });
  });
});
