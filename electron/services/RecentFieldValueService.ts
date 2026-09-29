import { randomUUID } from 'node:crypto';
import type { ValType } from '@shared/types';
import type { RecentFieldValueRepo } from '../db/repositories/RecentFieldValueRepo.ts';
import { isSecretFieldPath } from '../log.ts';

/** Roadmap decision (X02 "Value suggestions" §Eviction cap): 50 rows per field. */
const EVICTION_CAP = 50;

/**
 * The only ops both suggested and recorded. `$in`/`$nin` are
 * element-wise — the caller already splits their array into one entry per
 * scalar element before calling `recordMany`. Every other op (including
 * `$exists`, `$regex`, `$mod`, ...) is silently dropped here rather than
 * trusted from the renderer — main is the trust boundary for what gets
 * persisted, same reasoning as the secret-field-path check below.
 */
const RECORDABLE_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

export interface RecordFieldValueEntry {
  field: string;
  value: string;
  valType: ValType;
  op: string;
}

export interface RecentFieldValueSummary {
  value: string;
  valType: ValType;
  frequency: number;
  lastUsedAt: string;
}

export class RecentFieldValueService {
  private repo: RecentFieldValueRepo;

  constructor(repo: RecentFieldValueRepo) {
    this.repo = repo;
  }

  /**
   * Upserts every entry, then trims each touched field to the eviction cap.
   * Refuses (silently drops) any entry whose op isn't recordable or whose
   * field path names a secret (`log.ts`'s `REDACTED_KEYS`) — never trust the
   * renderer to have filtered these itself.
   */
  recordMany(
    connectionId: string,
    dbName: string,
    collection: string,
    entries: RecordFieldValueEntry[],
  ): { recorded: number } {
    const now = new Date().toISOString();
    const touchedFields = new Set<string>();
    let recorded = 0;
    this.repo.transaction(() => {
      for (const entry of entries) {
        if (!RECORDABLE_OPS.has(entry.op) || isSecretFieldPath(entry.field)) continue;
        this.repo.upsert({
          id: randomUUID(),
          connectionId,
          dbName,
          collection,
          field: entry.field,
          value: entry.value,
          valType: entry.valType,
          lastUsedAt: now,
        });
        touchedFields.add(entry.field);
        recorded += 1;
      }
      for (const field of touchedFields) {
        this.repo.evictOldest({ connectionId, dbName, collection, field, keep: EVICTION_CAP });
      }
    });
    return { recorded };
  }

  listForField(
    connectionId: string,
    dbName: string,
    collection: string,
    field: string,
    limit?: number,
  ): RecentFieldValueSummary[] {
    return this.repo.list({ connectionId, dbName, collection, field, limit }).map((row) => ({
      value: row.value,
      valType: row.val_type,
      frequency: row.use_count,
      lastUsedAt: row.last_used_at,
    }));
  }

  clearAll(): { deleted: number } {
    return { deleted: this.repo.clearAll() };
  }
}
