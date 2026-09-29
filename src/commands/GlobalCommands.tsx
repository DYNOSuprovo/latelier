import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../ThemeContext';
import { useSettings } from '../pages/SettingsContext';
import { AuditLogModal } from '../pages/AuditLogModal';
import { useRegisterCommands } from './useRegisterCommands';

/**
 * Registers commands available from every route: theme toggle, settings,
 * the audit log, navigation jumps, and `New connection`. Mount once near the
 * App root, inside the router and theme provider. Renders the audit log modal
 * itself, since nothing but this command opens it.
 */
export function GlobalCommands() {
  const navigate = useNavigate();
  const [, toggleTheme] = useTheme();
  const settings = useSettings();
  const [audit, setAudit] = useState<{ connectionId: string | null } | null>(null);

  useRegisterCommands(
    [
      {
        id: 'theme.toggle',
        title: 'Toggle dark mode',
        group: 'general',
        keywords: ['theme', 'dark', 'light'],
        perform: () => toggleTheme(),
      },
      {
        id: 'settings.open',
        title: 'Open settings',
        group: 'general',
        keywords: ['preferences', 'config'],
        perform: () => settings.open(),
      },
      {
        id: 'audit.open',
        title: 'Open audit log',
        group: 'general',
        keywords: ['history', 'operations', 'changes'],
        perform: (ctx) => setAudit({ connectionId: ctx.connectionId }),
      },
      {
        id: 'nav.workspace',
        title: 'Go to workspace',
        group: 'navigation',
        keywords: ['tabs', 'query'],
        // `connectionId` falls back to the Focused Tab's Connection off the deep
        // screen, so this also offers the jump from the Data View's
        // own empty state once a Connection exists — not just from
        // `/connections/:id`.
        when: (ctx) => ctx.pathname !== '/workspace' && ctx.connectionId !== null,
        perform: () => navigate('/workspace'),
      },
      {
        id: 'connection.new',
        title: 'New connection',
        group: 'connection',
        keywords: ['add', 'create'],
        shortcut: '⌘N',
        perform: () => navigate('/connections/new'),
      },
      {
        id: 'connection.edit',
        title: 'Edit selected connection',
        group: 'connection',
        keywords: ['modify'],
        // `connectionId` falls back to the Focused Tab's Connection off the deep
        // screen, so this is now also reachable from the Data View —
        // pass `returnTo` so saving/canceling lands back where the command
        // was invoked from, not always on the deep screen it used to be the
        // only way to reach this from.
        when: (ctx) => ctx.connectionId !== null,
        perform: (ctx) => {
          if (ctx.connectionId) {
            navigate(`/connections/${ctx.connectionId}/edit`, { state: { returnTo: ctx.pathname } });
          }
        },
      },
    ],
    [navigate, toggleTheme, settings],
  );

  return audit ? (
    <AuditLogModal initialConnectionId={audit.connectionId} onClose={() => setAudit(null)} />
  ) : null;
}
