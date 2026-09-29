import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { RecentQueryService } from '../../services/RecentQueryService.ts';
import type { RecentFieldValueService } from '../../services/RecentFieldValueService.ts';

const RecentKindSchema = z.enum(['find', 'aggregation']);

const ListInputSchema = z.object({
  connectionId: NonEmpty.optional(),
  dbName: NonEmpty.optional(),
  collection: NonEmpty.optional(),
  kind: RecentKindSchema.optional(),
  limit: z.number().int().min(1).optional(),
}).optional();

const GetInputSchema = z.object({ id: NonEmpty });

const ClearInputSchema = z.object({
  id: NonEmpty.optional(),
  connectionId: NonEmpty.optional(),
  dbName: NonEmpty.optional(),
  collection: NonEmpty.optional(),
  kind: RecentKindSchema.optional(),
}).optional();

// Mirrors `shared/types.ts`'s `ValType` union. No shared zod schema exists
// for it yet — every other channel sends the compiled filter as an opaque
// EJSON string, not structured conditions.
const ValTypeSchema = z.enum([
  'string', 'number', 'long', 'decimal', 'boolean', 'date', 'null', 'regex', 'objectid', 'array',
]);

const ValuesForFieldInputSchema = CollectionTargetSchema.extend({
  field: NonEmpty,
  limit: z.number().int().min(1).max(100).optional(),
});

const RecordFieldValuesInputSchema = CollectionTargetSchema.extend({
  entries: z.array(z.object({
    field: NonEmpty,
    value: NonEmpty,
    valType: ValTypeSchema,
    op: NonEmpty,
  })).min(1),
});

export function registerRecentChannels(
  router: Router,
  svc: RecentQueryService,
  fieldValueSvc: RecentFieldValueService,
): void {
  router.register(
    IPC_CHANNELS.recentList,
    zodValidator(ListInputSchema),
    (input) => svc.list(input ?? {}),
  );

  router.register(
    IPC_CHANNELS.recentGet,
    zodValidator(GetInputSchema),
    ({ id }) => svc.get(id),
  );

  router.register(
    IPC_CHANNELS.recentClear,
    zodValidator(ClearInputSchema),
    (input) => svc.clear(input ?? {}),
  );

  router.register(
    IPC_CHANNELS.recentValuesForField,
    zodValidator(ValuesForFieldInputSchema),
    ({ connectionId, dbName, collection, field, limit }) => ({
      values: fieldValueSvc.listForField(connectionId, dbName, collection, field, limit),
    }),
  );

  router.register(
    IPC_CHANNELS.recentRecordFieldValues,
    zodValidator(RecordFieldValuesInputSchema),
    ({ connectionId, dbName, collection, entries }) =>
      fieldValueSvc.recordMany(connectionId, dbName, collection, entries),
  );

  router.register(
    IPC_CHANNELS.recentClearFieldValues,
    zodValidator(z.object({}).optional()),
    () => fieldValueSvc.clearAll(),
  );
}
