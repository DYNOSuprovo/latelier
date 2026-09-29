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
 * Pasting a top-level JSON array into the Document Editor's insert mode
 * routes to `doc:insertMany` and inserts every document in one shot.
 */
test('doc writes: pasting a JSON array into Insert adds every document', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Insert Many Target' },
        { dbName: 'shop', collection: 'orders', docs: [{ _id: 0, sku: 'seed', status: 'pending' }] },
      );
      await expectStatusDot(win, 'Insert Many Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('seed')).toBeVisible({ timeout: 8000 });

      // ── Insert an array of two documents ─────────────────────────────────
      await win.getByRole('button', { name: /Insert document/ }).click();
      const insertDialog = win.getByRole('dialog', { name: 'Insert document' });
      await expect(insertDialog).toBeVisible({ timeout: 5000 });

      // Fields is the default view (W18 §2); switch to JSON to paste an array.
      await insertDialog.getByRole('radiogroup', { name: 'View' }).getByText('JSON', { exact: true }).click();
      const insertBox = insertDialog.getByRole('textbox', { name: 'Document JSON' });
      await insertBox.fill(
        '[{"_id": 1, "sku": "bulk-one", "status": "pending"}, {"_id": 2, "sku": "bulk-two", "status": "pending"}]',
      );

      // The editor's primary button label reflects the array count.
      await win.getByRole('button', { name: /^Insert 2 documents$/ }).click();

      // Editor closes, the run reruns automatically. Both new rows appear.
      await expect(win.getByText('bulk-one')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('bulk-two')).toBeVisible();
      await expect(insertDialog).not.toBeVisible();
    });
  });
});
