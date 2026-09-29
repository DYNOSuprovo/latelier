// Shared runtime-free types. Populated incrementally as specs land.

export type AuthMech = 'default' | 'scram256' | 'scram1' | 'x509' | 'awsiam' | 'none';
export type ConnType = 'srv' | 'standard';
export type ReadPref =
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest';
export type SshAuth = 'key' | 'password';

/**
 * Canonical connection — matches the `connections` row plus derived flags.
 * Phase C (C01) may extend this; for Step 5 only the subset used by the URI
 * builder is required.
 */
export interface Connection {
  id: string;
  name: string;
  color: string;
  connectionType: ConnType;
  host: string;
  port: number;
  defaultDb?: string;
  authMech: AuthMech;
  authUsername?: string;
  authDatabase?: string;
  tls: {
    enabled: boolean;
    verify: boolean;
    caPath?: string;
    clientCertPath?: string;
  };
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    username?: string;
    authMethod?: SshAuth;
    privateKeyPath?: string;
  };
  advanced: {
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    serverSelectionTimeoutMs: number;
    readPreference: ReadPref;
    maxPoolSize: number;
    directConnection: boolean;
    appName?: string;
  };
  hasPasswordStored: boolean;
  hasSshPasswordStored: boolean;
  hasSshPassphraseStored: boolean;
  /**
   * Blocks every MongoDB write reachable through this connection, enforced
   * in the main process (not just hidden in the UI) — see ADR 0005.
   */
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

/**
 * Input used for create/probe. Plaintext password (when present) is carried
 * across IPC; main persists it to SecretsVault and drops the plaintext reference.
 */
