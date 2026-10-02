import { test, expect } from '@playwright/test';
import { withApp } from '../helpers/e2eApp';

/**
 * GAP 6 — first true UI-driven E2E. The four older E2E files all bypass the
 * UI and call `window.atelier` directly via `win.evaluate`, so they verify
 * the IPC bridge but cannot catch:
 *   - A broken Vite chunk hash in the packaged build (renderer fails to
 *     load main script).
 *   - A React render-time crash that an `ErrorBoundary` swallows silently.
 *   - A missing public asset / CSS that breaks the layout.
 *   - A console.error stream during boot that's invisible until a real user
 *     opens devtools.
 *
 * This test launches the packaged app, waits for the renderer to settle,
 * verifies the Connections shell rendered, and asserts there were no
 * console errors during boot.
 */
test('renderer mounts the Data View with no console errors', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();

    // Capture every console message starting from the very first paint.
    // `win.on('console', …)` only catches messages emitted after this hook
    // is attached, but since we attach immediately after `firstWindow()`
    // resolves and the renderer is still loading, we cover the full boot.
    const errors: string[] = [];
    win.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Filter favicon and devtools-only noise — they're not regressions
      // and they vary per platform.
      if (/favicon|DevTools/i.test(text)) return;
      errors.push(text);
    });

    // Catch unhandled exceptions surfaced from the renderer.
    const pageErrors: string[] = [];
    win.on('pageerror', (err) => pageErrors.push(err.message));

    await win.waitForLoadState('domcontentloaded');

    // the Data View is the app's home now. Its TitleBar Connection
    // Switcher trigger ("Connection: none selected" on a fresh, zero-
    // connection launch) is the stable anchor a fresh boot always renders.
    // Waiting for it to be visible is a deterministic mount signal; we
    // intentionally avoid `networkidle` since persistent IPC subscriptions
    // (theme broadcaster, status events) make it non-deterministic.
    const trigger = win.getByRole('button', { name: /^Connection:/ });
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Opening it renders the popover's listbox and "Manage connections…" row —
    // both always present, even with zero saved Connections.
    await trigger.click();
    const listbox = win.locator('[role="listbox"][aria-label="Connections"]');
    await expect(listbox).toBeVisible({ timeout: 5000 });
    const manageButton = win.getByRole('button', { name: 'Manage connections…' });
    await expect(manageButton).toBeVisible();

    // React must actually have populated #root.
    const rootHasChildren = await win.evaluate(() => {
      const root = document.getElementById('root');
      return Boolean(root && root.childElementCount > 0);
    });
    expect(rootHasChildren).toBe(true);

    expect(
      errors,
      `unexpected console.error during renderer boot:\n${errors.join('\n')}`,
    ).toEqual([]);
    expect(
      pageErrors,
      `unhandled renderer exception:\n${pageErrors.join('\n')}`,
    ).toEqual([]);
  });
});
