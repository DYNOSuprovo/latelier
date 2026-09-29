import React from 'react';
import {
  List,
  useDynamicRowHeight,
  type RowComponentProps,
} from 'react-window';
import { I } from '../../../icons';
import { ejsonStringify } from '../../../utils/ejson';
import { docKey, isRecord } from '../../../utils/displayValue';
import { tokenizeJson, type Token, type TokenKind } from '../../../utils/jsonHighlight';
import { copyToClipboard } from '../../../utils/clipboard';
import { anchorFromRect, isEditKey } from '../../../utils/contextMenuKey';
import { useCollectionWorkspace } from '../context';
import { useResultSelection } from '../resultSelection';
import { getDocId } from './docId';
import { SelectToggle } from './SelectToggle';
import { DocActionsPopup } from './RowActionsMenu';
import { useDocMenu } from './useDocMenu';

interface JsonViewProps {
  documents: unknown[];
}

/**
 * Strip the Fields control's hidden top-level fields from a document before
 * it is serialized for display. Rendering-only: every action on the
 * document (Copy, Edit, Delete/Select) is handed the original `doc`, never
 * this redacted copy — hiding a field must never change what gets sent to
 * Mongo or the clipboard. Only top-level paths are handled, matching what
 * `columnConfig.hidden` (Table's Fields control) currently stores.
 */
function redactHidden(doc: unknown, hidden: Set<string>): unknown {
  if (hidden.size === 0 || !isRecord(doc)) return doc;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!hidden.has(key)) out[key] = value;
  }
  return out;
}

function tokenColor(kind: TokenKind): string {
  switch (kind) {
    case 'key':     return 'var(--atelier-accent)';
    case 'string':  return '#2e7d32';
    case 'number':  return 'var(--atelier-color-number)';
    case 'boolean': return '#e65100';
    case 'null':    return 'var(--atelier-text-ghost)';
    case 'punct':   return 'var(--atelier-text-muted)';
    default:        return 'var(--atelier-text)';
  }
}

function tokenWeight(kind: TokenKind): React.CSSProperties['fontWeight'] {
  return kind === 'key' ? 600 : undefined;
}

// A node in the bracket-nesting tree over the flat token stream: either a
// single token, or a `{`/`[` ... `}`/`]` group holding its inner tokens as
// children (recursively, for nested groups). Building this tree is what lets
// a group collapse to a one-line summary without re-deriving JSON
// serialization — the existing tokenizer already did the formatting work.
type JsonNode =
  | { kind: 'leaf'; token: Token }
  | { kind: 'group'; id: number; open: Token; close: Token; children: JsonNode[]; entries: number };

function buildJsonTree(tokens: Token[]): JsonNode[] {
  let i = 0;
  let nextId = 0;
  function parseNodes(): JsonNode[] {
    const nodes: JsonNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.text === '}' || t.text === ']') break;
      if (t.text === '{' || t.text === '[') {
        const open = t;
        i++;
        const children = parseNodes();
        const close = tokens[i]!;
        i++;
        let commas = 0;
        let hasContent = false;
        for (const c of children) {
          if (c.kind === 'leaf') {
            if (c.token.text === ',') commas++;
            else if (!(c.token.kind === 'punct' && /^\s*$/u.test(c.token.text))) hasContent = true;
          } else {
            hasContent = true;
          }
        }
        nodes.push({ kind: 'group', id: nextId++, open, close, children, entries: hasContent ? commas + 1 : 0 });
        continue;
      }
      nodes.push({ kind: 'leaf', token: t });
      i++;
    }
    return nodes;
  }
  return parseNodes();
}

function JsonToken({ token }: { token: Token }) {
  return (
    <span style={{ color: tokenColor(token.kind), fontWeight: tokenWeight(token.kind) }}>
      {token.text}
    </span>
  );
}

