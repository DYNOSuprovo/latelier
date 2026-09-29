# X15 — Dialog consolidation onto Mantine + unsaved-changes guards

This is *epic N1 — Consolidate hand-rolled dialogs onto Mantine + unsaved-changes guards*.

## Purpose

The app has two dialog stacks. Mantine `Modal`/`Drawer` (`DeleteConfirm`,
`CreateCollectionDrawer`, `TroubleshootingDrawer`, the `Drop*` confirms) get
Escape-to-close, a focus trap, initial focus, and focus return for free. Eleven
hand-rolled `position: fixed` overlays each independently lack all four, and
several put `role="dialog"` on the *backdrop* rather than the panel, so screen
readers announce the wrong element.

Verified 2026-08-14: **zero** of the hand-rolled overlays handle Escape at all
(`grep -c Escape` returns 0 for every one of them).

This spec collapses the second stack into the first, and closes the data-loss
hole that both stacks share.

## Scope

### In

- The eleven hand-rolled overlays in §1, migrated to Mantine `Modal`/`Drawer`.
- An unsaved-changes guard on every dialog that holds typed input — including
  the two that are *already* Mantine (§2 explains why they need it too).
- `role="dialog"` on the panel, an accessible name on every dialog.

### Out — deliberately, and not "not yet"

- **`FeatureHint.tsx:65`** — the epic says X15 "subsumes most of it". It does
  not subsume the FeatureHint. A coachmark is a non-modal popover that points at
  the thing it describes; trapping focus in it and requiring Escape to leave
  would make it *worse*, not better. It stays open on its own terms.
- **`ReferenceDrawer`** (`features/references/ReferenceDrawer.tsx`) — a docked
  inline flex panel inside the results area, with no backdrop and no modal
  semantics. It is not a dialog and must not become one. Named here so that a
  later pass does not "finish the job" by converting it.
- **Extracting `NewTabPicker`** out of the 2813-line `Workspace.tsx`. It gets
  migrated *in place*. Extraction is a worthwhile refactor and a separate one.
- **`Workspace/DeleteConfirm.tsx`** and
  **`features/connections/ConnectionDeleteDialog.tsx`** — already Mantine, and
  both are deliberately *not* folded into `confirmDestructive`; the reasons are
  written into `src/utils/confirm.ts` and still hold. Which of the app's
  destructive dialogs get type-to-confirm versus an undo toast is decided by
  [ADR 0013](../docs/adr/0013-destructive-friction.md), not by this spec.

## Dependencies

- `@mantine/core` ^9.5.1, `@mantine/modals` — both already dependencies.
- `ModalsProvider` is mounted in `src/App.tsx:44` and in the component-test
  render helper `tests/helpers/render.tsx:32`. Nothing new to wire.

## 0. Where the pieces live today

The epic's file:line anchors are from 2026-07-16 and have drifted. `NewConnection.tsx`
in particular is now 97 lines — `PlaintextFallbackModal` moved into
`ConnectionForm.tsx`. Anchors re-verified 2026-08-14:

| Overlay | Anchor (`role="dialog"`) | Holds typed input |
| --- | --- | --- |
| `EditDrawer` | `Workspace/EditDrawer.tsx:257` | yes — replacement doc / `$set` patch |
| `NewTabPicker` | `Workspace.tsx:295` | no |
| `SaveModal` | `Workspace/SaveModal.tsx:79` | yes — name + description |
| `WriteStageConfirm` | `Workspace/Aggregation/AggregationTab.tsx:678` | no |
| `ExplainDrawer` | `Workspace/Aggregation/ExplainDrawer.tsx:153` | no |
| `SavePipelineModal` | `Workspace/Aggregation/SavePipelineModal.tsx:70` | yes |
| `SaveAsCollectionModal` | `Workspace/Aggregation/SaveAsCollectionModal.tsx:78` | yes |
| `CreateIndexDrawer` | `IndexesTab.tsx:714` † | yes — multi-field |
| `UserDrawer` | `UsersTab.tsx:678` † | yes — multi-field |
| `PlaintextFallbackModal` | `features/connections/ConnectionForm.tsx:1264` | no — but see below |
| `ReferenceRulesEditor` | `features/references/ReferenceRulesEditor.tsx:201` | yes — rule form |

