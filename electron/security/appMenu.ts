import type { MenuItemConstructorOptions } from 'electron';

/**
 * The packaged app's menu: role-based App (macOS only), Edit and Window menus,
 * and deliberately no View menu — that is where the default template carries
 * Toggle Developer Tools and Reload. Edit must stay: on macOS the copy, paste
 * and select-all shortcuts are menu accelerators, and a null menu kills them.
 */
export function buildAppMenuTemplate(
  isMac: boolean,
  appName: string,
): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ label: appName, role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}
