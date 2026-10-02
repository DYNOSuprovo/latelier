# W06 — Result views (Tree / JSON / Table)

## Purpose

Render the current result set in one of three views. Tree shows collapsed rows with a preview and expands to a typed field grid. JSON shows syntax-highlighted EJSON. Table shows tabular rows with column overflow. All three share a single data source (the tab's last successful run) and a single selection concept.

## Scope

- **In**: The three view components, the per-doc row expansion state, the column set derivation for Table, the preview-field picker integration, the document-selection concept (for W08 edit/delete), empty and loading states.
- **Out**: Running queries (W03/W05), pagination (W07), writing docs (W08).

## Dependencies

- W03 (EJSON shape), W05 (produces the docs), W07 (page controls), W08 (selection drives edit/delete), W10 (preview fields).

## 1. Data source

Held on the active collection tab as `state.lastRun`, in renderer memory only: main strips it before every `state_json` write (results can be production documents), so a restored tab has no `lastRun` until it runs — default-query tabs auto-run, custom-query tabs show "Run the query to see results":

```ts
interface LastRun {
  documents: unknown[];      // EJSON canonical
  totalCount?: number;
  durationMs: number;
  ranAt: string;             // ISO
  error?: IpcError;
}
```

Documents are always EJSON objects. A helper `toDisplayValue(v): { type, display, raw }` classifies each leaf:

| EJSON shape                      | `type`       | `display` |
| -------------------------------- | ------------ | --------- |
| `{ $oid: "…" }`                  | `objectid`   | `ObjectId("ffff…")` |
| `{ $date: "…" }`                 | `date`       | ISO string |
| `{ $numberLong: "…" }`           | `long`       | the number |
| `{ $numberDecimal: "…" }`        | `decimal`    | the number |
| `{ $regex: …, $options: … }`     | `regex`      | `/r/opts`  |
| `{ $binary: { … } }`             | `binary`     | `Binary(len=…)` |
| plain `string`/`number`/`boolean`| accordingly  |            |
| `null`                           | `null`       | `null`     |
| `Array`                          | `array`      | `[N items]` |
| plain object                     | `object`     | `{N fields}` |

## 2. Tree view (default)

Row layout (matches existing mock):
- Collapsed: `[▸] [📄] [shortId]   [key: value · key: value · …]   [✏ pick preview]`.
- Expanded: a field grid with three columns (field, value, type), nested objects/arrays expand on click.

### Expansion state
- `expanded: Set<string>` per tab (persisted in tab state).
- Clicking the ▸/▾ toggles.
- Deep field expansion uses a path like `_id.$oid` for persistence is overkill — iteration 1 does NOT persist deep expansion, only top-level row expansion.

### Preview fields
- Driven by the per-collection preview fields (W10). Shown in the collapsed row header, up to 4 fields.
- Each row has a ✏ button that opens `PreviewPicker` (already in mock): a popover listing all known field names from the current result set (union of keys across the first 50 docs). Selecting checkboxes updates preview fields via W10 IPC.

### Short id
- For `_id` of type `ObjectId`, show last 8 hex chars. For non-Object-id `_id`, show up to 12 chars of the EJSON stringification, prefixed with the type badge.

### Selection
- Single-select: clicking the collapsed row header selects the doc (blue left border). Cmd/Ctrl-click toggles selection for multi-select.
- Selection is consumed by W08 for `Edit document` / `Delete document(s)` actions.

## 3. JSON view

- Each doc in its own card (matches mock).
- Uses `JSON.stringify(EJSON.parse(...), null, 2)` output with light syntax highlighting (keys bold; strings green; numbers blue; booleans orange; null grey — colors from tokens).
- Syntax highlighting is computed at render time by a tiny tokenizer in `utils/jsonHighlight.ts` — do NOT bring in `prismjs` or `highlight.js` for iteration 1.
- The "card" is selectable (click toggles selection).

## 4. Table view

- Derive columns:
  - Take the union of top-level keys across the first 50 docs.
  - Ensure `_id` is first, then the current preview fields in order, then the remaining keys alphabetically.
- Column widths: default auto with `max-width: 200px` + ellipsis overflow. User can drag column separators to resize (persisted in tab state as `state.columns.{field}.width`).
- Nested objects/arrays show as `{N}` / `[N]` badges that expand into a small popover showing the nested JSON.
- Right-click on a row → context menu: `Edit`, `Delete`, `Copy`, `Copy as JSON`.

## 5. Common

### Loading & empty
- Loading (between Run click and response): overlay with subtle spinner, keep previous docs visible ("stale but readable").
- Empty (`documents.length === 0`): centered placeholder "No matching documents" with a helpful link "Clear filter" (resets builder).
- Errored: the error pill in W05 conveys the state; the result area keeps the previous docs visible with a small amber "stale" badge.

### Keyboard
- `j` / `k` move selection down / up (when result area focused).
- `Enter` expands the selected row in Tree view.
- `d` in Table/Tree deletes the selected doc (with confirm; W08).
- `Space` toggles expansion.

### Performance
- Virtualize Table view rows with `react-window` when `documents.length > 200`.
- Tree view also virtualized when > 200 rows.

## 6. Acceptance criteria

- [ ] All three views render the same underlying `documents` array without re-running the query.
- [ ] Changing preview fields updates Tree and Table header order without a new run.
- [ ] Selection state persists while switching view modes.
- [ ] Expanding a row in Tree persists across tab switches (top-level only).
- [ ] EJSON values (ObjectId, Date, Long, Decimal) render with correct type badges.
- [ ] Column resize in Table persists across relaunches.
- [ ] Switching view modes is instant (no extra fetch).

## 7. Test cases

### Component
- **tree-collapsed.spec.tsx**: renders short id + preview fields; click ▸ expands.
- **tree-expanded.spec.tsx**: type badges rendered (objectid/date/number/...); nested object expands.
- **preview-picker.spec.tsx**: picker lists all field names; selecting updates preview fields via W10 mock.
- **json-highlight.spec.tsx**: keys are bold; strings are green; numbers are blue; null is grey.
- **table-columns.spec.tsx**: column order: _id first, then preview, then alpha remainder.
- **table-resize.spec.tsx**: drag a column separator → `api.tabs.update` called with new width.
- **selection.spec.tsx**: click selects; cmd-click toggles additional; switching view keeps selection.
- **empty-state.spec.tsx**: zero docs → placeholder with Clear filter link.
- **virtualize.spec.tsx**: with 500 docs, DOM contains ≤ 60 row nodes.

### E2E
- **view-swap.e2e.ts**: run query → Tree, click rows → switch to JSON → same docs → switch to Table → resize a column → reload app → width persisted.
