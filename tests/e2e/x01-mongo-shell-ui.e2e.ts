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
 * X01 — Mongo shell pane (UI-driven). The existing `mongo-shell.e2e.ts` IPC
 * test verifies the REPL via `mshell.start/write/onOutput`. This
 * spec drives the input textarea + output rendering through the actual UI
 * (`MongoShellPane.tsx:274` — `aria-label="Mongo shell input"`).
 */
test('mongo shell ui: open pane, run a ping command, output renders', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      // Insert a doc so the navigator surfaces a user DB; opening a collection
      // tab is required for the Shell button to enable (the title-bar toggle
      // only un-disables when `shellAvailable = !!shellConnection`, which is
      // the Focused Tab's Connection gated on there being an open tab).
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Shell Target' },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'a' }] },
      );
      await expectStatusDot(win, 'Shell Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      // Toggle the shell pane via the title-bar button.
      // The button's accessible name is its visible text "Shell"; Mantine's
      // Tooltip surfaces the longer label via aria-describedby.
      // `exact` matters: this connection is named "Shell Target", and the
      // TitleBar's Connection name is itself a button (the Connection
      // Switcher trigger) sitting in the same title bar. Playwright's `name`
      // is a case-insensitive substring match by default, so without `exact`
      // this resolves to both buttons and fails strict mode.
      await win.getByRole('button', { name: 'Shell', exact: true }).click();

      // Shell input has a stable aria-label.
      const shellInput = win.locator('input[aria-label="Mongo shell input"]');
      await expect(shellInput).toBeVisible({ timeout: 10000 });

      // Wait for shell to be ready (placeholder switches from "starting…" to empty).
      await expect(shellInput).not.toHaveAttribute('placeholder', 'starting…', { timeout: 15000 });

      // Submit a ping command — Enter is the submit key (MongoShellPane.tsx:283).
      // The REPL doesn't auto-await Promises, so prefix `await` (the
      // existing IPC mongo-shell.e2e.ts uses the same incantation).
      await shellInput.fill('await db.runCommand({ ping: 1 })');
      await shellInput.press('Enter');

      // The output area renders `"ok": 1` once the result returns.
      await expect(win.getByText(/"ok":\s*1/).first()).toBeVisible({ timeout: 10000 });
    });
  });
});
