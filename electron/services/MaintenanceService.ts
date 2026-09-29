import type { RecentQueryRepo } from '../db/repositories/RecentQueryRepo.ts';
import type { AuditRepo } from '../db/repositories/AuditRepo.ts';
import type { AppStateService } from './AppStateService.ts';

const MAINTENANCE_KEY = 'maintenance.lastRunAt';
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_RETENTION_DAYS = 30;
const AUDIT_RETENTION_DAYS = 90;
// Undo happens within minutes of a mistake; the record is worth reading for
// months. So a Pre-image is dropped long before the row it belongs to.
const PRE_IMAGE_RETENTION_DAYS = 7;
const PRE_IMAGES_KEPT_PER_CONNECTION = 200;

export class MaintenanceService {
  private recentRepo: RecentQueryRepo;
  private auditRepo: AuditRepo;
  constructor(recentRepo: RecentQueryRepo, auditRepo: AuditRepo) {
    this.recentRepo = recentRepo;
    this.auditRepo = auditRepo;
  }

  runIfNeeded(appState: Pick<AppStateService, 'get' | 'set'>): void {
    const lastRun = appState.get<string>(MAINTENANCE_KEY);
    const now = Date.now();

    if (lastRun !== null) {
      const lastRunMs = new Date(lastRun).getTime();
      if (now - lastRunMs < INTERVAL_MS) return;
    }

    this.vacuum();
    appState.set(MAINTENANCE_KEY, new Date(now).toISOString());
  }

  private vacuum(): void {
    this.recentRepo.deleteOlderThan(RECENT_RETENTION_DAYS);
    this.auditRepo.expirePreImages(PRE_IMAGE_RETENTION_DAYS, PRE_IMAGES_KEPT_PER_CONNECTION);
    this.auditRepo.deleteOlderThan(AUDIT_RETENTION_DAYS);
  }
}
