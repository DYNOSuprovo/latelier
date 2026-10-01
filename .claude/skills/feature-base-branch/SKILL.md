---
name: feature-base-branch
description: Run a multi-ticket feature through a shared base branch — spec to main, one branch per issue merged into the base, single PR to main at the end. Use when a spec produces more than two tickets. Invoke with `/feature-base-branch <base-branch-name>` — e.g., `/feature-base-branch query-builder-redesign`.
disable-model-invocation: true
---

You are running a multi-ticket feature through a shared base branch. Ticket branches
stack on each other and merge into the base; only the finished base merges into `main`.
This keeps each ticket independently revertable while `main` sees one reviewable diff
and one e2e run.

Used for `feature/connection-switcher`, `feature/connection-switcher-redesign`,
and `query-builder-redesign` — those predate the
stacked-branch and vertical-slice changes below; treat them as shape references only.

## The shape

```
main ──────────────────────────────────────────────────────────┬── base PR ── main
       └─> base branch (spec committed directly, no PR) ──┐
                                                      feat/<N>-slug
                                                            │
                                                      feat/<M>-slug   (stacked on <N>)
                                                            │
                                                      feat/<P>-slug   (stacked on <M>)

                                        merge into base in stack order, oldest first
```

A ticket that does not build on another open ticket branches straight off the
base instead; stack only where there is a real dependency.

## Workflow

1. **Cut the base branch from freshly-pulled `main`, then commit the spec straight onto
   it** — no separate PR to `main` for the spec. Ticket bodies still cite its section
   numbers.
   ```bash
   git fetch origin --prune && git checkout main && git pull && git checkout -b <base>
   # add/edit specs/<slug>.md, commit it directly on <base>
   git push -u origin <base>
   ```

2. **File issues sliced vertically, not horizontally.** Default is one issue per
   acceptance-criteria cluster — but when the criteria naturally split into layers
   (backend endpoint, frontend wiring, tests), don't file one issue per layer. File one
   issue per vertical slice instead: each ticket ships a complete, demoable increment of
   user-visible behavior end-to-end (UI → IPC → service → repo), even if slim. Horizontal
   slicing leaves every ticket but the last un-demoable and forces false serialization —
   the frontend ticket can't be verified until the backend ticket merges. Add each issue
   to the project board. Resolve the owner from the checkout first, then the project
   number from the owner — hardcoding either fails with a misleading
   "Could not resolve to a ProjectV2" after a transfer or a rename:
   ```bash
   owner=$(gh repo view --json owner --jq .owner.login)
   gh project list --owner "$owner"          # pick the board, note its number
   gh project item-add <number> --owner "$owner" --url <issue-url>
   ```

3. **One branch per issue; stack only on a real dependency.** A ticket that needs
   another open ticket's code branches off **that ticket's branch**, without waiting
   for it to merge — that's what makes it a stack instead of a serial queue. A ticket
   that needs nothing unmerged branches straight off the base, so it can merge in any
   order. Never commit directly to the base or to another ticket's branch; even a fix
   gets its own branch and PR.

4. **Delegate implementation to a subagent**, one ticket per agent. Give it the spec
   section and the *current* `npm test` baseline count — the branch it's stacked on, not
   `main`'s and not necessarily the base's. Every worker brief carries
   `.claude/lead-run.md` (worktree, profile and gate rules). Leading the run through
   agents end to end — planning, briefs, review, waiting, shipping — follows the
   `pragmatic-orchestrate` skill's `epic-run.md` where you have it installed.

5. **Validate by mutation before pushing.** Break the property the new tests claim to
   protect, confirm they go red, revert. A green `tsc -b` proves nothing; it was green
   before. Watch for equivalent mutations — a change the compiler or runtime collapses
   back to identical behaviour is not a coverage hole.

6. **Open the PR against the branch this ticket is stacked on** — the previous ticket's
   branch, or the base for the first ticket in the stack — body carrying `Closes #N`.
   When the branch it targets merges, its PR needs to retarget onto whatever that branch
   merged into, so it eventually points at the base (GitHub does this automatically if
   the merged branch is deleted; otherwise retarget by hand before continuing).

7. **Run the gates the non-default base suppresses.** A PR not targeting `main`
   triggers **no GitHub workflow** — `pull_request` is scoped to `branches: [main]` to
   conserve runner minutes. Only the installed apps report on it (SonarCloud, the review
   bot). Their checks are not the gates; every gate is yours:
   - Lint, `tsc -b`, `audit:ipc`, and `npm test` run locally — CI will not run them.
   - `npm run test:e2e` locally too, nothing else running concurrently (it wedges
     Rolldown's thread pool). CI runs e2e only on PRs into `main`.
   - `Closes #N` does not auto-close → `gh issue close #N` with a comment on what landed.
   - A review bot's green check is not a review: confirm it actually posted one on the
     head commit (a bot on a plan that reviews nothing still reports "pass").

8. **Never merge a ticket PR until every check on it is green**, and merge the stack in
   order — oldest first. Wait for the run to finish — a pending or failed check is a
   block, not a formality. Wait in one background job rather than polling in the
   foreground:
   ```bash
   gh pr checks <N> --watch
   ```
   A check that failed for infrastructure reasons (read its log first) is not a code
   failure; say so on the PR before merging past it.
   A red check gets fixed on the ticket branch and re-run. Don't merge out of stack
   order — merging a downstream ticket before the one it's stacked on leaves it carrying
   that ticket's diff, and its gates pass against content that isn't in the base yet.
   Don't merge "to unblock the next ticket" either — a broken base poisons every branch
   stacked on it afterwards.

9. **Anything found mid-run becomes a new issue, stacked into the same chain like any
   other ticket** — never scope creep in the current ticket. File it, link it as a
   blocker of the base's tracking issue (`docs/agents/issue-tracker.md`), then branch and
   ship it the same way as every other ticket in the stack. These filed issues are now
   part of the feature, not an optional follow-up: the feature is not complete, and the
   base → `main` PR does not open, until every issue found mid-run is implemented and
   merged into the base — filing it is what gets it scheduled, not what discharges it.

10. **When every issue — original and discovered — is closed, run `/verify` before
    calling the feature done.** Only after it passes, open the PR base → `main`. This
    one gets the full gate: every Definition-of-Done gate in `CLAUDE.md`, including
    `npx tsc -b` by hand (nothing in CI typechecks `main`) and Gitar's review on the
    combined diff.

    **Merging base → `main` requires the user's explicit consent, every time.** Open the
    PR, run the gates, report the result, and ask. "The gates are green" is not consent;
    neither is an earlier approval of the feature, the spec, or any ticket merge. Without
    a clear yes in the current conversation, the run ends with an open PR — that is a
    complete, successful outcome, not an unfinished one.

11. **Clean up**, once the user has merged or told you to. Merge with `--delete-branch`, `git fetch --prune`, and verify before
    deleting anything local:
    ```bash
    git merge-base --is-ancestor <branch> main && echo MERGED || echo NOT MERGED
    ```
    A `[gone]` upstream plus an unmerged commit means the PR was *closed*, not merged —
    don't delete it. Then re-check the native ABI by **opening a database**:
    ```bash
    node -e "const db=require('better-sqlite3')(':memory:'); db.prepare('select 1').get(); db.close();"
    ```

## When not to use this

Two tickets or fewer — branch each off `main` directly. The base branch pays for itself
by collapsing N e2e runs and N reviewer passes into one; below three tickets it's just an
extra merge.
