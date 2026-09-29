import React from 'react';
import { Alert, Button, Checkbox, Group, List, Modal, NativeSelect, Progress, ScrollArea, Stack, Table, Text } from '@mantine/core';
import type {
  CsvColumnMapping,
  CsvColumnType,
  CsvPreview,
  DataImportInput,
  DataImportProgressEvent,
  ImportReport,
} from '@shared/types';
import { api, getErrorMessage } from '../../api/atelier';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { offerUndo } from './offerUndo';

interface ImportDialogProps {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Known only to the navigator; the workspace host learns it from main's refusal. */
  readOnly?: boolean;
  onClose: () => void;
  /** Called once the import has run, while the dialog stays open on its report. */
  onImported: (report: ImportReport) => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

// Main settles the format by the same extension test.
const CSV_FILE = /\.csv$/i;

const TYPE_OPTIONS: { value: CsvColumnType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'objectId', label: 'ObjectId' },
  { value: 'skip', label: 'Skip' },
];

interface CsvStep {
  path: string;
  preview: CsvPreview;
  columns: CsvColumnMapping[];
}

const columnName = (header: string) => header || '(no name)';

/**
 * Import a JSON array, JSONL or CSV file into an existing collection: pick a
 * file, map a CSV's columns to types, run the import, show what landed and
 * what didn't. Props-driven rather than
 * reading the collection workspace, because the navigator hosts it too.
 */
