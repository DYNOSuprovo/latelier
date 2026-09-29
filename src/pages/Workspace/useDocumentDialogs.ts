import React from 'react';
import { notify } from '../../theme/notifications';
import { offerUndo } from './offerUndo';
import { currentFilterJson } from './builder';
import { stripIdForDuplicate } from './views/docId';
import type { CollectionTab } from '@shared/types';
import type { RunnerTarget, UseQueryRunnerResult } from './useQueryRunner';

/** Identity of the collection a drawer is writing to, captured at open time. */
export interface DocTarget {
  tabId: string;
  connectionId: string;
  dbName: string;
  collection: string;
}

function targetOf(tab: CollectionTab): DocTarget {
  return {
    tabId: tab.id,
    connectionId: tab.connectionId,
    dbName: tab.dbName,
    collection: tab.collection,
  };
}

export function useDocumentDialogs(deps: {
  activeCollectionRef: React.RefObject<CollectionTab | null>;
  queryRunner: UseQueryRunnerResult;
  activeTabId: string | null;
  /** Resolves a tab's current runner target at write-completion time; `null` if the tab is gone. */
  resolveRunnerTarget: (tabId: string) => RunnerTarget | null;
  /** The Focused Tab's Connection is read-only, so the Document Editor never opens. */
  readOnly: boolean;
}): {
  editing: { doc: unknown; target: DocTarget; focusPath?: string } | null;
  deleteDoc: unknown | null;
  deleteAllOpen: boolean;
  updateAllOpen: boolean;
  deleteSelected: unknown[] | null;
  inserting: { target: DocTarget; duplicateDocJson: string | null } | null;
  openEdit: (doc: unknown, focusPath?: string) => void;
  setDeleteDoc: React.Dispatch<React.SetStateAction<unknown | null>>;
  setDeleteSelected: React.Dispatch<React.SetStateAction<unknown[] | null>>;
  openInsertModal: () => void;
  openDeleteAllModal: () => void;
  openUpdateAllModal: () => void;
  openDuplicate: (doc: unknown) => void;
  closeInsertDrawer: () => void;
  handleInserted: () => void;
  handlePartialInsert: () => void;
  closeEditor: () => void;
  handleDocSaved: (auditId?: string) => void;
  closeDeleteDialogs: () => void;
  handleDeleted: (auditId: string | undefined, message: string) => void;
  closeUpdateAllModal: () => void;
  handleUpdatedAll: (auditId: string | undefined, message: string) => void;
  /** Bumps once per completed insert/edit/delete/delete-many, so a consumer
   * that only cares "did a write just land" (e.g. the header's stats fetch)
   * doesn't have to re-run on every read-only query re-run (sort, filter,
   * page). */
  writeVersion: number;
} {
  const { activeCollectionRef, activeTabId, resolveRunnerTarget, readOnly } = deps;
  const { run } = deps.queryRunner;

  // Target travels inside editing/inserting with the payload, captured at
  // open time, so a tab switch mid-edit can't retarget the eventual write.
  const [editing, setEditing] = React.useState<{ doc: unknown; target: DocTarget; focusPath?: string } | null>(null);
  const [deleteDoc, setDeleteDoc] = React.useState<unknown | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false);
  const [updateAllOpen, setUpdateAllOpen] = React.useState(false);
  // Holds the selected documents, not just ids, so the $in filter can be
  // recomputed from the canonical revived-BSON _id values.
  const [deleteSelected, setDeleteSelected] = React.useState<unknown[] | null>(null);
  // `null` duplicateDocJson means opened via plain Insert; the Document
  // Editor's insert mode falls back to '{}'.
  const [inserting, setInserting] = React.useState<{
    target: DocTarget;
    duplicateDocJson: string | null;
  } | null>(null);
  const [writeVersion, setWriteVersion] = React.useState(0);

  const openEdit = React.useCallback(
    (doc: unknown, focusPath?: string) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      if (readOnly) {
        notify.info('This connection is read-only, so its documents cannot be edited.', {
          title: 'Read-only connection',
        });
        return;
      }
      setEditing({ doc, target: targetOf(a), focusPath });
    },
    [activeCollectionRef, readOnly],
  );
  const openInsertModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    setInserting({ target: targetOf(a), duplicateDocJson: null });
  }, [activeCollectionRef]);
  const openDeleteAllModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    if (currentFilterJson(a.state) === null) {
      notify.error('Filter text is blank or not valid JSON', {
        title: 'No runnable filter',
      });
      return;
    }
    setDeleteAllOpen(true);
  }, [activeCollectionRef]);
  const openUpdateAllModal = React.useCallback(() => {
    const a = activeCollectionRef.current;
    if (!a) return;
    if (currentFilterJson(a.state) === null) {
      notify.error('Filter text is blank or not valid JSON', {
        title: 'No runnable filter',
      });
      return;
    }
    setUpdateAllOpen(true);
  }, [activeCollectionRef]);
  const openDuplicate = React.useCallback(
    (doc: unknown) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      setInserting({ target: targetOf(a), duplicateDocJson: stripIdForDuplicate(doc) });
    },
    [activeCollectionRef],
  );

  // A bare run() would refresh the Focused Tab, not the pinned drawer's tab —
  // resolve the pinned tab from the live tab list instead. `null` (tab gone,
  // e.g. ⌘W with the drawer open) no-ops rather than falling back.
  const refreshSource = React.useCallback(
    (target: DocTarget) => {
      const runnerTarget = resolveRunnerTarget(target.tabId);
      if (!runnerTarget) return;
      void run(undefined, runnerTarget);
      setWriteVersion((v) => v + 1);
    },
    [resolveRunnerTarget, run],
  );

  const closeInsertDrawer = React.useCallback(() => setInserting(null), []);
  const handleInserted = React.useCallback(() => {
    const target = inserting?.target;
    closeInsertDrawer();
    if (target) refreshSource(target);
  }, [closeInsertDrawer, inserting, refreshSource]);
  const handlePartialInsert = React.useCallback(() => {
    if (inserting) refreshSource(inserting.target);
  }, [inserting, refreshSource]);

  const closeEditor = React.useCallback(() => setEditing(null), []);
  const handleDocSaved = React.useCallback((auditId?: string) => {
    const target = editing?.target;
    setEditing(null);
    if (!target) return;
    refreshSource(target);
    offerUndo('Document updated', auditId, () => refreshSource(target));
  }, [editing, refreshSource]);

  const closeDeleteDialogs = React.useCallback(() => {
    setDeleteDoc(null);
    setDeleteAllOpen(false);
    setDeleteSelected(null);
  }, []);
  // Not routed through refreshSource: DeleteConfirm reads its target live
  // from the Focused Tab, so a delete can only complete against it.
  const handleDeleted = React.useCallback((auditId: string | undefined, message: string) => {
    closeDeleteDialogs();
    void run();
    setWriteVersion((v) => v + 1);
    // Exactly one toast: Undo-bearing when reversible, plain otherwise — a
    // delete-all over the bulk capture ceiling still needs to say what
    // happened.
    if (auditId === undefined) {
      notify.success(message);
      return;
    }
    const a = activeCollectionRef.current;
    if (a) {
      const target = targetOf(a);
      offerUndo(message, auditId, () => refreshSource(target));
    }
  }, [activeCollectionRef, closeDeleteDialogs, refreshSource, run]);

  // Same shape as delete-all: UpdateConfirm also reads its target live from
  // the Focused Tab (see the tab-switch effect below), so it's closed the
  // same way rather than routed through refreshSource's captured target.
  const closeUpdateAllModal = React.useCallback(() => setUpdateAllOpen(false), []);
  const handleUpdatedAll = React.useCallback((auditId: string | undefined, message: string) => {
    closeUpdateAllModal();
    void run();
    setWriteVersion((v) => v + 1);
    // Exactly one toast: Undo-bearing when reversible, plain otherwise — an
    // update over the bulk capture ceiling still needs to say what happened.
    if (auditId === undefined) {
      notify.success(message);
      return;
    }
    const a = activeCollectionRef.current;
    if (a) {
      const target = targetOf(a);
      offerUndo(message, auditId, () => refreshSource(target));
    }
  }, [activeCollectionRef, closeUpdateAllModal, refreshSource, run]);

  // DeleteConfirm's and UpdateConfirm's targets are read live from the
  // Focused Tab, so any route that moves focus off the tab either was opened
  // against (⌘1-9, ⌘W, cycling, palette tab.open) must close them —
  // otherwise they'd act on the wrong collection. editing/inserting
  // deliberately do NOT close here: they carry their own captured target and
  // hold an in-progress draft that a tab switch must not silently discard.
  //
  // Adjusted during render (not an effect) to avoid an extra commit+render pass per switch.
  const [prevTabId, setPrevTabId] = React.useState(activeTabId);
  if (activeTabId !== prevTabId) {
    setPrevTabId(activeTabId);
    closeDeleteDialogs();
    closeUpdateAllModal();
  }

  return {
    editing,
    deleteDoc,
    deleteAllOpen,
    updateAllOpen,
    deleteSelected,
    inserting,
    openEdit,
    setDeleteDoc,
    setDeleteSelected,
    openInsertModal,
    openDeleteAllModal,
    openUpdateAllModal,
    openDuplicate,
    closeInsertDrawer,
    handleInserted,
    handlePartialInsert,
    closeEditor,
    handleDocSaved,
    closeDeleteDialogs,
    handleDeleted,
    closeUpdateAllModal,
    handleUpdatedAll,
    writeVersion,
  };
}
