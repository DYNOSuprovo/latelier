# Contributing to L'Atelier

Thanks for looking. This file says what the project expects so you can decide
whether a change is worth your time before you write it.

Two things are unusual here and worth knowing up front:

1. **The merge bar is high and it is not negotiable per-PR.** See
   [Definition of done](#definition-of-done). A change that does not pass it
   does not merge, and "this part probably didn't touch that area" is not a
   reason to skip a gate.
2. **The design docs come first.** `specs/` is the source of truth, not the
   code. Non-trivial changes start by reading the relevant spec.

## Before you start

**Open an issue first** for anything beyond a typo or an obvious one-line bug
fix. This project is spec-driven; a feature that does not fit an existing spec
needs a decision about where it belongs before anyone writes code. A PR that
arrives without that conversation may be asking for a redesign nobody agreed
to.

Bug reports are always welcome without asking first.

## Setting up

Node.js **24.15 or newer, below 25** (see `.nvmrc`). The 24.15 floor is real:
`jsdom` declares `^22.22.2 || ^24.15.0 || >=26.0.0` and an older 24.x fails
`npm install` under `--engine-strict`.

```bash
npm install     # better-sqlite3 ships an N-API prebuilt — nothing compiles
npm run dev     # Vite + Electron in watch mode
```

If you hit a `NODE_MODULE_VERSION` error, do not add a rebuild script — see
the note in [README.md](./README.md#a-note-on-native-modules-better-sqlite3).

## Architecture rules that will fail review

These are not style preferences. Breaking one means the change cannot merge as
written.

- **The renderer is a dumb UI.** `src/**` must never import `mongodb`,
  `better-sqlite3`, `ssh2`, `fs`, `path`, `os`, or anything under `electron/`.
  `scripts/check-renderer-purity.mjs` enforces this, but only as an editor hook
  for agents working in this repo — it is not a git hook, so if you are working
  by hand nothing stops you at commit time. Review will catch it.
- **All I/O lives in the main process**, reached only through the typed bridge
  `window.atelier` (`shared/ipc.ts`, exposed by `electron/preload.ts`).
- **`shared/` is types-only.** Runtime code there drags Node APIs into the
  renderer bundle.
- **Migrations are append-only.** Never edit a merged file in
  `electron/db/migrations/`; add `NNN-name.sql`.
- **Never `console.log`.** Use `electron/log.ts`.
- **Issue numbers in comments point to the history; they don't replace it.**
  `(#87)` in a comment or test title is welcome, but the comment still
  explains *why the code is this way* without opening the issue. A bare `#<n>`
  means an issue in this repository; cite anything else as `owner/repo#<n>`
  or a full URL. No "reviewer finding" tags or date stamps.

[CLAUDE.md](./CLAUDE.md) carries the full set, including the IPC envelope
contract, the main-process layering, and how Extended JSON travels on the wire.
It is written for AI coding agents but it is the accurate description of the
codebase for anyone.

## Definition of done

**[CLAUDE.md's "Definition of done"](./CLAUDE.md#definition-of-done) is the
canonical list, and it is the only one.** What follows is a pointer, not a copy.

That is deliberate. An earlier draft of this file restated the gates and drifted
from the original before it was ever merged — it softened the discovered-issues
rule and dropped two gates outright. This project retired a `BACKLOG.md` for the
same reason: a second copy of a list always loses to the first.

In short: typecheck, lint, the Vitest suite, mutation testing, the two-part IPC
gate, E2E, reviewer findings resolved, and every issue your change discovered
closed — **not merely filed**. Read the real list before you rely on that
summary; the details are where the drift happens.

Two points worth calling out because they surprise people:

- **Filing a discovered issue is not discharging it.** A defect you notice does
  not belong in your diff — file it, and link it as a blocker of the work that
  found it. The feature stays unfinished while a blocker is open. Only the
  maintainer can de-scope one, and only in writing.
- **`npm run test:mutation` is not in CI.** Neither is the `ipc-channel-auditor`
  agent. A gate that CI cannot run is still owed; someone runs it by hand.

Tier is picked once, from the change as a whole. Docs-only — Markdown files and
nothing else, `specs/` included — owes only the discovered-issues gate. A
comment-only edit to a source file owes a subset. A change touching both docs
and code is a code change.

CI runs lint, typecheck, `audit:ipc`, the Vitest suite **and E2E** on pushes to
`main` and on PRs targeting `main`.

## Testing

Four layers, exposed as Vitest projects:

| Layer | Environment | For |
| --- | --- | --- |
| `unit` | node | pure functions — URI parser, MQL compiler, EJSON, reducers |
| `integration` | node + real SQLite temp file + `mongodb-memory-server` | services, repos, handlers |
| `component` | jsdom + Testing Library | renderer components against a mocked `window.atelier` |
| `e2e` | Playwright + Electron | full flows, throwaway `userData` per test |

Two habits this codebase has learned the hard way:

- **A fixture that cannot express the bug cannot test for it.** Before
  asserting, check that your fixture could actually fail.
- **Verify a claim about language or library semantics empirically** — a quick
  Node probe — rather than asserting it from memory. Boxed BSON values and raw
  JS numbers do not compare the way you expect.

## Commits and pull requests

- One logical change per PR. Say what broke and why the fix is the right shape,
  not just what you changed.
- **Never amend a pushed commit.** New commit, always.
- Never use `--no-verify` or `--no-gpg-sign`.
- Resolve a review thread once you have pushed the fix for it.
- Reference the issue your PR closes.

## Agent tooling is optional

Parts of this repo are set up for AI coding agents — `CLAUDE.md`, `AGENTS.md`,
`.claude/`, and a GitNexus code-intelligence index. **None of it is required to
contribute.** If you are working by hand, ignore `.claude/` entirely; the
Definition of done above is the whole contract.

## Licence

By contributing you agree your contribution is licensed under the
[MIT Licence](./LICENSE), the same terms as the project.