export interface ConnectionInput
  extends Omit<
    Connection,
    | 'id'
    | 'hasPasswordStored'
    | 'hasSshPasswordStored'
    | 'hasSshPassphraseStored'
    | 'createdAt'
    | 'updatedAt'
    | 'lastUsedAt'
  > {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionRuntime {
  id: string;
  status: ConnectionStatus;
  errorCode?: ProbeErrorCode;
  errorMessage?: string;
  connectedAt?: string;
  serverVersion?: string;
  topology?: MongoTopology;
}

export type MongoTopology = 'Single' | 'ReplicaSet' | 'Sharded' | 'Unknown';

export type ProbeErrorCode =
  | 'AUTH'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'TLS'
  /**
   * TCP connected but the TLS handshake never completed. Distinct from
   * `TLS` (certificate-level verification failure) — this fires on the
   * classic "server doesn't speak TLS on this port" pattern.
   */
  | 'TLS_HANDSHAKE'
  | 'UNAUTHORIZED'
  | 'UNKNOWN';

export interface ProbeResult {
  ok: boolean;
  serverVersion?: string;
  topology?: MongoTopology;
  roundTripMs?: number;
  errorCode?: ProbeErrorCode;
  errorMessage?: string;
}

/**
 * Slim row used by the sidebar list. Avoids sending the entire Connection
 * (with TLS paths, advanced options, etc.) across IPC on every list call.
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  color: string;
  host: string;
  port: number;
  connectionType: ConnType;
  lastUsedAt?: string;
  status: 'unknown' | 'connected' | 'disconnected' | 'connecting' | 'error';
  serverVersion?: string;
  readOnly: boolean;
}

/**
 * Patch shape for conn:update. Each field is optional; secret fields can be
 * supplied as a plaintext to replace, or via a `clear*` flag to remove.
 */
export type ConnectionUpdate = Partial<ConnectionInput> & {
  clearPassword?: boolean;
  clearSshPassword?: boolean;
  clearSshPassphrase?: boolean;
};

/**
 * Warnings produced by the URI parser that the UI surfaces as a non-blocking
 * toast (e.g., multi-host SRV list was truncated, or unsupported option was
 * dropped).
 */
export interface ParsedUriWarning {
  code: 'MULTI_HOST_TRUNCATED' | 'OPTION_DROPPED';
  detail?: string;
}

export interface ParsedUri {
  input: Partial<ConnectionInput>;
  warnings: ParsedUriWarning[];
}

// ─── Workspace tabs (W01) ───────────────────────────────────────────────────

/** Sub-views shown inside a collection tab. */
export type CollectionView = 'documents' | 'aggregation' | 'structure';

export type ResultViewMode = 'Tree' | 'JSON' | 'Table';
export type BuilderTab = 'Builder' | 'Saved' | 'Recent';

// ─── Query builder types (W04) ──────────────────────────────────────────────

/**
 * Operators with a value-shape-compatible encoder. Other operator strings
 * are allowed on `CondNode.op` (the user can type any op via autocomplete)
 * but are advisory-flagged as "doesn't apply" or "not encodable" outside
 * this set — see `builder.ts`'s `isCompilableOp`/`isApplicableOp` and
 * `filterTree.ts`'s printer (the live encoder, post-W13) for the shape
 * buckets.
 */
export type MqlOp =
  | '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte'
  | '$in' | '$nin' | '$regex' | '$exists' | '$type' | '$all'
  | '$mod' | '$size' | '$bitsAllClear' | '$bitsAnySet' | '$bitsAllSet' | '$bitsAnyClear';

export type ValType =
  | 'string' | 'number' | 'long' | 'decimal' | 'boolean' | 'date' | 'null' | 'regex' | 'objectid' | 'array';

/**
 * Sort/limit/projection knobs, each editable in exactly one place: sort and
 * limit in the query bar's advanced grid (W13 §7), projection in the Fields
 * control (W14 §4). `conditions`/`logic` retired by W13 — the
 * filter is `CollectionTabState.queryRaw` / `SavedFindPayload.queryRaw` text,
 * not a compiled condition list. See `legacyBuilder.ts` for the pre-W13
 * shape this superseded.
 */
export interface BuilderState {
  projection: string[];
  /**
   * W15 §9(b) — raw projection escape hatch. When set (non-blank) it
   * is sent to the driver verbatim and `projection` is ignored, exactly as
   * `queryRaw` overrides the structured filter. Optional and additive: a tab
   * persisted before this field existed has no key here and restores unchanged.
   */
  projectionRaw?: string;
  sort: string;
  limit: string;
}

// ─── Query runner types (W03) ────────────────────────────────────────────────

export interface FindInput {
  connectionId: string;
  dbName: string;
  collection: string;
  filter: string;
  projection?: string;
  sort?: string;
  limit: number;
  skip: number;
  ejsonRelaxed?: boolean;
  cancelToken?: string;
}

export interface FindResult {
  documents: unknown[];
  durationMs: number;
  hasMore: boolean;
}

/**
 * Wire shape returned by main. The `documentsJson` string is canonical EJSON
 * (already serialized) and gets parsed once in the preload before the result
 * is exposed to the renderer as `FindResult`. Avoids structured-cloning the
 * full document array across the contextBridge.
 */
export interface FindResultWire {
  documentsJson: string;
  durationMs: number;
  hasMore: boolean;
}

export interface ExplainInput extends Omit<FindInput, 'limit' | 'skip' | 'cancelToken'> {
  verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}

/** Verbosity union shared by find-explain and aggregation-explain callers. */
export type ExplainVerbosity = ExplainInput['verbosity'];

// ─── Export all matching (W03 / export-all) ──────────────────────────────────

export interface QueryExportColumn {
  header: string;
  path: string;
}

export interface QueryExportInput {
  connectionId: string;
  dbName: string;
  collection: string;
  filter: string;
  sort?: string;
  projection?: string;
  /** Builder's own `limit`, if set — capped server-side at the export hard cap. */
  limit?: number;
  format: 'json' | 'jsonl' | 'csv';
  relaxed?: boolean;
  /** Required when `format === 'csv'` — the Fields control's visible columns. */
  columns?: QueryExportColumn[];
  defaultName?: string;
}

export interface QueryExportResult {
  path: string | null;
  written: number;
  truncated: boolean;
}

// ─── Import (JSON / JSONL / CSV into an existing collection) ────────────────

export type ImportFormat = 'json' | 'jsonl' | 'csv';

/** What a CSV column's cells become; `skip` leaves the column out of every document. */
export type CsvColumnType = 'string' | 'number' | 'boolean' | 'date' | 'objectId' | 'skip';

export interface CsvColumnMapping {
  /** The file's header cell, checked against the file again at import. A dotted header nests. */
  header: string;
  type: CsvColumnType;
  /** An empty cell stores `null`; otherwise it leaves the field out. */
  emptyAsNull: boolean;
}

/** `data:previewCsv`: what the import dialog shows before a CSV import runs. */
export interface CsvPreview {
  /** Basename only. */
  fileName: string;
  headers: string[];
  /** The first data rows, as parsed; a ragged row stays ragged. */
  rows: string[][];
  /** One per header: the type every non-empty cell in the file converts to. */
  inferred: CsvColumnType[];
}

export interface DataImportInput {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Absolute path the renderer got from `app.pickFile('data-import')`. */
  path: string;
  /** Renderer-generated UUID; lets `data:cancelImport` and progress events target this run. */
  cancelToken?: string;
  /** Required for a `.csv` file, refused for any other: one mapping per header, in file order. */
  csv?: { columns: CsvColumnMapping[] };
}

export interface ImportReport {
  /** Basename only — never the directory the file came from. */
  fileName: string;
  format: ImportFormat;
  inserted: number;
  failed: number;
  /**
   * The first failures. `at` is a 1-based line for JSONL, a 0-based array
   * index for JSON, and a 1-based spreadsheet row for CSV (the header is row 1).
   */
  errors: { at: number; message: string }[];
  /** More documents failed than `errors` lists. */
  errorsTruncated: boolean;
  /** Cancel was requested and the import stopped after its current batch. */
  cancelled: boolean;
  /** Present only when the import was recorded Reversible (≤10,000 landed), for Undo. */
  auditId?: string;
}

/** Pushed once per batch while `data:import` runs. */
export interface DataImportProgressEvent {
  cancelToken: string;
  processed: number;
  inserted: number;
  failed: number;
  bytesRead: number;
  totalBytes: number;
}

// ─── Result view types (W06) ─────────────────────────────────────────────────

export interface LastRunError {
  code: string;
  message: string;
  details?: unknown;
}

export interface LastRun {
  documents: unknown[];
  totalCount?: number;
  durationMs: number;
  ranAt: string;
  error?: LastRunError;
}

// ─── Saved queries (W09) ─────────────────────────────────────────────────────

export type SavedKind = 'find' | 'aggregation' | 'script';

export interface SavedQuerySummary {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  kind: SavedKind;
  name: string;
  updatedAt: string;
  /** Derived from `payload.description` — read-only, populated by the service. */
  description?: string;
}

export interface SavedFindPayload {
  kind: 'find';
  builder: BuilderState;
  queryRaw: string;
  description?: string;
}

export interface SavedAggregationPayload {
  kind: 'aggregation';
  stages: Stage[];
  description?: string;
}

export type SavedPayload = SavedFindPayload | SavedAggregationPayload;

export interface SavedQuery extends SavedQuerySummary {
  payload: SavedPayload;
  createdAt: string;
}

// ─── Aggregation stages + runner (A02, A04, A06) ─────────────────────────────

export type StageOp =
  | '$match' | '$group' | '$sort' | '$project' | '$addFields'
  | '$limit' | '$skip' | '$count' | '$lookup' | '$unwind'
  | '$replaceRoot' | '$redact' | '$out' | '$merge'
  | '$set' | '$unset'
  | '$facet' | '$bucket' | '$sample' | '$graphLookup'
  | '$unionWith' | '$setWindowFields' | '$geoNear' | '$documents';

export interface Stage {
  id: number;
  op: StageOp | string;
  body: string;
  enabled: boolean;
  note?: string;
}

export interface PipelineState {
  stages: Stage[];
  activeStageId: number | null;
}

export interface AggInput {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];
  limit?: number;
  cancelToken?: string;
  allowWrite?: boolean;
}

