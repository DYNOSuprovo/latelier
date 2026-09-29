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
 * C05/C08 — Delete connection: the Switcher row's inline Delete action opens
 * a confirmation dialog; confirming removes the item.
 */
test('delete connection: confirm dialog removes item from list', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const switcher = new WorkspacePage(win).switcher;
      await switcher.waitVisible();

      await seedConnection(win, { ...baseConnInput(host, port), name: 'To Delete' });
      await seedConnection(win, { ...baseConnInput(host, port), name: 'To Keep' });
      await expect(switcher.item('To Delete')).toBeVisible({ timeout: 8000 });
      await expect(switcher.item('To Keep')).toBeVisible();

      // The row's inline Delete icon (hover to reveal it, then click) — the
      // retired list screen's right-click context menu no longer exists.
      await switcher.delete('To Delete');

      // Confirmation dialog appears. Mantine's Modal sets role="dialog" on its
      // visible content (named by the title via aria-labelledby); the
      // role="alertdialog" we pass lands on the hidden Modal root, so target the
      // content dialog by its title-derived accessible name.
      const dialog = win.getByRole('dialog', { name: 'Delete "To Delete"?' });
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // docs/adr/0013 — deleting a connection is type-to-confirm: the
      // Delete button stays disabled until the name is typed back.
      await dialog.getByRole('textbox', { name: 'Confirm connection name' }).fill('To Delete');

      // Confirm delete — the "Delete" button is inside the dialog.
      await dialog.getByRole('button', { name: 'Delete' }).click();

      // Item removed; the other connection stays.
      await switcher.waitVisible();
      await expect(switcher.item('To Delete')).not.toBeVisible({ timeout: 5000 });
      await expect(switcher.item('To Keep')).toBeVisible();
    });
  });
});
