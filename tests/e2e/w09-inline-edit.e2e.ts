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
 * T2.6 / W18 §8 — in-place cell editing in the Table view. Writes a
 * single-field guarded `$set` (the Document Editor's own save path) via
 * `api.doc.updateOne`, without opening the Document Editor. Proves, end to
 * end, that only the edited field changes and every other field on the
 * document survives untouched.
 */
test('table inline edit: hover pencil -> edit one cell -> only that field changes', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Inline Edit Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ _id: 30, sku: 'multi-field', status: 'pending', qty: 5 }],
        },
      );
      await expectStatusDot(win, 'Inline Edit Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('multi-field')).toBeVisible({ timeout: 8000 });

      // Switch to the Table view — the inline-edit affordance is Table-only.
      await ws.viewTableButton.click();
      const statusCell = win.getByTitle(/Drag to add "status/);
      await expect(statusCell).toBeVisible({ timeout: 8000 });

      await statusCell.hover();
      await statusCell.getByRole('button', { name: 'Edit cell value' }).click();

      const input = statusCell.getByRole('textbox');
      await input.fill('shipped');
      await input.press('Enter');

      // Re-run happens automatically on a successful update (Workspace.tsx's
      // `updateField`) — the edited field changes...
      await expect(win.getByText('shipped')).toBeVisible({ timeout: 8000 });
      // ...and the untouched fields survive: the load-bearing $set proof.
      await expect(win.getByText('multi-field')).toBeVisible();
      await expect(win.getByRole('gridcell', { name: /^5\b/ })).toBeVisible();
    });
  });
});

/**
 * W18 §8 — a boolean cell shows an always-on toggle rather than the
 * pencil-into-text-input flow: no separate "editing" state, no Enter/Escape
 * — flipping the checkbox is the whole interaction, and it writes through
 * the same guarded save path as the string case above.
 */
test('table inline edit: a boolean cell toggles and saves without opening an editor', async () => {
  const { host, port } = await startMemoryServer();

  await withApp(async (app) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expectConsoleClean(win, async () => {
      const conn = await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: 'Boolean Inline Edit Target' },
        {
          dbName: 'shop',
          collection: 'orders',
          docs: [{ _id: 31, sku: 'flag-doc', active: true }],
        },
      );
      await expectStatusDot(win, 'Boolean Inline Edit Target', 'connected');

      const ws = new WorkspacePage(win);
      await ws.openCollectionFromNavigator('shop', 'orders');

      await ws.queryBarRunButton.click();
      await expect(win.getByText('flag-doc')).toBeVisible({ timeout: 8000 });

      await ws.viewTableButton.click();
      const activeCell = win.getByTitle(/Drag to add "active/);
      await expect(activeCell).toBeVisible({ timeout: 8000 });

      // No pencil for a boolean cell — the toggle is always there.
      await expect(activeCell.getByRole('button', { name: 'Edit cell value' })).toHaveCount(0);
      const toggle = activeCell.getByRole('checkbox', { name: 'Edit active' });
      await expect(toggle).toBeChecked();

      await toggle.click();

      // The toggle disables itself while the write is in flight (W18 §8's
      // in-flight guard) and re-enables once the post-write re-run lands —
      // not merely once the write itself settles, which would still be
      // showing the optimistic value even on a failed save.
      await expect(toggle).toBeEnabled({ timeout: 8000 });

      // The load-bearing proof: the document actually persisted the flip,
      // not just the optimistic checkbox state.
      const doc = await win.evaluate(async (cid) => {
        const api = (window as unknown as {
          atelier: {
            query: {
              find: (i: {
                connectionId: string;
                dbName: string;
                collection: string;
                filter: string;
                limit: number;
                skip: number;
              }) => Promise<{ documents: Array<{ active?: boolean }> }>;
            };
          };
        }).atelier;
        const res = await api.query.find({
          connectionId: cid,
          dbName: 'shop',
          collection: 'orders',
          filter: '{"_id":31}',
          limit: 1,
          skip: 0,
        });
        return res.documents[0];
      }, conn.id);
      expect(doc?.active).toBe(false);
    });
  });
});