`PlaintextFallbackModal` holds no text input but is a **security** confirmation —
it asks the user to accept storing a secret in plaintext. It gets the same
treatment as the rest and is not deprioritised for being small.

† **These two have no backdrop at all**, and their `role="dialog"` was already on
the panel. They are bare `position: absolute` panels inside their tab's
`position: relative` container — no scrim, no `inset: 0`, nothing to click
through. Verified against the pre-migration source, because the table above
otherwise reads as if every row shared the backdrop defect.

That changes what the guard is *for* on these two. Elsewhere in X15 the guard
closes an existing hole — a stray backdrop click already discarded typed input.
Here there was no backdrop to click, so Mantine's overlay and its Escape handler
are **new** dismissal surfaces the drawers never had. The guard ships alongside
them rather than fixing them: migrating without it would *introduce* the
data-loss path instead of removing one.

Worth stating plainly because it is the one place in this spec where the same
change is justified by a different argument, and a reviewer checking "did this
fix the reported bug?" would find no reported bug to point at.

### Already fixed — do not re-migrate

The epic lists a twelfth row, **`SavedTab` inline delete**, as "a 3rd distinct
delete-confirm pattern". That was fixed separately (N4.7): `views/SavedTab.tsx:53`
now calls `confirmDestructive`, and the hand-rolled `role="alertdialog"` overlay
is gone. The row is stale. Scope is **eleven** overlays, not twelve.

## 1. The migration (Mantine, no custom wrapper)

Each overlay's hand-rolled backdrop `<div>` + panel `<div>` collapses to a
Mantine `<Modal>` or `<Drawer>`. `CreateCollectionDrawer.tsx:161` and
`DeleteConfirm.tsx:145` are the two in-repo reference implementations.

**No shared dialog wrapper is introduced.** Mantine already *is* the wrapper;
a project-local component around it would add an indirection whose only job is
to re-export defaults. The one thing Mantine does not supply is the dirty-guard,
and that already exists too (§2).

Drawers keep `position="right"`, matching the four that are already correct.

## 2. The unsaved-changes guard — and the trap it exists to close

**This is the load-bearing section. A migration that skips it ships a regression
while every gate stays green.**

Mantine's `Modal` and `Drawer` both default to `closeOnClickOutside: true`
(verified in `node_modules/@mantine/core/esm/components/{Modal,Drawer}/*.mjs:18`).
That default *is* the defect the epic reports against `EditDrawer` — "backdrop
click discards a fully-typed replacement doc".

So a naive migration is actively misleading. It delivers Escape, the focus trap,
focus return, and `role="dialog"` on the panel — four real fixes — and **silently
preserves the data-loss bug**, because the hand-rolled backdrop's `onClick={onClose}`
is replaced by a Mantine default that does exactly the same thing.

It also means the two drawers that are *already* on Mantine —
`InsertDrawer` and `CreateCollectionDrawer` — **have this bug today**. They were
never in the "hand-rolled" category, which is why the epic files them under
guards rather than migration.

Every dialog holding typed input therefore takes both:

```tsx
<Drawer
  opened
  onClose={requestClose}          // not onClose={onClose}
  closeOnClickOutside={false}     // backdrop no longer discards
  position="right"
  title="Edit document"
>
```

…where `requestClose` consults the existing shared confirm:

```ts
const requestClose = async () => {
  if (!isDirty) return onClose();
  const discard = await confirmDestructive({
    title: 'Discard changes?',
    body: 'This closes the editor and loses what you typed.',
    confirmLabel: 'Discard',
  });
  if (discard) onClose();
};
```

`confirmDestructive` (`src/utils/confirm.ts`) already exists — built for that fix,
already used at five call sites, promise-returning so it drops into existing
control flow without inverting it. Its doc comment already names `"Discard"` as
one of the expected verbs. **No new hook, no new abstraction.**