function JsonTreeNodes({
  nodes,
  docKey,
  collapsedKeys,
  onToggle,
}: {
  nodes: JsonNode[];
  docKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'leaf') return <JsonToken key={i} token={node.token} />;
        const nodeKey = `${docKey}:${node.id}`;
        const collapsed = collapsedKeys.has(nodeKey);
        const toggle = (e: React.SyntheticEvent) => {
          e.stopPropagation();
          onToggle(nodeKey);
        };
        return (
          <React.Fragment key={i}>
            <span
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter is Run (PanelBody's handler), not a toggle.
                if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === ' ') {
                  e.preventDefault();
                  toggle(e);
                }
              }}
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              style={{ cursor: 'pointer' }}
            >
              <JsonToken token={node.open} />
              {collapsed && node.entries > 0 && (
                <span style={{ color: 'var(--atelier-text-ghost)', fontStyle: 'italic' }}>
                  {` …${node.entries} `}
                </span>
              )}
            </span>
            {!collapsed && (
              <JsonTreeNodes
                nodes={node.children}
                docKey={docKey}
                collapsedKeys={collapsedKeys}
                onToggle={onToggle}
              />
            )}
            <JsonToken token={node.close} />
          </React.Fragment>
        );
      })}
    </>
  );
}

// Collapse state is keyed by `${docKey}:${nodeId}` and owned by the caller
// (not local state here) so it survives a react-window row unmounting on
// scroll, and so a refreshed document at the same row index doesn't inherit
// another document's collapsed nodes.
export function HighlightedJson({
  json,
  docKey,
  collapsedKeys,
  onToggle,
}: {
  json: string;
  docKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const tree = React.useMemo(() => buildJsonTree(tokenizeJson(json)), [json]);

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--atelier-text)',
      }}
    >
      <JsonTreeNodes nodes={tree} docKey={docKey} collapsedKeys={collapsedKeys} onToggle={onToggle} />
    </pre>
  );
}

interface DocCardProps {
  doc: unknown;
  idx: number;
  isSelected: boolean;
  isCopied: boolean;
  collapsedKeys: Set<string>;
  hiddenFields: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggle: (idx: number) => void;
  onCopy: (doc: unknown, idx: number) => void;
  onEdit: (doc: unknown) => void;
  onDelete: (doc: unknown) => void;
  // Opens the shared `RowActionsMenu` (Duplicate — Edit/Delete already have
  // their own always-visible buttons on this card).
  onOpenRowMenu: (
    doc: unknown,
    anchor: { x: number; y: number },
    focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
  ) => void;
}

