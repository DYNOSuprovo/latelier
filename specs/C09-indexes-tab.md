# C09 — Indexes tab (real listing + create / drop)

> **Removed by W16 Tier 2 (ADR 0003).** The Connection Manager's Indexes tab
> is gone, along with `IndexesHost`, the DB/collection picker wrapper it used
> in the interim. `IndexesTab` is namespace-scoped (`{connectionId, dbName,
> collection}`) and now lives in the collection tab's Structure sub-view,
> stacked above the sampled schema (`src/pages/Workspace/StructureView.tsx`),
> with no picker of its own — the namespace comes from the open tab. The
> `ui.indexes.lastTarget` preference stays retired (W16 Tier 1). Read this
> spec's "pick a database, drill into a collection" framing as history, not
> the current component boundary.

## Purpose

Replace the C08 `StubTab` for the Indexes tab in `DetailPanel.tsx` with a real, per-collection index manager. Lets the user list indexes for any collection on the active connection, see their key spec / options / usage stats, create a new index, and drop a non-default one.

The shape mirrors C07 — pick a database, drill into a collection, work on its indexes — but stays inside `DetailPanel` instead of opening a workspace tab. Index management is a connection-scoped operation, not a query-scoped one; users move between many collections quickly and do not need a tab per collection.

## Scope

- **In**: `index:list`, `index:create`, `index:drop` IPC channels, `IndexService`, the `IndexesTab` component, drill-in DB → collection picker reusing `meta:listDatabases` + `meta:listCollections`, create-index drawer, drop confirm dialog, `$indexStats` enrichment with graceful fallback.
- **Out**:
  - Index re-build / re-create on a different shard. Deferred — covered by drop + create.
  - Search-index / Atlas Vector index management. Atlas-only commands (`createSearchIndex` / `updateSearchIndex` etc.) are out of scope for v1 because they are managed-Atlas-only and we do not detect that environment.
  - Hidden index toggle (`hidden: true`) — listed when present but the create form does not expose it. Deferred until we have a real user request.
  - Bulk operations (drop all non-`_id_`, etc.). Power user feature; defer.
  - Index hint integration with `query:find`. Belongs in W03; tracked separately.

## Dependencies

- C05 (selected connection state), C07 (DB / collection meta endpoints — reused as-is), C08 (the stub being replaced), F05 (MongoPool).
- New entries in `shared/ipc.ts`, `shared/types.ts`, `electron/preload.ts`, `electron/main.ts` registration.
- No new SQLite tables, no new migration. Index state is server-side.

## 1. Types

```ts
// shared/types.ts (additions)

/** Sort direction or specialised index type for a single keyed field. */
export type IndexFieldDirection =
  | 1               // ascending
  | -1              // descending
  | 'text'
  | 'hashed'
  | '2d'
  | '2dsphere'
  | 'geoHaystack';

export interface IndexInfo {
  /** Server-assigned name (`_id_`, `name_1_age_-1`, or user-given). */
  name: string;
  /** Insertion-ordered field → direction map preserved as parallel arrays. */
  key: Array<{ field: string; direction: IndexFieldDirection }>;
  /** True for the implicit `{ _id: 1 }` index (cannot be dropped). */
  isIdIndex: boolean;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  /** TTL in seconds — present iff this is a TTL index. */
  expireAfterSeconds?: number;
  /** EJSON-canonical string of `partialFilterExpression`, when set. */
  partialFilterExpression?: string;
  /** EJSON-canonical string of `collation`, when set. */
  collation?: string;
  /** Index version (driver field `v`). */
  version: number;
  /** Best-effort byte size from `$collStats.indexSizes`. Absent on fallback. */
  sizeBytes?: number;
  /** Best-effort access stats from `$indexStats`. Absent if unauthorized. */
  usage?: {
    ops: number;
    since: string; // ISO
  };
}

export interface IndexCreateInput {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Insertion order is preserved → drives the compound key order on the server. */
  fields: Array<{ field: string; direction: IndexFieldDirection }>;
  options: {
    name?: string;            // server generates one if omitted
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: string; // EJSON canonical
    collation?: string;               // EJSON canonical
  };
}

export interface IndexDropInput {
  connectionId: string;
  dbName: string;
  collection: string;
  name: string;
}
```

