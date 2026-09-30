import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunnerHandle, RunnerSpawner } from '../../electron/services/runner/spawner';
import { scrubbedRunnerEnv } from '../../electron/services/runner/spawner';

const RUNNER_ENTRY = fileURLToPath(
  new URL('../../electron/script-runner/runner.ts', import.meta.url),
);

export interface SpawnRecord {
  child: ChildProcess;
  args: readonly string[];
  env: Record<string, string>;
  /** Every message main posted to this child, in order. */
  sent: unknown[];
  spawnedAt: number;
  firstMessageAt?: number;
}

export interface TestSpawner extends RunnerSpawner {
  spawns: SpawnRecord[];
  /** Children that have not exited. */
  alive(): ChildProcess[];
  killAll(): void;
}

/**
 * Forks the real runner under plain Node (type stripping), so the integration
 * tests exercise the same file the packaged app bundles, through the same
 * message protocol, without needing Electron.
 */
export function createTestSpawner(): TestSpawner {
  const spawns: SpawnRecord[] = [];
  return {
    spawns,
    spawn(): RunnerHandle {
      const args: string[] = [];
      const env = scrubbedRunnerEnv();
      // execArgv is emptied so the child does not inherit the vitest worker's flags.
      const child = fork(RUNNER_ENTRY, args, {
        execArgv: [],
        env,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const record: SpawnRecord = { child, args, env, sent: [], spawnedAt: Date.now() };
      spawns.push(record);
      return {
        postMessage: (message) => {
          record.sent.push(message);
          child.send(message as never);
        },
        onMessage: (listener) =>
          child.on('message', (m) => {
            record.firstMessageAt ??= Date.now();
            listener(m);
          }),
        onExit: (listener) => child.once('exit', (code) => listener(code)),
        kill: () => {
          child.kill('SIGKILL');
        },
      };
    },
    alive: () => spawns.map((s) => s.child).filter((c) => c.exitCode === null && c.signalCode === null),
    killAll: () => {
      for (const c of spawns.map((s) => s.child)) c.kill('SIGKILL');
    },
  };
}