export function ImportDialog({
  connectionId,
  dbName,
  collection,
  readOnly = false,
  onClose,
  onImported,
  returnFocusTo,
}: ImportDialogProps) {
  const close = useDialogFocusReturn(onClose, returnFocusTo);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const [progress, setProgress] = React.useState<DataImportProgressEvent | null>(null);
  const [csv, setCsv] = React.useState<CsvStep | null>(null);
  const cancelTokenRef = React.useRef<string | null>(null);
  const unsubscribeRef = React.useRef<(() => void) | null>(null);

  // The import keeps running in main even if this component unmounts (e.g.
  // the workspace tab closes mid-import), so this only stops listening —
  // it never cancels the run.
  React.useEffect(() => () => unsubscribeRef.current?.(), []);

  const startRun = (): string => {
    setError(null);
    setRunning(true);
    setProgress(null);
    const cancelToken = crypto.randomUUID();
    cancelTokenRef.current = cancelToken;
    unsubscribeRef.current = api.data.onImportProgress((evt) => {
      if (evt.cancelToken === cancelToken) setProgress(evt);
    });
    return cancelToken;
  };

  const endRun = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    cancelTokenRef.current = null;
    setRunning(false);
    setProgress(null);
  };

  const importPath = async (path: string, cancelToken: string, mapping?: DataImportInput['csv']) => {
    const result = await api.data.import({
      connectionId, dbName, collection, path, cancelToken, ...(mapping ? { csv: mapping } : {}),
    });
    setCsv(null);
    setReport(result);
    onImported(result);
    // No toast when nothing landed — `result.auditId` is only set when
    // something did (offerUndo no-ops on undefined either way).
    offerUndo(`${plural(result.inserted, 'document')} imported from ${result.fileName}`, result.auditId, () =>
      onImported(result),
    );
  };

  const chooseAndImport = async () => {
    const cancelToken = startRun();
    try {
      const { path } = await api.app.pickFile('data-import');
      if (path === null) return; // cancelled picker: stay open, nothing ran
      if (CSV_FILE.test(path)) {
        // A CSV stops at its mapping step; `importCsv` runs it.
        const preview = await api.data.previewCsv({ path });
        setReport(null);
        setCsv({
          path,
          preview,
          columns: preview.headers.map((header, i) => ({ header, type: preview.inferred[i] ?? 'string', emptyAsNull: false })),
        });
        return;
      }
      setCsv(null);
      await importPath(path, cancelToken);
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed'));
    } finally {
      endRun();
    }
  };

  // A failed run keeps the mapping step up, so a clashing or mistyped
  // column can be changed and the import tried again.
  const importCsv = async (step: CsvStep) => {
    const cancelToken = startRun();
    try {
      await importPath(step.path, cancelToken, { columns: step.columns });
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed'));
    } finally {
      endRun();
    }
  };

  const setColumn = (index: number, patch: Partial<CsvColumnMapping>) =>
    setCsv((step) => step && { ...step, columns: step.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const cancelImport = () => {
    const token = cancelTokenRef.current;
    if (token) void api.data.cancelImport({ token });
  };

  const at = (n: number) => {
    if (report?.format === 'json') return `Index ${n}`;
    return report?.format === 'csv' ? `Row ${n}` : `Line ${n}`;
  };

  return (
    <Modal
      opened
      // The import keeps running in main whatever the dialog does, so it
      // stays up until the report is in.
      onClose={running ? () => {} : close}
      withCloseButton={!running}
      title={`Import into "${collection}"`}
      centered
      size={csv ? 'xl' : 'md'}
    >
      <Stack gap="sm">
        {report === null ? (
          running ? (
            <Stack gap={4}>
              <Progress
                value={progress && progress.totalBytes > 0 ? Math.min(100, (progress.bytesRead / progress.totalBytes) * 100) : 0}
                size="sm"
                aria-label="Import progress"
              />
              <Group justify="space-between" gap="xs">
                <Text size="xs" c="dimmed">
                  {progress ? `${plural(progress.inserted, 'document')} imported` : 'Starting…'}
                </Text>
                <Button variant="subtle" size="compact-xs" onClick={cancelImport}>
                  Cancel import
                </Button>
              </Group>
            </Stack>
          ) : csv ? (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                The first {plural(csv.preview.rows.length, 'row')} of {csv.preview.fileName}. Each column&apos;s type
                was inferred from the whole file; change any before importing. A dotted header nests, and an empty cell
                leaves its field out unless Empty → null is ticked.
              </Text>
              <ScrollArea.Autosize mah={360} type="auto">
                <Table withTableBorder withColumnBorders fz="xs" aria-label={`Preview of ${csv.preview.fileName}`}>
                  <Table.Thead>
                    <Table.Tr>
                      {csv.columns.map((c, i) => (
                        <Table.Th key={i} miw={120}>
                          <Stack gap={4}>
                            <Text size="xs" fw={600} ff="monospace">{columnName(c.header)}</Text>
                            <NativeSelect
                              size="xs"
                              aria-label={`Type of ${columnName(c.header)}`}
                              data={TYPE_OPTIONS}
                              value={c.type}
                              onChange={(e) => setColumn(i, { type: e.currentTarget.value as CsvColumnType })}
                            />
                            <Checkbox
                              size="xs"
                              label="Empty → null"
                              aria-label={`Empty ${columnName(c.header)} as null`}
                              checked={c.emptyAsNull}
                              disabled={c.type === 'skip'}
                              onChange={(e) => setColumn(i, { emptyAsNull: e.currentTarget.checked })}
                            />
                          </Stack>
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {csv.preview.rows.map((row, r) => (
                      <Table.Tr key={r}>
                        {csv.columns.map((_c, i) => <Table.Td key={i}>{row[i] ?? ''}</Table.Td>)}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
            </Stack>
          ) : (
            <Text size="xs" c="dimmed">
              A JSON array or JSONL file of Extended JSON documents (canonical or relaxed), or a CSV file with a header
              row, into {dbName}.{collection}.
            </Text>
          )
        ) : (
          <>
            <Text size="sm" role="status">
              {report.cancelled ? 'Cancelled — ' : 'Imported '}
              {plural(report.inserted, 'document')}{report.cancelled ? ' landed' : ''} from {report.fileName}
              {report.failed > 0 ? `; ${plural(report.failed, 'document')} failed.` : '.'}
            </Text>
            {report.errors.length > 0 && (
              <ScrollArea.Autosize mah={220} type="auto">
                <List size="xs" spacing={2} aria-label="Import failures">
                  {report.errors.map((e) => (
                    <List.Item key={e.at}>
                      <Text span size="xs" ff="monospace">{at(e.at)}:</Text> {e.message}
                    </List.Item>
                  ))}
                </List>
              </ScrollArea.Autosize>
            )}
            {report.errorsTruncated && (
              <Text size="xs" c="dimmed">
                Only the first {report.errors.length} failures are listed.
              </Text>
            )}
          </>
        )}
        {readOnly && (
          <Alert color="yellow" variant="light" role="alert">
            This connection is read-only. Importing is disabled.
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={running}>
            {report === null ? 'Cancel' : 'Close'}
          </Button>
          {csv && !running && (
            <Button variant="default" size="compact-xs" onClick={() => void chooseAndImport()} disabled={readOnly}>
              Choose another file…
            </Button>
          )}
          <SubmitButton
            size="compact-xs"
            submitting={running}
            disabled={readOnly}
            onClick={() => void (csv ? importCsv(csv) : chooseAndImport())}
          >
            {running ? 'Importing…' : csv ? 'Import' : report === null ? 'Choose file…' : 'Import another file…'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
