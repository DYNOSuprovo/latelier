import { test, expect } from '@playwright/test';
import { stopAllMemoryServers, withApp } from '../helpers/e2eApp';

test.afterAll(stopAllMemoryServers);

/**
 * Renderer hardening, asserted by behaviour rather than by configuration.
 *
 * Every check here reads what the browser actually enforces, never what
 * `main.ts` was asked to set. That distinction is the whole point: a
 * Content-Security-Policy served as a header is delivered by
 * `webRequest.onHeadersReceived`, and whether that fires at all depends on the
 * URL scheme the document was loaded from. Asserting the string we passed to
 * `callback()` would pass identically if the header never reached the document.
 *
 * This runs against the built bundle over `file://` — `run-e2e.sh` launches
 * without `VITE_DEV_SERVER_URL`, so `main.ts` takes the `loadFile` branch,
 * which is the same path a packaged app takes and the stricter of the two
 * policies.
 */

test('the shipped policy blocks a third-party connection from the renderer', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // `connect-src 'self'` is the directive that matters most for this app:
    // the renderer holds document contents from the user's cluster, and an
    // exfiltration attempt is a fetch to somewhere else. A blocked fetch
    // rejects with a TypeError before any network activity happens, so this
    // resolves fast and offline.
    const result = await win.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });

    expect(result).toBe('blocked');
  });
});

test('the renderer cannot open a window, and a foreign navigation is refused', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // setWindowOpenHandler denies, so window.open resolves to null rather than
    // a WindowProxy. A second BrowserWindow would also show up in app.windows().
    const opened = await win.evaluate(() => window.open('https://example.com/') !== null);
    expect(opened).toBe(false);
    expect(app.windows()).toHaveLength(1);

    // will-navigate prevents the default, so the document stays put. Asserting
    // the URL after the attempt is what proves the guard ran — a passing
    // `assign()` call would leave the app replaced by a remote page that still
    // holds the preload bridge.
    const before = await win.evaluate(() => location.href);
    await win.evaluate(() => {
      location.assign('https://example.com/');
    });
    await win.waitForTimeout(500);
    expect(await win.evaluate(() => location.href)).toBe(before);
  });
});

test('navigation is judged by parsed location, not by string prefix', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const before = await win.evaluate(() => location.href);

    // Two URLs a prefix test waves through.
    //
    // The first is a host smuggled behind a userinfo segment: everything before
    // the `@` is credentials, so this string starts with a dev-server URL while
    // its real origin is `http://evil.example`.
    //
    // The second is an arbitrary local file. `startsWith('file://')` accepts
    // every one of them, and so would an origin comparison — a file URL reports
    // its origin as the string "null", identically for the app document and for
    // anything else on disk.
    for (const url of [
      'http://localhost:5173@evil.example/',
      'file:///tmp/attacker.html',
    ]) {
      await win.evaluate((u) => {
        location.assign(u);
      }, url);
      await win.waitForTimeout(300);
      expect(await win.evaluate(() => location.href), url).toBe(before);
    }

    // The renderer is still the app, still wired: a denied navigation must not
    // leave a half-torn-down document behind.
    expect(await win.evaluate(() => typeof window.atelier)).toBe('object');
  });
});

test('the app still works under the policy — no CSP violation during boot', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();

    // A CSP that breaks the app fails silently: a blocked stylesheet or script
    // leaves a blank pane, not an exception. Chromium reports each refusal to
    // the console, so collecting those is the only way to see it.
    const violations: string[] = [];
    win.on('console', (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
    });

    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => document.fonts.ready);
    // The app renders its first real surface, not just an empty root.
    await expect(win.getByRole('banner')).toBeVisible({ timeout: 15_000 });

    expect(violations).toEqual([]);
  });
});

test('the renderer is denied every permission Electron would otherwise grant', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // With no handler installed Electron answers notifications and geolocation
    // as granted. Reading both the permission state and the request outcome
    // covers the check handler and the request handler separately.
    const result = await win.evaluate(async () => {
      const state = (await navigator.permissions.query({ name: 'notifications' })).state;
      const requested = await Notification.requestPermission();
      const geoCode = await new Promise<number>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(0),
          (err) => resolve(err.code),
        );
      });
      return { state, requested, geoCode };
    });

    expect(result.state).toBe('denied');
    expect(result.requested).toBe('denied');
    // PERMISSION_DENIED
    expect(result.geoCode).toBe(1);
  });
});

test('a window created later inherits the navigation guard', async () => {
  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // The guard is installed on `web-contents-created`, not on the main window
    // alone. A second window built outside createWindow() proves it: it never
    // went through any per-window setup.
    const denied = await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false });
      await w.loadURL('about:blank');
      const result = await w.webContents.executeJavaScript(
        "window.open('https://example.com') === null",
      );
      w.destroy();
      return result;
    });

    expect(denied).toBe(true);
  });
});
