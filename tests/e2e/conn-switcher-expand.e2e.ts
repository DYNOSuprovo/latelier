import { test, expect } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnection, seedConnection } from './helpers/uiSeed';
import { expectStatusDot } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * the expanded Connections table, driven in a real Electron window.
 *
 * The component suite covers the branching (search, selection, footer
 * enablement, keyboard row selection). What only a real window can answer is
 * whether the surface actually renders and lays out — a 70rem Modal hosting a
 * Mantine `Table` inside a scroll container, with a four-button footer —
 * since jsdom never measures anything.
 */
test('expanded table: opens from Manage connections, searches, selects a row, and connects', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const switcher = new WorkspacePage(win).switcher;

    // X16.1 — `seedActiveConnection` chooses the Connection in the
    // Switcher, which opens and then closes the popover — seed first, then
    // open it.
    const alpha = await seedActiveConnection(win, {
      ...baseConnInput(host, port),
      name: 'Alpha Cluster',
    });
    expect(alpha.id).toBeTruthy();
    await switcher.waitVisible();
    await expect(switcher.item('Alpha Cluster')).toBeVisible({ timeout: 8000 });
    await seedConnection(win, { ...baseConnInput(host, port), name: 'Beta Cluster' });
    await expect(switcher.item('Beta Cluster')).toBeVisible({ timeout: 8000 });

    await switcher.openExpandedTable();

    // Expanding closes the popover — the two are never on screen together.
    await expect(switcher.listbox).toHaveCount(0);
    await expect(switcher.expandedTableRow('Alpha Cluster')).toBeVisible();
    await expect(switcher.expandedTableRow('Beta Cluster')).toBeVisible();

    // Regression: Mantine's `FocusTrap` (which `Modal` wraps its body in)
    // looks for `[data-autofocus]` and only falls back to "first tabbable
    // element" — the Modal's own header close button, rendered before the
    // body — when it finds none. The React `autoFocus` prop sets a plain DOM
    // attribute the trap never looks at, so this only proves anything in a
    // real focus trap, not jsdom.
    await expect(switcher.expandedTableSearch).toBeFocused({ timeout: 5000 });

    // no footer to disable: nothing is selected yet, so Connect isn't
    // rendered on any row.
    await expect(switcher.expandedTableRowAction('Alpha Cluster', 'Connect')).toHaveCount(0);

    await switcher.expandedTableSearch.fill('beta');
    await expect(switcher.expandedTableRow('Alpha Cluster')).toHaveCount(0);
    await expect(switcher.expandedTableRow('Beta Cluster')).toBeVisible();

    await switcher.expandedTableRow('Beta Cluster').click();
    await expect(switcher.expandedTableRowAction('Beta Cluster', 'Connect')).toBeVisible();
    // Selecting reveals detail inline, in place — the table never narrows to
    // make room for it.
    await expect(switcher.expandedTableDialog.getByText(/Default DB/i)).toBeVisible({
      timeout: 5000,
    });

    await switcher.expandedTableRowAction('Beta Cluster', 'Connect').click();

    // Connect connects and closes the table, same destination the popover's
    // own row click reaches. X16.4 — it opens no tab, so the landing
    // signal is the row's own status, not the TitleBar naming it.
    await expect(switcher.expandedTableDialog).toHaveCount(0);
    await expectStatusDot(win, 'Beta Cluster', 'connected');
  });
});

/**
 * "Every Connection is comparable at a glance" (the issue's own justification
 * for this surface) only holds if the columns stay legible once there are
 * enough rows to scroll — a header that scrolls away with row 1 leaves every
 * row past the fold unlabeled. Only a real window can prove this: jsdom never
 * lays anything out, so the component suite cannot tell a `position: sticky`
 * header that actually stays put from one that silently scrolled off.
 */
test('expanded table: the column header stays visible once there are enough rows to scroll', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const switcher = new WorkspacePage(win).switcher;

    // X16.1 — `seedActiveConnection` chooses the Connection in the
    // Switcher, which opens and then closes the popover — seed first, then
    // open it.
    const first = await seedActiveConnection(win, {
      ...baseConnInput(host, port),
      name: 'Connection 00',
    });
    expect(first.id).toBeTruthy();
    await switcher.waitVisible();
    for (let i = 1; i < 14; i++) {
      await seedConnection(win, {
        ...baseConnInput(host, port),
        name: `Connection ${String(i).padStart(2, '0')}`,
      });
    }
    await expect(switcher.item('Connection 13')).toBeVisible({ timeout: 8000 });

    await switcher.openExpandedTable();

    const nameHeader = switcher.expandedTableDialog.getByRole('columnheader', { name: 'Name' });
    await expect(nameHeader).toBeInViewport();

    // Scroll the last row into view — well past where the header would sit
    // in normal document flow — and confirm it is still on screen.
    await switcher.expandedTableRow('Connection 13').scrollIntoViewIfNeeded();
    await expect(nameHeader).toBeInViewport();
    await expect(switcher.expandedTableRow('Connection 13')).toBeInViewport();

    // Regression: Mantine `Modal`'s own `returnFocus` can't restore focus to
    // the popover's "Manage connections" button — it's already unmounted (closing the
    // popover is what opened this table, per ADR 0001) — so without this
    // table returning focus itself, Escape would strand a keyboard user at
    // `<body>`, the top of the Data View's tab order.
    const trigger = switcher.trigger;
    await win.keyboard.press('Escape');
    await expect(switcher.expandedTableDialog).toHaveCount(0);
    await expect(trigger).toBeFocused({ timeout: 5000 });
  });
});

/**
 * Regression: the table's focus-return-to-trigger is wired to `Modal`'s own
 * `onClose` specifically — not a plain unmount effect — because footer
 * actions unmount this table too, straight into another modal in the same
 * commit. Edit is that case: `editFromExpandedTable` closes the table and
 * opens `ConnectionFormModal` together. An unmount-keyed return would race
 * the form's own focus trap for a coin-flip winner; only a real window can
 * settle who actually wins a race between two live focus traps — jsdom
 * never contests a `.focus()` call the way a browser's focus manager does.
 */
test('expanded table: Edit hands focus to the Connection form, not back to the trigger', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const switcher = new WorkspacePage(win).switcher;

    // X16.1 — `seedActiveConnection` chooses the Connection in the
    // Switcher, which opens and then closes the popover — seed first, then
    // open it.
    const alpha = await seedActiveConnection(win, {
      ...baseConnInput(host, port),
      name: 'Alpha Cluster',
    });
    expect(alpha.id).toBeTruthy();
    await switcher.waitVisible();
    await expect(switcher.item('Alpha Cluster')).toBeVisible({ timeout: 8000 });

    await switcher.openExpandedTable();

    await switcher.expandedTableRow('Alpha Cluster').click();
    await switcher.expandedTableRowAction('Alpha Cluster', 'Edit').click();

    const formDialog = win.getByRole('dialog', { name: 'Edit Connection' });
    await expect(formDialog).toBeVisible({ timeout: 8000 });
    await expect(switcher.trigger).not.toBeFocused();
  });
});
