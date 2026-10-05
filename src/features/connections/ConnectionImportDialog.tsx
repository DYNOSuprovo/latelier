import React from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, PasswordInput, Stack, Table, Text } from '@mantine/core';
import type { ImportCommitResult, ImportPreview } from '@shared/types';
import { api, getErrorMessage, isIpcError } from '../../api/atelier';
import { notifyConnectionsChanged } from '../../state/connections';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { REPICK_LABEL } from './transferCopy';
import { TransferResult } from './TransferResult';

type Preview = Extract<ImportPreview, { token: string }>;
interface Done {
  result: ImportCommitResult;
  preview: Preview;
}

/**
 * Connection Import: pick a file (main opens the dialog and validates it),
 * review what will be saved and under which names, enter the Export
 * Passphrase if the file has secrets, then create the ticked Connections.
 */
export function ConnectionImportDialog({ onClose }: { onClose: () => void }) {
  const close = useDialogFocusReturn(onClose);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [ticked, setTicked] = React.useState<Set<number>>(new Set());
  const [passphrase, setPassphrase] = React.useState('');
  const [passphraseError, setPassphraseError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Done | null>(null);

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.conn.importPreview();
      if ('cancelled' in res) return;
      setPreview(res);
      setTicked(new Set(res.entries.map((e) => e.index)));
      setPassphrase('');
      setPassphraseError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not read the file'));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (withoutSecrets: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setPassphraseError(null);
    try {
      const result = await api.conn.importCommit({
        token: preview.token,
        indices: preview.entries.map((e) => e.index).filter((i) => ticked.has(i)),
        ...(withoutSecrets ? { withoutSecrets: true } : preview.hasSecrets ? { passphrase } : {}),
      });
      setDone({ result, preview });
      notifyConnectionsChanged();
    } catch (e) {
      // A wrong passphrase keeps the file's token in main, so the form stays editable for a retry.
      if (isIpcError(e) && e.code === 'BAD_PASSPHRASE') setPassphraseError('Wrong Export Passphrase.');
      else {
        setError(getErrorMessage(e, 'Import failed'));
        // Rows may have been created before the failure; the list must not stay stale.
        notifyConnectionsChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const noneTicked = ticked.size === 0;

  return (
    <Modal opened onClose={busy ? () => {} : close} title="Import Connections" centered size="lg">
      <Stack gap="sm">
        {done ? (
          <TransferResult
            result={done.result}
            planned={done.preview.entries.map((e) => ({ index: e.index, name: e.name, repick: e.repick }))}
            verb="imported"
          />
        ) : preview ? (
          <>
            <Table withTableBorder fz="xs" aria-label="Connections in the file">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={28} />
                  <Table.Th>Saved as</Table.Th>
                  <Table.Th>Files to pick again</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.entries.map((e) => (
                  <Table.Tr key={e.index}>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        aria-label={`Import ${e.name}`}
                        checked={ticked.has(e.index)}
                        onChange={(ev) => {
                          const on = ev.currentTarget.checked;
                          setTicked((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(e.index);
                            else next.delete(e.index);
                            return next;
                          });
                        }}
                      />
                    </Table.Td>
                    <Table.Td>
                      {e.savedAs === e.name ? (
                        e.name
                      ) : (
                        <Text span size="xs" fw={600} c="orange">
                          {e.name} → {e.savedAs}
                        </Text>
                      )}{' '}
                      {e.hasSecrets && <Badge size="xs" variant="light">passwords</Badge>}
                    </Table.Td>
                    <Table.Td>{e.repick.map((r) => REPICK_LABEL[r]).join(', ')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {preview.hasSecrets && (
              <PasswordInput
                label="Export Passphrase"
                size="xs"
                autoComplete="off"
                data-autofocus
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.currentTarget.value);
                  setPassphraseError(null);
                }}
                error={passphraseError}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && passphrase !== '' && !noneTicked && !busy) void commit(false);
                }}
              />
            )}
          </>
        ) : (
          <Text size="xs" c="dimmed">
            Choose a Connection Export file. Nothing is written until you confirm.
          </Text>
        )}
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && preview && preview.hasSecrets && (
            <Button
              variant="default"
              size="compact-xs"
              disabled={busy || noneTicked}
              onClick={() => void commit(true)}
            >
              Import without passwords
            </Button>
          )}
          {!done &&
            (preview ? (
              <SubmitButton
                size="compact-xs"
                submitting={busy}
                disabled={noneTicked || (preview.hasSecrets && passphrase === '')}
                onClick={() => void commit(false)}
              >
                {busy ? 'Importing…' : 'Import'}
              </SubmitButton>
            ) : (
              <SubmitButton size="compact-xs" submitting={busy} onClick={() => void choose()}>
                Choose file…
              </SubmitButton>
            ))}
        </Group>
      </Stack>
    </Modal>
  );
}
