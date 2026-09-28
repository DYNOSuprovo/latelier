import React from 'react';
import { useMenuFocus } from '../../../hooks/useMenuFocus';

export interface DocMenuState {
  x: number;
  y: number;
  doc: unknown;
  returnFocusTo?: HTMLElement | null;
  focusMenuOnOpen?: boolean;
}

/**
 * Open state, dismiss and focus wiring for Tree's and JSON's per-document
 * "More actions" popup; render it with `DocActionsPopup`.
 */
export function useDocMenu() {
  const [docMenu, setDocMenu] = React.useState<DocMenuState | null>(null);
  const docMenuRef = React.useRef<HTMLDivElement | null>(null);
  const openDocMenu = React.useCallback(
    (
      doc: unknown,
      anchor: { x: number; y: number },
      focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
    ) => {
      setDocMenu({ ...anchor, doc, returnFocusTo: focus?.returnFocusTo, focusMenuOnOpen: focus?.focusMenuOnOpen });
    },
    [],
  );
  const closeDocMenu = React.useCallback(() => setDocMenu(null), []);
  useMenuFocus(docMenuRef, docMenu, closeDocMenu);
  return { docMenu, docMenuRef, openDocMenu, closeDocMenu };
}