export interface AggStagePreview {
  stageId: number;
  count?: number;
  sample: unknown[];
}

export interface AggResult {
  rows: unknown[];
  durationMs: number;
  totalCount?: number;
  stageCounts: Record<number, number>;
  stageSamples: Record<number, unknown[]>;
  hasMore: boolean;
}

/**
 * Wire shape for AggResult — see FindResultWire. Only `rows` is large enough
 * to benefit from string-on-wire; stageSamples are bounded to a few docs per
 * stage and stay as objects.
 */
export interface AggResultWire {
  rowsJson: string;
  durationMs: number;
  totalCount?: number;
  stageCounts: Record<number, number>;
  stageSamples: Record<number, unknown[]>;
  hasMore: boolean;
}

export interface PreviewInput {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];
  limit?: number;
}

export type AggSaveMode = '$out' | '$merge';

export interface AggMergeOptions {
  whenMatched?: 'replace' | 'keepExisting' | 'merge' | 'fail';
  whenNotMatched?: 'insert' | 'discard' | 'fail';
}

export interface AggRunAndSaveInput extends AggInput {
  target: {
    dbName: string;
    collection: string;
    mode: AggSaveMode;
    merge?: AggMergeOptions;
  };
}

export interface AggExplainInput extends AggInput {
  verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}