`IndexInfo.key` is an ordered array, not a record, because compound-index field order is meaningful and JavaScript object key ordering on the wire would be brittle.

## 2. IPC contract

| Channel        | Input              | Output                | Notes                                      |
| -------------- | ------------------ | --------------------- | ------------------------------------------ |
| `index:list`   | `{ connectionId, dbName, collection }` | `IndexInfo[]` | Includes `_id_`. Ordered by name.          |
| `index:create` | `IndexCreateInput` | `{ name: string }`     | Returns the server-assigned name.          |
| `index:drop`   | `IndexDropInput`   | `{ dropped: true }`    | Refuses `_id_` server-side (VALIDATION).   |

No `SECRET_INPUT`. No additions to `scripts/ipc-secret-allowlist.txt`.

Channel name registry additions in `shared/ipc.ts`:

```ts
indexList:   'index:list',
indexCreate: 'index:create',
indexDrop:   'index:drop',
```

`IpcApi` gains:

```ts
index: {
  list: (input: { connectionId: string; dbName: string; collection: string }) => Promise<IndexInfo[]>;
  create: (input: IndexCreateInput) => Promise<{ name: string }>;
  drop: (input: IndexDropInput) => Promise<{ dropped: true }>;
};
```

Preload binding follows the existing one-line-per-method pattern.

## 3. Service (main)

```ts
// electron/mongo/IndexService.ts

export class IndexService {
  constructor(private pool: MongoPool) {}

  async list(input): Promise<IndexInfo[]> {
    const db = await this.pool.getDb(input.connectionId, input.dbName);
    const coll = db.collection(input.collection);

    // 1. The authoritative source: collection.indexes() always works for a
    //    user with read access. Returns the raw spec docs.
    const raw = await coll.indexes();

    // 2. Two best-effort enrichments — both fail open. Either one being
    //    unavailable (Atlas free tier, scoped role) just leaves the field absent
    //    on every IndexInfo; the UI handles that gracefully.
    const [stats, sizes] = await Promise.allSettled([
      coll.aggregate([{ $indexStats: {} }], { maxTimeMS: 3000 }).toArray(),
      coll.aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 3000 }).next(),
    ]);

    return raw.map((spec) => buildIndexInfo(spec, stats, sizes));
  }

  async create(input): Promise<{ name: string }> {
    validateCreateInput(input); // throws ValidationError on bad EJSON / bad direction
    const opts = buildCreateOpts(input.options); // parse EJSON options here
    const coll = (await this.pool.getDb(input.connectionId, input.dbName))
      .collection(input.collection);
    try {
      const name = await coll.createIndex(buildKeySpec(input.fields), opts);
      return { name };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async drop(input): Promise<{ dropped: true }> {
    if (input.name === '_id_') {
      throw new ValidationError('cannot drop the default _id index', { name: input.name });
    }
    const coll = (await this.pool.getDb(input.connectionId, input.dbName))
      .collection(input.collection);
    try {
      await coll.dropIndex(input.name);
      return { dropped: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }
}
```

Wired into `electron/main.ts` like the other services: instantiate after `MongoPool` and call `registerIndexChannels(router, indexSvc)`.

### `buildIndexInfo` rules

- `isIdIndex` = `spec.name === '_id_' || (Object.keys(spec.key).length === 1 && spec.key._id === 1)`.
- `key` = `Object.entries(spec.key).map(([field, direction]) => ({ field, direction }))`. Driver preserves insertion order for compound keys.
- `partialFilterExpression`, `collation` — pass through `ejsonEncode(..., false)` so they reach the renderer as canonical strings (consistent with the rest of the wire).
- `sizeBytes` — pull from `storageStats.indexSizes[name]` when the `$collStats` aggregate succeeded.
- `usage` — pull from the `$indexStats` row whose `name` matches; emit `{ ops: row.accesses.ops, since: row.accesses.since }`.

### Error classification

Reuses `classifyMongoOpError` (`electron/mongo/errors.ts`):

