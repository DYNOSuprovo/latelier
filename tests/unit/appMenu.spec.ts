import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate } from '../../electron/security/appMenu.ts';

function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((i) => [
    ...(i.role ? [i.role] : []),
    ...(Array.isArray(i.submenu) ? roles(i.submenu) : []),
  ]);
}

describe('buildAppMenuTemplate', () => {
  it('has no developer-tools or reload entry on either platform', () => {
    for (const isMac of [true, false]) {
      const all = roles(buildAppMenuTemplate(isMac, 'App'));
      for (const banned of ['viewMenu', 'toggleDevTools', 'reload', 'forceReload']) {
        expect(all, `${isMac} ${banned}`).not.toContain(banned);
      }
    }
  });

  it('keeps zoom and full screen in a trimmed View menu', () => {
    for (const isMac of [true, false]) {
      const template = buildAppMenuTemplate(isMac, 'App');
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
      expect(roles(buildAppMenuTemplate(isMac, 'App'))).toEqual(
        expect.arrayContaining(['editMenu', 'windowMenu']),
      );
    }
  });

  it('adds the labelled app menu on macOS only, first', () => {
    const mac = buildAppMenuTemplate(true, 'L Atelier');
    expect(mac.map((i) => i.role ?? i.label)).toEqual([
      'appMenu',
      'editMenu',
      'View',
      'windowMenu',
    ]);
    expect(mac[0].label).toBe('L Atelier');
    expect(buildAppMenuTemplate(false, 'L Atelier').map((i) => i.role ?? i.label)).toEqual([
      'editMenu',
      'View',
      'windowMenu',
    ]);
  });
});
