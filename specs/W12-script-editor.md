# W12 — Script editor tab

## Purpose

Give users a workspace tab where they can write a multi-statement
JavaScript/Mongo script, run the whole buffer against the active
connection, and see the result rendered as structured output (not a
stdout stream). Complements W11 (the REPL pane): same `db` surface,
different UX — write-and-run instead of read-eval-print. Scripts run
in a separate process, one per run (see §3 and ADR 0014).

The script editor is the right tool when the work is "compose a few
lines, iterate, save, share"; the shell pane is the right tool when
the work is "poke the cluster one expression at a time".

## Scope

- **In**: a `'script'` workspace tab kind backed by
  `workspace_tabs.state_json`; a CodeMirror 6 editor in the renderer
  with JS syntax highlighting; a `ScriptService` in main that orchestrates
  a script-runner child process, which runs the user buffer in a
  `node:vm` context wrapped in an async IIFE; IPC channels
  `script:run` / `script:cancel`; structured result rendering (last
  expression value + a print buffer); cancellation by killing the
  child, keyed on a cancel token.
- **Out**: persisting scripts as named/saved entities (covered by a
  future `W13-saved-scripts.md`); multi-file imports / `require()`;
  scheduled / repeating runs; sharing scripts across connections.

## Why a tab (not the W11 pane)

W11 already exposes a stdin/stdout REPL with the exact same backing
machinery. A script editor is a *different* UX problem:

1. **Editing affordance.** Multi-line composition with syntax
   highlighting and key-bindings beats a single-line `<input>`.
2. **Result shape.** Users want to see the *return value* of their
   script as a typed, navigable structure — a table when it's an array
   of docs, a JSON tree when it's a `UpdateResult` — not a
   monospaced text stream.
3. **Lifecycle.** A tab persists per-workspace (the buffer survives
   relaunch via `state_json`); the W11 pane is intentionally
   ephemeral.

The two surfaces share the `db` proxy and the `MongoPool` integration
point — execution is identical, only the UX differs.

## Dependencies

- C02 (`Connection`), F04 (IPC pattern), F05 (`MongoPool` —
  `getClient(connectionId)`), W01 (workspace tab model), W11
  (`ShellService` — the `db` proxy / collection-alias helpers are
  extracted and reused).

## 1. Types

```ts
// shared/types.ts

export type WorkspaceTabKind = 'collection' | 'script';

export interface ScriptTabState {
  /** Editor buffer. UTF-8. */
  source: string;
  /** Selected database for the `db` proxy at run time. Optional —
   *  scripts can also explicitly call `use("...")`. */
  dbName?: string;
  /** Last successful run's result. Renderer memory only: main strips it
   *  before every `state_json` write, so it does not survive relaunch. */
  lastResult?: ScriptRunResultWire;
  /** Last error, if the last run failed. Mutually exclusive with
   *  lastResult. Renderer memory only, like lastResult. */
  lastError?: { code: string; message: string };
}

export interface ScriptRunInput {
  connectionId: string;
  dbName?: string;
  source: string;
  /** Renderer-supplied UUID; used by `script:cancel`. */
  cancelToken?: string;
  /** Hard ceiling so a runaway script can't pin the main process.
   *  Defaults to 60_000 ms. User-selectable per-tab via a toolbar
   *  knob: 15s / 60s / 5min / no limit (≈24 h). */
  maxTimeMs?: number;
  /** EJSON canonical (false) vs relaxed (true). Default false to
   *  match the rest of the app. */
  ejsonRelaxed?: boolean;
}

export interface ScriptRunResultWire {
  /** EJSON-encoded last-expression value. May be a JSON array,
   *  object, or scalar. `null` when the script produced no value. */
  valueJson: string | null;
  /** Concatenated `print()` / `printjson()` output, capped at 64 KB.
   *  Empty string when the script did not call print. */
  printBuffer: string;
  durationMs: number;
}
```

## 2. IPC channels

| Channel         | Input             | Output                | Notes |
| --------------- | ----------------- | --------------------- | ----- |
| `script:run`    | `ScriptRunInput`  | `ScriptRunResultWire` | runs the buffer in a runner child process, in a fresh `vm.Context`. Throws `MongoOpError` / `ValidationError` / `SystemError`. |
| `script:cancel` | `{ token: string }` | `void`              | kills the runner bound to that token. No-op if unknown. |

