import { utilityProcess } from 'electron';
import { scrubbedRunnerEnv, type RunnerHandle, type RunnerSpawner } from './spawner.ts';

/**
 * Production spawner: one Electron `utilityProcess` per run, forking the
 * bundled `script-runner.cjs`. Nothing about the run travels in argv or env;
 * the request (credentials included) goes over the message port.
 */
export function createUtilityProcessSpawner(entryPath: string): RunnerSpawner {
  return {
    spawn(): RunnerHandle {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: 'atelier-script',
        env: scrubbedRunnerEnv(),
        stdio: 'ignore',
      });
      return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => child.on('message', listener),
        onExit: (listener) => child.once('exit', listener),
        kill: () => {
          child.kill();
        },
      };
    },
  };
}
