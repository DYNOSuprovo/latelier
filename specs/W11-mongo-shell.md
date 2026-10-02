# W11 — Mongo shell pane (REPL in a runner child)

## Purpose

Give users a first-class shell affordance from inside the workspace: a
button in the workspace chrome that opens a bottom pane wrapping a
JavaScript REPL with a Mongo driver context, scoped to the active
connection (and optionally the active db). The REPL runs in a **child
process of the app** (the script runner, see ADR 0014), with its `db`
bridged to the connection that main holds — there is no external
`mongosh` dependency.

This spec implements GitHub.

## Scope

- **In**: `ShellService` in main that starts one runner child per
  session, which hosts a `node:repl.REPLServer`, and answers the child's
  database calls over the existing `MongoPool` `MongoClient` so the
  shell never re-authenticates; IPC channels for start / write / stop
  and an output event stream; renderer pane that renders the output as a
  monospace stream and forwards keystrokes to stdin; a "Shell" toggle
  button on the workspace chrome.
- **Out**: full mongosh feature parity (autocomplete, history, custom
  helpers like `it`); shell-history persistence; multiple concurrent
  shell sessions per connection.

## Process model

The shell is not `spawn('mongosh')`, and it is no longer a REPL inside the
main Electron process either.

Not `mongosh`: it would be a runtime dependency on every user's machine,
and the child would need a URI with embedded credentials and a brand-new
connection, a second auth round-trip on top of the one the app already
paid.

Not in main: the REPL context exposes `require` and `process`, so a REPL
in the main process is a REPL in the process that holds the secrets
vault, the SQLite database and every connection's live client. The REPL
now runs in the same runner child that scripts use (ADR 0014):

- **One long-lived child per session**, forked through the same
  `RunnerSpawner` and the same bundled entry (`script-runner.cjs`) as a
  script run. The first message it receives is a `shell-start` request
  instead of a `run` request, and it opens `repl.start` over in-memory
  streams (`electron/script-runner/shellSession.ts`).
- **The child holds no `MongoClient`, URI or credentials.** Its `db` is
  the script runner's RPC facade: each call becomes a frame to main, which
  answers it through an `rpcHost` that `ShellService` creates per
  session, over the pool's own client, with the connection's read-only
  flag read live on every call. No new connection is opened, and
  nothing connection-related is ever posted to the child.
- **Main keeps the rest.** Input is rewritten by `rewriteShellSugar` in
  main and posted to the child as `shell-in` messages; the child posts
  the REPL's output back as `shell-out` messages and main forwards them,
  unchanged, to the existing `mshell:output-event` emitter. The IPC
  channels and the renderer contract are the same as before.

What this does and does not protect. A `require('child_process')` or
`process` escape typed into the REPL reaches only the child: no
credentials, no connection string, no client, no route to main's memory,
the vault, SQLite or other connections. The child is still an ordinary
process of the same OS user, so the escape keeps that user's files,
processes and network, and against a deployment that needs no
authentication it can open its own connection to the server. That is why
a read-only connection still refuses the whole session (section 5): the
REPL cannot tell a read from a write, and it is not a sandbox. MongoDB
roles remain the authoritative control; for a hard guarantee, connect
with a database user that only holds read privileges.

## Dependencies

- C02 (`Connection`), F04 (IPC pattern), F05 (`MongoPool` —
  `getClient(connectionId)` is the integration point).

## 1. Types

```ts
// shared/types.ts
export interface ShellSessionInfo {
  sessionId: string;
  connectionId: string;
  dbName?: string;
  startedAt: string;
}

export type ShellOutputKind = 'stdout' | 'stderr' | 'exit';

export interface ShellOutputEvent {
  sessionId: string;
  kind: ShellOutputKind;
  /** Present for stdout/stderr. Plain text. */
  data?: string;
  /** Present only when kind === 'exit'. */
  exitCode?: number | null;
  /** Present only when kind === 'exit' and the process was signalled. */
  signal?: string | null;
}
```

