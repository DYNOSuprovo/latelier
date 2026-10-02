import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type { ImportCommitResult, UriBatchDefaults, UriPreviewEntry } from '@shared/types';
import { api, getErrorMessage } from '../../api/atelier';
import { notifyConnectionsChanged } from '../../state/connections';
import { SubmitButton } from '../../components/SubmitButton';
import { REPICK_LABEL, plural } from './transferCopy';
import { TransferResult } from './TransferResult';

/** Mirrors the limits main enforces on `conn:previewUris` (C13 §7.1); main stays the authority. */
const MAX_LINES = 100;
const MAX_LINE_LENGTH = 4096;
const PREVIEW_DELAY_MS = 250;

type OkEntry = Extract<UriPreviewEntry, { ok: true }>;
interface Creds {
  username: string;
  password: string;
}

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * C13 §7 — adding Connections. Pasted connection strings (one per line) are
 * the main route; a file import and the full single-Connection form are one
 * click away, since both are ways of adding too.
 *
 * Steps: paste (live preview + batch defaults) → credentials (only the lines
 * missing a username or password) → result. Main parses every line, so no
 * connection string is interpreted here, and no password ever comes back.
 */
export function ConnectionAddDialog({
  onClose,
  onImportFile,
  onSingleForm,
}: {
  onClose: () => void;
  /** Leaves this dialog for the file-import flow. */
  onImportFile: () => void;
  /** Leaves this dialog for the full Connection form. */
  onSingleForm: () => void;
}) {
  const [text, setText] = React.useState('');
  const [defaults, setDefaults] = React.useState<UriBatchDefaults>({ readOnly: false, directConnection: false });
  // Keyed by the text it was made for, so a preview of older text is never shown or acted on.
  const [preview, setPreview] = React.useState<{ key: string; entries: UriPreviewEntry[]; error: string | null }>(
    { key: '', entries: [], error: null },
  );
  const [step, setStep] = React.useState<'paste' | 'credentials'>('paste');
  const [creds, setCreds] = React.useState<Record<number, Creds>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportCommitResult | null>(null);

  const lines = React.useMemo(() => linesOf(text), [text]);
  const linesKey = lines.join('\n');
  const tooMany = lines.length > MAX_LINES;
  const tooLong = lines.findIndex((l) => l.length > MAX_LINE_LENGTH);
  const localError = tooMany
    ? `Up to ${MAX_LINES} connection strings at a time.`
    : tooLong >= 0
      ? `Line ${tooLong + 1} is longer than ${MAX_LINE_LENGTH.toLocaleString()} characters.`
      : null;

  // Debounced: typing a connection string should not fire one parse per keystroke.
  React.useEffect(() => {
    if (lines.length === 0 || localError) return;
    let live = true;
    const t = window.setTimeout(() => {
      api.conn
        .previewUris(lines)
        .then((p) => live && setPreview({ key: linesKey, entries: p.entries, error: null }))
        .catch(
          (e) =>
            live &&
            setPreview({
              key: linesKey,
              entries: [],
              error: getErrorMessage(e, 'Could not read the connection strings'),
            }),
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // `linesKey` stands in for `lines`, which is a new array on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, localError]);

  const current = !localError && lines.length > 0 && preview.key === linesKey;
  const entries = current ? preview.entries : [];
  const previewError = current ? preview.error : null;
  const good = current ? entries.filter((e): e is OkEntry => e.ok) : [];
  const asking = good.filter((e) => e.needsCredentials);
  const credsFor = (e: OkEntry): Creds => creds[e.index] ?? { username: e.authUsername ?? '', password: '' };
  const orphanPassword = (e: OkEntry) => {
    const c = credsFor(e);
    return c.password !== '' && c.username.trim() === '';
  };
  const credsValid = asking.every((e) => !orphanPassword(e));

  const submit = async () => {
    if (busy || good.length === 0 || !credsValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.conn.createFromUris({
        uris: lines,
        defaults,
        credentials: asking.flatMap((e) => {
          const c = creds[e.index];
          if (!c) return [];
          return [{
            index: e.index,
            ...(c.username.trim() ? { username: c.username.trim() } : {}),
            ...(c.password ? { password: c.password } : {}),
          }];
        }),
      });
      setResult(res);
      if (res.created.length > 0) notifyConnectionsChanged();
    } catch (e) {
      setError(getErrorMessage(e, 'Could not add the connections'));
    } finally {
      setBusy(false);
    }
  };

  const addLabel = busy ? 'Adding…' : `Add ${plural(good.length, 'connection')}`;

  return (
    <Modal opened onClose={busy ? () => {} : onClose} title="Add connections" centered size="lg">
      <Stack gap="sm">
        {result ? (
          <TransferResult
            result={result}
            planned={good.map((e) => ({ index: e.index, name: e.savedAs, repick: e.repick }))}
            verb="added"
          />
        ) : step === 'paste' ? (
          <>
            <Textarea
              label="Connection strings"
              description="One per line. Each is named after its host."
              placeholder={'mongodb://user:password@db1.example.com:27017\nmongodb+srv://cluster0.example.mongodb.net'}
              rows={5}
              resize="vertical"
              size="xs"
              data-autofocus
              spellCheck={false}
              autoComplete="off"
              styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              error={localError ?? previewError ?? undefined}
            />
            {current && entries.length > 0 && <PreviewTable entries={entries} />}
            <Group gap="lg">
              <Checkbox
                size="xs"
                label="Read-only"
                checked={defaults.readOnly}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setDefaults((d) => ({ ...d, readOnly: on }));
                }}
              />
              <Checkbox
                size="xs"
                label="Direct connection"
                description="Not for SRV, or a string that sets it itself."
                checked={defaults.directConnection}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setDefaults((d) => ({ ...d, directConnection: on }));
                }}
              />
            </Group>
          </>
        ) : (
          <CredentialsStep entries={asking} credsFor={credsFor} orphanPassword={orphanPassword} onChange={setCreds} />
        )}
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="space-between" gap="xs">
          <Group gap={4}>
            {!result && step === 'paste' && (
              <>
                <Button variant="subtle" size="compact-xs" onClick={onImportFile}>
                  Import from file…
                </Button>
                <Button variant="subtle" size="compact-xs" onClick={onSingleForm}>
                  Single connection (full form)…
                </Button>
              </>
            )}
          </Group>
          <Group gap="xs">
            {result ? (
              <Button size="compact-xs" onClick={onClose}>
                Done
              </Button>
            ) : step === 'paste' ? (
              <>
                <Button variant="subtle" size="compact-xs" onClick={onClose}>
                  Cancel
                </Button>
                {asking.length > 0 ? (
                  <Button size="compact-xs" disabled={good.length === 0} onClick={() => setStep('credentials')}>
                    Next
                  </Button>
                ) : (
                  <SubmitButton
                    size="compact-xs"
                    submitting={busy}
                    disabled={good.length === 0}
                    onClick={() => void submit()}
                  >
                    {addLabel}
                  </SubmitButton>
                )}
              </>
            ) : (
              <>
                <Button variant="subtle" size="compact-xs" onClick={() => setStep('paste')} disabled={busy}>
                  Back
                </Button>
                <SubmitButton
                  size="compact-xs"
                  submitting={busy}
                  disabled={!credsValid}
                  onClick={() => void submit()}
                >
                  {addLabel}
                </SubmitButton>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function PreviewTable({ entries }: { entries: UriPreviewEntry[] }) {
  return (
    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
      <Table fz="xs" verticalSpacing={4} aria-label="Connections to add">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Saved as</Table.Th>
            <Table.Th>Host</Table.Th>
            <Table.Th>Notes</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((e) =>
            e.ok ? (
              <Table.Tr key={e.index}>
                <Table.Td fw={600}>{e.savedAs}</Table.Td>
                <Table.Td style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {e.srv ? e.host : `${e.host}:${e.port}`}
                  {e.srv && <Badge size="xs" variant="light" ml={6}>SRV</Badge>}
                </Table.Td>
                <Table.Td>
                  {[
                    e.needsCredentials ? 'asks for credentials next' : null,
                    ...e.repick.map((r) => REPICK_LABEL[r]),
                    ...e.warnings,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Table.Td>
              </Table.Tr>
            ) : (
              <Table.Tr key={e.index}>
                <Table.Td c="red">Line {e.index + 1}</Table.Td>
                <Table.Td colSpan={2} c="red">
                  Skipped: {e.reason}
                </Table.Td>
              </Table.Tr>
            ),
          )}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function CredentialsStep({
  entries,
  credsFor,
  orphanPassword,
  onChange,
}: {
  entries: OkEntry[];
  credsFor: (e: OkEntry) => Creds;
  orphanPassword: (e: OkEntry) => boolean;
  onChange: React.Dispatch<React.SetStateAction<Record<number, Creds>>>;
}) {
  const set = (e: OkEntry, patch: Partial<Creds>) =>
    onChange((prev) => ({ ...prev, [e.index]: { ...credsFor(e), ...patch } }));
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        These connection strings have no username or password. Leave both blank for a server without
        authentication.
      </Text>
      {entries.map((e, i) => {
        const c = credsFor(e);
        return (
          <Group key={e.index} gap="xs" align="flex-start" wrap="nowrap">
            <Text size="xs" fw={600} w={180} pt={6} style={{ overflowWrap: 'anywhere' }}>
              {e.savedAs}
            </Text>
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              aria-label={`Username for ${e.savedAs}`}
              placeholder="Username"
              autoComplete="off"
              data-autofocus={i === 0 ? true : undefined}
              value={c.username}
              onChange={(ev) => set(e, { username: ev.currentTarget.value })}
              error={orphanPassword(e) ? 'Add a username for this password.' : undefined}
            />
            <PasswordInput
              size="xs"
              style={{ flex: 1 }}
              aria-label={`Password for ${e.savedAs}`}
              placeholder="Password"
              autoComplete="new-password"
              value={c.password}
              onChange={(ev) => set(e, { password: ev.currentTarget.value })}
            />
          </Group>
        );
      })}
    </Stack>
  );
}
