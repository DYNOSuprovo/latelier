import { z } from 'zod';
import type { WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { ImportService } from '../../mongo/ImportService.ts';
import type { DataImportProgressEvent } from '@shared/types';
import { ValidationError } from '../../errors.ts';

const CsvColumnSchema = z.object({
  header: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'objectId', 'skip']),
  emptyAsNull: z.boolean(),
});

// The path is only shape-checked by the schema; the handler then refuses any
// path main's own open dialog didn't return, and `ImportService` re-validates
// it (absolute, allowed extension, a regular file) before reading, and checks
// the column mapping against the file's own header row.
const ImportSchema = CollectionTargetSchema.extend({
  path: NonEmpty,
  cancelToken: NonEmpty.optional(),
  csv: z.object({ columns: z.array(CsvColumnSchema) }).optional(),
});

const PreviewCsvSchema = z.object({
  path: NonEmpty,
});

const CancelInputSchema = z.object({
  token: NonEmpty,
});

/**
 * `pickedImports` is the set `registerAppChannels` fills from the open
 * dialog. A renderer is trusted to hand back a file the user picked, never to
 * choose one: without this, any `.json`/`.csv` path on disk could be read
 * into a collection or back out through the CSV preview.
 */
export function registerDataChannels(router: Router, svc: ImportService, pickedImports: ReadonlySet<string>): void {
  const assertPicked = (path: string): void => {
    if (!pickedImports.has(path)) {
      throw new ValidationError('only a file chosen in the import dialog can be read', { field: 'path' });
    }
  };

  router.register(
    IPC_CHANNELS.dataImport,
    zodValidator(ImportSchema),
    (input) => {
      assertPicked(input.path);
      return svc.importFile(input);
    },
  );

  router.register(
    IPC_CHANNELS.dataPreviewCsv,
    zodValidator(PreviewCsvSchema),
    ({ path }) => {
      assertPicked(path);
      return svc.previewCsv(path);
    },
  );

  router.register(
    IPC_CHANNELS.dataCancelImport,
    zodValidator(CancelInputSchema),
    ({ token }) => {
      svc.cancel(token);
      return undefined;
    },
  );
}

/**
 * Build the `emit` callback `ImportService` uses to push progress events to
 * the renderer. Same shape as `mshell.ts`'s `makeMshellEmitter` — lives here,
 * next to the channel name.
 */
export function makeDataEmitter(
  getWebContents: () => WebContents | null,
): (event: DataImportProgressEvent) => void {
  return (event) => {
    const wc = getWebContents();
    if (!wc || wc.isDestroyed()) return;
    wc.send(IPC_CHANNELS.dataImportProgressEvent, event);
  };
}