`closeOnClickOutside={false}` is set only on dialogs that hold input. A dialog
with nothing to lose (`ExplainDrawer`, `NewTabPicker`, `WriteStageConfirm`) keeps
the default, because there a backdrop click is a convenience, not a trap.

### Ten guarded surfaces, and how the list kept growing

The count moved twice, both times for the same reason, and the reason is worth
more than the number.

The epic listed **five**. Auditing input sites found **nine**. Then T8 found a tenth,
`ConnectionFormModal` — a Mantine `Modal` hosting the entire connection
form including a typed **password**, with both dismissal defaults left on. Escape
or one stray backdrop click discarded the lot.

Every miss has the same shape: the surface was **already on Mantine and never
hand-rolled**, so it appeared on neither the epic's audit of hand-rolled overlays
nor the list derived from it. That blind spot cost four things in this epic —
`InsertDrawer` and `CreateCollectionDrawer` carrying the data-loss bug,
twelve unnamed close buttons, the a11y criteria in §3 silently exempting
already-Mantine dialogs, and one further defect it produced.

**"Already on Mantine" is not evidence of "correct."** Mantine supplies the
mechanics — focus trap, Escape, portal — and *none* of the policy: not
`closeOnClickOutside`, not `aria-label` on the close button, not what counts as
dirty. A dialog that was migrated years ago is exactly as likely to be wrong on
policy as one written last week, and *less* likely to be looked at.

`ConnectionFormModal`'s guard reads dirtiness from `@mantine/form`'s own
`isDirty()` rather than a hand-rolled snapshot, surfaced through an
`onDirtyChange` prop because the form state lives inside `ConnectionForm` and the
modal owns the dismissal. `ConnectionForm` already calls `formApi.resetDirty()`
after hydrating an edit, so the pre-fill case is correct without this layer
knowing what a loaded connection looks like.

### The nine found before that

The epic lists five guard targets. Auditing the input sites found **nine** dialogs
that hold typed input and lose it identically on a backdrop click:

| Guarded | In epic's list? |
| --- | --- |
| `EditDrawer`, `InsertDrawer`, `CreateCollectionDrawer`, `SaveModal`, `ReferenceRulesEditor` | yes |
| `CreateIndexDrawer`, `UserDrawer` | **no** — both multi-field config forms |
| `SavePipelineModal`, `SaveAsCollectionModal` | **no** — both name/description forms |

The four additions are the same defect with the same fix, so they are guarded in
the ticket that migrates them rather than deferred to a follow-up. Confirmed with
the maintainer 2026-08-14.

### Dirtiness is "differs from initial", not "was touched"

`isDirty` compares the current buffer to what the dialog opened with. Typing a
character and deleting it again is not dirty. This matters for `EditDrawer`,
which opens pre-filled with the document, and for `InsertDrawer`'s Duplicate
pre-fill: a "was focused" heuristic would prompt on every close.

### Dirtiness spans every buffer the dialog owns, not the visible one

`EditDrawer` keeps **two** buffers — `docJson` (replace mode) and `patchJson`
(update mode) — and `switchMode` (`EditDrawer.tsx:125`) deliberately preserves
both when toggling. An `isDirty` that reads only the *active* buffer is wrong in
a way that is easy to ship and hard to notice:

> Type a `$set` patch in update mode → switch to replace mode → click the
> backdrop. The active buffer is the untouched document, so `isDirty` is false,
> no prompt fires, and the typed patch is gone.

So `isDirty` is the disjunction over every buffer the dialog owns:
`docJson !== initialDocJson || patchJson !== '{}'`. Any dialog with more than one
input follows the same rule — `CreateIndexDrawer` and `UserDrawer` are multi-field
and get the same treatment.

## 2b. Focus return — `useDialogFocusReturn`, and the traps under it

Mantine's own `returnFocus` is **inert in this app**. `useFocusReturn` hangs its
whole body off `useDidUpdate` keyed on `opened`, `useDidUpdate` skips its first
run, and every dialog here mounts with `opened` a bare attribute and is unmounted
by its parent. `opened` never transitions, so the trigger is never captured and a
close leaves focus on `<body>` — silently, and only for keyboard and
screen-reader users. Filed and fixed separately.