| Mongo code / class                         | IPC code        |
| ------------------------------------------ | --------------- |
| Unauthorized / 13                          | `UNAUTHORIZED`  |
| IndexNotFound / 27                         | `NOT_FOUND`     |
| IndexOptionsConflict / 85, IndexKeySpecsConflict / 86 | `CONFLICT` |
| ServerSelection / network / timeout        | `NETWORK` / `TIMEOUT` (existing taxonomy) |
| anything else                              | `MONGO_ERROR`   |

`buildCreateOpts` parses EJSON for `partialFilterExpression` and `collation` — bad JSON throws `ValidationError` *before* the request hits Mongo, so the user gets an immediate inline error.

## 4. Renderer — `IndexesTab` component

Replaces `<StubTab title="Index management" .../>` at `DetailPanel.tsx:635`.

### Layout

```
┌─ Search row ──────────────────────────────────────────────────────┐
│ [Database ▾]  [Collection ▾]   [+ New index]   [⟳ Refresh]        │
├───────────────────────────────────────────────────────────────────┤
│ Name              Key                  Options       Size  Use    │
│ ───────────────────────────────────────────────────────────────── │
│ _id_              { _id: 1 }           default       12 KB  18k   │
│ email_1_unique    { email: 1 }         unique        38 KB   3.2k │
│ created_-1_ttl    { created: -1 }      ttl 7d         5 KB    0 [x]
│ …                                                                  │
└───────────────────────────────────────────────────────────────────┘
```

- DB picker reuses `meta:listDatabases({ connectionId, includeSystem: showSystem })` with the same `ui.showSystemDbs` pref as Collections.
- Collection picker calls `meta:listCollections` once per DB; cached for the lifetime of the tab.
- Selecting (db, collection) calls `index:list`. List re-fetches on Refresh and after every successful create/drop.
- ~~Last (db, collection) selection persists to `app_state['ui.indexes.lastTarget']` (per app, not per connection — small enough to be a single key) so re-opening the tab restores the view.~~ **Removed by W16 Tier 2** — there is no picker any more; `IndexesTab` takes its namespace from the open collection tab.
- ~~Pickers are dropdown buttons styled like the existing tab bar — keep the visual language consistent with `CollectionsTab`. No tree/sidebar.~~ **Removed by W16 Tier 2.**

### Index row anatomy

- **Name**: monospace 12 px, truncate with tooltip.
- **Key**: monospace 11 px, rendered as `{ field: dir, … }`. Direction `1` / `-1` / `text` / `hashed` etc. shown verbatim.
- **Options**: comma-separated badge list. Each option is a `Pill` (existing component): `unique`, `sparse`, `partial`, `ttl 5m / 7d` (humanise), `text`, `2dsphere`, `hashed`, `collation`, `hidden`. `_id_` shows `default` muted.
- **Size**: `humanBytes(sizeBytes)` (existing helper) or `—` if not available.
- **Use**: `usage.ops.toLocaleString()` short form (`12.3k`, `1.2M`) or `—`. Hover tooltip: "since {usage.since}".
- **Drop button**: trailing `[x]` icon, hidden for `_id_`. Click → drop confirm dialog.

### Drill-down details

Clicking a row toggles an inline expander showing:
- Full key as pretty EJSON.
- All options including `partialFilterExpression`, `collation`, `version`.
- "Copy spec as MQL" button → pushes `db.<coll>.createIndex({…}, {…})` to clipboard so the user can replay it elsewhere.

### Empty / error states

- Connection not connected → reuse the `CollectionsTab` "Not connected" state copy.
- DB/collection not yet picked → `Pick a database and collection to inspect its indexes.`
- `index:list` returned `[]` → never happens in practice (`_id_` always exists) but guard with "No indexes — pick a different collection".
- IPC throws `UNAUTHORIZED` → amber inline banner: "This connection lacks the privilege to read indexes on {db}.{coll}."
- IPC throws `MONGO_ERROR` / `NETWORK` → red inline banner with a Retry button.

### Create-index drawer

Reuses the existing right-side drawer pattern (W08 Insert drawer). 360 px wide.

