import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConnectionExportService } from '../../services/ConnectionExportService.ts';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';
import { MAX_URI_LENGTH, MAX_URI_LINES } from '../../services/connectionBulkAdd.ts';

/** The Export Passphrase floor (C13 §2); the renderer enforces the same and the entry-twice rule. */
const MIN_PASSPHRASE_LENGTH = 12;

const ExportInput = z
  .strictObject({
    ids: z.array(NonEmpty).min(1),
    includeSecrets: z.boolean(),
    passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).optional(),
  })
  .refine((v) => !v.includeSecrets || v.passphrase !== undefined, {
    path: ['passphrase'],
    message: 'An Export Passphrase is required to include passwords',
  });

const PreviewInput = z.undefined().or(z.null()).or(z.strictObject({}));

const CommitInput = z.strictObject({
  token: NonEmpty,
  indices: z.array(z.number().int().min(0)).min(1),
  passphrase: z.string().min(1).optional(),
  withoutSecrets: z.boolean().optional(),
});

const Uris = z.array(z.string().min(1).max(MAX_URI_LENGTH)).min(1).max(MAX_URI_LINES);

const PreviewUrisInput = z.strictObject({ uris: Uris });

const CreateFromUrisInput = z.strictObject({
  uris: Uris,
  defaults: z.strictObject({ readOnly: z.boolean(), directConnection: z.boolean() }),
  credentials: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(MAX_URI_LINES - 1),
        username: z.string().max(128).optional(),
        password: z.string().optional(),
      }),
    )
    .max(MAX_URI_LINES),
});

/**
 * Kept apart from `conn.ts` so that file's signature and its test fixtures stay
 * as they are. Neither the file's path nor any decrypted secret is in any
 * payload or result: main owns the dialogs and the file.
 */
export function registerConnExportChannels(router: Router, svc: ConnectionExportService): void {
  // SECRET_INPUT: 'conn:export' payload carries the Export Passphrase.
  router.register(IPC_CHANNELS.connExport, zodValidator(ExportInput), (input) =>
    svc.export(input),
  );

  router.register(IPC_CHANNELS.connImportPreview, zodValidator(PreviewInput), () =>
    svc.importPreview(),
  );

  // SECRET_INPUT: 'conn:importCommit' payload carries the Export Passphrase.
  router.register(IPC_CHANNELS.connImportCommit, zodValidator(CommitInput), (input) =>
    svc.importCommit(input),
  );

  // SECRET_INPUT: 'conn:previewUris' payload is connection strings that may embed passwords.
  router.register(IPC_CHANNELS.connPreviewUris, zodValidator(PreviewUrisInput), ({ uris }) =>
    svc.previewUris(uris),
  );

  // SECRET_INPUT: 'conn:createFromUris' payload carries connection strings and typed passwords.
  router.register(IPC_CHANNELS.connCreateFromUris, zodValidator(CreateFromUrisInput), (input) =>
    svc.createFromUris(input),
  );
}
