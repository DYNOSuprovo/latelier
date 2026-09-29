# W14 — Query bar advanced row: correctness, affordance, projection

## Purpose

W13 §7 made the query bar the **single owner** of sort / limit / projection by
deleting the drawer's duplicate editors. That was the right call, but it removed
a safety net that had been masking two defects in the surviving owner:

1. The advanced row's open/closed state is computed **once, at first mount**, and
   never resyncs. After the first tab, whether it is open bears no relation to
   whether the tab actually has advanced values set.
2. The projection input **silently discards** the user's typed text when it fails
   to parse — contradicting the null contract `parseProjection` was written to
   honor.

Both predate W13. Neither mattered much while the drawer carried a second,
always-correct copy of these fields. Post-W13 the advanced row is the only
surface, so a wrong or hidden advanced row is now a wrong query with no second
opinion available.

This spec covers the correctness fixes, the missing affordance, and the
projection editor's parity gap with the filter tree.

> **Since decided (§4):** projection no longer lives in the advanced row — it
> moved into the result bar's Fields control. Where §1–§3 and §7–§8 say
> "projection / sort / limit", the advanced row now carries sort / limit
> only; §3's draft contract moved with the input and holds there unchanged.

## Scope

- **In**: `advancedOpen` lifecycle, a persistent indicator that collapsed
  advanced values exist, `commitProjection`'s draft-retention contract, inline
  validation feedback for projection, and the decision on whether projection gets
  a structured editor.
- **Out**: Saved / Recent tab restyling (Mantine + `aria-label` parity) and the
  Recent tab's missing query preview — real, P2, pre-existing, and unrelated to
  the advanced row; separate tickets. `ReferenceDrawer`'s fixed `width={380}`.
  `FindInput` additions (`collation` / `hint` / `maxTimeMS` / `readPreference`) —
  still W13 §Scope's Phase 3.

## Dependencies

- W13 (single owner for sort/limit/projection — the precondition for this spec
  mattering), W05 (query bar), W09 (saved queries), W10 (recent).

---

## 1. The `advancedOpen` defect

`QueryBar.tsx:143-147`:

```ts
const hasAdvanced =
  state.builder.projection.length > 0 ||
  state.builder.sort.trim() !== '' ||
  state.builder.limit.trim() !== '';
const [advancedOpen, setAdvancedOpen] = React.useState(hasAdvanced);
```

`useState(hasAdvanced)` consumes `hasAdvanced` as an **initial value only**.
Three facts make this permanent rather than merely stale:

- `QueryBar.tsx` contains **zero** `useEffect` — nothing resyncs `advancedOpen`.
- `<QueryBar>` is mounted at `Workspace.tsx:2245` with **no `key`**, so it never
  remounts on tab switch.
- The only writer is `toggleAdvanced` (user click / Enter / Space).

So `advancedOpen` is fixed for the lifetime of the Workspace, decided by whatever
the first tab happened to look like.

`BuilderPane.tsx:1044` already solves this exact problem for the drawer with
`key={`${meta.tabId}:${loadGen}`}` (W13 §5.6). The advanced row needs the same
treatment.

### Reproduction

1. Open a collection tab with no sort / limit / projection → `advancedOpen`
   initializes `false`.
2. Switch to a second tab, or load a Saved query into the current tab, whose
   `builder.projection` is set.
3. The projection that is about to run is set, and the row that would show it is
   collapsed, with no indication anything is there.

The inverse is equally wrong: first tab has a sort, so the row opens; every
later tab shows an expanded, empty advanced grid.

### Required behavior

`advancedOpen` MUST re-derive from `hasAdvanced` whenever the underlying tab or
its builder values change — on tab switch and on a Saved/Recent load — while
preserving a user's explicit toggle **within** a tab. An explicit collapse must
not be undone by an unrelated re-render.

Implementation is open (a `key` on `QueryBar` mirroring `FilterDrawer`, or state
lifted per tab). A bare `useEffect(() => setAdvancedOpen(hasAdvanced), [...])` is
**not** acceptable: it would fight the user's own toggle on every keystroke that
changes `builder`.

---

## 2. The missing affordance

