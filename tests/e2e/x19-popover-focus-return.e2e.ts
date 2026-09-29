import { test, expect, type Page } from '@playwright/test';
import {
  baseConnInput,
  startMemoryServer,
  stopAllMemoryServers,
  withApp,
} from '../helpers/e2eApp';
import { WorkspacePage } from './pages';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectConsoleClean } from './helpers/uiAsserts';

test.afterAll(stopAllMemoryServers);

/**
 * #79 — a Popover that closes on a click landing on a non-focusable area
 * drops focus to `<body>` instead of returning it to the trigger. The
 * component suite (`fields-control.spec.tsx`, `connection-switcher.spec.tsx`)
 * covers this with a synthetic `<div>` click, which jsdom + `userEvent`
 * reproduces faithfully for the *click-outside* detection. What only a real
 * window can answer is the timing: whether Chromium's own mousedown default
 * action (blurring the focused element to `<body>` when the mousedown target
 * isn't focusable) actually races the fix the way the fix assumes.
 *
 * Finds a real on-screen point that isn't inside any focusable element,
 * dialog, popover dropdown, or draggable node — clicking it exercises the
 * exact gesture the bug report named ("click a plain area of the page"),
 * not a button or another control.
 */
async function findNonFocusablePoint(win: Page): Promise<{ x: number; y: number }> {
  const point = await win.evaluate(() => {
    const blocked = 'button,input,a,select,textarea,[tabindex],[role="dialog"],[contenteditable],.mantine-Popover-dropdown,[draggable]';
    for (let y = 5; y < innerHeight; y += 17) {
      for (let x = 5; x < innerWidth; x += 23) {
        const el = document.elementFromPoint(x, y);
        if (el && el !== document.body && !el.closest(blocked)) return { x, y };
      }
    }
    return null;
  });
  if (!point) throw new Error('no non-focusable point found on screen');
  return point;
}

test('popover focus return: a click on a non-focusable area returns focus to the trigger, not <body>', async () => {
  test.setTimeout(120_000);
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'P79' },
        { dbName: 'shop', collection: 'orders', docs: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
      );
      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');
      // The auto-run on open is the only query run. A second Run click used to
      // land its result mid-test on a slow CI runner, replacing `documents`
      // and resetting the active row (PR #122's shard 4).
      await ws.viewTableButton.click();

      // --- FieldsControl: uncontrolled Popover, `returnFocus` fix. ---
      const fieldsTrigger = win.getByRole('button', { name: 'Fields', exact: true });
      await expect(fieldsTrigger).toBeVisible();

      await fieldsTrigger.click();
      const moveDownButton = win.getByRole('button', { name: /^Move .* down$/ }).first();
      await expect(moveDownButton).toBeVisible();
      // Focus a control inside the dropdown first, so this proves the case
      // where focus sits *inside* the dropdown at close, not just the case
      // where it was never moved off the trigger.
      await moveDownButton.focus();

      const plainPoint1 = await findNonFocusablePoint(win);
      await win.mouse.click(plainPoint1.x, plainPoint1.y);
      await expect(fieldsTrigger).toBeFocused({ timeout: 5000 });

      // Guard: clicking another control instead keeps focus there, rather
      // than the fix unconditionally yanking it back to the trigger. Uses
      // the navigator's Refresh button — a real `<button>`, unlike the
      // Table/Tree/JSON switch, whose visible label sits over an sr-only
      // radio input and so never itself becomes `document.activeElement`.
      await fieldsTrigger.click();
      await expect(win.getByRole('button', { name: /^Move .* down$/ }).first()).toBeVisible();
      await ws.navigatorRefreshButton.click();
      await expect(ws.navigatorRefreshButton).toBeFocused({ timeout: 5000 });

      // --- ConnectionSwitcher: controlled Popover, deferred-check fix. ---
      const switcher = ws.switcher;
      await switcher.trigger.click();
      await expect(switcher.searchInput).toBeFocused({ timeout: 5000 });

      const plainPoint2 = await findNonFocusablePoint(win);
      await win.mouse.click(plainPoint2.x, plainPoint2.y);
      await expect(switcher.trigger).toBeFocused({ timeout: 5000 });
      // Wait for the real precondition before reopening — Mantine keeps the
      // dropdown mounted through its exit transition, so a bare re-click
      // right after the trigger-focused assertion can race the previous
      // dropdown's teardown and its search field's `autoFocus`.
      await expect(switcher.searchInput).toBeHidden();

      // Guard: clicking another control instead keeps focus there.
      await switcher.trigger.click();
      await expect(switcher.searchInput).toBeFocused({ timeout: 5000 });
      await fieldsTrigger.click();
      await expect(fieldsTrigger).toBeFocused({ timeout: 5000 });
    });
  });
});
