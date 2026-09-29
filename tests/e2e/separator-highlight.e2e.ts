import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { baseConnInput, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';

const here = path.dirname(fileURLToPath(import.meta.url));

test.afterAll(stopAllMemoryServers);

/**
 * the builder and shell splitters were painted `transparent` inline
 * with no hover or active state, so they were invisible at rest and gave no
 * feedback while being dragged. The navigator's bespoke `ResizeHandle` had
 * highlighted on both since long before.
 *
 * This has to be an e2e. The fix is a `[data-separator]:hover/:active` rule,
 * and jsdom implements neither pseudo-class — a component test cannot tell
 * the fixed code from the broken code. It also cannot tell whether the
 * highlight survives the drag, which is the half the user actually noticed:
 * `react-resizable-panels` takes pointer capture on the separator, so the
 * pointer leaves the 4px strip almost immediately once you start dragging.
 */
test('panel splitters highlight on hover and stay lit through a drag', async () => {
  const { host, port } = await startMemoryServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));

  const app = await electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: { ...process.env, ATELIER_USER_DATA_DIR: userDataDir, NODE_ENV: 'test' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Seed a collection tab so the builder split is on screen at all.
    // Connected, not just created — X16.5 renders a "not connected"
    // placeholder instead of the builder pane for a Dormant Connection, and
    // this test's subject (the resize separator) only exists on the real pane.
    await win.evaluate(async (input) => {
      const api = (window as unknown as {
        atelier: {
          conn: { create: (i: unknown) => Promise<{ id: string }> };
          mongo: { connect: (id: string) => Promise<unknown> };
          tabs: {
            openCollection: (input: {
              connectionId: string;
              dbName: string;
              collection: string;
            }) => Promise<{ id: string }>;
          };
        };
      }).atelier;
      const c = await api.conn.create(input);
      await api.mongo.connect(c.id);
      await api.tabs.openCollection({
        connectionId: c.id,
        dbName: 'db',
        collection: 'orders',
      });
    }, baseConnInput(host, port));
    await win.reload();
    await win.waitForLoadState('domcontentloaded');

    const separator = win.getByRole('separator', { name: 'Resize Query Builder' });
    await expect(separator).toBeVisible({ timeout: 15_000 });

    // Resolve `--atelier-accent` through a probe rather than hardcoding a hex:
    // the token differs between light and dark, and `getComputedStyle` reports
    // the separator's background as rgb(), not as the var reference.
    const accent = await win.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--atelier-accent)';
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    expect(accent).not.toBe('rgba(0, 0, 0, 0)');

    const background = () =>
      separator.evaluate((el) => getComputedStyle(el).backgroundColor);

    // At rest: transparent, so the splitter does not draw a line across the UI.
    await win.mouse.move(0, 0);
    expect(await background()).toBe('rgba(0, 0, 0, 0)');

    // Hover: lit. Aimed near the top of the strip rather than at its centre —
    // the builder pane's collapse notch is vertically centred and
    // half-protrudes over the separator, so `hover()` lands on the notch's
    // chevron and never reaches the separator at all.
    const box = await separator.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + 20;
    // Polled rather than read once: the rule carries a 120ms transition, so an
    // immediate read catches the colour at t=0 and reports the resting value
    // against perfectly good code.
    await win.mouse.move(cx, cy);
    await expect.poll(background).toBe(accent);

    // Drag: still lit once the pointer is well clear of the 4px strip. This is
    // the assertion that fails if the highlight is keyed off `:hover` — the
    // library takes pointer capture on pointerdown, so the pointer is off the
    // strip for all but the first instant of a real drag.
    await win.mouse.down();
    await win.mouse.move(cx - 120, cy);
    // Waited out deliberately, not polled. Polling would pass on the first
    // sample against broken code — the handle is still lit from the hover and
    // only fades over the following 120ms. Sampling once, after the transition
    // could have completed, is what makes this assertion mean anything.
    await win.waitForTimeout(300);
    expect(await background()).toBe(accent);
    await win.mouse.up();

    // Released and pointer parked away: back to transparent. The drag leaves
    // the separator focused, so this is what fails if the focus highlight is
    // keyed off `[data-separator='focus']` — the handle would stay lit until
    // the user clicked something else.
    await win.mouse.move(0, 0);
    await expect.poll(background).toBe('rgba(0, 0, 0, 0)');

    // Keyboard resize still gets an indicator. The Tab is not navigation — it
    // is what puts Chromium in keyboard modality, which is the condition
    // `:focus-visible` keys off. Focusing the separator without it reproduces
    // the mouse case and the handle correctly stays dark.
    await win.keyboard.press('Tab');
    await separator.focus();
    await expect.poll(background).toBe(accent);
    // And it is genuinely the resize control while focused.
    const before = await separator.getAttribute('aria-valuenow');
    await win.keyboard.press('ArrowLeft');
    await expect.poll(() => separator.getAttribute('aria-valuenow')).not.toBe(before);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
