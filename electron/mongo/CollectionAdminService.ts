import type {
  CollectionCreateInput,
  CollectionCreateOptions,
  CollectionDropInput,
  CollectionRenameInput,
  DatabaseDropInput,
} from '@shared/types';
import { ejsonParse } from './ejson.ts';
import { classifyMongoOpError } from './errors.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import type { MongoPool } from './MongoPool.ts';
import { ADMIN_LONG_TIMEOUT_MS, STATS_TIMEOUT_MS } from './timeouts.ts';
import { attachUndo } from './undo.ts';

/**
 * Structural admin operations on collections and databases (T1.1) —
 * createCollection / dropCollection / renameCollection / dropDatabase via the
 * driver's `Db` handle. There is no SQLite repo here: these are Mongo admin
 * ops, not app-local state.
 */
export class CollectionAdminService {
  private pool: MongoPool;

  constructor(pool: MongoPool) {
    this.pool = pool;
  }

  async create(input: CollectionCreateInput): Promise<{ name: string }> {
    const w = this.pool.write(input.connectionId);
    validateCollectionName(input.collection);
    const opts = buildCreateCollectionOptions(input.options);
    const db = await w.db(input.dbName);

    // `db.createCollection(name, opts)` only throws NamespaceExists (48) when
    // the requested options differ from the existing collection's — probed
    // live against mongodb 7.2.0 / MongoDB 7.x (mongodb-memory-server):
    // calling it twice with *identical* options (both `{}`, the common "New
    // collection" default) silently no-ops and returns the existing handle
    // with no error at all. Pre-check existence so a duplicate name always
    // surfaces as CONFLICT instead of a confusing silent no-op in that
    // common case (see the "identical default options" regression test).
    //
    // If listCollections itself fails (e.g. the connection can create but
    // not list collections — an authz split some deployments use), don't
    // fail the create outright: fall through and let db.createCollection's
    // own native duplicate detection (NamespaceExists, classified below)
    // be the backstop instead.
    let exists: boolean;
    try {
      const found = await db
        .listCollections({ name: input.collection }, { nameOnly: true, maxTimeMS: STATS_TIMEOUT_MS })
        .toArray();
      exists = found.length > 0;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new ConflictError(`collection "${input.collection}" already exists`, {
        dbName: input.dbName,
        collection: input.collection,
      });
    }

    try {
      // Metadata op — creating a namespace, not scanning one.
      await db.createCollection(input.collection, { ...opts, maxTimeMS: STATS_TIMEOUT_MS });
      return { name: input.collection };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async drop(input: CollectionDropInput): Promise<{ dropped: boolean }> {
    const w = this.pool.write(input.connectionId);
    const db = await w.db(input.dbName);
    try {
      // Override: dropping a large collection means WiredTiger frees every
      // page, which can legitimately outrun the metadata-op budget above —
      // give it the long admin budget instead of STATS_TIMEOUT_MS.
      const dropped = await db.dropCollection(input.collection, { maxTimeMS: ADMIN_LONG_TIMEOUT_MS });
      return { dropped };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async rename(input: CollectionRenameInput): Promise<{ name: string }> {
    const w = this.pool.write(input.connectionId);
    validateCollectionName(input.newName);
    const db = await w.db(input.dbName);
    try {
      // Same-database rename is a catalog-only metadata op (CollectionRenameInput
      // forbids a cross-db target), so it belongs on the metadata budget, not
      // the long one drop needs.
      await db.renameCollection(input.collection, input.newName, { maxTimeMS: STATS_TIMEOUT_MS });
      return attachUndo({ name: input.newName }, { fromName: input.collection, toName: input.newName });
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async dropDatabase(input: DatabaseDropInput): Promise<{ dropped: true }> {
    const w = this.pool.write(input.connectionId);
    const db = await w.db(input.dbName);
    try {
      // Override, same reason as drop() above: freeing every collection's
      // storage in the database can legitimately take a while.
      await db.dropDatabase({ maxTimeMS: ADMIN_LONG_TIMEOUT_MS });
      return { dropped: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }
}

const VALID_GRANULARITIES = new Set(['seconds', 'minutes', 'hours']);
const VALID_VALIDATION_LEVELS = new Set(['off', 'strict', 'moderate']);
const VALID_VALIDATION_ACTIONS = new Set(['error', 'warn']);

export function validateCollectionName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new ValidationError('collection name cannot be empty', { name });
  }
  if (name.startsWith('system.')) {
    throw new ValidationError('collection names starting with "system." are reserved', {
      name,
    });
  }
  if (name.includes('\0')) {
    throw new ValidationError('collection name cannot contain null characters', {
      name,
    });
  }
}

/**
 * Pure builder: translates the wire-level `CollectionCreateOptions` (EJSON
 * strings for collation/validator) into the plain object the driver's
 * `createCollection(name, opts)` expects. Exported + unit-tested in
 * isolation from any Mongo connection.
 */
export function buildCreateCollectionOptions(
  options: CollectionCreateOptions,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  if (options.capped) {
    if (typeof options.size !== 'number' || !Number.isFinite(options.size) || options.size <= 0) {
      throw new ValidationError('capped collections require a positive numeric size', {
        field: 'size',
        size: options.size,
      });
    }
    opts.capped = true;
    opts.size = options.size;
    if (typeof options.max === 'number') opts.max = options.max;
  }

  if (options.timeseries) {
    const { timeField, metaField, granularity } = options.timeseries;
    if (!timeField) {
      throw new ValidationError('timeseries requires a timeField', { field: 'timeField' });
    }
    if (granularity && !VALID_GRANULARITIES.has(granularity)) {
      throw new ValidationError(`invalid timeseries granularity: ${granularity}`, {
        field: 'granularity',
        granularity,
      });
    }
    const timeseries: Record<string, unknown> = { timeField };
    if (metaField) timeseries.metaField = metaField;
    if (granularity) timeseries.granularity = granularity;
    opts.timeseries = timeseries;
    if (typeof options.expireAfterSeconds === 'number') {
      opts.expireAfterSeconds = options.expireAfterSeconds;
    }
  }

  if (options.collation) {
    try {
      opts.collation = ejsonParse(options.collation);
    } catch (err) {
      throw new ValidationError('collation: invalid EJSON', {
        field: 'collation',
        reason: (err as Error).message,
      });
    }
  }

  if (options.validator) {
    try {
      opts.validator = ejsonParse(options.validator);
    } catch (err) {
      throw new ValidationError('validator: invalid EJSON', {
        field: 'validator',
        reason: (err as Error).message,
      });
    }
  }

  if (options.validationLevel) {
    if (!VALID_VALIDATION_LEVELS.has(options.validationLevel)) {
      throw new ValidationError(`invalid validationLevel: ${options.validationLevel}`, {
        field: 'validationLevel',
      });
    }
    opts.validationLevel = options.validationLevel;
  }

  if (options.validationAction) {
    if (!VALID_VALIDATION_ACTIONS.has(options.validationAction)) {
      throw new ValidationError(`invalid validationAction: ${options.validationAction}`, {
        field: 'validationAction',
      });
    }
    opts.validationAction = options.validationAction;
  }

  return opts;
}
