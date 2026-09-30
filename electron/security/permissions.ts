import type { Session } from 'electron';

/**
 * The only permission the renderer may hold. Electron's default answers most
 * permission requests (notifications, geolocation, ...) as granted, and this
 * app needs none of them. `clipboard-sanitized-write` is what
 * `navigator.clipboard.writeText` asks for — every copy button goes through it
 * — so a blanket deny would break copy. `clipboard-read` stays denied: the
 * renderer has no reason to read what the user copied elsewhere.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

export function installPermissionHandlers(
  ses: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}
