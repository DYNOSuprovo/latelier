# C05 — ConnectionManager deep detail screen

## Purpose

The deep, bare detail screen for one Connection (path `/connections/:id`). Houses the title bar
with a back affordance to the Data View, and the detail area (Overview / Collections / Indexes /
Users). Owns delete confirmation for the Connection it's showing.

> Superseded (ADR [0001](../docs/adr/0001-data-view-home-connection-switcher.md)): the
> list-sidebar this page originally shipped with is retired. The Data View (`/workspace`) is the
> app's home now; the Switcher popover is the one canonical list of saved Connections
> (see [X11](./X11-workspace-composition.md) / `ConnectionSwitcher.tsx`). This screen is reached
> only via the Switcher's "Manage connection…" action — deep-link only, never landed on.

## Scope

- **In**: Shell layout, title bar with a back-to-Data-View affordance, resolving the Connection
  from `:id`, a not-found state for an id that no longer resolves, top-level delete confirmation
  (delegates actual work to C08's successor, `ConnectionDeleteDialog`).
- **Out**: Detail-tab content (Overview C06, Collections C07, Indexes C09 — amended by W16 Tier 1,
  Users C10), the Connection list (retired — see ADR 0001; the Switcher is the list now), the
  Connection creation / edit form (C03), CmdK palette (X07).

## Dependencies

- C01, C02 (`conn:list`, `conn:delete`, `conn:touchUsed`), F05 (`mongo:status` events for the live
  status badge).

## 1. Routes

- `/connections/:id` — this page. No selection state beyond the route param; there is no sibling
  list to fall back through.
- `/connections` (bare, no id) — retired; redirects to `/workspace` (App.tsx).
- `/connections/new` — NewConnection create mode (C03). Returns to `/workspace` on save/cancel.
- `/connections/:id/edit` — NewConnection edit mode (C03). Returns to `/connections/:id` on
  save/cancel.

## 2. Component tree

```
ConnectionManager
 ├── TitleBar (back-to-Data-View affordance + CmdK opener + theme toggle)
 └── DetailPanel (Overview / Collections / Indexes / Users, keyed by :id)
```

## 3. Selection

Selection comes strictly from `useParams<{ id }>()` — matched against the live `conn:list`
snapshot (via `useConnections()`, so the status badge stays live). There is no "select the first
Connection" fallback: an id that doesn't resolve (deleted elsewhere, stale bookmark) renders the
not-found state below, not an empty-list state.

## 4. Not-found state

If `:id` doesn't match any Connection in the live list: "This connection no longer exists." with a
**Back to Data View** button (`navigate('/workspace')`).

## 5. Title bar

- Back affordance: `← Data View` — `navigate('/workspace')`.
- Breadcrumb: the Connection's name (or "Connection" while unresolved).
- CmdK opener, theme toggle (unchanged from the retired shell).

## 6. Detail header actions

Rendered by `DetailPanel`, next to the Connection's name/status:

- **Edit** → `/connections/:id/edit`.
- **Delete** → opens `ConnectionDeleteDialog`; confirming calls `api.conn.delete(id)` and always
  navigates to `/workspace` (there is no sibling row to fall back to — see §7).
- **Disconnect** (only when connected) → `api.mongo.disconnect(id)`.
- **Open workspace** (primary) → `/workspace` with `state.openForConnection`.

## 7. Delete flow

- Confirm dialog (shared `ConnectionDeleteDialog`, also used by the Switcher):
  > Delete "**{name}**"?
  > This removes the saved connection and all its saved queries and history. Mongo data on the
  > server is not touched.
  > [Cancel] [Delete]
- Confirm calls `api.conn.delete(id)`:
  - On success: navigate to `/workspace` (replace).
  - On `NOT_FOUND`: navigate to `/workspace` (replace) — already gone.
  - On `DB_ERROR`: banner; dialog closes, screen stays put.

## 8. Accessibility

- Status badge and detail content carry the same accessibility contract as before (C06/C07/C09/C10
  are unchanged by this rewrite).
- The back affordance and delete/edit buttons are plain `<button>`s reachable by keyboard.

## 9. Acceptance criteria

- [ ] `/connections/:id` renders the Connection named by the route param, with its Overview /
      Collections / Indexes / Users tabs intact.
- [ ] An id that doesn't resolve shows the not-found state, not a blank screen or a crash.
- [ ] The back affordance navigates to `/workspace`.
- [ ] Deleting the shown Connection navigates to `/workspace`.
- [ ] `/connections` (bare) and `/` both redirect to `/workspace`.
- [ ] A Mongo status change broadcast by main updates the header's status badge within 500ms.

## 10. Test cases

### Component (`tests/component/connection-detail.spec.tsx`)
- **renders-by-route-id**: mock `api.conn.list` → the connection named by `:id` renders.
- **not-found**: an id absent from the list → not-found copy + working back button.
- **back-affordance**: TitleBar's back button navigates to `/workspace`.
- **delete-navigates-home**: confirming delete calls `api.conn.delete` and lands on `/workspace`.

### E2E
- Reached via the Switcher's "Manage connection…" (`⌘↵` or the row's Manage icon) — see
  `conn-switcher-keyboard.e2e.ts` / the Switcher's own e2e coverage for that path.
