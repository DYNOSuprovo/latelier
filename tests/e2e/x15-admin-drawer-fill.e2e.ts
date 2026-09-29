import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { ConnectionSwitcherPage, WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * X15 — the admin drawers' bodies need a flex context.
 *
 * Both `CreateIndexDrawer` and `UserDrawer` put a scrolling region above a
 * footer and size it with `flex: 1`. Mantine's `Drawer.Body` is a plain padded
 * block, so without the `styles={{ content, body }}` column the region takes
 * its content height, `overflowY: auto` never engages, and a long form pushes
 * the footer off the bottom of the drawer.
 *
 * This has to be e2e. jsdom does no layout — every `getBoundingClientRect()`
 * there returns zeroes — so deleting either `styles` block leaves all 19 of
 * the component cases for these drawers green. Same reason
 * `x15-drawer-body-fill.e2e.ts` exists for the Document Editor and the fill assertion
 * in `a06-explain-plan.e2e.ts` exists for `ExplainDrawer`.
 *
 * These two tabs had no e2e coverage of any kind before this.
 */
test('the admin drawers fill their panel', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const name = 'Admin Drawers';
    await seedActiveConnectionWithDocs(
      win,
      { ...baseConnInput(host, port), name },
      { dbName: 'shop', collection: 'orders', docs: [{ sku: 'a' }] },
    );
    await expectStatusDot(win, name, 'connected');

    const fillOf = () =>
      win.evaluate(() => {
        const content = document.querySelector('.mantine-Drawer-content') as HTMLElement;
        const body = content?.querySelector('.mantine-Drawer-body') as HTMLElement | null;
        if (!content || !body) return 0;
        return (body.getBoundingClientRect().height / content.getBoundingClientRect().height) * 100;
      });

    // ── Indexes ─────────────────────────────────────────────────────────
    // The Indexes surface moved off the Connection Manager and into the
    // collection tab's Structure sub-view (W16 Tier 2, ADR 0003) —
    // namespace-scoped, no DB/collection picker.
    const ws = new WorkspacePage(win);
    await ws.openCollectionFromNavigator('shop', 'orders');
    await win.getByRole('tab', { name: /Structure/ }).click();
    await win.getByRole('button', { name: /New index/ }).first().click();
    await expect(win.getByRole('dialog', { name: /New index/ })).toBeVisible({ timeout: 8000 });
    expect(await fillOf()).toBeGreaterThan(50);
    await win.getByRole('dialog', { name: /New index/ }).getByRole('button', { name: 'Close' }).click();

    // ── Users ───────────────────────────────────────────────────────────
    // The deep detail screen is reached only via "Manage" (ADR 0001).
    const switcher = new ConnectionSwitcherPage(win);
    await switcher.ensureOpen();
    await switcher.waitVisible();
    await switcher.manage(name);
    await win.getByRole('button', { name: 'Users', exact: true }).click();
    // "+ New user" is disabled until a specific database is picked — the
    // default is "All databases" (`UsersTab.tsx:272`).
    await win.getByLabel('Database').selectOption('shop');
    await win.getByRole('button', { name: /New user/ }).first().click();
    // The title carries the database: `New user (shop)`.
    await expect(win.getByRole('dialog', { name: /New user/ })).toBeVisible({ timeout: 8000 });
    expect(await fillOf()).toBeGreaterThan(50);
  });
});