`QueryBar.tsx:293-332`. The disclosure trigger is a `div role="button"
tabIndex={0}` containing a chevron and the text `query`, with
`aria-expanded` / `aria-controls="query-bar-advanced"` correctly wired to the
controlled region at `QueryBar.tsx:370`. Enter and Space are handled.

**Keyboard and screen-reader reachability are correct — this is not an a11y
defect.** The problem is visual: nothing indicates that projection / sort / limit
exist and are hidden. The only hint is a hover tooltip, which does not exist for
touch, and does not exist for a user who never hovers the label.

This row previously had the fix. Commit `43ee030` added an accent dot beside
`QUERY` whenever `!advancedOpen && hasAdvanced`; commit `7a21468` removed it 29
minutes later to match a design mockup, and `1ddd538` later restored only the
chevron rotation. `hasAdvanced` survives in the code with its rendering use
deleted — today it feeds nothing but the broken `useState` in §1.

### Required behavior

When the advanced row is collapsed **and** any of projection / sort / limit is
set, the collapsed row MUST carry a persistent, non-hover visual indicator that
values are hidden. A count ("3 set") is preferable to a bare dot: it survives
monochrome rendering and states the actual fact.

Additionally: verify a visible `:focus-visible` style on the trigger. The app
defines none for this custom `role="button"`, so it currently relies on the
browser default — acceptable if it renders, but it must be confirmed rather than
assumed.

---

## 3. The projection draft-discard defect

`QueryBar.tsx:120-127`:

```ts
const commitProjection = () => {
  if (projDraft === null) return;
  const next = parseProjection(projDraft);
  if (next !== null) {
    onPatch({ builder: { ...state.builder, projection: next } });
  }
  setProjDraft(null);   // runs even when next === null
};
```

`parseProjection` returns `null` for anything the inclusion-only model cannot
express — exclusions (`{a: 0}`), `$slice`, malformed input. Returning `null`
rather than a lossy parse is deliberate, and its doc comment states the reason:
*so the caller keeps the user's draft text instead of silently dropping fields*.

The caller does not keep it. `setProjDraft(null)` runs unconditionally, the input
falls back to the last committed value via `projValue = projDraft ?? projDisplay`,
and the typed text is gone. No error, no red border, no message. The parser
honors the contract; the component defeats it.

This is the sharpest instance of the asymmetry with the filter tree, which on an
unprintable edit shows an inline `role="alert"` on the offending row
(`BuilderPane.tsx:446-450`, `:530-534`) and **never** discards the edit — the
tree keeps it and only `queryRaw` holds at the last good value (W13 §5.5).

### Required behavior

- On parse failure, the draft text MUST be retained in the input.
- The failure MUST be surfaced inline, with the same `role="alert"` treatment the
  filter tree uses for an unprintable row.
- The message MUST distinguish the two failure causes, because they call for
  different user actions: *malformed input* (fix the text) versus *a valid
  projection this editor cannot model* — exclusions and `$slice` — where the
  correct advice is to use raw MQL, mirroring how `filterTree.ts` degrades an
  unrepresentable clause to an editable raw node rather than rejecting it.

---

## 4. Projection editor parity — decided: a text field, in the Fields control

The filter got a recursive per-row editor with typed values, operator pickers,
and raw-clause degradation. Projection remained a single text input over an
inclusion-only model.

Whether to close that gap is a **product decision this spec records rather than
settles**. §3 is required regardless: retaining the draft and explaining the
failure is correct behavior for a text input and is a prerequisite for any richer
editor. A structured projection editor — field chips with include/exclude
toggles, sourced from `previewKnownFields` which the query bar already receives —
is a larger change whose value depends on how often users hand-write projections.

Recommendation: ship §1–§3 first, then decide §4 against real use. Do not build
the structured editor speculatively.

### Decision

