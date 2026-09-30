import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConnectionService } from '../../mongo/ConnectionService.ts';
import type { Router } from '../router.ts';
import { IdInputSchema, NonEmpty, zodValidator } from '../validators.ts';
import {
  ConnectionInputSchema,
  ConnectionTestInputSchema,
  ConnectionUpdateSchema,
  ParseUriInputSchema,
} from '../schemas/connection.ts';

const UpdateInput = z.object({
  id: NonEmpty,
  patch: ConnectionUpdateSchema,
});

export function registerConnChannels(router: Router, svc: ConnectionService): void {
  router.register(
    IPC_CHANNELS.connList,
    zodValidator(z.undefined().or(z.null()).optional()),
    () => svc.list(),
  );

  router.register(
    IPC_CHANNELS.connGet,
    zodValidator(IdInputSchema),
    ({ id }) => svc.get(id),
  );

  // SECRET_INPUT: 'conn:create' payload carries plaintext password / ssh credentials.
  router.register(
    IPC_CHANNELS.connCreate,
    zodValidator(ConnectionInputSchema),
    (input) => svc.create(input),
  );

  // SECRET_INPUT: 'conn:update' patch may carry plaintext secrets.
  router.register(
    IPC_CHANNELS.connUpdate,
    zodValidator(UpdateInput),
    ({ id, patch }) => svc.update(id, patch),
  );

  router.register(
    IPC_CHANNELS.connDelete,
    zodValidator(IdInputSchema),
    async ({ id }) => {
      await svc.delete(id);
      return { id };
    },
  );

  router.register(
    IPC_CHANNELS.connTouchUsed,
    zodValidator(IdInputSchema),
    ({ id }) => {
      svc.touchUsed(id);
      return { id };
    },
  );

  // SECRET_INPUT: 'conn:parseUri' payload is a full URI that may embed credentials.
  router.register(
    IPC_CHANNELS.connParseUri,
    zodValidator(ParseUriInputSchema),
    ({ uri }) => svc.parseUri(uri),
  );

  // SECRET_INPUT: 'conn:test' payload carries plaintext credentials.
  router.register(
    IPC_CHANNELS.connTest,
    zodValidator(ConnectionTestInputSchema),
    (input) => svc.test(input),
  );
}
