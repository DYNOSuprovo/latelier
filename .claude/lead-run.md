# Project overlay for agent-led runs

Read by a lead running several tickets through worker agents (the
`pragmatic-orchestrate` skill's `epic-run.md` looks for this file) and appended
to every worker brief. CLAUDE.md stays the authority; this file only collects
what a worker in a worktree must know on top of it.

## Worker rules

- **Never install dependencies in a worktree.** Lead-made worktrees get a
  symlinked `node_modules` (`ln -s ../../../node_modules .claude/worktrees/<wt>/node_modules`);
  `npm ci` or `npm install` through the link deletes the shared install and
  breaks every other worktree and the main checkout. A module that seems
  missing is reported, not installed.
- **Never launch the app against the real profile.** Any Electron launch
  (dev, packaged, e2e by hand) sets `ATELIER_USER_DATA_DIR` to a fresh
  directory under the system temp dir. `~/Library/Application Support/L'Atelier`
  is off-limits, read or write.
- **Fast gates only:** `npx tsc -b`, `npm run lint`, the specs you added or
  touched plus the existing specs of the modules you changed
  (`npx vitest run --project <unit|integration|component> <files>`), and
  `npm run audit:ipc` when you touched `electron/ipc` or `shared/`. A module in
  `stryker.config.json`'s `mutate` array gets a scoped run, kept at 90% or more:
  `npx stryker run --mutate <file> --ignorePatterns release,.claude,.playwright-mcp`.
- **Behaviour-parity work** (anything that moves a database call, a script or
  the shell across a process or RPC boundary) tests every BSON type both ways
  and every cursor kind, tailable included, against `mongodb-memory-server`.

## Lead facts

- **Worktree setup**, on the base the ticket merges into:
  `git worktree add -q -b <branch> .claude/worktrees/<wt> origin/<base>` then
  the `node_modules` symlink above.
- **Per-PR gates** (the lead runs them once per head commit): `npx tsc -b`,
  `npm run lint`, `npm run audit:ipc`, `npm test`, `npm run test:e2e`.
  **Once per base**, before the PR to `main`: `npm run test:mutation` and the
  `ipc-channel-auditor` agent.
- **CI check to wait on** for a PR into a feature base: `SonarCloud Code Analysis`
  (no GitHub workflow runs there). Wait for it on the head commit before
  merging; a merge while it is pending is how a quality-gate failure lands.
- **`github-advanced-security` failing** is usually Copilot's autofind job
  erroring (`The requested model is not supported` in the job log), not a
  finding. Read the log before treating it as either.
- **Known flaky component tests under full-suite load:** #247 and #390. A
  failure there is re-run in isolation before it is treated as a regression.
