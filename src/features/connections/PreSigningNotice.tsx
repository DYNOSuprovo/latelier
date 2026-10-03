import React from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { api } from '../../api/atelier';
import { useConnectionTransfer } from './ConnectionTransferProvider';

const DISMISSED_KEY = 'ui.notices.preSigningDismissed';
const TITLE = 'Export your connections before updating';

/**
 * X09 Phase 3 — the last unsigned release tells macOS users what the next
 * one changes. The signed build has a new app identity, and macOS ties the
 * saved passwords' keychain item to it, so they may not be readable after
 * the update: exporting with passwords now is the way to keep them.
 *
 * Shown once per launch until exported or dismissed for good; closing it
 * only defers it. Only with saved Connections, since otherwise there is
 * nothing to keep. Decided once at mount, so creating a Connection mid-session
 * never pops it up. Remove it from the signed release.
 */
export function PreSigningNotice() {
  const { openExport } = useConnectionTransfer();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!navigator.userAgent.includes('Mac')) return;
    let live = true;
    void Promise.all([api.prefs.get<boolean>(DISMISSED_KEY), api.conn.list()]).then(([dismissed, conns]) => {
      if (live && dismissed !== true && conns.length > 0) setOpen(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const dismiss = () => {
    setOpen(false);
    void api.prefs.set(DISMISSED_KEY, true);
  };

  return (
    <Modal opened={open} onClose={() => setOpen(false)} title={TITLE} centered size="md">
      <Stack gap="md">
        <Text size="sm">
          The next version may not be able to read the passwords saved by this one. Export your connections
          with their passwords now, and import the file if any go missing.
        </Text>
        <Text size="xs" c="dimmed">
          Also coming: the app is signed by Apple (no more security warning) and updates itself.
        </Text>
        <Group justify="space-between">
          <Button variant="subtle" size="compact-sm" onClick={dismiss}>
            Don&apos;t show again
          </Button>
          <Button
            size="compact-sm"
            data-autofocus
            onClick={() => {
              dismiss();
              openExport({ withSecrets: true });
            }}
          >
            Export connections
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
