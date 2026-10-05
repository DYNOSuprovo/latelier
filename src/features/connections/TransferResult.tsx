import { Alert, List, Stack, Text } from '@mantine/core';
import type { ImportCommitResult, RepickFile } from '@shared/types';
import { REPICK_LABEL, plural } from './transferCopy';

/**
 * What an import or a connection-string add actually did. `planned` is what
 * the preview listed, keyed by position: names are re-planned at commit and
 * can differ from the preview, which is what "renamed" reports.
 */
export function TransferResult({
  result,
  planned,
  verb,
}: {
  result: ImportCommitResult;
  planned: { index: number; name: string; repick: RepickFile[] }[];
  verb: 'imported' | 'added';
}) {
  const entryAt = new Map(planned.map((e) => [e.index, e]));
  const renamed = result.created.flatMap((c) => {
    const original = entryAt.get(c.index)?.name;
    return original !== undefined && original !== c.name ? [{ index: c.index, from: original, to: c.name }] : [];
  });
  const repicks = result.created.flatMap((c) => {
    const files = entryAt.get(c.index)?.repick ?? [];
    return files.length > 0 ? [{ index: c.index, name: c.name, files }] : [];
  });
  return (
    <Stack gap="xs">
      <Text size="sm" role="status">
        {plural(result.created.length, 'Connection')} {verb}.
      </Text>
      {result.failed.length > 0 && (
        <Alert color="red" variant="light" role="alert" title={`Not ${verb}`}>
          <List size="xs" spacing={2} aria-label={`Connections not ${verb}`}>
            {result.failed.map((f) => (
              <List.Item key={f.index}>
                {f.name}: {f.reason}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {renamed.length > 0 && (
        <List size="xs" spacing={2} aria-label="Renamed Connections">
          {renamed.map((r) => (
            <List.Item key={r.index}>
              {r.from} → {r.to}
            </List.Item>
          ))}
        </List>
      )}
      {repicks.length > 0 && (
        <List size="xs" spacing={2} aria-label="Files to pick again">
          {repicks.map((r) => (
            <List.Item key={r.index}>
              {r.name}: {r.files.map((f) => REPICK_LABEL[f]).join(', ')}
            </List.Item>
          ))}
        </List>
      )}
      {result.secretsNotStored.length > 0 && (
        <List size="xs" spacing={2} aria-label="Secrets not stored">
          {result.secretsNotStored.map((s) => (
            <List.Item key={`${s.name}/${s.reason}`}>
              {s.name}: {s.reason}
            </List.Item>
          ))}
        </List>
      )}
    </Stack>
  );
}