`src/hooks/useDialogFocusReturn.ts` is the single mechanism. It wraps a close
handler; **wrap the dismiss paths only** — Mantine's `onClose` plus Cancel/Close
buttons. Success paths (`onSaved`, `onDropped`, `onInserted`) stay raw: they are
handoffs into another surface, and after a drop or rename the trigger is often a
row that no longer exists.

Three things about it are load-bearing, each learned the hard way:

**Capture during render, never in a mount effect.** The original fix specified a
mount effect, reasoning that React runs child effects before parent effects and
Mantine's focus trap defers via `setTimeout`. That holds for `EditDrawer` — and
breaks for every dialog carrying `autoFocus`, because React applies `autoFocus`
in the commit's *layout* phase, before any `useEffect`. The effect then captures
the dialog's **own** input and later "restores" focus into a node being
unmounted, landing on `<body>`. A `useState` initializer runs before the commit,
so nothing has moved focus yet.

Verified by mutation: swapping the initializer for a mount effect reds exactly
the `CreateCollectionDrawer` case (which has `autoFocus`) while `InsertDrawer`
(which does not) stays green. Affects `CreateCollectionDrawer`,
`DropCollectionConfirm`, `DropDatabaseConfirm`, `RenameCollectionModal` and both
tab drop confirms.

**Restore only focus that is still ours.** Restoring unconditionally — Mantine's
behaviour — drags focus off a control the user clicked elsewhere and back onto
the trigger. `ConnectionSwitcher.tsx:344` documents this; the shared hook uses a
`[role="dialog"],[role="alertdialog"]` check, a deliberately wider superset of
that `contains` test so a nested overlay still counts as ours.

**Run from the close gesture, not from unmount.**
`ConnectionExpandedTable.tsx:186` documents why: several of its actions unmount
it straight into another surface, and an unmount-keyed effect fires there too,
racing that surface's own `FocusTrap` for a coin-flip winner.

`ConnectionSwitcher` and `ConnectionExpandedTable` keep their specialised
implementations — both are documented, and `ConnectionExpandedTable` needs a
`returnFocusTo` prop the shared hook cannot supply.

## 2c. The flex fix applies to `Drawer`, not to centred `Modal`

The `styles={{ content, body }}` column is needed wherever a full-height
**`Drawer`** sizes its content with `flex: 1` — `EditDrawer`, `CreateIndexDrawer`,
`UserDrawer`, `ExplainDrawer`. A drawer's content is the full viewport height, so
the body has to be *told* to take the remaining track or the child collapses.

It is **not** needed on a centred **`Modal`**. Mantine sizes a centred modal to
its children and caps its own height, so the body already occupies what is left
of the content and the flex column changes nothing.

Measured on `ReferenceRulesEditor` with 60 seeded rules, with and against the
fix — **identical** both ways: modal 720px in an 800px viewport, no viewport
overflow, no internal scroll. The `styles` block was therefore removed from it
rather than kept as defensive decoration, along with a comment asserting a
failure mode ("a long rule list grows the body past the modal") that does not
occur.

Two things follow for anyone extending X15:

- Don't copy the block onto a `Modal` by analogy with the drawers. Measure first.
- The body-vs-content ratio used by `x15-drawer-body-fill.e2e.ts` and
  `a06-explain-plan.e2e.ts` is a **drawer** metric. On a centred modal it sits
  near 100% whether or not the fix is present, so an assertion written that way
  passes against the broken layout and proves nothing.

## 3. Acceptance criteria

Per dialog X15 touches — **migrated or already Mantine**:

- [ ] Escape closes it (via the dirty-guard where one applies).
- [ ] Focus moves into the dialog on open, is trapped while open, and returns to
      the trigger on close.
- [ ] `role="dialog"` resolves to the **panel**, not the backdrop.
- [ ] It has an accessible name.
- [ ] `✕`/close controls have an `aria-label`.

