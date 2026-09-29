import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { DocumentService } from '../../mongo/DocumentService.ts';

const InsertSchema = CollectionTargetSchema.extend({
  docJson: NonEmpty,
});

const InsertManySchema = CollectionTargetSchema.extend({
  docsJson: NonEmpty,
});

const UpdateOneSchema = CollectionTargetSchema.extend({
  filterJson: NonEmpty,
  updateJson: NonEmpty,
});

const FilterOnlySchema = CollectionTargetSchema.extend({
  filterJson: NonEmpty,
});

const DeleteManySchema = CollectionTargetSchema.extend({
  filterJson: NonEmpty,
  confirmToken: NonEmpty,
});

const ConfirmUpdateManySchema = UpdateOneSchema;

const UpdateManySchema = UpdateOneSchema.extend({
  confirmToken: NonEmpty,
});

export function registerDocChannels(router: Router, svc: DocumentService): void {
  router.register(
    IPC_CHANNELS.docInsert,
    zodValidator(InsertSchema),
    (input) => svc.insert(input),
  );

  router.register(
    IPC_CHANNELS.docInsertMany,
    zodValidator(InsertManySchema),
    (input) => svc.insertMany(input),
  );

  router.register(
    IPC_CHANNELS.docUpdateOne,
    zodValidator(UpdateOneSchema),
    (input) => svc.updateOne(input),
  );

  router.register(
    IPC_CHANNELS.docDeleteOne,
    zodValidator(FilterOnlySchema),
    (input) => svc.deleteOne(input),
  );

  router.register(
    IPC_CHANNELS.docConfirmDeleteMany,
    zodValidator(FilterOnlySchema),
    (input) => svc.confirmDeleteMany(input),
  );

  router.register(
    IPC_CHANNELS.docDeleteMany,
    zodValidator(DeleteManySchema),
    (input) => svc.deleteMany(input),
  );

  router.register(
    IPC_CHANNELS.docConfirmUpdateMany,
    zodValidator(ConfirmUpdateManySchema),
    (input) => svc.confirmUpdateMany(input),
  );

  router.register(
    IPC_CHANNELS.docUpdateMany,
    zodValidator(UpdateManySchema),
    (input) => svc.updateMany(input),
  );
}