The REPL's own output, errors included, arrives as `stdout`. `stderr` and
`exit` come from main: an `exit` event is emitted whenever a session ends
(`exitCode` 0 for a stop or a REPL `.exit`, 1 when the session was ended
for a reason), and a session that ends for a reason, a connection that
disconnected or turned read-only or a child that died on its own, first
carries that reason as a `stderr` event. `signal` is not set.

## 2. IPC channels

| Channel          | Input                                                         | Output                | Notes |
| ---------------- | ------------------------------------------------------------- | --------------------- | ----- |
| `mshell:start`   | `{ connectionId: string; dbName?: string }`                   | `ShellSessionInfo`    | starts a runner child hosting a `node:repl` |
| `mshell:write`   | `{ sessionId: string; data: string }`                         | `void`                | posts the line, after `rewriteShellSugar`, to the child |
| `mshell:stop`    | `{ sessionId: string }`                                       | `void`                | ends the session and kills the child |
| `mshell:list`    | —                                                             | `ShellSessionInfo[]`  | enumerate live sessions |
| `mshell:onOutput`| event `mshell:output-event` carrying `ShellOutputEvent`       | —                     | renderer subscribes via preload |

## 3. ShellService (main)

```ts
class ShellService {
  start(input: { connectionId: string; dbName?: string }): Promise<ShellSessionInfo>;
  write(sessionId: string, data: string): void;
  stop(sessionId: string): Promise<void>;
  list(): ShellSessionInfo[];
  /** Called from app `before-quit` to close any live sessions. */
  disposeAll(): Promise<void>;
}
```

Behaviour:

- `start` refuses a read-only connection (section 5), then calls
  `pool.readClient(connectionId)` so a connect failure surfaces as a
  clean error before anything is spawned or any session state is
  allocated.
- It then spawns the runner child, creates the session's `rpcHost`
  over that client, and posts one `shell-start` request (database name
  and banner text only). The child writes the banner, then runs a
  `repl.REPLServer` over passthrough `input` / `output` streams. Output
  bytes fan out as `kind: 'stdout'` events.
- The REPL `context`, built in the child, exposes:
  - `db` — the RPC facade. `db.<name>` returns a collection of the
    current database; `runCommand`, `stats`, `listCollections` and the
    other methods on the script bridge's list work as in the script
    editor, and a call that is not on that list is a `TypeError`.
  - `use(name)` — switches the current database, updates the prompt.
  - `help()` — short reminder of available verbs.
- Mongosh-style sugar is rewritten in main before a line is posted:
  - `use foo` (no parens) becomes `use("foo")`.
  - `show dbs` / `show databases` becomes a call that runs
    `listDatabases` on `admin` through the bridge (`authorizedDatabases`).
  - `show collections` / `show tables` lists the current database's
    collections through the bridge.
- The REPL's default evaluator allows top-level `await`
  (`await db.users.findOne()` etc.).
- Sessions are scoped per connection — calling `start` for a connection
  that already has a live session reuses it. Idempotent toggle.
- **Lifecycle lives in main.** Ending a session kills the child and
  closes its host (which closes the session's cursors and aborts
  in-flight driver work), then emits the `exit` event. A session ends
  when:
  - it is stopped (`mshell:stop`, or the pane closing);
  - its connection reports `disconnected` on the pool's `status` event
    (Disconnect, delete, a host edit, or the pool losing the
    deployment), or turns read-only;
  - the REPL ends itself (`.exit`);
  - the app quits: `disposeAll` is wired into `app.on('before-quit')`
    and kills every child;
  - the child dies on its own (a crash, `process.exit()` typed into the
    REPL, a kill from outside). That is a clean error, not a hang: a
    `stderr` event carrying the reason, then the `exit` event.

## 4. Renderer pane (`MongoShellPane.tsx`)

- A bottom pane inside the workspace, ~260 px tall by default,
  resizable via a `ResizeHandle` (height persisted in
  `prefs:set('ui.workspace.shellHeight', n)`).