> **These apply to every dialog, not only the hand-rolled ones.** An earlier
> draft scoped this list to "migrated overlays", which quietly exempted the
> dialogs that were already Mantine — and the epic's own acceptance says
> plainly that *every* dialog needs an accessible name. The exemption had teeth:
> Mantine's `CloseButton` ships **no** default `aria-label` (its `defaultProps`
> are `{ variant: "subtle" }`), so twelve already-Mantine dialogs render an
> unnamed `✕` that a screen reader announces as just "button". Filed separately.
>
> The general lesson for the rest of this spec: *already on Mantine* is not
> evidence of *correct*. It was the same mistake behind §2 — those dialogs
> carried the backdrop data-loss bug precisely because nobody re-examined them.

Per input-holding dialog, additionally:

- [ ] `closeOnClickOutside={false}`.
- [ ] A backdrop click with a dirty buffer is **inert** — it does not close, and
      it does not prompt. The typed text is still there afterwards.
- [ ] Escape with a dirty buffer **prompts**; Cancel keeps the typed text and
      leaves the dialog open; Discard closes it.
- [ ] Closing a clean dialog does *not* prompt.

### The backdrop is inert, it does not prompt — and why that distinction matters

An earlier draft of this section asked for both `closeOnClickOutside={false}`
*and* "a backdrop click prompts". Those are contradictory: the prop is what makes
the backdrop stop dismissing the dialog at all, so there is no dismissal left to
intercept.

Picking the *prompting* variant instead — leaving `closeOnClickOutside` at its
default and routing `onClose` to the guard — would also quietly defeat §4. With
`onClose={requestClose}`, removing `closeOnClickOutside={false}` still prompts and
still preserves the text, so the mutation is a **no-op** and the test stays green
against the broken code. The whole point of §4 is that this exact mutation kills a
test.

So: the backdrop is inert, and the assertion that discriminates is *"no prompt
appeared"*. The prompt-and-Cancel-keeps-the-text behaviour lives on **Escape**,
which is a criterion in its own right above.

## 4. Verification — mutation, not green

`tsc -b` was green before this work and proves nothing about it. Each ticket
validates by mutation:

1. **The guard**: type into the buffer, click the backdrop, assert the text
   survives. Then delete `closeOnClickOutside={false}` and confirm that exact
   test goes red. A guard test that stays green with the prop removed is testing
   nothing.
2. **The a11y set**: assert focus lands inside the panel on open and returns to
   the trigger on close.

Watch for equivalent mutations: removing `closeOnClickOutside={false}` from a
dialog that has no dirty state is a no-op, not a coverage hole.

## 5. Test-suite impact

Baseline on the base branch at cut time (`75ab79a`): **2503 tests** — 1088 unit /
591 integration / 824 component, across 213 files, all passing.

Mantine portals dialog content to `document.body`. Existing component tests that
reach into an overlay by DOM structure (`container.querySelector`) break; tests
using accessible queries (`getByRole`, `getByLabelText`) survive. The per-ticket
breakdown is in §6.

## 6. Ticket slicing

Sliced **one ticket per overlay cluster, each fully migrated + guarded + tested**.

The horizontal split this deliberately refuses is "T1 build a wrapper → T2 migrate
everything onto it → T3 add the guards": the first two tickets would be
un-demoable, and the third would be a second edit pass over every file already
touched. There is no backend layer here to slice against — the UI → IPC → service
axis has no purchase on a pure-renderer change — so the vertical axis is the
overlay itself.

**T1 is conventions-setting.** Every later ticket copies its guard shape, its
mutation test, and its handling of portaled DOM. It is `EditDrawer` because that
is the surface the bug was reported against, and because it exercises migration
*and* a multi-buffer dirty guard in one ticket.

### Churn, measured

Two things make this much smaller than it looks.

**The harness already absorbs the transition risk.** `tests/helpers/render.tsx`
wraps every component render in `MantineProvider theme env="test"` +
`ModalsProvider` + `Notifications`, and `env="test"` makes Mantine `<Transition>`
mount synchronously. `jsdomSetup.ts` already shims `matchMedia`/`ResizeObserver`.
Playwright uses page-scoped, auto-retrying locators. **No prerequisite harness
ticket is needed** — and `CreateCollectionDrawer` already portals today and
passes, which is the existence proof.

