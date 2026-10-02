import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { freshUserData, launchApp, startMemoryServer, stopAllMemoryServers } from '../helpers/e2eApp';
import { WorkspacePage } from './pages/WorkspacePage';

/**
 * C13 §7–8 — paste connection strings into the Connections table's "Add
 * connections" (one complete, one missing its credentials, one bad), type the
 * missing credentials, connect with them, then check both rows and delete
 * them in one batch without the table closing.
 */

type Atelier = {
  conn: {
    create: (input: unknown) => Promise<{ id: string }>;
    delete: (id: string) => Promise<unknown>;
    list: () => Promise<{ id: string; name: string; readOnly: boolean }[]>;
  };
  mongo: { connect: (id: string) => Promise<{ status: string }> };
  secrets: { setPlaintextFallback: (enabled: boolean) => Promise<{ enabled: boolean }> };
};

test.afterAll(stopAllMemoryServers);

test('add Connections from pasted strings, with typed credentials, then batch-delete them', async () => {
  const { host, port } = await startMemoryServer({
    auth: { enable: true, customRootName: 'admin', customRootPwd: 'rootpw' },
  });
  const dir = freshUserData();
  let app: ElectronApplication | null = null;

  try {
    app = await launchApp(dir);
    // 'Enable' is button 1 in main's plaintext-fallback warning.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // No OS keychain (Linux CI): opt into the plaintext fallback, as a user would.
    await win.evaluate(async (probe) => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      try {
        const c = await api.conn.create(probe);
        await api.conn.delete(c.id);
      } catch (err) {
        if ((err as { code?: string }).code !== 'SECRETS_UNAVAILABLE') throw err;
        await api.secrets.setPlaintextFallback(true);
      }
    }, {
      name: 'probe', color: '#1A6835', connectionType: 'standard', host, port,
      authMech: 'scram256', authUsername: 'u', password: 'p', tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 5000, socketTimeoutMs: 5000, serverSelectionTimeoutMs: 5000,
        readPreference: 'primary', maxPoolSize: 1, directConnection: true,
      },
    });

    const switcher = new WorkspacePage(win).switcher;
    await switcher.openExpandedTable();
    const table = switcher.expandedTableDialog;
    await table.getByRole('button', { name: '+ Add connections' }).click();

    const add = win.getByRole('dialog', { name: 'Add connections', exact: true });
    await add.getByRole('textbox', { name: 'Connection strings' }).fill(
      [
        `mongodb://admin:rootpw@${host}:${port}/?authSource=admin&serverSelectionTimeoutMS=5000`,
        `mongodb://${host}:${port}/?authSource=admin&serverSelectionTimeoutMS=5000`,
        'not a connection string',
      ].join('\n'),
    );
    const preview = add.getByRole('table', { name: 'Connections to add' });
    await expect(preview.getByText(host, { exact: true })).toBeVisible();
    await expect(preview.getByText(`${host} (2)`, { exact: true })).toBeVisible();
    await expect(preview.getByText('Line 3', { exact: true })).toBeVisible();
    await add.getByRole('checkbox', { name: 'Read-only' }).check();

    await add.getByRole('button', { name: 'Next' }).click();
    await add.getByRole('textbox', { name: `Username for ${host} (2)` }).fill('admin');
    await add.getByLabel(`Password for ${host} (2)`).fill('rootpw');
    await add.getByRole('button', { name: 'Add 2 connections' }).click();

    await expect(add.getByRole('status')).toHaveText('2 Connections added.');
    await expect(add.getByLabel('Secrets not stored')).toHaveCount(0);
    await add.getByRole('button', { name: 'Done' }).click();
    await expect(add).toBeHidden();

    // The table stayed open underneath, and now lists both.
    await expect(table.getByText(`${host} (2)`, { exact: true })).toBeVisible();
    const typed = await win.evaluate(async (name) => {
      const api = (window as unknown as { atelier: Atelier }).atelier;
      const rows = await api.conn.list();
      const row = rows.find((r) => r.name === name);
      if (!row) throw new Error(`${name} was not added: ${JSON.stringify(rows)}`);
      return { readOnly: row.readOnly, status: (await api.mongo.connect(row.id)).status };
    }, `${host} (2)`);
    expect(typed).toEqual({ readOnly: true, status: 'connected' });

    await table.getByRole('checkbox', { name: 'Check all shown connections' }).check();
    await table.getByRole('toolbar', { name: 'Checked connections' }).getByRole('button', { name: 'Delete…' }).click();
    const confirm = win.getByRole('dialog', { name: 'Delete 2 connections?' });
    await confirm.getByRole('textbox', { name: 'Confirm deletion' }).fill('delete 2');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(table.getByText('No connections yet')).toBeVisible();
    await expect(table).toBeVisible();
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
