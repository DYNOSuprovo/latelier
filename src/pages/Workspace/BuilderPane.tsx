import React, { memo } from 'react';
import {
  ActionIcon,
  Button,
  Menu,
  Select,
  Tabs,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { confirmDestructive } from '../../utils/confirm';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { copyToClipboard } from '../../utils/clipboard';
import { notify } from '../../theme/notifications';
import {
  emptyBuilder,
  compileFindOptions,
  effectivePageLimit,
  findProblem,
  FIELD_OPS,
  isCompilableOp,
  DRAGGED_FIELD_MIME,
  condFromDragged,
  mergeOrReplaceDragged,
  valTypeFromDisplayType,
  opForValType,
  type DraggedField,
} from './builder';
import {
  parseFilter,
  printFilter,
  updateAt,
  insertAt,
  removeAt,
  moveAt,
  wrapInGroup,
  toRawNode,
  tryParseRaw,
  nodeAt,
  type GroupNode,
  type CondNode,
  type RawNode,
  type NodePath,
  type NodeProblem,
} from './filterTree';
import { SavedTab } from './views/SavedTab';
import { RecentTab } from './views/RecentTab';
import { legacyCompileFilter, type LegacyBuilderState, type LegacySavedFindPayload } from './legacyBuilder';
import { useSuggestions } from '../../features/fieldSuggestions/useSuggestions';
import { SuggestionPopover } from '../../features/fieldSuggestions/SuggestionPopover';
import { DEFAULT_FIELD_SOURCES, DEFAULT_VALUE_SOURCES, fieldOperatorSource } from '../../features/fieldSuggestions/sources';
import { hasOperatorDocs, resolveOperatorSymbol } from '../../features/fieldSuggestions/operators';
import { OperatorTooltip } from '../../features/fieldSuggestions/OperatorTooltip';
import type { SuggestionContext } from '../../features/fieldSuggestions/types';
import type {
  BuilderState,
  BuilderTab,
  RecentQuery,
  SavedQuery,
  SavedQuerySummary,
  ValType,
} from '@shared/types';
import { useCollectionWorkspace } from './context';

interface BuilderPaneProps {
  /** Bumped externally after a save so SavedTab re-fetches. */
  savedRefreshKey: number;
  /** Opens an aggregation or script saved item as its own top-level tab. */
  onOpenInTab: (saved: SavedQuerySummary) => void;
}

const VAL_TYPES: ValType[] = ['string', 'number', 'long', 'decimal', 'boolean', 'date', 'null', 'regex', 'objectid', 'array'];

/** The only ops the value popover offers suggestions for — mirrors `RECORDABLE_OPS` in `RecentFieldValueService`. */
const VALUE_SUGGESTION_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

const EMPTY_ROOT: GroupNode = { kind: 'group', logic: '$and', children: [] };

function pathsEqual(a: NodePath, b: NodePath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function pathKey(path: NodePath): string {
  return path.length === 0 ? 'root' : path.join('.');
}

/**
 * Mongosh-flavored preview of the typed value the user just entered. Shown
 * as a faint hint to the right of the value input so the user sees what
 * the wrapped MQL will look like (e.g. `ISODate("2026-04-01")`) without
 * having to read the generated query bar.
 */
function formatCondPreview(cond: { valType: ValType; value: string }): string {
  const v = cond.value;
  switch (cond.valType) {
    case 'string':
      return v ? `"${v}"` : '""';
    case 'number':
      return v || '0';
    case 'long':
      return v ? `NumberLong("${v}")` : 'NumberLong("…")';
    case 'decimal':
      return v ? `NumberDecimal("${v}")` : 'NumberDecimal("…")';
    case 'boolean':
      return v === 'true' ? 'true' : 'false';
    case 'date':
      return v ? `ISODate("${v}")` : 'ISODate("…")';
    case 'null':
      return 'null';
    case 'regex':
      return v ? `/${v}/` : '/…/';
    case 'objectid':
      return v ? `ObjectId("${v}")` : 'ObjectId("…")';
    case 'array':
      return v || '[]';
    default:
      return v || '…';
  }
}

/** AND/OR/NOR segmented control shared by every group header (root + nested). */
function LogicPicker({
  value,
  onChange,
  disabled,
}: {
  value: GroupNode['logic'];
  onChange: (v: GroupNode['logic']) => void;
  disabled?: boolean;
}) {
  const T = themeVars;
  return (
    <div
      role="radiogroup"
      aria-label="Group logic"
      style={{
        display: 'flex',
        borderRadius: T.rs,
        overflow: 'hidden',
        border: `1px solid ${T.border}`,
      }}
    >
      {(['$and', '$or', '$nor'] as const).map((v, i) => {
        const active = value === v;
        const label = v === '$and' ? 'AND' : v === '$or' ? 'OR' : 'NOR';
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v)}
            style={{
              padding: '2px 9px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.3,
              cursor: disabled ? 'default' : 'pointer',
              background: active ? T.accent : 'transparent',
              color: active ? T.accentText : T.textMuted,
              border: 'none',
              borderRight: i < 2 ? `1px solid ${T.border}` : 'none',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The row-level "⋮" menu: Move up / Move down / Convert to raw clause (cond
 * rows only) / Wrap in group / Duplicate.
 *
 * Remove has its own one-click ✕ beside this menu rather than living here
 * too — one affordance per action, not two. Move up/down live here instead
 * of as two more icons on every row: a `Menu.Item` is keyboard-reachable, so
 * reorder is never drag-only, and the row's control strip stays a fixed
 * width. At the ends the item is disabled rather than hidden, so the menu
 * doesn't change shape row to row.
 */
function RowMenu({
  onConvertToRaw,
  onWrap,
  onDuplicate,
  onMove,
  canMoveUp,
  canMoveDown,
  disabled,
  ariaLabel,
  rowKey,
}: {
  onConvertToRaw?: () => void;
  onWrap: () => void;
  onDuplicate: () => void;
  onMove: (delta: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled?: boolean;
  ariaLabel: string;
  /** `pathKey(path)`, so a move can put focus back on the row that moved. */
  rowKey: string;
}) {
  return (
    <Menu position="bottom-end" shadow="md" width={190}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={ariaLabel}
          disabled={disabled}
          data-row-menu={rowKey}
        >
          {I.more}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item disabled={!canMoveUp} onClick={() => onMove(-1)}>
          Move up
        </Menu.Item>
        <Menu.Item disabled={!canMoveDown} onClick={() => onMove(1)}>
          Move down
        </Menu.Item>
        {onConvertToRaw && <Menu.Item onClick={onConvertToRaw}>Convert to raw clause</Menu.Item>}
        <Menu.Item onClick={onWrap}>Wrap in group</Menu.Item>
        <Menu.Item onClick={onDuplicate}>Duplicate</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Move a row, then put focus back on it.
 *
 * Rows are keyed by `pathKey(childPath)`, which is positional, so after a
 * move React keeps the menu that was at the old index and focus lands on
 * whatever sibling took that slot. For a keyboard user repeating "Move up"
 * that means the second press acts on the wrong row.
 *
 * Stable per-node identities would fix it at the root, but the tree model has
 * no node ids and inventing them is a much larger change than the defect
 * warrants. Re-targeting focus by the row's *new* path is the small fix.
 */
function moveRowKeepingFocus(
  root: GroupNode,
  path: NodePath,
  delta: number,
  applyEdit: (next: GroupNode) => void,
): void {
  applyEdit(moveAt(root, path, delta));
  const parent = path.slice(0, -1);
  const nextKey = pathKey([...parent, path[path.length - 1]! + delta]);
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-row-menu="${nextKey}"]`)
      ?.focus();
  });
}

interface TreeEditProps {
  root: GroupNode;
  applyEdit: (next: GroupNode) => void;
  readOnly: boolean;
  /**
   * `pathKey` of the single group/row currently highlighted as a drop
   * target, or `null` — lifted to `FilterDrawer` rather than tracked
   * per-group/row. A per-scope `dragLeave` guard has to correctly
   * special-case handing off to a nested drop-owner vs. a real exit vs. a
   * flicker between plain children — an easy place to get an edge case
   * wrong. With a single shared value there is nothing to hand off — the
   * next scope's own `onDragOver` just overwrites it, which un-highlights
   * the old one for free. The only thing that still needs telling is "the
   * drag ended without landing anywhere I control", which `FilterDrawer`'s
   * one document-level `dragend` listener covers for every level at once.
   */
  activeDropPath: string | null;
  setActiveDropPath: (path: string | null) => void;
}

/** Where the row sits among its siblings — drives the move items' ends. */
interface RowMoveProps {
  canMoveUp: boolean;
  canMoveDown: boolean;
}

/**
 * Row-level drop handlers, shared by `CondRow` and `RawRow`. A drop landing
 * exactly on a row merges/replaces that row (`mergeOrReplaceDragged`)
 * instead of bubbling up to the parent `GroupView`'s handler, which would
 * insert a fresh sibling. `stopPropagation()` is what wins that race — same
 * bubbling-intercepts-parent shape the group level uses between nested
 * groups, one level further in. Same `canAcceptDrop`/`readOnly` guard as
 * `GroupView`'s group-level handler.
 *
 * Highlighting is driven by the shared `activeDropPath` (see `TreeEditProps`)
 * rather than a state local to this hook: `stopPropagation()` here means a
 * bubbled `dragOver` never reaches the parent `GroupView`, so if each level
 * tracked its own on/off flag, something would have to explicitly tell the
 * group its highlight is stale the instant the cursor crosses onto a row.
 * With one shared value, this row's own `onDragOver` claiming it is what
 * un-highlights the group; nothing else has to know.
 */
function useRowDropHandlers(
  node: CondNode | RawNode,
  path: NodePath,
  root: GroupNode,
  applyEdit: (next: GroupNode) => void,
  readOnly: boolean,
  activeDropPath: string | null,
  setActiveDropPath: (path: string | null) => void,
): {
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  isActive: boolean;
} {
  const key = pathKey(path);
  const canAcceptDrop = (e: React.DragEvent): boolean =>
    !readOnly && e.dataTransfer.types.includes(DRAGGED_FIELD_MIME);
  return {
    isActive: activeDropPath === key,
    onDragOver: (e) => {
      if (!canAcceptDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (activeDropPath !== key) setActiveDropPath(key);
    },
    onDrop: (e) => {
      if (!canAcceptDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveDropPath(null);
      const raw = e.dataTransfer.getData(DRAGGED_FIELD_MIME);
      if (!raw) return;
      let dragged: DraggedField;
      try {
        dragged = JSON.parse(raw) as DraggedField;
      } catch {
        return;
      }
      // A dragged field can legitimately hold `undefined` (BSON's Undefined
      // type) — `DocFieldTree`'s drag source now guards against starting
      // such a drag at all, but this is defense in depth for any other
      // payload source, since `condFromDragged` crashes downstream on one.
      if (typeof dragged.field !== 'string' || !dragged.field || dragged.value === undefined) return;
      // A raw row can hold a hand-typed clause a dropped field would
      // silently overwrite (`mergeOrReplaceDragged` only merges onto an
      // existing `cond`, so a `raw` target always falls to replace). An
      // empty raw row has nothing to lose, so it replaces without asking.
      if (node.kind === 'raw' && node.json.trim()) {
        void confirmDestructive({
          title: 'Replace this raw clause?',
          body: 'Dropping a field here replaces this hand-typed clause with a new condition. It cannot be undone.',
          confirmLabel: 'Replace',
        }).then((proceed) => {
          if (proceed) applyEdit(updateAt(root, path, mergeOrReplaceDragged(node, dragged)));
        });
        return;
      }
      applyEdit(updateAt(root, path, mergeOrReplaceDragged(node, dragged)));
    },
  };
}

function CondRow({
  node,
  path,
  root,
  applyEdit,
  problem,
  readOnly,
  activeDropPath,
  setActiveDropPath,
  suggestionContext,
  canMoveUp,
  canMoveDown,
}: TreeEditProps & RowMoveProps & {
  node: CondNode;
  path: NodePath;
  problem: string | undefined;
  suggestionContext: SuggestionContext | null;
}) {
  const T = themeVars;
  const fieldInputRef = React.useRef<HTMLInputElement>(null);
  const [fieldPopoverOpen, setFieldPopoverOpen] = React.useState(false);
  const { items: fieldSuggestionItems } = useSuggestions(
    fieldPopoverOpen ? suggestionContext : null,
    node.field,
    { fieldSources: DEFAULT_FIELD_SOURCES },
  );

  const opInputRef = React.useRef<HTMLInputElement>(null);
  const [opPopoverOpen, setOpPopoverOpen] = React.useState(false);
  const opSuggestionCtx = React.useMemo<SuggestionContext | null>(
    () => (suggestionContext ? { ...suggestionContext, operatorContext: 'matchKey' } : null),
    [suggestionContext],
  );
  // The op box is a draft until it's finished: typing writes here, not
  // to `node.op`, so a half-typed operator never reaches `printFilter` and
  // never turns on the "not applied" banner or the red border mid-keystroke.
  // `null` means "no draft" (nothing typed since the last commit); the box
  // then shows the committed `node.op`.
  const [opDraft, setOpDraft] = React.useState<string | null>(null);
  const opValue = opDraft ?? node.op;
  const { items: opSuggestionItems } = useSuggestions(
    opPopoverOpen ? opSuggestionCtx : null,
    opValue,
    { fieldSources: [fieldOperatorSource] },
  );

  // Value suggestions: gated on a non-empty field and one of
  // `VALUE_SUGGESTION_OPS` — every other op (`$exists`, `$regex`, `$mod`, ...)
  // gets no popover, mirroring what `RecentFieldValueService` will ever
  // record for it.
  const valueInputRef = React.useRef<HTMLInputElement>(null);
  const [valuePopoverOpen, setValuePopoverOpen] = React.useState(false);
  const valueSuggestionsAllowed = node.field.trim() !== '' && VALUE_SUGGESTION_OPS.has(node.op);
  const valueSuggestionCtx = React.useMemo<SuggestionContext | null>(
    () =>
      suggestionContext && valueSuggestionsAllowed
        ? { ...suggestionContext, target: { field: node.field, operator: node.op } }
        : null,
    [suggestionContext, valueSuggestionsAllowed, node.field, node.op],
  );
  const { items: valueSuggestionItems } = useSuggestions(
    valuePopoverOpen ? valueSuggestionCtx : null,
    node.value,
    { valueSources: DEFAULT_VALUE_SOURCES },
  );

  const patch = (p: Partial<CondNode>) => applyEdit(updateAt(root, path, { ...node, ...p }));
  const rowDrop = useRowDropHandlers(node, path, root, applyEdit, readOnly, activeDropPath, setActiveDropPath);

  // ADR 0004's scope note — a typed symbol becomes its operator on blur, never
  // per keystroke: `>` is a prefix of `>=`, so a keystroke map would convert
  // `>` before the user reaches the `=`. Blur is also X14's commit point for
  // Shell Syntax, so the builder and the Filter Bar settle at the same moment.
  //
  // The box keeps showing `$gt` afterwards. `node.op` therefore always holds a
  // real operator and `printFilter` / `isCompilableOp` are untouched.
  //
  // The popover guard below is defence rather than a live fix: the ranker
  // currently returns zero rows while the box holds a bare symbol, so there is
  // no row to click and no clobber to have. It costs three lines and it is the
  // only thing standing between a future ranking change and a wrong operator.
  const symbolResolvedByPopover = React.useRef(false);
  // Commits the draft (if any) to `node.op` — the point the banner/border can
  // finally turn on, since `patch` is what feeds `printFilter`. A suggestion
  // pick already patched directly (`onSelect` below) and cleared the draft,
  // so the popover guard here just means "nothing left to commit".
  // Escape sets this ref (not just state) because the keydown handler blurs
  // the input in the same tick — the blur listener below runs against the
  // still-stale `opDraft` closure before React re-renders, so a state-only
  // revert would race and re-commit the very draft it just discarded.
  const opDraftRevertedRef = React.useRef(false);
  const commitOpDraft = () => {
    if (opDraftRevertedRef.current) {
      opDraftRevertedRef.current = false;
      return;
    }
    if (symbolResolvedByPopover.current) {
      symbolResolvedByPopover.current = false;
      return;
    }
    if (opDraft === null) return;
    const resolved = resolveOperatorSymbol(opDraft);
    patch({ op: resolved ?? opDraft });
    setOpDraft(null);
  };
  // Escape is the box's own cancel — it discards the draft and falls back to
  // the last-committed op, the same "undo the in-progress edit" contract
  // Shell Syntax's fields already give the user.
  const revertOpDraft = () => {
    opDraftRevertedRef.current = true;
    setOpDraft(null);
  };

  /**
   * Enter is the other way a person finishes typing an operator, and blur
   * alone missed it: `>` then Enter left `>` in the box and the row
   * unprintable, on the one keystroke that reads as "done".
   *
   * Three keys deliberately excluded:
   *
   * - An Enter the popover already consumed. It `preventDefault`s when an
   *   arrowed-into row is picked, and its listener is native and bound to
   *   this input, so it runs before React's root-delegated handler and
   *   `defaultPrevented` is already true here. Without the check, arrowing to
   *   `$in` over a typed `>` would land `$gt`.
   * - ⌘/Ctrl+Enter, which the Documents view's tab-wide handler runs the
   *   query on (`PanelBody`). Resolving
   *   first would show `$gt` in the box while the run still used the
   *   last-committed filter — the state has not re-rendered. Leaving it alone
   *   keeps the row visibly unfinished, which is the truth.
   */
  const handleOpKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      revertOpDraft();
      opInputRef.current?.blur();
      return;
    }
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
    commitOpDraft();
  };
  const remove = () => applyEdit(removeAt(root, path));
  const wrap = () => applyEdit(wrapInGroup(root, path, '$and'));
  const duplicate = () => applyEdit(insertAt(root, path.slice(0, -1), { ...node }));
  const move = (delta: number) => moveRowKeepingFocus(root, path, delta, applyEdit);
  // Converts on the *typed* op, not only the committed one: `toRawNode` falls
  // back to a blank pending raw node whenever the op is uncompilable (below),
  // regardless of which uncompilable text it was given, so a still-drafted
  // `$elemMatch` converts the same as a committed one would.
  const convertToRaw = () => applyEdit(updateAt(root, path, toRawNode({ ...node, op: opValue })));

  // §6 — typing an unmodelled op (e.g. $elemMatch) is no longer a dead end:
  // offer a one-click escape to a raw clause the instant the op looks
  // unencodable, independent of whether the row currently has a print
  // problem (a pending row with an empty field never has one — §5.4). Keyed
  // on the draft (`opValue`), not the committed `node.op` — the whole point
  // is not waiting for a commit that would otherwise never come for text
  // like `$elemMatch`.
  const showConvertToRaw = opValue.startsWith('$') && !isCompilableOp(opValue);
  const showOpDocs = node.op.startsWith('$') && !problem && hasOperatorDocs(node.op, 'query');

  // The row's one Remove control names what it removes. A row whose field is
  // still blank has nothing to name, so it keeps the bare label rather than
  // reading `Remove condition ""`.
  const removeLabel = node.field.trim()
    ? `Remove condition ${node.field}`
    : 'Remove condition';

  return (
    <div
      onDragOver={rowDrop.onDragOver}
      onDrop={rowDrop.onDrop}
      data-row-path={pathKey(path)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        marginBottom: 8,
        borderRadius: T.rs,
        background: rowDrop.isActive ? T.accentSoft : undefined,
        boxShadow: rowDrop.isActive ? `inset 0 0 0 1.5px ${T.accent}` : undefined,
        transition: 'background 120ms, box-shadow 120ms',
      }}
    >
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <TextInput
          ref={fieldInputRef}
          placeholder="field"
          value={node.field}
          disabled={readOnly}
          onChange={(e) => {
            patch({ field: e.target.value });
            if (!fieldPopoverOpen) setFieldPopoverOpen(true);
          }}
          onFocus={() => setFieldPopoverOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setFieldPopoverOpen(false), 100);
          }}
          size="xs"
          style={{ flex: 1 }}
        />
        <SuggestionPopover
          open={fieldPopoverOpen}
          items={fieldSuggestionItems}
          anchorRef={fieldInputRef}
          onSelect={(s) => {
            if (s.kind === 'field') {
              const nextValType = valTypeFromDisplayType(s.type);
              const nextOp = opForValType(nextValType, node.op);
              patch({ field: s.path, valType: nextValType, op: nextOp });
            }
            setFieldPopoverOpen(false);
            fieldInputRef.current?.blur();
          }}
          onClose={() => setFieldPopoverOpen(false)}
        />
        <TextInput
          ref={opInputRef}
          placeholder="$op"
          value={opValue}
          disabled={readOnly}
          onChange={(e) => {
            setOpDraft(e.target.value);
            if (!opPopoverOpen) setOpPopoverOpen(true);
          }}
          onFocus={() => setOpPopoverOpen(true)}
          onKeyDown={handleOpKeyDown}
          onBlur={() => {
            commitOpDraft();
            window.setTimeout(() => setOpPopoverOpen(false), 100);
          }}
          aria-invalid={!!problem}
          title={problem ?? undefined}
          error={!!problem}
          size="xs"
          style={{ width: 100, flexShrink: 0 }}
          styles={{ input: { fontFamily: 'monospace' } }}
        />
        <SuggestionPopover
          open={opPopoverOpen}
          items={opSuggestionItems}
          anchorRef={opInputRef}
          label="Operator suggestions"
          onSelect={(s) => {
            if (s.kind === 'operator') {
              // The popover blurs the input on its way out, so the blur
              // handler runs next — against the *stale* `node.op`, because
              // this patch has not rendered yet. Without the flag, choosing
              // `$in` after typing `>` would land `$gt`: two patches in one
              // tick, and `patch` spreads a stale `node` rather than taking a
              // functional update.
              symbolResolvedByPopover.current = true;
              patch({ op: s.name });
              // A pick is itself a commit (per the issue's fix shape) — clear
              // the draft so the box falls back to `node.op` (about to become
              // `s.name`) instead of showing the typed text the pick replaced.
              setOpDraft(null);
            }
            setOpPopoverOpen(false);
            opInputRef.current?.blur();
          }}
          onClose={() => setOpPopoverOpen(false)}
        />
        {showOpDocs && (
          <OperatorTooltip name={node.op} prefClass="query" placement="below">
            <button
              type="button"
              aria-label={`Documentation for ${node.op}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: `1px solid ${T.border}`,
                background: 'none',
                padding: 0,
                margin: 0,
                font: 'inherit',
                color: T.textGhost,
                fontSize: 10,
                fontWeight: 600,
                cursor: 'help',
                flexShrink: 0,
                userSelect: 'none',
              }}
            >
              ?
            </button>
          </OperatorTooltip>
        )}
        <RowMenu
          ariaLabel="Condition options"
          disabled={readOnly}
          onConvertToRaw={convertToRaw}
          onWrap={wrap}
          onDuplicate={duplicate}
          onMove={move}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          rowKey={pathKey(path)}
        />
        <Tooltip label={removeLabel} withArrow>
          <ActionIcon
            variant="default"
            color="red"
            size="sm"
            disabled={readOnly}
            onClick={remove}
            aria-label={removeLabel}
          >
            {I.close}
          </ActionIcon>
        </Tooltip>
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Select
          value={node.valType}
          disabled={readOnly}
          onChange={(value) => {
            if (!value) return;
            const vt = value as ValType;
            const nextOps = FIELD_OPS[vt] ?? FIELD_OPS.string;
            const op = (nextOps as readonly string[]).includes(node.op)
              ? node.op
              : (nextOps[0] ?? '$eq');
            patch({ valType: vt, op });
          }}
          aria-label="Value type"
          data={VAL_TYPES.map((vt) => ({ label: vt, value: vt }))}
          size="xs"
          allowDeselect={false}
          withCheckIcon={false}
          style={{ width: 88, flexShrink: 0 }}
          styles={{
            input: {
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: T.textMuted,
            },
          }}
        />
        {node.op !== '$exists' && (
          <>
            <TextInput
              ref={valueInputRef}
              placeholder="value"
              value={node.value}
              disabled={readOnly}
              onChange={(e) => {
                patch({ value: e.target.value });
                if (!valuePopoverOpen) setValuePopoverOpen(true);
              }}
              onFocus={() => setValuePopoverOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setValuePopoverOpen(false), 100);
              }}
              size="xs"
              style={{ flex: 1 }}
              styles={{ input: { fontFamily: 'monospace' } }}
            />
            {valueSuggestionsAllowed && (
              <SuggestionPopover
                open={valuePopoverOpen}
                items={valueSuggestionItems}
                anchorRef={valueInputRef}
                label="Value suggestions"
                onSelect={(s) => {
                  if (s.kind === 'value') patch({ value: s.display });
                  setValuePopoverOpen(false);
                  valueInputRef.current?.blur();
                }}
                onClose={() => setValuePopoverOpen(false)}
              />
            )}
            <Tooltip label={formatCondPreview(node)} withArrow>
              <span
                style={{
                  fontSize: 9,
                  color: T.textGhost,
                  fontFamily: '"JetBrains Mono", monospace',
                  flexShrink: 0,
                  maxWidth: 90,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatCondPreview(node)}
              </span>
            </Tooltip>
          </>
        )}
      </div>

      {showConvertToRaw && (
        <Button
          variant="subtle"
          color="yellow"
          size="compact-xs"
          disabled={readOnly}
          onClick={convertToRaw}
          styles={{ root: { alignSelf: 'flex-start', fontSize: 10, padding: '0 4px' } }}
        >
          Convert to raw clause
        </Button>
      )}

      {problem && (
        <span role="alert" style={{ fontSize: 10, color: T.warn, lineHeight: 1.3 }}>
          {problem}
        </span>
      )}
    </div>
  );
}

function RawRow({
  node,
  path,
  root,
  applyEdit,
  problem,
  readOnly,
  activeDropPath,
  setActiveDropPath,
  canMoveUp,
  canMoveDown,
}: TreeEditProps & RowMoveProps & {
  node: RawNode;
  path: NodePath;
  problem: string | undefined;
}) {
  const T = themeVars;
  const patchJson = (json: string) => applyEdit(updateAt(root, path, { ...node, json }));
  const remove = () => applyEdit(removeAt(root, path));
  const wrap = () => applyEdit(wrapInGroup(root, path, '$and'));
  const duplicate = () => applyEdit(insertAt(root, path.slice(0, -1), { ...node }));
  const move = (delta: number) => moveRowKeepingFocus(root, path, delta, applyEdit);
  const tryParse = () => applyEdit(updateAt(root, path, tryParseRaw(node)));
  const rowDrop = useRowDropHandlers(node, path, root, applyEdit, readOnly, activeDropPath, setActiveDropPath);

  return (
    <div
      onDragOver={rowDrop.onDragOver}
      onDrop={rowDrop.onDrop}
      data-row-path={pathKey(path)}
      style={{
        border: `1px solid ${rowDrop.isActive ? T.accent : T.border}`,
        borderRadius: T.rs,
        padding: 6,
        marginBottom: 8,
        background: rowDrop.isActive ? T.accentSoft : T.surfaceRaised,
        boxShadow: rowDrop.isActive ? `inset 0 0 0 1.5px ${T.accent}` : undefined,
        transition: 'background 120ms, box-shadow 120ms, border-color 120ms',
      }}
    >
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
        <textarea
          value={node.json}
          disabled={readOnly}
          onChange={(e) => patchJson(e.target.value)}
          placeholder='raw clause, e.g. {"items":{"$elemMatch":{"sku":1}}}'
          aria-label="Raw clause"
          spellCheck={false}
          rows={2}
          style={{
            flex: 1,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            padding: '4px 6px',
            border: `1px solid ${problem ? T.warn : T.border}`,
            borderRadius: T.rx,
            background: T.bg,
            color: T.text,
            resize: 'vertical',
            outline: 'none',
          }}
        />
        <RowMenu
          ariaLabel="Raw clause options"
          disabled={readOnly}
          onWrap={wrap}
          onDuplicate={duplicate}
          onMove={move}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          rowKey={pathKey(path)}
        />
        <Tooltip label="Remove raw clause" withArrow>
          <ActionIcon
            variant="default"
            color="red"
            size="sm"
            disabled={readOnly}
            onClick={remove}
            aria-label="Remove raw clause"
          >
            {I.close}
          </ActionIcon>
        </Tooltip>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <Button variant="subtle" size="compact-xs" disabled={readOnly} onClick={tryParse}>
          Try to parse
        </Button>
        {problem && (
          <span role="alert" style={{ fontSize: 10, color: T.warn, lineHeight: 1.3 }}>
            {problem}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupView({
  node,
  path,
  root,
  applyEdit,
  problems,
  readOnly,
  activeDropPath,
  setActiveDropPath,
  isRoot,
  suggestionContext,
}: TreeEditProps & {
  node: GroupNode;
  path: NodePath;
  problems: NodeProblem[];
  isRoot: boolean;
  suggestionContext: SuggestionContext | null;
}) {
  const T = themeVars;

  // Drop-target resolution lives here, on the group itself, rather than on
  // a pane-level wrapper. `path` is this group's own NodePath, so a drop
  // always inserts as a child of the exact group the cursor is over.
  // Bubbling + `stopPropagation()` on dragOver/drop is what gives the
  // innermost group priority: a nested GroupView's div sits inside its
  // parent's, so the deepest one under the cursor is the DOM event target
  // and claims the event before it ever reaches the parent's own handler —
  // no coordinate/geometry hit-testing needed.
  //
  // Highlighting reads `activeDropPath` (see `TreeEditProps`) rather than a
  // group-local on/off flag — a `dragLeave`-based guard here is an easy
  // place to get an edge case wrong. With one shared value, a nested
  // row/group's own `onDragOver` claiming it is what un-highlights this
  // group; nothing here has to detect the hand-off.
  const key = pathKey(path);
  const isActive = activeDropPath === key;
  const canAcceptDrop = (e: React.DragEvent): boolean =>
    !readOnly && e.dataTransfer.types.includes(DRAGGED_FIELD_MIME);
  const handleDragOver = (e: React.DragEvent) => {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (activeDropPath !== key) setActiveDropPath(key);
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveDropPath(null);
    const raw = e.dataTransfer.getData(DRAGGED_FIELD_MIME);
    if (!raw) return;
    let dragged: DraggedField;
    try {
      dragged = JSON.parse(raw) as DraggedField;
    } catch {
      return;
    }
    // A dragged field can legitimately hold `undefined` (BSON's Undefined
    // type) — `DocFieldTree`'s drag source now guards against starting
    // such a drag at all, but this is defense in depth for any other
    // payload source, since `condFromDragged` crashes downstream on one.
    if (typeof dragged.field !== 'string' || !dragged.field || dragged.value === undefined) return;
    applyEdit(insertAt(root, path, condFromDragged(dragged)));
  };

  const addCondition = () => {
    const cond: CondNode = { kind: 'cond', field: '', op: '$eq', valType: 'string', value: '' };
    applyEdit(insertAt(root, path, cond));
  };
  const addGroup = () => {
    const group: GroupNode = { kind: 'group', logic: '$and', children: [] };
    applyEdit(insertAt(root, path, group));
  };
  const addRaw = () => {
    const raw: RawNode = { kind: 'raw', json: '' };
    applyEdit(insertAt(root, path, raw));
  };
  const setLogic = (logic: GroupNode['logic']) => applyEdit(updateAt(root, path, { ...node, logic }));
  const removeGroup = () => applyEdit(removeAt(root, path));

  const problemFor = (childPath: NodePath): string | undefined =>
    problems.find((p) => pathsEqual(p.path, childPath))?.message;

  // Depth cue: the accent left border fades toward the plain border colour
  // one level at a time, so a group at depth 4 doesn't read the same as one
  // at depth 1. The cue is colour only: it rides the left border a group
  // already has, adding no indentation of its own on top of the group's own
  // padding. Floored at 40% so depth 8 is still a border and not a blank edge.
  const depthAccent = `color-mix(in srgb, ${T.accent} ${Math.max(100 - (path.length - 1) * 20, 40)}%, ${T.border})`;

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      // Only the root carries this label: it's the pane's original,
      // still-tested accessible name (filter-tree-drawer.spec.tsx), kept as
      // the whole-pane fallback description. Nested groups are identified
      // for tests by `data-group-path` instead of a second, ambiguous label.
      aria-label={isRoot ? 'Drop a field here to add a condition' : undefined}
      data-group-path={pathKey(path)}
      style={
        isRoot
          ? {
              // The root's own box owns the pane's drop highlight, filling
              // the same visible area as the outer drawer wrapper, so no
              // drop can land outside every group's DOM node.
              background: isActive ? T.accentSoft : undefined,
              boxShadow: isActive ? `inset 0 0 0 1.5px ${T.accent}` : undefined,
              transition: 'background 120ms, box-shadow 120ms',
            }
          : {
              border: `1px solid ${isActive ? T.accent : T.border}`,
              borderRadius: T.rs,
              padding: '6px 8px',
              marginBottom: 8,
              // Two declarations, not one shorthand: if a runtime can't parse
              // the `color-mix`, only the colour override is dropped and the
              // border falls back to a flat accent instead of disappearing.
              borderLeft: `3px solid ${T.accent}`,
              borderLeftColor: isActive ? T.accent : depthAccent,
              background: isActive ? T.accentSoft : undefined,
              transition: 'background 120ms, border-color 120ms',
            }
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: isRoot ? '7px 10px' : '0 0 6px',
          borderBottom: isRoot ? `1px solid ${T.border}` : 'none',
        }}
      >
        <LogicPicker value={node.logic} onChange={setLogic} disabled={readOnly} />
        <Tooltip label="Add condition" withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            disabled={readOnly}
            onClick={addCondition}
            aria-label="Add condition"
          >
            {I.plus}
          </ActionIcon>
        </Tooltip>
        {/* Three add buttons, three glyphs. "Add condition" keeps the plus;
            the nested group takes parentheses (how a boolean group is
            written); `<>` moves to the raw clause, the only one of the
            three it actually describes. */}
        <Tooltip label="Add nested group" withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            disabled={readOnly}
            onClick={addGroup}
            aria-label="Add group"
          >
            {I.group}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Add raw clause" withArrow>
          <ActionIcon
            variant="default"
            size="sm"
            disabled={readOnly}
            onClick={addRaw}
            aria-label="Add raw clause"
          >
            {I.code}
          </ActionIcon>
        </Tooltip>
        <span style={{ flex: 1 }} />
        {!isRoot && (
          <Tooltip label="Remove group" withArrow>
            <ActionIcon
              variant="default"
              color="red"
              size="sm"
              disabled={readOnly}
              onClick={removeGroup}
              aria-label="Remove group"
            >
              {I.close}
            </ActionIcon>
          </Tooltip>
        )}
      </div>
      <div style={{ padding: isRoot ? '6px 10px 4px' : 0 }}>
        {/* Say what an empty tree's state means and what to do about it, in
            words, rather than leaving a radiogroup and three icon buttons
            over blank space — but not while the tree is frozen read-only
            (§6a), where the empty root is the *unparsed* bar's doing and
            "matches every document" would be a lie sitting directly under
            the banner saying the filter text is invalid. */}
        {isRoot && !readOnly && node.children.length === 0 && (
          <p style={{ margin: '4px 0 6px', fontSize: 11, color: T.textMuted, lineHeight: 1.45 }}>
            No conditions yet — this filter matches every document. Add a
            condition to narrow it down, or drag a field in from the results;
            the query bar above shows the same filter as text.
          </p>
        )}
        {node.children.map((child, i) => {
          const childPath = [...path, i];
          const key = pathKey(childPath);
          if (child.kind === 'group') {
            return (
              <GroupView
                key={key}
                node={child}
                path={childPath}
                root={root}
                applyEdit={applyEdit}
                problems={problems}
                readOnly={readOnly}
                activeDropPath={activeDropPath}
                setActiveDropPath={setActiveDropPath}
                isRoot={false}
                suggestionContext={suggestionContext}
              />
            );
          }
          if (child.kind === 'cond') {
            return (
              <CondRow
                key={key}
                node={child}
                path={childPath}
                root={root}
                applyEdit={applyEdit}
                readOnly={readOnly}
                activeDropPath={activeDropPath}
                setActiveDropPath={setActiveDropPath}
                problem={problemFor(childPath)}
                suggestionContext={suggestionContext}
                canMoveUp={i > 0}
                canMoveDown={i < node.children.length - 1}
              />
            );
          }
          return (
            <RawRow
              key={key}
              node={child}
              path={childPath}
              root={root}
              applyEdit={applyEdit}
              readOnly={readOnly}
              activeDropPath={activeDropPath}
              setActiveDropPath={setActiveDropPath}
              problem={problemFor(childPath)}
              canMoveUp={i > 0}
              canMoveDown={i < node.children.length - 1}
            />
          );
        })}
        {/* With nested groups it's hard to tell which group a drop would
            land in from the whole-group highlight alone, since that only
            lights up once a field is already over it. This strip gives
            every group (root and nested) its own always-visible, bounded
            target: it's inside this group's own DOM, so hovering it lights
            up exactly this group's own `isActive` and no other. It bubbles
            straight to this group's own onDrop — no row sits between it and
            the group — but a drag released anywhere else over a non-empty
            group (the far more likely spot, since a thin unlabeled strip is
            easy to miss among the rows above it) lands on a row's own
            handler and silently replaces it instead of adding a sibling.
            Taller + labeled as "+ Add condition" instead of a bare "+" so it
            reads as the deliberate target it is, not release-anywhere-and-
            hope. `title` is still worth setting even though the div is
            `aria-hidden` — hover tooltips read `title` independent of the
            accessibility tree; a screen-reader user has the keyboard-
            reachable "Add condition" button above for the same result. */}
        {!readOnly && (
          <div
            aria-hidden
            title={`Drop a field here to add a condition to this ${isRoot ? 'filter' : 'group'}`}
            style={{
              textAlign: 'center',
              fontSize: 11,
              lineHeight: '28px',
              height: 28,
              marginTop: node.children.length === 0 ? 0 : 4,
              borderRadius: T.rs,
              border: `1px dashed ${isActive ? T.accent : T.border}`,
              color: isActive ? T.accent : T.textMuted,
              transition: 'border-color 120ms, color 120ms',
            }}
          >
            + Add condition
          </div>
        )}
      </div>
    </div>
  );
}

interface FilterDrawerProps {
  queryRaw: string;
  onCommit: (patch: { queryRaw: string }) => void;
  suggestionContext: SuggestionContext | null;
}

/**
 * Names the rows behind the "N not applied" banner — a condition by its
 * field, a raw clause by what it is — rather than leaving a bare count that's
 * unfindable once the offending row scrolls out of view in a deep tree.
 * `printNode` returns `pending` for a blank field *before* it can raise a
 * problem, so every condition problem is guaranteed a non-blank name.
 */
function problemLabels(root: GroupNode, problems: NodeProblem[]): string[] {
  const seen = new Set<string>();
  for (const p of problems) {
    const node = nodeAt(root, p.path);
    seen.add(node && node.kind === 'cond' ? node.field : 'raw clause');
  }
  return [...seen];
}

function seedTree(text: string): { root: GroupNode; readOnly: boolean } {
  const parsed = parseFilter(text);
  return parsed.ok ? { root: parsed.root, readOnly: false } : { root: EMPTY_ROOT, readOnly: true };
}

/**
 * The recursive filter-tree editor (W13 §5, §6). A *view* of `queryRaw`, not
 * its own source of truth: the local `root` is only ever seeded from
 * `queryRaw` (on mount, and again whenever `queryRaw` changes from outside
 * this component — §5.3's reconcile rule) and only ever written back to
 * `queryRaw` through `printFilter`'s fail-closed gate.
 *
 * Remounted (fresh `root`/`lastPrinted`/`problems`) whenever the caller
 * changes this component's `key` — done for the tab id (§5.6: two tabs
 * commonly share `queryRaw: '{}'`, so text equality alone can't detect a
 * tab switch) and for each Reset / Saved / Recent load (§5.3's other
 * external-edit triggers), which may coincidentally write the same text
 * the drawer already holds and so wouldn't otherwise be seen as a change.
 */
function FilterDrawer({ queryRaw, onCommit, suggestionContext }: FilterDrawerProps) {
  const T = themeVars;
  const [tree, setTree] = React.useState(() => seedTree(queryRaw));
  const [problems, setProblems] = React.useState<NodeProblem[]>([]);
  // The text this component itself last wrote (or last reconciled against)
  // — state, not a ref, so the reconcile check below (React's sanctioned
  // "derive state from a changed prop" pattern, see react.dev) can read and
  // update it during render without tripping the no-refs-during-render rule.
  const [lastPrinted, setLastPrinted] = React.useState(queryRaw);
  const [activeDropPath, setActiveDropPath] = React.useState<string | null>(null);

  // Single global catch-all for "the drag ended without landing anywhere I
  // control" — cancelled, dropped outside the window, Escape — covering
  // every group/row at once. A per-scope `dragLeave` guard is an easy place
  // to get this wrong, since `dragleave` fires on target change like
  // `mouseout` and its `relatedTarget` doesn't reliably distinguish a real
  // exit from a hand-off to a nested drop target. `dragend` fires once, on
  // the drag source, when the operation terminates for any reason, and
  // bubbles to `document` regardless of where in the tree the pointer last
  // was.
  React.useEffect(() => {
    const clear = () => setActiveDropPath(null);
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, []);

  // §5.3 reconcile rule: only re-seed when `queryRaw` differs from the text
  // this component itself last wrote — that's what lets a pending row
  // survive a same-tab re-render while still following a bar edit /
  // Saved-Recent load / Reset. Adjusted directly in the render body rather
  // than in an effect, so there's no stale-tree frame before the reseed
  // lands.
  if (queryRaw !== lastPrinted) {
    setLastPrinted(queryRaw);
    const parsed = parseFilter(queryRaw);
    if (parsed.ok) {
      setTree({ root: parsed.root, readOnly: false });
      setProblems([]);
    } else {
      // §6a — invalid JSON in the bar freezes the drawer read-only on the
      // last valid tree rather than blanking it.
      setTree((prev) => ({ root: prev.root, readOnly: true }));
    }
  }

  const applyEdit = (nextRoot: GroupNode) => {
    setTree({ root: nextRoot, readOnly: false });
    const printed = printFilter(nextRoot);
    if (printed.ok) {
      setProblems([]);
      // §5.4 — a pending row (empty field / blank raw json) prints to the
      // same text as before it was added; skip the no-op commit so
      // "+ Condition" / "+ Raw" truly leaves `queryRaw` untouched.
      if (printed.json !== lastPrinted) {
        setLastPrinted(printed.json);
        onCommit({ queryRaw: printed.json });
      }
    } else {
      // §5.5 — print failed: keep the edit in the local tree, surface the
      // message on the offending row, leave `queryRaw` at its last good
      // value (we simply don't call onCommit).
      setProblems(printed.problems);
    }
  };

  return (
    <div
      // Per-group targeting resolves drops on each GroupView (root
      // included), which renders below the two banners in this div. A drop
      // landing exactly on a banner never reaches GroupView's own handler,
      // since it's a sibling, not an ancestor — that leaves a dead zone the
      // root GroupView's `stopPropagation()` doesn't cover, and ADR 0007
      // states no drop should be able to land outside every group's DOM
      // node. This wrapper is the fallback: it only ever sees a drop
      // GroupView didn't already claim and stop, so it always means the
      // root group.
      onDragOver={(e) => {
        if (tree.readOnly || !e.dataTransfer.types.includes(DRAGGED_FIELD_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // Reaching this handler at all means no GroupView's own
        // `stopPropagation()`'d handler claimed the event first — the
        // pointer is over a banner or the wrapper's own padding, a dead
        // zone that still means "root" per the fallback below.
        if (activeDropPath !== 'root') setActiveDropPath('root');
      }}
      onDrop={(e) => {
        if (tree.readOnly || !e.dataTransfer.types.includes(DRAGGED_FIELD_MIME)) return;
        e.preventDefault();
        setActiveDropPath(null);
        const raw = e.dataTransfer.getData(DRAGGED_FIELD_MIME);
        if (!raw) return;
        let dragged: DraggedField;
        try {
          dragged = JSON.parse(raw) as DraggedField;
        } catch {
          return;
        }
        // A dragged field can legitimately hold `undefined` (BSON's Undefined
      // type) — `DocFieldTree`'s drag source now guards against starting
      // such a drag at all, but this is defense in depth for any other
      // payload source, since `condFromDragged` crashes downstream on one.
      if (typeof dragged.field !== 'string' || !dragged.field || dragged.value === undefined) return;
        applyEdit(insertAt(tree.root, [], condFromDragged(dragged)));
      }}
      style={{
        border: `1.5px solid ${T.border}`,
        borderRadius: T.r,
        background: T.bg,
        overflow: 'hidden',
      }}
    >
      {problems.length > 0 && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            padding: '4px 10px',
            color: T.redText,
            background: T.redSoft,
            borderBottom: `1px solid ${T.redBorder}`,
          }}
        >
          ⚠ {problems.length} not applied: {problemLabels(tree.root, problems).join(', ')}
        </div>
      )}
      {tree.readOnly && (
        <div
          role="alert"
          style={{
            fontSize: 10,
            padding: '4px 10px',
            color: T.textMuted,
            background: T.surfaceRaised,
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          Filter text isn&apos;t valid JSON — the tree below is the last valid version.
        </div>
      )}
      <GroupView
        node={tree.root}
        path={[]}
        root={tree.root}
        applyEdit={applyEdit}
        problems={problems}
        readOnly={tree.readOnly}
        activeDropPath={activeDropPath}
        setActiveDropPath={setActiveDropPath}
        isRoot
        suggestionContext={suggestionContext}
      />
    </div>
  );
}

function BuilderPaneInner({
  savedRefreshKey,
  onOpenInTab,
}: BuilderPaneProps) {
  const T = themeVars;
  const { state, actions, meta } = useCollectionWorkspace();
  const { connectionId, dbName, collection } = meta;
  const onPatch = actions.patch;
  const onRun = actions.run;

  // Bumped on Reset / Saved-run / Recent-run — the external-edit triggers of
  // §5.3 that may (coincidentally) write the same `queryRaw` text the drawer
  // already holds, which the drawer's own text-diff reconcile can't detect.
  // Folded into FilterDrawer's `key` (with the tab id, §5.6) so these always
  // force a fresh seed + drop any pending rows, the same as a genuine text
  // change would.
  const [loadGen, setLoadGen] = React.useState(0);

  const activeTab = state.activeBuilderTab;

  const suggestionContext = React.useMemo<SuggestionContext | null>(() => {
    if (!connectionId || !dbName || !collection) return null;
    return {
      connectionId,
      dbName,
      collection,
      recentDocs: state.lastRun?.documents,
    };
  }, [connectionId, dbName, collection, state.lastRun?.documents]);

  const setActiveTab = (tab: BuilderTab) => {
    onPatch({ activeBuilderTab: tab });
  };

  // Reproduces the query as actually run, not the user's raw inputs: same
  // skip/limit split `useQueryRunner` computes from the page
  // (`effectivePageLimit`), same projection and sort it hands to
  // `api.query.find` — so the copied command matches the page on screen.
  const handleCopyCode = () => {
    // Refused through the same `findProblem` the Run button gates on: one
    // rule for "is this query runnable", not a copy-path opinion beside it.
    // An unparseable filter, sort, or raw projection copies nothing rather
    // than verbatim text that won't run — the notification names the
    // clause rather than saying the copy failed, since the clipboard is
    // working fine; the query is not.
    const problem = findProblem(state);
    if (problem) {
      notify.error(`Nothing copied — ${problem}`);
      return;
    }
    const opts = compileFindOptions(state.builder);
    const { skip, limit } = effectivePageLimit(opts.limit, state.page, state.pageSize);
    // A `limit` of 0 means the page is past the user's cap and the runner
    // short-circuits to an empty result (`useQueryRunner.ts:143`) — there is
    // no `find` that reproduces that, so there is nothing to copy.
    //
    // A `.limit(0)` reads to the driver as "no limit", not zero — so
    // emitting one here to represent an exhausted page would paste an
    // *unbounded* cursor while the app itself shows zero rows: a
    // full-collection scan hiding behind code that looks like it matches
    // the screen. Refused, like every other unrunnable state above it,
    // rather than emitted with an explanatory comment attached — a comment
    // does not disarm the expression in front of it.
    if (limit <= 0) {
      notify.error(
        'Nothing copied — this page is past the limit, so the query returns no documents.',
      );
      return;
    }
    const parts = [`db.${collection}.find(${state.queryRaw}`];
    if (opts.projection) parts[0] += `, ${opts.projection}`;
    parts[0] += ')';
    if (opts.sort) parts.push(`.sort(${opts.sort})`);
    if (skip > 0) parts.push(`.skip(${skip})`);
    parts.push(`.limit(${limit})`);
    void copyToClipboard(parts.join(''), 'Command copied to the clipboard');
  };

  // Reset sits in the footer beside Save and can discard a tree that
  // represents arbitrarily much work, so it goes through a confirm rather
  // than wiping the whole tree and `queryRaw` on one click with no recovery.
  // Undo on the tree (§14.6) would be the better long-run answer and is its
  // own feature; a confirm is what closes the hole today.
  // `confirmDestructive` is the one confirm the app has, not a fourth
  // hand-rolled dialog.
  const handleReset = () => {
    void confirmDestructive({
      title: 'Reset this query?',
      body: (
        <span style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
          This clears the filter — every condition, group and raw clause — back
          to <code>{'{}'}</code>, along with the sort, limit and projection.
          It cannot be undone.
        </span>
      ),
      confirmLabel: 'Reset',
    }).then((proceed) => {
      if (!proceed) return;
      const empty: BuilderState = emptyBuilder();
      onPatch({ builder: empty, queryRaw: '{}' });
      setLoadGen((g) => g + 1);
    });
  };

  /**
   * Hydrate a stored find payload (saved or recent) into a builder patch —
   * the single call site for the W13-2 shim (spec §8). `queryRaw` when
   * present, else the pre-W13 filter compiled from `builder.conditions` via
   * the frozen `legacyCompileFilter`. Sort/limit/projection are copied
   * explicitly into the shrunk `BuilderState` shape (§8.4) rather than
   * passed through wholesale — the legacy `builder` also carries
   * `conditions`/`logic`, which the live type no longer has room for.
   *
   * `payload` is typed against `LegacySavedFindPayload`, not the live
   * `SavedFindPayload`, on purpose: if the live type's `queryRaw` is ever
   * made required, an annotation borrowed from that type would let
   * TypeScript "prove" the `??` fallback below unreachable and invite
   * deleting it — reintroducing the exact data loss this shim exists to
   * prevent for every find saved before `queryRaw` existed. The wire's IPC
   * schema validates saved/recent payloads loosely (`z.record`), so a
   * pre-`queryRaw` row really can arrive shaped like `LegacySavedFindPayload`
   * despite the live `SavedQuery`/`RecentQuery` types claiming otherwise —
   * that mismatch is exactly what this cast bridges.
   */
  const hydrateFindPayload = (
    payload: LegacySavedFindPayload,
  ): { builder: BuilderState; queryRaw: string } => {
    // `payload.builder` is typed required, but this reads data straight off
    // the wire (validated only as `z.record(z.string(), z.unknown())`, §8.3)
    // — a row missing it entirely isn't ruled out. Fall back to an empty
    // legacy builder (no conditions → `legacyCompileFilter` produces '{}')
    // rather than throwing inside a click handler with no feedback.
    const legacyBuilder: LegacyBuilderState = payload.builder ?? {
      conditions: [],
      logic: 'AND',
      sort: state.builder.sort,
      limit: state.builder.limit,
      projection: state.builder.projection,
    };
    const { sort, limit, projection } = legacyBuilder;
    // `projectionRaw` (W15 §9(b)) is saved and round-trips through SQLite,
    // so it has to be read here too, not dropped: dropping it means "Run
    // here" on a query saved with `{_id: 0}` runs with every field instead —
    // the §11 fail-open, from a saved query. `LegacyBuilderState` is frozen
    // and has no room for it, so TypeScript can't catch a drop here on its
    // own — the cast reads it off the wire shape the same way the
    // `queryRaw` fallback above does.
    //
    // Written explicitly, including when there is none: `onPatch` replaces
    // the whole builder, so a payload with no raw projection has to *clear*
    // one already on the tab, and clearing by omission is what caused this.
    const projectionRaw = payload.builder
      ? (payload.builder as { projectionRaw?: string }).projectionRaw
      : state.builder.projectionRaw;
    return {
      builder: { sort, limit, projection, projectionRaw },
      queryRaw: payload.queryRaw ?? legacyCompileFilter(legacyBuilder),
    };
  };

  const handleSavedRunHere = (saved: SavedQuery) => {
    if (saved.payload.kind === 'find') {
      const patch = hydrateFindPayload(saved.payload as unknown as LegacySavedFindPayload);
      onPatch(patch);
      onRun(patch);
      setLoadGen((g) => g + 1);
    }
  };

  const handleRecentRunHere = (recent: RecentQuery) => {
    if (recent.payload.kind === 'find') {
      const patch = hydrateFindPayload(recent.payload as unknown as LegacySavedFindPayload);
      onPatch(patch);
      onRun(patch);
      setLoadGen((g) => g + 1);
    }
  };

  return (
    <div
      style={{
        width: '100%',
        borderLeft: `1px solid ${T.border}`,
        background: T.surface,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* This was three bare <button>s with an accent bottom-border on the
          active one: no role, no aria-selected, no
          aria-controls, three separate tab stops. Mantine's Tabs is the
          tablist pattern already built, so the drawer inherits all of it
          (including arrow-key roving as a single tab stop) rather than
          hand-rolling a fourth copy.

          `keepMounted={false}` is load-bearing: Mantine's default keeps
          inactive panels in the DOM, which would fire Saved's and Recent's
          list IPC from the Filter tab and leave the Filter footer mounted
          behind the other two. */}
      <Tabs
        value={activeTab}
        onChange={(v) => { if (v) setActiveTab(v as BuilderTab); }}
        keepMounted={false}
        variant="default"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {/* 42px matches CollectionHeader height so the bottom border aligns */}
        <Tabs.List
          grow
          aria-label="Query drawer"
          style={{ flexShrink: 0, height: 42, borderBottom: `1px solid ${T.border}` }}
        >
          {(['Builder', 'Saved', 'Recent'] as BuilderTab[]).map((tab) => (
            <Tabs.Tab key={tab} value={tab} styles={{ tab: { fontSize: 11 } }}>
              {/* W13 §6 — the first tab's label is "Filter"; `tab` (the
                  BuilderTab value 'Builder') is unchanged so persisted tab
                  state / other call sites keep working. */}
              {tab === 'Builder' ? 'Filter' : tab}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel
          value="Builder"
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ padding: '12px 12px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <FilterDrawer
                key={`${meta.tabId}:${loadGen}`}
                queryRaw={state.queryRaw}
                onCommit={onPatch}
                suggestionContext={suggestionContext}
              />
            </div>
          </div>

          {/* Pinned bottom footer: Reset / Copy code. Save lived here too
              until the QueryBar toolbar Save (always visible, next to
              Run/History) made this one a duplicate; `saved.create`'s hint
              anchor moved with it. `SavedStrip` — a preview of the Saved tab
              one click away — is gone for the same reason. */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              padding: '8px 12px',
              borderTop: `1px solid ${T.border}`,
              flexShrink: 0,
            }}
          >
            <Button variant="default" size="compact-xs" onClick={handleReset}>
              Reset
            </Button>
            <Button
              variant="default"
              size="compact-xs"
              leftSection={I.copy}
              onClick={handleCopyCode}
            >
              Copy code
            </Button>
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="Saved" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <SavedTab
            connectionId={connectionId}
            dbName={dbName}
            collection={collection}
            refreshKey={savedRefreshKey}
            onRunHere={handleSavedRunHere}
            onOpenInTab={onOpenInTab}
          />
        </Tabs.Panel>

        <Tabs.Panel value="Recent" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <RecentTab
            connectionId={connectionId}
            dbName={dbName}
            collection={collection}
            onRunHere={handleRecentRunHere}
          />
        </Tabs.Panel>
      </Tabs>

    </div>
  );
}

// Memoized so unrelated Workspace re-renders (loading toggle, drawer
// state) don't re-render the builder. Effective while `state` keeps the
// same reference; callbacks are stabilized on the Workspace side.
export const BuilderPane = memo(BuilderPaneInner);
