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
 * C13 §7 — adding Connections from pasted connection strings, one per line.
 * The table's footer offers the full form and the file import beside it.
 *
 * Steps: paste (live preview + batch defaults) → credentials (only the lines
 * missing a username or password) → result. Main parses every line, so no
 * connection string is interpreted here, and no password ever comes back.
 */
export function ConnectionAddDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = React.useState('');
  const [defaults, setDefaults] = React.useState<UriBatchDefaults>({ readOnly: false, directConnection: false });
  // Keyed by the text it was made for, so a preview of older text is never shown or acted on.
  const [preview, setPreview] = React.useState<{ key: string; entries: UriPreviewEntry[]; error: string | null }>(
    { key: '', entries: [], error: null },
  );
  const [step, setStep] = React.useState<'paste' | 'credentials'>('paste');
  // Keyed by the connection string and which copy of it this is, not by line
  // number: going Back and deleting or reordering lines must never move a
  // password onto another host, and two identical lines still get one each.
  const [creds, setCreds] = React.useState<Record<string, Creds>>({});
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
  const credsKey = (e: OkEntry) => {
    const line = lines[e.index]!;
    // A line holds no newline, so this cannot collide with another line's key.
    return `${line}\n${lines.slice(0, e.index).filter((l) => l === line).length}`;
  };
  const credsFor = (e: OkEntry): Creds => creds[credsKey(e)] ?? { username: e.authUsername ?? '', password: '' };
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
          const c = creds[credsKey(e)];
          if (!c) return [];
          // The username always goes when the row was touched: blank is the
          // user saying "no authentication", not "keep the string's".
          return [{ index: e.index, username: c.username.trim(), ...(c.password ? { password: c.password } : {}) }];
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

  const addLabel = busy ? 'Adding…' : good.length === 0 ? 'Add' : `Add ${plural(good.length, 'connection')}`;

  return (
    <Modal opened onClose={busy ? () => {} : onClose} title="Paste URIs" centered size="lg">
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
              // `data-autofocus` only acts when the modal opens; this covers coming Back.
              autoFocus
              spellCheck={false}
              autoComplete="off"
              styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              error={localError ?? previewError ?? undefined}
            />
            <Group gap="xl" align="flex-start">
              <Checkbox
                size="xs"
                label="Read-only"
                description="No writes from the app."
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
            {current && entries.length > 0 && <PreviewTable entries={entries} />}
          </>
        ) : (
          <CredentialsStep
            entries={asking}
            credsFor={credsFor}
            orphanPassword={orphanPassword}
            onChange={(e, patch) => setCreds((prev) => ({ ...prev, [credsKey(e)]: { ...credsFor(e), ...patch } }))}
          />
        )}
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
            {result ? (
              <Button size="compact-xs" onClick={onClose} autoFocus>
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
  onChange: (e: OkEntry, patch: Partial<Creds>) => void;
}) {
  const set = onChange;
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        These connection strings have no username or password. Leave both blank for a server without
        authentication.
      </Text>
      {entries.map((e, i) => {
        const c = credsFor(e);
        const host = e.srv ? e.host : `${e.host}:${e.port}`;
        return (
          <Group key={e.index} gap="xs" align="flex-start" wrap="nowrap">
            <div style={{ width: 180, flexShrink: 0, paddingTop: 6, overflowWrap: 'anywhere' }}>
              <Text size="xs" fw={600}>{e.savedAs}</Text>
              {/* Only when the name alone would not say which server this is, e.g. "host (2)". */}
              {host !== e.savedAs && e.host !== e.savedAs && (
                <Text size="xs" c="dimmed" ff="monospace" truncate="end" title={host}>{host}</Text>
              )}
            </div>
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              aria-label={`Username for ${e.savedAs}`}
              placeholder="Username"
              autoComplete="off"
              autoFocus={i === 0}
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
