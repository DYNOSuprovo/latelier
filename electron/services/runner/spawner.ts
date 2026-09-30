/**
 * Seam between `ScriptService` and whatever starts the runner process.
 * Production wraps Electron's `utilityProcess` (`utilityProcessSpawner.ts`);
 * tests fork the same runner under plain Node.
 */
export interface RunnerHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Fires once, for any termination: clean exit, crash, or `kill()`. */
  onExit(listener: (code: number | null) => void): void;
  /** Terminate the process. Safe to call more than once. */
  kill(): void;
}

export interface RunnerSpawner {
  spawn(): RunnerHandle;
}

/**
 * Environment handed to a runner. A scripted child must not inherit whatever
 * secrets happen to sit in the app's environment, so this is an allowlist of
 * the few variables Node and the OS network stack need to work at all.
 */
const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export function scrubbedRunnerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