// ─── Recent queries + preview fields (W10) ───────────────────────────────────

export type RecentKind = 'find' | 'aggregation';

export interface RecentQuery {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  kind: RecentKind;
  payload: SavedPayload;
  ranAt: string;
  durationMs: number;
  resultCount?: number;
  errorCode?: string;
}

// ─── Audit log (X13) ─────────────────────────────────────────────────────────

/** Mirrors the `audit_log.op` CHECK constraint (migration 012). */
export type AuditOp =
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'
  | 'collectionDrop'
  | 'collectionRename'
  | 'databaseDrop'
  | 'import';

export type AuditOutcome = 'ok' | 'error' | 'partial';

/**
 * What the audit modal renders — never a document body. `filter` is the EJSON
 * text the Operation was sent; counts are absent when the Operation failed
 * before the server reported them.
 */
export type AuditSummary =
  | { op: 'insertMany'; insertedCount?: number }
  | { op: 'updateOne' | 'updateMany'; filter: string; matchedCount?: number; modifiedCount?: number }
  | { op: 'deleteOne' | 'deleteMany'; filter: string; deletedCount?: number }
  | { op: 'collectionRename'; fromName: string; toName: string }
  | { op: 'collectionDrop' | 'databaseDrop' }
  /** `format` is absent when the import failed before its file was read. `cancelled` is absent unless true. */
  | { op: 'import'; fileName: string; format?: ImportFormat; insertedCount?: number; failedCount?: number; cancelled?: boolean };

export interface AuditEntry {
  id: string;
  connectionId: string;
  dbName: string;
  /** Null only for `databaseDrop`. */
  collection: string | null;
  op: AuditOp;
  summary: AuditSummary;
  outcome: AuditOutcome;
  errorCode?: string;
  ranAt: string;
  durationMs: number;
  /**
   * Undo is still on offer: a Pre-image was captured, is still held, and has
   * not been used. False once the entry is undone or its Pre-image is swept.
   */
  reversible: boolean;
  undoneAt?: string;
}

export interface UndoResult {
  restored: number;
  skipped: number;
}

export interface AuditListInput {
  connectionId: string;
  dbName?: string;
  collection?: string;
  limit?: number;
  /** `ranAt` cursor: only entries strictly older are returned. */
  before?: string;
}

/**
 * A Table-view column addressed by a dotted path into each document rather
 * than a literal top-level key (T2.5, AC8). v1 is a plain accessor — no
 * expression evaluation. `label` defaults to `path` when unset.
 */
export interface ComputedColumn {
  id: string;
  path: string;
  label?: string;
}

/**
 * Table-view column show/hide/reorder/computed-column configuration (T2.5).
 * Persisted per-tab, like `columns` (widths) — not a per-collection
 * preference. All fields optional so existing persisted `state_json`
 * (written before this field existed) deserializes as "no config": all
 * derived columns visible, in their natural order.
 */
export interface TableColumnConfig {
  /** Explicit field order. Fields not listed append after these, in their
   * naturally-derived order (so schema drift never hides new fields). */
  order?: string[];
  /** Field names hidden from the header + body. */
  hidden?: string[];
  /** User-added dotted-path accessor columns, appended after derived ones. */
  computed?: ComputedColumn[];
}

/**
 * Per-tab state for a collection tab. Persisted as JSON via `workspace_tabs`.
 *
 * The tab now hosts three sub-views (Documents / Aggregation / Schema). Fields
 * scoped to the Documents view stay at the top level for backwards-compat with
 * existing persisted state; Aggregation and Schema state are nested.
 */