**Scan for `dialog.querySelector`, not just `container.querySelector`.** A first
pass over `container.` / `baseElement.` prefixes reported 11 of 110 files at risk
and pointed at the aggregation tab. That was wrong twice over:
`aggregation-tab.spec.tsx`'s `querySelector` calls target the *tab body*, not any
overlay, so they survive portaling — while the calls that genuinely break are
`dialog.querySelector(...)`, which that prefix filter never matched.

Real rework is concentrated in **`ExplainDrawer`**, not the aggregation cluster
at large:

| File | Breakage | Fix |
| --- | --- | --- |
| `component/explain-drawer.spec.tsx` | 3 × `dialog.querySelector('pre')` (L101/106/111) | `within(dialog).getByRole(…)` or a testid |
| `component/query-bar-explain.spec.tsx` | `dialog.querySelector('[role="alert"]')` (L294) | `within(dialog).getByRole('alert')` |
| `e2e/w10-saved-recent.e2e.ts` | `getByRole('button', {name:/^Save$/}).last()` (L51) — DOM-order assumption on SaveModal | scope to `win.getByRole('dialog')` |

Everything else in scope uses accessible queries and migrates untouched. The
`.closest('button')` uses in `users-create-drawer`, `collection-create-drawer` and
`connection-form` all sit on *triggers* outside the overlay, so they are safe.

### Coverage holes — three overlays have no tests at all

`WriteStageConfirm`, `SavePipelineModal` and `SaveAsCollectionModal` have **zero**
tests today. (`aggregation-tab.spec.tsx:180` tests the inline `$out` warning
strip, not the confirm dialog; `output-panel*.spec.tsx` only stub the
`onSaveAsCollection` prop and never open the modal.)

That makes them cheap to *change* and dangerous to change *unverified* — there is
no net. Their tickets write the a11y + guard tests from scratch rather than
adapting existing ones, and that authoring is the bulk of their cost.

| # | Ticket | Overlays | Guard? | Test position | Effort |
| --- | --- | --- | --- | --- | --- |
| T1 | `EditDrawer` — migrate + guard | 1 | yes (2 buffers) | ~41 cases, 4 files + e2e, all accessible → migrate-and-run | S |
| T2 | Guards for the already-Mantine drawers | 0 (guard-only) | `InsertDrawer`, `CreateCollectionDrawer` | ~28 cases, all accessible; `InsertDrawer` is the reference pattern for querying a portaled Drawer here | S |
| T3 | Workspace overlays | `NewTabPicker`, `SaveModal` | `SaveModal` | ~9 cases accessible; **one e2e ordering fix** (`w10` L51) | S |
| T4 | Aggregation cluster | `WriteStageConfirm`, `ExplainDrawer`, `SavePipelineModal`, `SaveAsCollectionModal` | the two Save* | **`ExplainDrawer`: 4 `dialog.querySelector` to rewrite. Other three: no tests exist — author them.** | M |
| T5 | Admin tabs | `CreateIndexDrawer`, `UserDrawer` | both (multi-field) | ~12 cases, accessible → migrate-and-run | S |
| T6 | Connections + references | `PlaintextFallbackModal`, `ReferenceRulesEditor` | `ReferenceRulesEditor` | ~7 cases, `screen`-scoped/`within` → safe | S |

Totals: 11 migrations + 2 guard-only surfaces = 13.

T2 is guard-only and carries no migration. It is a separate ticket rather than
folded into T1 because it is the one that closes a **latent** bug — these two
drawers look correct today precisely *because* they are already on Mantine, and
nothing about them would draw a reviewer's eye. Shipping it on its own makes that
visible in the history.

### Stack order

T1 → T2 → T3 → T4 → T5 → T6, each branched off the previous (not off the base).
T4 last-but-two on purpose: by then the portaling/selector breakage pattern is
known from four earlier tickets rather than being discovered inside the ticket
with the most test churn.

Run `npm run test:e2e` locally **after T1**, not at the end — so the transition
and selector fallout is learned once instead of six times. Redirect to a file;
piping a long run through `grep` buffers and looks wedged.