No `SECRET_INPUT` tag — no credential crosses the renderer/main IPC
boundary. (The runner does receive the connection's credentials from
main over a private message port; see §3.)

## 3. ScriptService (main)

```ts
class ScriptService {
  run(input: ScriptRunInput): Promise<ScriptRunResultWire>;
  cancel(token: string): void;
}
```

### Process model

`ScriptService` is an orchestrator; the script never runs in the main
process. Each `run()` forks one Electron `utilityProcess`
(`electron/script-runner/runner.ts`, built to `dist-electron/script-runner.cjs`
and shipped inside `app.asar`), posts it a single request, and waits for
one message back. The process is single-use and is killed as soon as it
has answered.

- **Timeout and cancel are kills.** Main arms one wall-clock timer per
  run, covering spawn, the runner's connect, the script, and result
  encoding. When it fires, or `script:cancel` arrives, or the app quits
  (`cancelAll`), main kills the child and rejects with `TIMEOUT`
  (`script exceeded …ms …` or `script cancelled`). A sync loop, a
  microtask loop (`while (true) await Promise.resolve()`), and a
  promise that never settles are all stopped the same way, and none of
  them can stall main, because the runner shares no memory or event
  loop with it.
- **A dead runner is a clean error.** A child that exits before
  answering surfaces as `SystemError('INTERNAL', 'script runner exited
  unexpectedly …')`.
- **Connect in main first.** `run` still calls `pool.readClient` so
  connect failures and connection status events surface as before,
  then asks `pool.connectionSpec(id)` for what the runner needs.
- **The runner owns its own `MongoClient`** (a second connection per
  run). Main sends `{ uri, options }` — credentials included, TLS CA and
  client-certificate files inlined as PEM contents — over the message
  port. They are never placed in argv or the environment, and the
  child's environment is an allowlist (`PATH`, OS temp/home, Windows
  `SystemRoot`), not a copy of main's.
- **Read-only is a UI safety guard in this design, not a security
  boundary.** The runner enforces it with the same `dbProxy` allowlist,
  inside a process that holds live credentials and the OS user's file
  and exec access. A script that escapes the `vm` context can open its
  own client and write. What the split buys is that such a script can
  no longer reach main's memory, the vault, SQLite, or other
  connections' clients, and can no longer freeze the app. Moving
  enforcement and credentials out of the child is the RPC bridge
  follow-up (ADR 0014).
- **A connection turned read-only mid-run stops its scripts.** The
  runner only has the flag as it was at spawn, so
  `ConnectionService.update` announces a false-to-true flip on the pool
  and `ScriptService` kills that connection's runners with a
  `READ_ONLY` refusal. Runs that start afterwards get the new flag.
- **A connection that goes away mid-run stops its scripts.** The runner's
  client is its own, so Disconnect, Cancel-connect, deleting the
  connection, or an edit that reconnects would otherwise leave a script
  running (and writing) against it. `ScriptService` listens for the pool's
  `disconnected` status and kills that connection's runners with a
  `DB_ERROR`. That status also fires when the pool decides the
  deployment is unreachable (its own client saw no known servers for the
  loss grace window), so a script is stopped on a dropped connection too.
  This is deliberate and fail-closed: do not narrow it to user-initiated
  disconnects.
- **Results are encoded in the runner** (50 MB cap, print buffer cap
  64 KB) and cross the port as a string.

Behaviour of the script itself:

- A fresh `vm.Context` is created per call. The context globals are:
  - `db` — the same Proxy `ShellService` builds (extracted to
    `electron/mongo/dbProxy.ts` so both services share one
    implementation). Mongosh-style aliases (`runCommand` →
    `command`, `count` → `countDocuments`) carry over.
  - `use(name)` — switches the proxy's current database.
  - `print(...args)` / `printjson(value)` — append to the print
    buffer (capped at 64 KB; further writes are silently dropped to
    keep the IPC payload bounded).
  - `EJSON` — re-export of `bson.EJSON`.
  - `ObjectId`, `ISODate`, `Long`, `Decimal128`, `UUID` — re-exports
    of `bson` constructors so users can write `new ObjectId(...)`
    just as they would in mongosh.
  - `signal` — an `AbortSignal`, exposed as a global so users can pass
    it manually to long-running ops. Cancel kills the process rather
    than aborting this signal, so it never fires; it remains so scripts
    that reference it keep working. The collection
    proxy *also* auto-threads it: when the user calls
    `db.coll.find(filter)` (no options), the wrapper rewrites that to
    `find(filter, { signal })`. If the user passes their own options
    object, theirs wins (so explicit `{ signal: undefined }` opts
    out). Same treatment for `findOne`, `aggregate`,
    `countDocuments`, `updateOne`, `updateMany`, `deleteOne`,
    `deleteMany`, `insertOne`, `insertMany`, and cursor `.toArray()`.