function DocCard({
  doc,
  idx,
  isSelected,
  isCopied,
  collapsedKeys,
  hiddenFields,
  onToggleCollapse,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  onOpenRowMenu,
}: DocCardProps) {
  const json = React.useMemo(() => {
    const visible = redactHidden(doc, hiddenFields);
    try {
      return ejsonStringify(visible, 2);
    } catch {
      return JSON.stringify(visible, null, 2);
    }
  }, [doc, hiddenFields]);

  // A plain click no longer does anything to selection — it used to toggle
  // this card into/out of the multi-selection, which surprised anyone who'd
  // learned Table or Tree's own click behavior first. ⌘/Ctrl+click still
  // toggles it, matching the other two views; the visible checkbox below is
  // the plain-click-free way in.
  const handleCardClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) onToggle(idx);
  };

  return (
    <div
      onClick={handleCardClick}
      // JSON has no roving row focus; the card is "focused" when one of its
      // own controls is, and `E` there opens the editor like it does on a
      // Table or Tree row. Only buttons live inside, so no typing reaches it.
      onKeyDown={(e) => {
        if (!isEditKey(e)) return;
        e.preventDefault();
        onEdit(doc);
      }}
      // `group`, deliberately not `button`. `button` is "children
      // presentational" in ARIA, and this card holds real <button>s — the
      // corner actions below, and the JSON body's own collapse toggles at
      // :111 via HighlightedJson — which such a role may not contain at any
      // depth (axe's nested-interactive). `group` is not children
      // presentational, so the controls inside stay exposed, and it is honest:
      // this is a document and the things you can do to it.
      //
      // It also keeps S6848 closed. That rule wants a role on an element with
      // a handler, not specifically an interactive one — the `role="group"`
      // context menus in TableView carry an onClick and came back clean on the
      // #18 scan. So the wide-area click survives without either finding.
      role="group"
      aria-label={`Document ${idx + 1}`}
      style={{
        border: `1px solid ${isSelected ? 'var(--atelier-accent-border)' : 'var(--atelier-border)'}`,
        borderRadius: 'var(--atelier-radius-sm)',
        background: isSelected ? 'var(--atelier-accent-soft)' : 'var(--atelier-surface-raised)',
        padding: '8px 10px',
        cursor: 'default',
        position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
        <SelectToggle selected={isSelected} docLabel={getDocId(doc)} onToggle={() => onToggle(idx)} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopy(doc, idx);
          }}
          title="Copy JSON"
          style={{
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border)',
            borderRadius: 'var(--atelier-radius-xs)',
            padding: '2px 5px',
            cursor: 'pointer',
            color: isCopied ? 'var(--atelier-accent)' : 'var(--atelier-text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 10,
          }}
        >
          {isCopied ? I.check : I.copy}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(doc);
          }}
          title="Edit"
          style={{
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border)',
            borderRadius: 'var(--atelier-radius-xs)',
            padding: '2px 5px',
            cursor: 'pointer',
            color: 'var(--atelier-text-muted)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {I.edit}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(doc);
          }}
          title="Delete"
          style={{
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border)',
            borderRadius: 'var(--atelier-radius-xs)',
            padding: '2px 5px',
            cursor: 'pointer',
            color: 'var(--atelier-red)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {I.trash}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            const viaKeyboard = e.detail === 0;
            onOpenRowMenu(doc, anchorFromRect(e.currentTarget.getBoundingClientRect()), {
              returnFocusTo: viaKeyboard ? e.currentTarget : undefined,
              focusMenuOnOpen: viaKeyboard,
            });
          }}
          title="More actions"
          aria-label={`More actions for document ${getDocId(doc)}`}
          style={{
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border)',
            borderRadius: 'var(--atelier-radius-xs)',
            padding: '2px 5px',
            cursor: 'pointer',
            color: 'var(--atelier-text-muted)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {I.more}
        </button>
      </div>
      <HighlightedJson
        json={json}
        docKey={docKey(doc, idx)}
        collapsedKeys={collapsedKeys}
        onToggle={onToggleCollapse}
      />
    </div>
  );
}

const MemoDocCard = React.memo(DocCard);

interface JsonRowProps {
  documents: unknown[];
  selectedIndices: Set<number>;
  copiedIdx: number | null;
  collapsedKeys: Set<string>;
  hiddenFields: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggle: (idx: number) => void;
  onCopy: (doc: unknown, idx: number) => void;
  onEdit: (doc: unknown) => void;
  onDelete: (doc: unknown) => void;
  onOpenRowMenu: DocCardProps['onOpenRowMenu'];
}

function JsonRow({
  index,
  style,
  documents,
  selectedIndices,
  copiedIdx,
  collapsedKeys,
  hiddenFields,
  onToggleCollapse,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  onOpenRowMenu,
}: RowComponentProps<JsonRowProps>) {
  const doc = documents[index];
  return (
    <div style={{ ...style, paddingBottom: 8 }} data-doc-key={docKey(doc, index)}>
      <MemoDocCard
        doc={doc}
        idx={index}
        isSelected={selectedIndices.has(index)}
        isCopied={copiedIdx === index}
        collapsedKeys={collapsedKeys}
        hiddenFields={hiddenFields}
        onToggleCollapse={onToggleCollapse}
        onToggle={onToggle}
        onCopy={onCopy}
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenRowMenu={onOpenRowMenu}
      />
    </div>
  );
}

