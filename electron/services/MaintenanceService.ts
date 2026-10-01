import type { RecentQueryRepo } from '../db/repositories/RecentQueryRepo.ts';
import type { RecentFieldValueRepo } from '../db/repositories/RecentFieldValueRepo.ts';
import type { AuditRepo } from '../db/repositories/AuditRepo.ts';
import type { AppStateService } from './AppStateService.ts';

const MAINTENANCE_KEY = 'maintenance.lastRunAt';
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 90;

export class MaintenanceService {
  private recentRepo: RecentQueryRepo;
  private recentFieldValueRepo: RecentFieldValueRepo;
  private auditRepo: AuditRepo;
  private checkpoint: () => void;
  constructor(deps: {
    recentRepo: RecentQueryRepo;
    recentFieldValueRepo: RecentFieldValueRepo;
    auditRepo: AuditRepo;
    /** Flushes purged pages out of the WAL; owns reporting a blocked checkpoint. */
    checkpoint: () => void;
  }) {
    this.recentRepo = deps.recentRepo;
    this.recentFieldValueRepo = deps.recentFieldValueRepo;
    this.auditRepo = deps.auditRepo;
    this.checkpoint = deps.checkpoint;
  }

  runIfNeeded(appState: Pick<AppStateService, 'get' | 'set'>): void {
    const lastRun = appState.get<string>(MAINTENANCE_KEY);
    const now = Date.now();

    if (lastRun !== null) {
      const lastRunMs = new Date(lastRun).getTime();
      if (now - lastRunMs < INTERVAL_MS) return;
    }

    this.purgeExpired();
    this.checkpoint();
    appState.set(MAINTENANCE_KEY, new Date(now).toISOString());
  }

  private purgeExpired(): void {
    this.recentRepo.deleteOlderThan(RECENT_RETENTION_DAYS);
    this.recentFieldValueRepo.deleteOlderThan(RECENT_RETENTION_DAYS);
    this.auditRepo.deleteOlderThan(AUDIT_RETENTION_DAYS);
  }
}
