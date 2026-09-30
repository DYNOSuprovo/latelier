# Scripts run in a child process, one per run, killed on timeout

User scripts ran in the main process inside `node:vm`. That has two problems, and only one was a bug anyone had hit. A script of `while (true) await Promise.resolve()` never lets the event loop turn, so the wall-clock timer that was meant to stop it could never fire, and the whole app froze until the user force-quit; `vm`'s own `timeout` only covers the synchronous part of a run. And `node:vm` is not a sandbox: a script can reach Node primordials through host-realm objects, so it sat in the process that holds the secrets vault, the SQLite database and every connection's live client.

**Decision.** `ScriptService` becomes an orchestrator and the script runs in an Electron `utilityProcess` (`electron/script-runner/runner.ts`, built to `dist-electron/script-runner.cjs`). One process per run. Main posts a single request over the message port and waits for one message back.

- **Timeout and cancel are kills.** One wall-clock timer per run covers spawn, connect, run and result encoding; when it fires, or cancel arrives, or the app quits, main kills the process and rejects with the same `TIMEOUT` errors as before. This is the only mechanism that bounds all three runaway shapes (sync loop, microtask loop, a promise that never settles), because the runner shares no event loop with main.
- **The runner owns its own `MongoClient`** for now. Main hands it the connection's URI and options over the port, credentials included, with TLS CA and client-certificate files inlined as PEM contents so it needs no file access of its own. Nothing goes in argv, and the child gets an allowlisted environment rather than a copy of main's.
- **Main still connects first** (`pool.readClient`), so connect errors and status events are unchanged. That means a second connection per run.
- **A child that dies before answering** is a `SystemError`, never a hang. Children are killed on quit.

## What this does and does not protect

Read-only is **still the in-process proxy guard, now running in the child**. It is a UI safety guard, not a security boundary: the child holds live credentials, so a script that escapes the `vm` context can open its own client and write on a read-only connection. The same child has the OS user's file and exec access. What the split does buy is that an escaped script can no longer reach main's memory, the secrets vault, SQLite, or other connections' clients, and can no longer freeze the app. This ADR does not claim more than that.

A connection flipped to read-only mid-run is handled by stopping its scripts: the runner only has the flag as it was at spawn, so `ConnectionService.update` announces the flip on the pool and `ScriptService` kills that connection's runners with a read-only refusal. Runs started after the flip receive the new flag.

## Considered Options

- **`vm` with `microtaskMode: 'afterEvaluate'`.** Makes the `vm` timeout cover microtasks queued in the context, but breaks any script that awaits a host promise, which is every `db` call. Rejected.
- **A pool of warm runners.** Measured before deciding: a fork plus `require('mongodb')` plus connect plus a trivial script is about 70 ms bundled (110 ms as `.ts`) under Node against a local `mongodb-memory-server`, and 120-140 ms end to end through the packaged app. That is not worth a pool's lifecycle, cross-run state and cleanup. Revisit if runs against a remote TLS or Atlas cluster make the per-run handshake the bottleneck.
- **A sandboxed renderer window as the runtime.** A separate, larger piece of work; not scheduled.

## Consequences

- Credentials cross from main to the child in this slice. The follow-up (an RPC bridge) makes the child's `db` a facade whose calls execute in main through the existing proxy, removing the `MongoClient`, the URI and the credentials from the child and moving read-only enforcement into main. Until it lands, ADR 0005's statement that the script pane's proxy guard is a real boundary does not hold, and is amended there.
- The runner entry is a second CommonJS build target (`vite.config.ts`, a second `preload` item), loaded by `utilityProcess` from inside `app.asar`; `mongodb` and `bson` are resolved from `node_modules` at run time. Verified in a packaged build with the release fuses (`OnlyLoadAppFromAsar`, `RunAsNode` off): no `asarUnpack` is needed.
- The runner must work both bundled as `.cjs` and as plain `.ts` under Node's type stripping, because the integration tests fork the `.ts` file. That rules out top-level `await`, `import.meta` and runtime path aliases anywhere in its import graph.
- `vm`'s `timeout` is gone; the kill is the single ceiling. The signal-threading into driver calls stays, but cancel no longer fires it, since a kill closes the sockets.
