/**
 * The runner's one link to main. Electron's utilityProcess exposes
 * `process.parentPort` (events carry `{ data }`); a plain Node fork, which the
 * integration tests use, speaks over the IPC channel instead.
 */
export interface Channel {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

export function openChannel(): Channel {
  const proc = process as NodeJS.Process & {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: 'message', listener: (e: { data: unknown }) => void): void;
    };
  };
  if (proc.parentPort) {
    const port = proc.parentPort;
    return {
      post: (m) => port.postMessage(m),
      onMessage: (listener) => port.on('message', (e) => listener(e.data)),
    };
  }
  if (typeof proc.send !== 'function') {
    throw new Error('script runner started without a parent channel');
  }
  const send = proc.send.bind(proc);
  return {
    post: (m) => {
      send(m);
    },
    onMessage: (listener) => proc.on('message', listener),
  };
}