export function JsonView({ documents }: JsonViewProps) {
  const { state, actions, meta } = useCollectionWorkspace();
  const onEditDoc = actions.openEdit;
  const onDeleteDoc = actions.openDelete;
  const onDuplicateDoc = actions.openDuplicate;
  // Fields control: same top-level `columnConfig.hidden` Table already
  // reads (`tableColumns.ts`'s `resolveColumns`) — display-only, so Copy/Edit/
  // Delete below always act on the untouched `doc`, never this set.
  const hiddenFields = React.useMemo(
    () => new Set(state.columnConfig?.hidden ?? []),
    [state.columnConfig?.hidden],
  );
  // T0.4 — selection lifted to the shared cross-view context (index-based,
  // scoped to the enclosing <ResultViewer>); falls back to local state when
  // rendered standalone (no provider mounted).
  const selection = useResultSelection(documents);
  const selectedIndices = selection.indices;
  const toggleSelect = selection.toggle;
  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);
  const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(() => new Set());
  // Collapse keys are `${docKey}:${node.id}`, where node.id is assigned in
  // token order over the *redacted* JSON — hiding or showing a field shifts
  // every id after it, so a stale collapsedKeys set would collapse the wrong
  // subtree. Reset rather than try to remap ids across a hidden-fields
  // change. "Adjust state during render" pattern (see TreeView's
  // prevDocuments reset), not a useEffect, to avoid a cascading render cycle.
  const [prevHiddenFields, setPrevHiddenFields] = React.useState(hiddenFields);
  if (prevHiddenFields !== hiddenFields) {
    setPrevHiddenFields(hiddenFields);
    setCollapsedKeys(new Set());
  }
  const toggleCollapse = React.useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const copyDoc = React.useCallback((doc: unknown, idx: number) => {
    const text = ejsonStringify(doc, 2);
    // The badge is the success feedback, so it waits for the write to
    // resolve. A failure toasts and leaves no badge behind.
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1200);
    });
  }, []);

  // "More actions" per-card menu — Duplicate only, since Edit/Delete already
  // have their own always-visible buttons on the card.
  const { docMenu, docMenuRef, openDocMenu: handleOpenRowMenu, closeDocMenu } = useDocMenu();

  // Cards are variable-height (driven by the doc's serialized size). The
  // estimate is intentionally generous; useDynamicRowHeight refines on render.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 180 });

  // Memoize so react-window receives a stable rowProps reference. A fresh
  // object literal on every render would force all visible rows to re-render
  // even when nothing they depend on changed (TableView does this too).
  const rowProps = React.useMemo<JsonRowProps>(
    () => ({
      documents,
      selectedIndices,
      copiedIdx,
      collapsedKeys,
      hiddenFields,
      onToggleCollapse: toggleCollapse,
      onToggle: toggleSelect,
      onCopy: copyDoc,
      onEdit: onEditDoc,
      onDelete: onDeleteDoc,
      onOpenRowMenu: handleOpenRowMenu,
    }),
    [
      documents,
      selectedIndices,
      copiedIdx,
      collapsedKeys,
      hiddenFields,
      toggleCollapse,
      toggleSelect,
      copyDoc,
      onEditDoc,
      onDeleteDoc,
      handleOpenRowMenu,
    ],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {hiddenFields.size > 0 && (
        <div
          style={{
            padding: '4px 12px 0',
            fontSize: 11,
            color: 'var(--atelier-text-muted)',
          }}
        >
          {hiddenFields.size === 1 ? '1 field hidden' : `${hiddenFields.size} fields hidden`}
        </div>
      )}
      <List<JsonRowProps>
        rowComponent={JsonRow}
        rowCount={documents.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={4}
        style={{
          flex: 1,
          minHeight: 0,
          padding: '8px 12px',
        }}
      />
      {docMenu && (
        <DocActionsPopup
          menu={docMenu}
          menuRef={docMenuRef}
          onEdit={onEditDoc}
          onDuplicate={onDuplicateDoc}
          onDelete={onDeleteDoc}
          isReadOnly={meta.isReadOnly}
          onClose={closeDocMenu}
        />
      )}
    </div>
  );
}