export interface CollectionTabState {
  /** Which sub-view is visible. Defaults to 'documents'. */
  activeView?: CollectionView;
  view: ResultViewMode;
  builder: BuilderState;
  /** Canonical filter text (W13 §8) — required, defaults to `'{}'`. */
  queryRaw: string;
  page: number;
  pageSize: number;
  totalCount?: number;
  lastRunHasMore?: boolean;
  lastRun?: LastRun;
  columns?: Record<string, { width: number }>;
  expandedRows?: Record<string, boolean>;
  /** Table-view column show/hide/reorder/computed config (T2.5). */
  columnConfig?: TableColumnConfig;
  activeBuilderTab: BuilderTab;
  /** Persisted reference-drawer stack; restored when the user revisits this tab. */
  referenceDrawer?: PersistedDrawerState;
  /** Aggregation sub-view state. Lazily populated when the user opens it. */
  aggregation?: AggregationTabState;
  /** Schema sub-view state. Lazily populated when the user opens it. */
  schema?: SchemaTabState;
}

/**
 * Per-tab state for an aggregation tab.
 */
export interface AggregationLastRun {
  rows: unknown[];
  durationMs: number;
  ranAt: string;
  stageCounts: Record<number, number>;
  stageSamples: Record<number, unknown[]>;
  hasMore?: boolean;
  error?: LastRunError;
}

export interface AggregationTabState {
  name?: string;
  savedId?: string;
  stages: Stage[];
  activeStageId: number | null;
  outputHeight: number;
  outputView: ResultViewMode;
  lastRun?: AggregationLastRun;
  dirty?: boolean;
}

/**
 * Per-tab state for the Schema sub-view (sample-based field-type summary).
 * `entries` is rebuilt from a sample of recent documents on open / refresh.
 */
export interface SchemaSampleEntry {
  /** Dotted field path. Top-level fields have no dots. */
  path: string;
  /** Frequency in [0, 1] across the sampled documents. */
  frequency: number;
  /** BSON-shaped type histogram (counts), e.g. { string: 8, null: 2 }. */
  types: Record<string, number>;
}