- The buffer is wrapped in an async IIFE before evaluation:
  ```js
  (async () => {
    <user source>
  })()
  ```
  The Promise it returns is awaited. Top-level `await` works because
  the wrapper is async.
- There is no `vm` `timeout`: it only bounds the synchronous part of a
  run and cannot see a microtask loop. The wall-clock kill above is the
  single ceiling.
- The "result value" is the last expression of the script. The
  wrapper parses the source with `acorn` (pure-JS, no native deps);
  if the final top-level statement is an `ExpressionStatement` it is
  prefixed with `return ` before evaluation. Anything else
  (assignments, declarations) produces no value, and `valueJson` is
  `null`. If acorn fails to parse, the source is run as-is and
  `valueJson` stays `null` — the syntax error surfaces from the vm
  with the user's original line/column, not the wrapper's. Mirrors
  how Node's REPL surfaces the last expression without forcing users
  to write `return`.
- The returned value is EJSON-encoded via the existing
  `ejsonEncode` (objects/arrays) or `ejsonStringifyRelaxed` helpers.
  Non-serialisable values (functions, the `db` proxy itself) collapse
  to `null` — the print buffer is the escape hatch for those.
- `cancel(token)` aborts that run's controller, which kills its runner;
  the token stays in the `active` map until the run's own cleanup
  removes it, so a same-token `run()` fired right after `cancel` is
  still rejected as `CONFLICT`. Idempotent.

### Trust boundary

`vm.createContext` is *not* a security boundary, and this spec does not
pretend otherwise: user scripts can reach Node primordials through the
host-realm objects in their context. The process split does not change
that; it changes what an escaped script can reach. Inside the runner it
has the OS user's file and exec access and, in this design, the one
connection's credentials. It has no route to main's memory, the secrets
vault, the SQLite database, or other connections. The threat model is
otherwise unchanged from W11: the user's own code, on the user's own
machine, against the user's own database. `isolated-vm` is rejected on
the same grounds as in W11: native ABI complications on top of
`better-sqlite3`, and no gain beyond what the process split gives.

## 4. Renderer surface

### 4.1 Tab kind

`WorkspaceTabKind` extends to `'collection' | 'script'`. The existing
tab strip already keys on `kind`; a new icon (`{I.code}`) and label
("Script") are added. New-script creation lives behind a "+ Script"
entry in the same overflow menu the workspace already uses for "+
Collection" tabs.

### 4.2 `ScriptTab.tsx`

Layout: vertical split, editor on top, result panel on the bottom,
`ResizeHandle` between (height ratio persisted in `state_json` so the
split survives relaunch).

- **Editor**: a `<ScriptEditor>` component wrapping CodeMirror 6 with
  `@codemirror/lang-javascript`, the project's existing dark/light
  theme tokens, and a controlled `value` / `onChange` API. Buffer
  changes flow through the same 250 ms-debounced
  `api.tabs.update({ stateJson })` path the rest of the workspace
  uses.
- **Run / Cancel toolbar**: Run is `Cmd/Ctrl+Enter`. While a run is
  in flight the button flips to Cancel and dispatches
  `script:cancel`.
- **Result panel**: branches by result shape.
  - **Array** → reuse the W06 result components (`TreeView` /
    `JsonView` / `TableView`) with a Tree / JSON / Table toggle
    persisted per-tab as `state.resultView`. Column widths and tree
    row-expansion state also round-trip through `state_json`
    (`resultColumns`, `resultExpandedRows`). When the array is
    not all records (e.g. `db.coll.distinct(...)`) only the JSON
    view is enabled.
  - **Single record** → reuse `JsonView` with a one-element array;
    no toggle.
  - **Scalar / `null` / `undefined`** → small inline `<pre>` with
    EJSON pretty-print.
  Before the first run the panel collapses to a one-line hint bar so
  the editor gets the full viewport; once a result or error is
  present it expands to the persisted height.
  The print buffer renders below the value as a collapsed `<pre>`
  (auto-expanded when non-empty).
- **Status row**: connection name, db name (with a dropdown to
  override), duration, error code (when applicable).

