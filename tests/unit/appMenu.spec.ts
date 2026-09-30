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

  it('keeps the edit and window menus that carry the keyboard shortcuts', () => {
    for (const isMac of [true, false]) {
      expect(roles(buildAppMenuTemplate(isMac, 'App'))).toEqual(
        expect.arrayContaining(['editMenu', 'windowMenu']),
      );
    }
  });

  it('adds the labelled app menu on macOS only, first', () => {
    const mac = buildAppMenuTemplate(true, 'L Atelier');
    expect(mac.map((i) => i.role)).toEqual(['appMenu', 'editMenu', 'windowMenu']);
    expect(mac[0].label).toBe('L Atelier');
    expect(buildAppMenuTemplate(false, 'L Atelier').map((i) => i.role)).toEqual([
      'editMenu',
      'windowMenu',
    ]);
  });
});