- Toggled by a chrome button in the title bar (`{I.terminal} Shell`).
- Hidden entirely when there is no active connection.
- Output area: monospace `<pre>` showing the rolling output buffer
  (capped at 200 KB, drop-from-front); scrolls to bottom on append.
- Input row: a single-line `<input>` that, on Enter, calls
  `api.mshell.write(sessionId, value + '\n')` and clears.
- Restart / Stop / Close controls in the pane header.

## 5. Security

- No credentials cross the IPC boundary, and none reach the child. The
  shell binds to the already-authenticated `MongoClient` from the pool,
  and that client stays in main; the child's `db` only sends requests
  for it. The child's environment is an allowlist (`PATH`, `HOME`, the
  temp dirs), not a copy of main's, and an escape that dumps
  `process.env` or `process.argv` finds no URI, user or password.
- A frame the child sends is checked by main (per-object method
  allowlist, live read-only flag, a per-session cursor table, caps on
  calls in flight and argument size), exactly as for a script: a REPL
  user can post whatever they like to the parent port.
- The shell has the same database authority the rest of the app has —
  no privilege escalation.
- **A read-only connection refuses the whole session** (ADR 0005),
  unchanged: `start` and every `write` call `assertWritable`, and a
  session already open when the connection turns read-only is ended.
  Moving the REPL out of main did not make it a sandbox; the child can
  still `require('child_process')` as the OS user, so a method-level
  guard on `db` would not hold. There is no setting to turn the shell
  off.
- What an escape from the REPL reaches is the child: the OS user's
  files, processes and network, and nothing of main's. Against a
  deployment that needs no authentication the child can connect to
  the server itself and write regardless of the app's read-only
  setting, because there are no credentials to withhold. MongoDB roles
  remain the authoritative control.
- The renderer only sees text in / text out.

## 6. Acceptance criteria

- [x] Clicking the chrome "Shell" button opens the pane scoped to the
      active connection; clicking again hides it.
- [x] On open, the pane prints a banner naming the connection.
- [x] Typing `await db.runCommand({ ping: 1 })` prints `{ "ok": 1 }`.
- [x] `show dbs` and `show collections` work.
- [x] `use <name>` switches the current database and updates the prompt.
- [x] Closing the pane / quitting the app stops the session cleanly and
      leaves no runner child alive.
- [x] The REPL runs in a runner child; no URI, user or password is in
      anything posted to it, nor in its environment or argv.
- [x] A child that dies unexpectedly, or a connection that disconnects,
      ends the session with an `exit` event (and a reason as `stderr`).

## 7. Test cases

### Integration (main)
- **shell-service.spec.ts**: drives a `ShellService` against a fake
  `MongoPool` + fake `MongoClient`, forking the real runner under Node.
  Covers banner, session reuse, expression evaluation,
  `db.<coll>.findOne`, `show dbs`, `show collections`, `use <name>`,
  stop / write-after-stop / list semantics, and the read-only refusal.
- **shell-runner.spec.ts**: the same service over a real pool and
  `mongodb-memory-server`. Covers reads and writes through main, `use`
  and the prompt, stop and `disposeAll` killing the child, a pool
  disconnect and a read-only flip ending the session, a crashed child,
  `process.exit()` and `.exit` inside the REPL, and that nothing posted
  to the child (and nothing an escape can read from its environment)
  carries a URI, user or password for a password-protected connection.
- **shell-protocol.spec.ts** (unit): the message shape guards.

### Component
- **mongo-shell-pane.spec.tsx**: mounts the pane against a mocked
  `api.mshell`; verifies start-on-mount, input → `mshell.write`, and
  the streamed-output rendering path.

### E2E
- **mongo-shell.e2e.ts**: launches the real Electron app (the runner
  child is an Electron `utilityProcess`), seeds a
  connection against an in-memory MongoDB, starts a session, runs `await
  db.runCommand({ ping: 1 })` through the IPC bridge, and asserts the
  `{ "ok": 1 }` payload appears in the output stream.