```
┌─ New index ──────────────────────────────────┐
│ Fields                                       │
│  ┌─────────────────────────┐ [Asc ▾] [×]    │
│  │ field name              │                │
│  └─────────────────────────┘                │
│  + Add field                                 │
│                                              │
│ Options                                      │
│  [ ] Unique                                  │
│  [ ] Sparse                                  │
│  [ ] TTL — expire after [____] seconds       │
│  [ ] Partial filter (EJSON):                 │
│  ┌──────────────────────────────────────┐   │
│  │ {}                                   │   │
│  └──────────────────────────────────────┘   │
│  [ ] Collation (EJSON):                      │
│  ┌──────────────────────────────────────┐   │
│  │ {}                                   │   │
│  └──────────────────────────────────────┘   │
│                                              │
│ Name (optional, server generates one)        │
│ [______________________________________]     │
│                                              │
│              [ Cancel ]  [ Create index ]    │
└──────────────────────────────────────────────┘
```

Validation rules (renderer-side, mirrored server-side):
- At least one field row with a non-empty name.
- Direction must be one of the eight literals listed in `IndexFieldDirection`.
- TTL requires exactly one field with direction `1` or `-1` (Mongo limitation). If the user toggles TTL on a multi-field or text/geo key, the form rejects with inline copy.
- `partialFilterExpression` / `collation` parse as EJSON locally — surfaces a parse error inline before submit.

Submit calls `api.index.create(...)`. On success: close drawer, refetch the list, toast `Index "{name}" created`. On `CONFLICT` (duplicate name or conflicting spec): keep the drawer open, show the inline error inside the form so the user can adjust.

### Drop confirm dialog

Two-step, modeled after W08 `confirmDeleteMany`:

```
Drop index "email_1_unique"?
This is permanent. Queries that relied on this index may slow down.

Type the index name to confirm:
[__________________________________________]
                              [ Cancel ] [ Drop ]
```

`Drop` button disabled until the typed text equals the index name exactly. On success: close, refetch, toast `Index "{name}" dropped`.

`_id_` is filtered out of the drop button list before this dialog is reachable; the server-side `ValidationError` is a defence-in-depth backstop.

## 5. State & persistence

- ~~No new SQLite tables, no migration. The only persisted state is `ui.indexes.lastTarget = { dbName, collection }` in `app_state` via existing `prefs` channels. Reset on disconnect or when the targeted (db, collection) no longer exists at refresh time.~~ **Removed by W16 Tier 2** — no persisted state remains; the tab is namespace-scoped by the open collection tab, which owns its own persistence.
- No caching of the index list — it's small and changes rarely; refetch on every (db, collection) switch and on Refresh.

## 6. Error handling

| Source                 | Surfacing                                         |
| ---------------------- | ------------------------------------------------- |
| `index:list` UNAUTHORIZED | Amber banner inline in the table area.        |
| `index:list` other err   | Red banner with Retry button.                  |
| `index:create` VALIDATION (local parse fail) | Inline form error next to the offending field. |
| `index:create` CONFLICT   | Inline banner inside the drawer; drawer stays open. |
| `index:create` other     | Inline banner inside the drawer.               |
| `index:drop` NOT_FOUND   | Toast "Index already dropped"; refetch list.    |
| `index:drop` other       | Banner in the dialog; dialog stays open.        |

`$indexStats` and `$collStats` failures are silent — `IndexInfo.usage` / `sizeBytes` simply absent; the UI renders `—`.

## 7. Acceptance criteria

- [ ] Indexes tab in `DetailPanel.tsx` no longer renders `StubTab`; renders the new `IndexesTab` component.
- [ ] DB picker lists every database (system DBs gated by the existing `ui.showSystemDbs` pref); collection picker re-uses `meta:listCollections` cache.
- [ ] Selecting (db, collection) lists every index from `collection.indexes()` and includes `_id_`.
- [ ] On a connection that authorizes `$indexStats` and `$collStats`, the **Use** and **Size** columns populate.
- [ ] On a connection that does not authorize them (Atlas free tier), **Use** and **Size** read `—` and the rest of the table still renders.
- [ ] Creating an index round-trips: form → `api.index.create` → server-assigned name visible in the list after refetch.
- [ ] Creating a duplicate index keeps the drawer open with an inline `CONFLICT` error.
- [ ] Dropping a non-`_id_` index removes it from the list after the two-step confirm.
- [ ] Dropping `_id_` is impossible from the UI (no Drop button on its row) and refused server-side with `VALIDATION` if invoked via raw IPC.
- [ ] ~~`ui.indexes.lastTarget` persists across reload: after restart, opening the Indexes tab re-selects the last DB / collection viewed (when both still exist).~~ **Retired by W16 Tier 1** — no longer applies; see that spec's Tier 1 acceptance criteria instead.
- [ ] `npm run audit:ipc` passes with no allowlist changes (no `SECRET_INPUT` channels added).

