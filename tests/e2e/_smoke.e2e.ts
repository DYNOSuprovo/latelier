import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedConnection } from './helpers/uiSeed';
import { expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * Phase-0 smoke for the UI-driven E2E scaffolding. Confirms:
 *   - page objects locate their stable anchors,
 *   - `seedConnection` writes through the IPC bridge,
 *   - the seeded connection round-trips through the renderer's connection list,
 *   - no console errors fire during the boot+seed path.
 *
 * Feature-level happy paths land in cNN/wNN/aNN/xNN/fNN spec files in later phases.
 */
test('scaffolding boots, seeds a connection, and reflects it in the list', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const switcher = new WorkspacePage(win).switcher;
      await switcher.waitVisible();
      await expect(switcher.manageButton).toBeVisible();

      const seeded = await seedConnection(win, {
        ...baseConnInput(host, port),
        name: 'Smoke Target',
      });
      expect(seeded.name).toBe('Smoke Target');

      // The renderer's connection list is driven by `useConnections()`, which
      // refreshes on its own polling cadence. Poll the locator instead of
      // baking a sleep — toBeVisible already retries until the test timeout.
      await expect(switcher.item('Smoke Target')).toBeVisible({ timeout: 10_000 });
    });
  });
});