export interface SchemaTabState {
  /** Number of documents requested from `meta:sampleSchema`. */
  sampleSize: number;
  /** Total documents actually used to build `entries` (may be < sampleSize). */
  sampledCount?: number;
  entries?: SchemaSampleEntry[];
  ranAt?: string;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Per-tab state for a script tab (W12). `source` is the editor buffer;
 * `lastResult` / `lastError` round-trip through `state_json` so reopening
 * the app restores the most recent run output.
 */
export interface ScriptTabState {
  /** Tab title shown in the strip. Defaulted on creation, user-renamable. */
  title: string;
  /** Editor buffer. UTF-8. */
  source: string;
  /** Default db for the `db` proxy at run time. Optional — scripts can
   *  also call `use("...")` themselves. */
  dbName?: string;
  /** Hard ceiling, ms. Toolbar knob: 15_000 / 60_000 / 300_000 /
   *  86_400_000 ("no limit"). Defaults to 60_000. */
  maxTimeMs?: number;
  /** Most recent successful run. Mutually exclusive with lastError. */
  lastResult?: ScriptRunResultWire;
  /** Most recent failed run. Mutually exclusive with lastResult. */
  lastError?: { code: string; message: string };
  /** Editor / result split height, px. */
  resultPanelHeight?: number;
  /** Persisted view mode for array-of-docs results. Tree/JSON/Table. */
  resultView?: ResultViewMode;
  /** Persisted column widths for the Table view of array results. */
  resultColumns?: Record<string, { width: number }>;
  /** Persisted row-expansion state for the Tree view of array results. */
  resultExpandedRows?: Record<string, boolean>;
}

interface WorkspaceTabBase {
  id: string;
  connectionId: string;
  position: number;
  isActive: boolean;
  openedAt: string;
  pinned: boolean;
}

export interface CollectionTab extends WorkspaceTabBase {
  kind: 'collection';
  dbName: string;
  collection: string;
  state: CollectionTabState;
}

export interface ScriptTab extends WorkspaceTabBase {
  kind: 'script';
  /** Empty string for script tabs — the SQL columns are required, but
   *  scripts don't bind to a db/collection at the row level. The active
   *  db lives in `state.dbName`. */
  dbName: string;
  collection: string;
  state: ScriptTabState;
}

export type WorkspaceTab = CollectionTab | ScriptTab;

// ─── Script tab IPC (W12) ───────────────────────────────────────────────────

export interface ScriptRunInput {
  connectionId: string;
  dbName?: string;
  source: string;
  /** Renderer-supplied UUID; used by `script:cancel`. */
  cancelToken?: string;
  /** Hard ceiling so a runaway script can't pin the main process. */
  maxTimeMs?: number;
  /** EJSON canonical (false) vs relaxed (true). Default false to match
   *  the rest of the app. */
  ejsonRelaxed?: boolean;
}

export interface ScriptRunResultWire {
  /** EJSON-encoded last-expression value. May be a JSON array, object,
   *  or scalar. `null` when the script produced no value. */
  valueJson: string | null;
  /** Concatenated `print()` / `printjson()` output, capped at 64 KB. */
  printBuffer: string;
  durationMs: number;
}

// ─── Document references (X05) ───────────────────────────────────────────────

/**
 * A rule says: when the renderer encounters `sourceField` inside a document
 * from `sourceDb.sourceCollection`, treat its value as a pointer to
 * `targetDb.targetCollection.targetField` and offer to load the referenced
 * document on demand. Purely a UI affordance — the underlying data is never
 * joined or mutated.
 */
export interface ReferenceRule {
  id: string;
  connectionId: string;
  sourceDb: string;
  sourceCollection: string;
  /** Dotted field path on the source document (e.g. `contact_id`, `items.productId`). */
  sourceField: string;
  targetDb: string;
  targetCollection: string;
  /** Target field to match against (default `_id`). */
  targetField: string;
  /** Fields to fetch from the target doc. Empty = fetch the whole document. */
  projection: string[];
  /** Optional title template — `{name}` / `{email}` placeholders expand against the resolved doc. */
  displayTemplate?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceRuleCreateInput {
  connectionId: string;
  sourceDb: string;
  sourceCollection: string;
  sourceField: string;
  targetDb: string;
  targetCollection: string;
  targetField?: string;
  projection?: string[];
  displayTemplate?: string;
  enabled?: boolean;
}

export type ReferenceRuleUpdateInput = Partial<
  Pick<
    ReferenceRule,
    | 'targetDb'
    | 'targetCollection'
    | 'targetField'
    | 'projection'
    | 'displayTemplate'
    | 'enabled'
  >
>;

export interface ReferenceResolveInput {
  ruleId: string;
  /** EJSON canonical string of the field's value (ObjectId, string, etc.). */
  valueEjson: string;
}

export interface ReferenceResolveResult {
  ruleId: string;
  found: boolean;
  /**
   * EJSON-encoded matched docs (already projected). Empty when no match.
   *
   * For scalar source values this is a 0- or 1-element array. For array
   * source values (e.g. `item_ids: [ObjectId, ObjectId, …]`) the resolver
   * runs `$in` against the target field and returns every match in the
   * source array's order; unmatched ids are silently dropped.
   */
  documents: unknown[];
  durationMs: number;
}

export interface ReferenceAutodetectInput {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Optional sample docs the caller already has on hand (lastRun). */
  sampleDocs?: unknown[];
}

export interface ReferenceAutodetectCandidate {
  sourceField: string;
  targetDb: string;
  targetCollection: string;
  targetField: string;
  /** True when a rule already exists for this source field. */
  alreadyConfigured: boolean;
}

/**
 * Persisted shape of a single drawer frame. The rule is snapshotted so the
 * drawer can render its breadcrumb / projection without an extra IPC fetch
 * on tab rehydrate; the value is stored as canonical EJSON for portability.
 */
export interface PersistedReferenceFrame {
  id: string;
  rule: ReferenceRule;
  valueEjson: string;
  label: string;
}

export interface PersistedDrawerState {
  stack: PersistedReferenceFrame[];
}

export type FeatureHintId =
  | 'run.execute'
  | 'refs.configure'
  | 'tabs.pin'
  | 'saved.create'
  | 'palette.discover';

export interface FeatureHintDismissalState {
  dismissedIds: FeatureHintId[];
  resetAt?: string;
}

// ─── Indexes (C09) ───────────────────────────────────────────────────────────

/** Sort direction or specialised index type for a single keyed field. */
export type IndexFieldDirection =
  | 1
  | -1
  | 'text'
  | 'hashed'
  | '2d'
  | '2dsphere'
  | 'geoHaystack';

export interface IndexInfo {
  /** Server-assigned name (`_id_`, `name_1_age_-1`, or user-given). */
  name: string;
  /** Insertion-ordered field → direction array; preserves compound key order. */
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
    since: string;
  };
}

export interface IndexCreateInput {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Insertion order is preserved → drives compound key order on the server. */
  fields: Array<{ field: string; direction: IndexFieldDirection }>;
  options: {
    name?: string;
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    /** EJSON canonical string. */
    partialFilterExpression?: string;
    /** EJSON canonical string. */
    collation?: string;
  };
}

export interface IndexDropInput {
  connectionId: string;
  dbName: string;
  collection: string;
  name: string;
}

// ─── Collection / database admin (T1.1) ──────────────────────────────────────

export type ValidationLevel = 'off' | 'strict' | 'moderate';
export type ValidationAction = 'error' | 'warn';

export interface CollectionCreateOptions {
  capped?: boolean;
  /** Bytes; required by the driver when `capped` is true. */
  size?: number;
  /** Max document count for a capped collection. */
  max?: number;
  timeseries?: {
    timeField: string;
    metaField?: string;
    granularity?: 'seconds' | 'minutes' | 'hours';
  };
  /** Seconds after which time-series documents expire. */
  expireAfterSeconds?: number;
  /** EJSON canonical string. */
  collation?: string;
  /** EJSON canonical string — `{ $jsonSchema: {...} }` or a query-style validator. */
  validator?: string;
  validationLevel?: ValidationLevel;
  validationAction?: ValidationAction;
}

export interface CollectionCreateInput {
  connectionId: string;
  dbName: string;
  collection: string;
  options: CollectionCreateOptions;
}

export interface CollectionDropInput {
  connectionId: string;
  dbName: string;
  collection: string;
}

export interface CollectionRenameInput {
  connectionId: string;
  dbName: string;
  /** Current collection name. */
  collection: string;
  /** New name — same database only. */
  newName: string;
}

export interface DatabaseDropInput {
  connectionId: string;
  dbName: string;
}

// ─── Users (C10) ─────────────────────────────────────────────────────────────

export type AuthMechanism =
  | 'SCRAM-SHA-1'
  | 'SCRAM-SHA-256'
  | 'MONGODB-X509'
  | 'PLAIN'
  | 'GSSAPI'
  | 'MONGODB-AWS'
  | 'MONGODB-OIDC';

export interface UserRoleRef {
  role: string;
  db: string;
}

export interface UserInfo {
  /** Storage db (where the user record lives). */
  db: string;
  username: string;
  /** Mechanism list as configured on the user. */
  mechanisms: AuthMechanism[];
  roles: UserRoleRef[];
  /** EJSON canonical string of `customData`, when set. */
  customData?: string;
  /** True when the user is configured only for non-password mechanisms. */
  external: boolean;
}

export interface RoleInfo {
  role: string;
  db: string;
  isBuiltin: boolean;
  inheritedRoles: UserRoleRef[];
}

export interface UserCreateInput {
  connectionId: string;
  /** Auth db — where the user record lives. */
  dbName: string;
  username: string;
  /**
   * Plaintext password. Encrypted in transport by Electron contextBridge.
   * NEVER persisted by L'Atelier; passed straight to MongoDB and then dropped.
   */
  password: string;
  roles: UserRoleRef[];
  /** Defaults to ['SCRAM-SHA-256'] when omitted. */
  mechanisms?: AuthMechanism[];
  /** EJSON canonical string. */
  customData?: string;
}

export interface UserUpdateInput {
  connectionId: string;
  dbName: string;
  username: string;
  patch: {
    /** Replaces the role array if present. */
    roles?: UserRoleRef[];
    /** Plaintext — same caveat as create. Omit to leave unchanged. */
    password?: string;
    /** EJSON canonical string. Omit to leave unchanged. */
    customData?: string;
    /** Replaces the mechanism list. */
    mechanisms?: AuthMechanism[];
  };
}

export interface UserDropInput {
  connectionId: string;
  dbName: string;
  username: string;
}

// ─── Mongo shell pane (W11) ──────────────────────────────────────────────────

export interface ShellSessionInfo {
  sessionId: string;
  connectionId: string;
  dbName?: string;
  startedAt: string;
}

export type ShellOutputKind = 'stdout' | 'stderr' | 'exit';

export interface ShellOutputEvent {
  sessionId: string;
  kind: ShellOutputKind;
  /** Present for stdout/stderr. Plain text (CSI-stripped). */
  data?: string;
  /** Present only when kind === 'exit'. */
  exitCode?: number | null;
  /** Present only when kind === 'exit' and the process was signalled. */
  signal?: string | null;
}
