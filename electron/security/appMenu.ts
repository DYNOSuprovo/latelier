import type { MenuItemConstructorOptions } from 'electron';

/**
 * The packaged app's menu: role-based App (macOS only), Edit, a trimmed View
 * and Window. The default View menu is replaced, not kept: it carries Toggle
 * Developer Tools and Reload, but it is also the only source of zoom
 * (Cmd/Ctrl +, -, 0) and full screen, and the app has no zoom of its own, so
 * those four stay. Edit must stay too: on macOS the copy, paste and select-all
 * shortcuts are menu accelerators, and a null menu kills them.
 */
export function buildAppMenuTemplate(
  isMac: boolean,
  appName: string,
): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ label: appName, role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