### 4.3 No new editor anywhere else (yet)

CodeMirror 6 is introduced *only* in `ScriptTab.tsx`. The query bar,
filter input, and aggregation stage editor keep their existing
textarea + autocomplete hook. Migrating those is out of scope and
tracked as a follow-up in GitHub Issues.

## 5. Security

- No credentials cross the renderer/main IPC boundary. Main hands the
  runner the connection's credentials over a private message port
  (never argv or env); the runner connects with them.
- The script has the same database authority the connection has — no
  privilege escalation, no impersonation.
- Evaluation happens in a **runner child process**, never in main. The
  renderer only sees the structured wire result.
- The wall-clock kill (`maxTimeMs`) is the only ceiling, and it holds
  against sync loops, microtask loops and awaited promises alike.
- Read-only is enforced by an in-runner guard and is a UI safety guard,
  not a security boundary (see §3).

## 6. Acceptance criteria

- [x] Opening a Script tab shows an empty CodeMirror 6 editor with JS
      syntax highlighting and the project's theme.
- [x] `Cmd/Ctrl+Enter` runs the buffer; the result panel renders the
      last expression value.
- [x] `db.users.find().toArray()` produces a renderable array result
      using the existing `ResultTable` (Tree / JSON / Table toggle,
      same components as the W06 collection result area).
- [x] `print("hi")` appears in the print buffer below the value.
- [x] An infinite loop (`while (true) {}`) is killed by the
      `maxTimeMs` ceiling; the renderer shows a `SystemError` with a
      clear "script exceeded N ms" message.
- [x] A microtask loop (`while (true) await Promise.resolve()`) with a
      500 ms limit returns `TIMEOUT` within about a second, other IPC
      calls keep answering meanwhile, and the next run succeeds.
- [x] A runner that dies mid-run surfaces a `SystemError`, and live
      runners are killed on quit.
- [x] The runner entry is built to `dist-electron/script-runner.cjs`
      and ships inside `app.asar`; a packaged macOS arm64 build (unsigned,
      `--dir`) with the release fuses runs a script. Windows, Linux and a
      signed macOS build are not yet verified.
- [x] Cancelling a long `find` (large collection, no index) via the
      Cancel button aborts within ~1 s.
- [x] Closing and reopening the app restores the buffer text, but not
      the most recent result/error: results can hold production
      documents, so they are never written to `state_json` (main strips
      `lastResult` / `lastError` on every write and a migration scrubs
      older rows). A reopened script tab shows its empty output state
      until Run.
- [x] EJSON round-trips (an `ObjectId` written in the buffer comes
      back as `$oid` in the result, and renders as `ObjectId(...)` in
      the table).

## 7. Test cases

### Unit (main)
- **script-service.spec.ts** (forks the real runner under Node against
  `mongodb-memory-server`): last-expression capture, `print` buffering
  + cap, top-level `await`, sync-loop / microtask-loop / never-settling
  / awaited-server-call timeouts, runner crash, `cancelAll`, cancel
  token bookkeeping, the 50 MB cap, a connection flipped read-only
  mid-run, syntax errors throw `ValidationError`, runtime errors throw
  `MongoOpError` (or `SystemError` for non-Mongo).
- **script-runner-protocol / script-result-encode /
  connection-spec-tls** (unit, in the Stryker `mutate` list): wire
  error round-trip, result encoding and cap, TLS inlining, runner
  environment allowlist.

### Integration (main + memory Mongo)
- **script-handler.spec.ts**: drives `script:run` against
  `mongodb-memory-server`. Covers a `find().toArray()` round-trip
  through EJSON, `cancel` aborts an in-flight `find`, `dbName`
  override is respected, the `db` proxy and the W11 shell agree on
  the same expression's output.

### Component
- **script-tab.spec.tsx**: mounts `<ScriptTab>` against a mocked
  `api.script`. Verifies `Cmd+Enter` invokes `script.run` with the
  buffer, the result table renders an array result, the print
  buffer renders below the value, Cancel calls `script.cancel`,
  buffer changes flow through `api.tabs.update`.

### E2E
- **script-editor.e2e.ts**: launches the real Electron app, seeds a
  connection against an in-memory MongoDB, opens a Script tab,
  types `db.users.insertOne({ name: "x" }); db.users.find().toArray();`,
  hits Cmd+Enter, asserts the document appears in the table and
  survives a relaunch.
