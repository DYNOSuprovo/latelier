import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate } from '../../electron/security/appMenu.ts';
import type { MenuCommand } from '../../shared/ipc.ts';

const noop = () => {};

function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((i) => [
    ...(i.role ? [i.role] : []),
    ...(Array.isArray(i.submenu) ? roles(i.submenu) : []),
  ]);
}

describe('buildAppMenuTemplate', () => {
  it('has no developer-tools or reload entry on either platform', () => {
    for (const isMac of [true, false]) {
      const all = roles(buildAppMenuTemplate(isMac, 'App', noop));
      for (const banned of ['viewMenu', 'toggleDevTools', 'reload', 'forceReload']) {
        expect(all, `${isMac} ${banned}`).not.toContain(banned);
      }
    }
  });

  it('keeps zoom and full screen in a trimmed View menu', () => {
    for (const isMac of [true, false]) {
      const template = buildAppMenuTemplate(isMac, 'App', noop);
      const view = template.find((i) => i.label === 'View');
      expect(roles(view?.submenu as MenuItemConstructorOptions[])).toEqual([
        'resetZoom',
        'zoomIn',
        'zoomOut',
        'togglefullscreen',
      ]);
      expect(view?.submenu).toEqual([
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ]);
      // Between Edit and Window, as in the default menu order.
      const order = template.map((i) => i.role ?? i.label);
      expect(order.slice(-3)).toEqual(['editMenu', 'View', 'windowMenu']);
    }
  });

  it('keeps the edit and window menus that carry the keyboard shortcuts', () => {
    for (const isMac of [true, false]) {
      expect(roles(buildAppMenuTemplate(isMac, 'App', noop))).toEqual(
        expect.arrayContaining(['editMenu', 'windowMenu']),
      );
    }
  });

  it('adds the labelled app menu on macOS only, first', () => {
    const mac = buildAppMenuTemplate(true, 'L Atelier', noop);
    expect(mac.map((i) => i.role ?? i.label)).toEqual([
      'appMenu',
      'File',
      'editMenu',
      'View',
      'windowMenu',
    ]);
    expect(mac[0].label).toBe('L Atelier');
    expect(buildAppMenuTemplate(false, 'L Atelier', noop).map((i) => i.role ?? i.label)).toEqual([
      'File',
      'editMenu',
      'View',
      'windowMenu',
    ]);
  });

  it('puts Export and Import Connections in a File menu that fires the matching command', () => {
    for (const isMac of [true, false]) {
      const fired: MenuCommand[] = [];
      const template = buildAppMenuTemplate(isMac, 'App', (c) => fired.push(c));
      const file = template.find((i) => i.label === 'File');
      const items = file?.submenu as MenuItemConstructorOptions[];
      expect(items.map((i) => i.label)).toEqual(['Export Connections…', 'Import Connections…']);
      for (const item of items) (item.click as () => void)();
      expect(fired, `isMac=${isMac}`).toEqual(['connections.export', 'connections.import']);
    }
  });
});