**Projection stays a text field, and it moves out of the advanced row into the
Fields control** (the result bar's one control for which fields you see), as a
separate section headed "Fetch only these fields from the server". No
structured chip editor is built.

Why: the parity gap turned out to be the smaller problem. Three controls
answered "which fields do I see?" — Preview fields, Columns and projection —
and projection, the only one with a server-side cost, sat in a different strip
under a different word, presented as a peer of two display toggles. A field a
projection excluded then dropped out of the column list with no explanation.
Putting the projection *beside* the display toggles, divided from them and each
explained in one line, is what teaches the difference:

- **Show in results** (hide / reorder): display only, instant, nothing is
  re-fetched.
- **Fetch only these fields from the server** (projection): changes what the
  server returns, applied on the next Run.

What moved and what did not:

- The input keeps everything it had: Shell Syntax repair on commit, the
  `projection` / `projectionRaw` split and its W15 §9(b) raw escape, the
  retained-draft messages of §3, and field completion. It commits on blur,
  Enter, and when the control closes; ⌘↵ inside it settles the draft and runs
  (the panel-level ⌘↵ skips dialogs, and the control's dropdown is one).
- Run compiles and sends the projection exactly as before; `BuilderState` is
  unchanged.
- The advanced row keeps sort, skip and limit. Its "n set" count no longer
  counts a projection and a projection alone no longer opens it; the Fields
  button carries its own "projection" badge instead, warn-coloured while the
  projection cannot run as written.
- A field the projection keeps off the wire is listed as "not fetched" rather
  than silently missing — every field the control can name without asking the
  server (the fields in hand, plus any the tab's column config remembers).

## 5. Types

No new types. No changes to `BuilderState`, `CollectionTabState`, or any
persisted shape. `projection: string[]` and its inclusion-only model are
unchanged.

## 6. IPC contract

**None.** This spec is renderer-only. No channel is added, removed, or altered,
so the 5-file contract and `scripts/ipc-secret-allowlist.txt` are untouched.

---

## 7. Acceptance criteria

- [ ] Opening a tab with no advanced values, then switching to a tab whose
      projection / sort / limit is set, leaves the advanced row **open**.
- [ ] The inverse: first tab has a sort, second tab has none → the advanced row
      is **collapsed** on the second tab.
- [ ] Loading a Saved query with a projection into the active tab opens the
      advanced row.
- [ ] A user's explicit collapse of the advanced row is **not** undone by editing
      the filter, typing in the query bar, or any other same-tab re-render.
- [ ] When collapsed with at least one advanced value set, the trigger shows a
      persistent indicator without hover, stating how many are set.
- [ ] The trigger keeps `aria-expanded` / `aria-controls` correct, remains
      operable by Enter and Space, and shows a visible focus ring.
- [ ] Typing an unparseable projection and blurring **retains the typed text**.
- [ ] That failure renders a `role="alert"` message adjacent to the input.
- [ ] A valid-but-unmodelable projection (`{a: 0}`, `$slice`) produces a message
      distinct from the malformed-input message, and points at raw MQL.
- [ ] A valid projection still commits and clears the draft exactly as today.
- [ ] No change to `builder.projection`'s persisted shape; a tab saved before this
      change restores identically.

## 8. Test cases

**Component** (`tests/component/`)

1. Two-tab fixture, tab A with no advanced values and tab B with a projection;
   assert the advanced region is present after switching A → B, and absent after
   B → A. This is the §1 regression and MUST fail against current `main`.
2. Explicit collapse, then patch `queryRaw`; assert the region stays collapsed —
   the guard against a naive `useEffect` resync.
3. Saved-query load with a projection into a tab that had none; assert the region
   opens.
4. Collapsed + advanced values set → indicator present, with its count. Collapsed
   + none set → absent.
5. Enter a malformed projection, blur, assert the input still holds the typed
   text and an `alert` is rendered.
6. Enter `{a: 0}`, blur, assert the draft is retained and the message names raw
   MQL rather than a syntax error.
7. Enter a valid projection, blur, assert it commits and the draft clears.

**Unit** (`tests/unit/`)

8. `parseProjection` returns `null` for exclusions, `$slice`, and malformed
   input, and a field list for each accepted form (strict JSON, unquoted keys,
   bare comma list). Partly covered today — extend rather than duplicate.

**E2E** (`tests/e2e/`)

9. One flow: open two collection tabs, set a projection on the second, switch
   away and back, assert the advanced row reflects the active tab both times.

Note for whoever writes test 1: assert on the presence of the region
(`#query-bar-advanced`) or its inputs, not on the advanced grid's internal
markup, which W13 already reshaped once.
