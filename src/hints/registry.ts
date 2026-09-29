import type { FeatureHintId } from '@shared/types';

export interface FeatureHintCopy {
  id: FeatureHintId;
  title: string;
  body: string;
  ctaLabel?: string;
  /**
   * Lower wins. When more than one candidate's `when` is true at once,
   * `HintsProvider` shows the one with the lowest `priority` rather than
   * whichever mounted first — the primary path (Run) should always beat a
   * secondary feature hint, regardless of registration order.
   */
  priority: number;
}

export const HINT_REGISTRY: Record<FeatureHintId, FeatureHintCopy> = {
  'run.execute': {
    id: 'run.execute',
    title: 'Press Run to see your results',
    body: 'Cmd+Enter (Ctrl+Enter on Windows/Linux) runs the query without leaving the keyboard.',
    priority: 0,
  },
  'refs.configure': {
    id: 'refs.configure',
    title: 'Link this field to another doc?',
    body: 'Fields ending in _id or Id can become clickable references. Configure a rule to follow them.',
    ctaLabel: 'Configure references',
    priority: 10,
  },
  'tabs.pin': {
    id: 'tabs.pin',
    title: 'Pin this tab',
    body: 'Pinned tabs stay at the front of the strip and are easy to find later. Right-click any tab to pin it.',
    priority: 20,
  },
  'saved.create': {
    id: 'saved.create',
    title: 'Save this query',
    body: 'Run something useful? Save it for one-click reuse from the Saved tab.',
    ctaLabel: 'Save now',
    priority: 30,
  },
  'palette.discover': {
    id: 'palette.discover',
    title: 'Find any action with ⌘K',
    body: 'Press ⌘K (Ctrl+K on Windows/Linux) to search every action — switch connections, run queries, configure references, and more.',
    ctaLabel: 'Try it',
    priority: 40,
  },
};
