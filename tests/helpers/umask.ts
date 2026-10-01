import { isMainThread } from 'node:worker_threads';

/**
 * Sets a permissive umask so a mode the code forgot to set shows up as 0755/0644.
 * `process.umask(mask)` throws inside worker threads (the Stryker vitest runner
 * uses them), so there the ambient umask is kept — the assertions still hold,
 * they just lose the guarantee against an unusually strict host umask.
 * Returns a function that restores the previous umask.
 */
export function useUmask022(): () => void {
  if (!isMainThread) return () => undefined;
  const prev = process.umask(0o022);
  return () => {
    process.umask(prev);
  };
}
