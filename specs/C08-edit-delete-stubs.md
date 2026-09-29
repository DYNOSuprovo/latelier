# C08 — Edit / Delete / stub tabs / CmdK stub

## Purpose

Cover the remaining pieces of the Connection Manager detail area: the Edit button, the Delete flow (confirm + result), the Indexes and Users stub tabs, and a minimal CmdK stub so the keyboard shortcut is not broken. Each is small individually; grouping them keeps the spec count tight.

## Scope

- **In**: Edit navigation, Delete dialog + IPC, stub `Indexes` / `Users` tabs, CmdK-stub overlay.
- **Out**: The actual CmdK search implementation (deferred), NewConnection form (C03).

> The list-side delete context-menu entry point this spec originally referenced no longer exists
> — the list-sidebar screen was retired (see [C05](./C05-connection-manager-shell.md)).
> Delete on the deep detail screen is now the header's own Delete button.

## Dependencies

- C02 (`conn:delete`, `conn:update`), C03 (edit route), C05 (selection state).

## 1. Detail header actions

The existing mock detail header has three buttons: Edit, Delete, Open workspace. They become:

### Edit
- Navigates to `/connections/:id/edit` — NewConnection in edit mode (C03).

### Delete
- Opens the confirm dialog (implemented in C05 §9; shared component).

### Open workspace
- Primary action. Behavior:
  1. `await api.conn.touchUsed(id);`
  2. `await api.tabs.openDefault({ connectionId: id });` — main chooses the first non-system DB + first collection and inserts a tab. Returns tab info.
  3. `navigate('/workspace')`.
- If no databases exist yet (empty server): navigate to workspace anyway, where a "No collections yet" empty state renders (W01).

## 2. Stub tabs

> **Superseded.** This section describes the empty-state placeholders as they
> shipped in Phase C. Both were later replaced with real CRUD tabs in
> post-iteration-1 specs [C09](./C09-indexes-tab.md) (Indexes, itself amended
> by W16 Tier 1 and then removed by W16 Tier 2 — see that spec's note) and
> [C10](./C10-users-tab.md) (Users) — `StubTab` no longer exists in `src/`.
> The Connection Manager's Indexes tab no longer exists either; index
> management moved into the collection tab's Structure sub-view. Kept below
> as historical record of what Phase C originally shipped.

### Indexes tab
Renders a centered empty-state card:

```
┌────────────────────────────────────────────┐
│                                            │
│        Index management                    │
│        coming in a future release.         │
│                                            │
│   Use the MongoDB shell or your existing   │
│   tooling for index operations.            │
│                                            │
│   [ View on GitHub roadmap ]               │
│                                            │
└────────────────────────────────────────────┘
```

Styling matches existing mock's textGhost message. The link button is a `<button>` that runs `shell.openExternal` via an `app:openExternal` IPC (restricted to `https://` URLs; see F04).

### Users tab
Same structure as Indexes, different copy:
> User management coming in a future release. Use `db.createUser` in the shell or your cloud provider's UI.

Both tabs are fully clickable; nothing else is interactive. They exist so the tab bar layout stays stable.

## 3. CmdK stub

- Global shortcut `⌘K` / `Ctrl+K` opens an overlay identical in shell to the existing mock but with **limited** results:
  - Section "Actions" lists:
    - `New connection` → `/connections/new`.
    - `Settings` (stub, no-op with tooltip "coming soon").
    - `Toggle dark mode`.
  - Section "Connections" lists the first 10 saved connections (from already-loaded state; not a new API call).
- **No collection search, no saved-query search.** Those arrive with the full CmdK spec later.
- `Esc` or click outside closes.
- Arrow keys navigate results; `Enter` fires the action.
- Opening via `⌘K` a second time toggles closed (matches mock behavior).

The stub exists so we don't regress the keyboard shortcut or the title-bar affordance. The top-right `⌘K` pill in the title bar still opens it.

## 4. IPC additions

| Channel             | Input           | Output      |
| ------------------- | --------------- | ----------- |
| `app:openExternal`  | `{ url }`       | `void`      |
| `tabs:openDefault`  | `{ connectionId }` | `WorkspaceTab` (see W01) |

`app:openExternal` validates the URL is `https://` and matches an allow-list (iteration 1: anything `https://` that parses via `URL`). Otherwise returns VALIDATION.

## 5. Acceptance criteria

- [ ] Edit button navigates to `/connections/:id/edit`.
- [ ] Delete confirmation appears on the detail-header Delete button (the sidebar context-menu entry point it originally also covered is retired); after confirm, `api.conn.delete` fires and the user lands on the Data View (no sibling row to adjust selection to).
- [ ] Open workspace opens the workspace with a tab; refreshing the app restores the tab.
- [ ] Indexes and Users tabs render placeholder cards with working links.
- [ ] `⌘K` opens the stub overlay from every route that includes it (ConnectionManager, Workspace); items route correctly; Esc closes.
- [ ] Opening an arbitrary `https://anthropic.com` via the overlay action runs `shell.openExternal`; `file://` URL is rejected with VALIDATION.

## 6. Test cases

### Component
- **edit-nav.spec.tsx**: click Edit → `useNavigate` called with edit route.
- **delete-confirm-cancel.spec.tsx**: click Delete → dialog visible; Cancel leaves list unchanged.
- **delete-confirm-ok.spec.tsx**: confirm → `api.conn.delete` called; list updates.
- **stub-tabs.spec.tsx**: clicking Indexes/Users tab renders placeholder text.
- **cmdk-toggle.spec.tsx**: `⌘K` opens; second press closes; `Esc` closes.
- **cmdk-action.spec.tsx**: "New connection" item → navigates.
- **open-external-guard.spec.tsx**: mock returns VALIDATION for `file://` — UI surfaces an unobtrusive error.

### Integration
- **open-external-allow.spec.ts**: IPC handler calls Electron `shell.openExternal` only after the URL parses and has protocol `https:`.