## 8. Test cases

### Unit
- **build-index-info.spec.ts** — given driver `indexes()` output + `$indexStats` rows + `$collStats.indexSizes`, produces the expected `IndexInfo[]`. Covers:
  - `_id_` flagged `isIdIndex`.
  - Compound key field order preserved.
  - TTL → `expireAfterSeconds` populated, no `expireAfterSeconds` for non-TTL.
  - `$indexStats` Promise rejected → every `usage` absent.
  - `$collStats` Promise rejected → every `sizeBytes` absent.
- **build-create-opts.spec.ts** — EJSON `partialFilterExpression` parsed; bad EJSON → `ValidationError`; TTL with multi-field key → `ValidationError`.

### Integration (against `mongodb-memory-server`)
- **list-indexes.spec.ts** — seed a collection with three explicit indexes (one TTL, one partial, one compound) → `index:list` returns four (`_id_` + the three) with all fields populated.
- **create-index.spec.ts** — `index:create` for `{ email: 1 } unique` → `index:list` shows it; second call with same fields/options → CONFLICT.
- **drop-index.spec.ts** — `index:drop` removes it; dropping `_id_` returns VALIDATION.
- **unauthorized.spec.ts** — stub `aggregate({ $indexStats })` to throw 13 → list still returns rows; `usage` absent everywhere.

### Component
- **indexes-tab-render.spec.tsx** — mock `api.meta` + `api.index` → component renders DB picker, collection picker, table.
- **indexes-create-drawer.spec.tsx** — open drawer, fill fields, submit → `api.index.create` called with the expected payload.
- **indexes-drop-confirm.spec.tsx** — Drop button on a non-`_id_` row opens dialog; typing the wrong name keeps the button disabled; typing the right name + Drop → `api.index.drop` called.
- **indexes-empty-states.spec.tsx** — no DB selected → empty-state copy; UNAUTHORIZED on list → amber banner.

### E2E
- **indexes-create-and-drop.e2e.ts** — open Indexes tab → pick DB / coll → New index → fill → Create → row appears → Drop → confirm → row gone.

## 9. Implementation order

Three commits, each independently mergeable:

1. **Backend.** `IndexService` + `index:list` only. Wire into `main.ts`. Tests: build-index-info unit, list-indexes integration, unauthorized integration. No UI yet — the StubTab still renders.
2. **Read-only UI.** Replace `StubTab` with `IndexesTab` that lists indexes with the DB / collection picker. Persist `ui.indexes.lastTarget`. Tests: indexes-tab-render component, indexes-empty-states component.
3. **Mutations.** Create / drop channels + drawer + drop-confirm dialog. Tests: create-index integration, drop-index integration, indexes-create-drawer + indexes-drop-confirm component, full E2E.

## 10. Risks and mitigations

- **Atlas free tier blocks `$indexStats`.** Already mitigated by `Promise.allSettled` in `IndexService.list`. Test asserts the fallback path.
- **Index names with special characters.** The drop-confirm dialog requires an exact-match string compare on the index name; no escaping concerns. The "Copy spec as MQL" button must JSON-stringify the name.
- **Concurrent create from another client.** Refetching after every mutation is the simplest way to stay consistent. Manual Refresh covers the rest.
- **Long-running create on a large collection.** `createIndex` is foreground by default in the driver. v1 surfaces this as a spinning Create button without a progress affordance — acceptable since users typically create indexes on collections small enough to finish in seconds, and we already have a 30 s `socketTimeoutMS` default. If this hurts in practice, add an explicit "create in background" toggle in a follow-up.
