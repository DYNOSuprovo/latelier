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
 * W14 §4 — the projection is edited in the Fields control, not the query
 * bar's advanced row, and Run sends it exactly as before: the field it
 * leaves out stops coming back from the server.
 */
test('a projection set in the Fields control is what the next Run fetches', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Fields Projection Target' },
        {
          dbName: 'shop',
          collection: 'customers',
          docs: [{ name: 'ada', tier: 'gold' }],
        },
      );
      await expectStatusDot(win, 'Fields Projection Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'customers');
      await expect(win.getByText('gold')).toBeVisible({ timeout: 8000 });

      // No projection cell in the advanced row any more.
      await ws.queryBarAdvancedToggle.click();
      await expect(ws.queryBarAdvanced).toBeVisible();
      await expect(ws.queryBarAdvanced.getByText(/projection/i)).toHaveCount(0);

      await ws.fieldsButton.click();
      await expect(win.getByText('Fetch only these fields from the server')).toBeVisible();
      await ws.fieldsProjection.fill('{ name: 1 }');
      await ws.fieldsProjection.press('Enter');
      await expect(ws.fieldsProjection).toHaveValue('{ name: 1 }');

      // Hiding is instant; fetching waits for Run — `tier` is still on screen.
      await expect(win.getByText('gold')).toBeVisible();

      await ws.queryBarRunButton.click();
      await expect(win.getByText('ada')).toBeVisible({ timeout: 8000 });
      await expect(win.getByText('gold')).toHaveCount(0);
    });
  });
});
