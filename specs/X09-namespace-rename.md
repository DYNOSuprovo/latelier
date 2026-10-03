# X09 — Namespace rename (MongoLab → L'Atelier)

> **Status: Phase 1 + Phase 2 applied · Phase 3 deferred.** The display name in the menu bar / Finder, the IPC bridge identifier (`window.atelier`), the env var (`ATELIER_USER_DATA_DIR`), and renderer file paths now use the L'Atelier name. `appId` is still `dev.mongolab.app`. Phase 3 — the `appId` change, the remaining `mongolab` filenames, and recovering data from the old userData directory — is its own ticket.

## Purpose

Finish the L'Atelier rebrand in code, after [X08](./X08-brand-identity.md) shipped the visual identity. Splits the rename into three phases so the breaking ones (anything that touches user data) don't ride along with the cosmetic ones.

## Scope

### Phase 1 — Display strings (in)
- `productName: MongoLab` → `productName: L'Atelier` in `electron-builder.yml`
- `name`, `productName` in `package.json`
- README first-heading
- `<title>` in `index.html`

### Phase 2 — Code identifiers (in)
- `window.mongolab` → `window.atelier` (preload + `shared/ipc.ts` shape, every renderer consumer)
- File renames: `src/api/mongolab.ts` → `src/api/atelier.ts`; `tests/helpers/mongolabMock.ts` → `tests/helpers/atelierMock.ts`
- Env var: `MONGOLAB_USER_DATA_DIR` → `ATELIER_USER_DATA_DIR` (electron/main.ts, E2E test helpers, docs)
- TypeScript module-augmentation (`declare global { interface Window { atelier: … } }`)

### Phase 3 — userData identity (out — separate ticket)
- `appId: dev.mongolab.app` → `io.github.anonhym.latelier`. The project is hosted on GitHub with no domain of its own, so the ID uses the reverse of `anonhym.github.io`, the form Flathub requires for such projects.
- **`appId` does not decide the userData path.** Electron derives it from `app.name`, which `app.setName("L'Atelier")` in `electron/main.ts` sets. Changing `appId` leaves the directory where it is. What it does change on macOS is the bundle identity that, together with the code signature, governs access to the "L'Atelier Safe Storage" keychain item. The `appId` switch therefore has to land before the first Developer-ID-signed release, and the app must handle a secret it can no longer decrypt (a specific re-enter-password path, not a generic error) before either change ships.
- Recovering data orphaned by Phase 1: `app.setName` already moved userData from the `mongolab` directory to `L'Atelier`, so an install that predates it has its data at the old path. One-shot migration on first launch: if the old directory exists and the new one has no database, move (or copy) it across. Platforms:
  - macOS: `~/Library/Application Support/mongolab/` → `~/Library/Application Support/L'Atelier/`
  - Windows: `%APPDATA%/mongolab/` → `%APPDATA%/L'Atelier/`
  - Linux: `~/.config/mongolab/` → `~/.config/L'Atelier/`
- E2E coverage: launch with old userData dir present → assert data preserved post-migration.
- Moving Connections between machines or installs is not part of this phase; that is [C13](./C13-connection-export-import.md).
- **Warning in the last unsigned release.** On macOS, at launch, with at least one saved Connection: a one-time dialog, "Export your connections before updating", saying the next version won't be able to read the passwords this one saved. Its main button opens the C13 export with passwords already included. It also mentions, in small print, that the next version is signed and updates itself. "Export connections" and "Don't show again" both stop it (`ui.notices.preSigningDismissed`); closing it only defers it to the next launch. Other platforms keep their passwords across the switch, so they never see it. The signed release removes it.

### Out (also deferred)
- Spec body rewrites in `specs/F*`, `specs/C*`, `specs/W*`, `specs/A*`, `specs/X*` that reference "MongoLab" in prose. These are historical design docs; updating them is documentation hygiene, not blocking.
- Generated `.claude/skills/generated/*` files — they regenerate via `npx gitnexus analyze`.
- Renaming the `mongo-lab` git repo or the `mongo-lab` directory on disk.

## Naming decisions

| Surface | Old | New | Notes |
|---|---|---|---|
| Display name | `MongoLab` | `L'Atelier` | apostrophe preserved; safe for macOS DMG names, Windows installer text |
| Package name | `mongo-lab` | `latelier` | lowercase, no apostrophe (npm name rules) |
| IPC bridge global | `window.mongolab` | `window.atelier` | renderer-side; not user-facing |
| Env var | `MONGOLAB_USER_DATA_DIR` | `ATELIER_USER_DATA_DIR` | E2E + dev override |
| appId (Phase 3) | `dev.mongolab.app` | `io.github.anonhym.latelier` | reverse-DNS; bundle identity, not the userData path |

## Why not all-at-once

Renaming the userData directory orphans every existing user's settings, secrets, and saved connections, and changing `appId` together with code signing can cut off access to their saved secrets. Both need a tested path — and the migration itself is its own design (do we move? copy + symlink? leave the old dir for rollback?). Coupling that to the cosmetic rename is the kind of thing that ships a P0 bug: a user updates and "all their connections are gone."

The split lets the visible rename ship safely now; the under-the-hood rename ships once migration is implemented and tested.

## Acceptance criteria — Phase 1 + Phase 2

- [x] App menu bar / About dialog / window title display "L'Atelier" instead of "MongoLab".
- [x] `npm run lint`, typecheck, and unit + component tests are green after the rename.
- [x] No `import` statements reference `'./api/mongolab'` (all replaced with `'./api/atelier'`).
- [x] No `window.mongolab` references in `src/` or `tests/`.
- [x] No `MONGOLAB_USER_DATA_DIR` references in source; `ATELIER_USER_DATA_DIR` is honored in `electron/main.ts` and E2E helpers.

## Acceptance criteria — Phase 3 (deferred)

- [ ] `appId: io.github.anonhym.latelier` set in `electron-builder.yml`, before the first Developer-ID-signed release.
- [ ] On first launch, userData left at the old `mongolab` path migrates to the `L'Atelier` path on macOS, Windows, and Linux.
- [ ] E2E test: launch with simulated old userData; assert connections + secrets persist post-migration.

## See also

- [X08](./X08-brand-identity.md) — visual identity rollout (precedes this).
- The "Rename MongoLab → L'Atelier in code" item — this spec replaces that plan; Phase 3 of it is still open.
