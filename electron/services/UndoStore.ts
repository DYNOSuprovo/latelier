/** Newest entries kept per Connection — the allowance the on-disk sweep used to enforce. */
export const UNDO_ENTRIES_PER_CONNECTION = 200;
/** Total Pre-image bytes held across every Connection. */
export const UNDO_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

interface Held {
  connectionId: string;
  json: string;
  bytes: number;
}

/**
 * Pre-images for Undo, held in main-process memory only. Nothing here is ever
 * written to disk, so a restart forgets every one of them by design. Bounded
 * per Connection and in total bytes; the oldest entry goes first.
 */
export class UndoStore {
  // Map iterates in insertion order, so the first key is always the oldest.
  private entries = new Map<string, Held>();
  private totalBytes = 0;
  private perConnection: number;
  private maxBytes: number;

  constructor(limits: { perConnection?: number; maxBytes?: number } = {}) {
    this.perConnection = limits.perConnection ?? UNDO_ENTRIES_PER_CONNECTION;
    this.maxBytes = limits.maxBytes ?? UNDO_MAX_TOTAL_BYTES;
  }

  put(id: string, connectionId: string, json: string): void {
    this.delete(id);
    const bytes = Buffer.byteLength(json, 'utf8');
    this.entries.set(id, { connectionId, json, bytes });
    this.totalBytes += bytes;
    let held = 0;
    for (const e of this.entries.values()) if (e.connectionId === connectionId) held++;
    for (const [oldId, e] of this.entries) {
      if (held <= this.perConnection) break;
      if (e.connectionId === connectionId) {
        this.delete(oldId);
        held--;
      }
    }
    // The entry just added is last, so it is the one thing this never drops:
    // a single capture larger than the cap still gets to be undone.
    for (const oldId of this.entries.keys()) {
      if (this.totalBytes <= this.maxBytes || this.entries.size === 1) break;
      this.delete(oldId);
    }
  }

  get(id: string): string | undefined {
    return this.entries.get(id)?.json;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  delete(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.totalBytes -= e.bytes;
    this.entries.delete(id);
  }
}
