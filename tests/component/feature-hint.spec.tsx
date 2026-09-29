import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '../helpers/render';
import { FeatureHint } from '../../src/hints/FeatureHint';
import { HintsProvider } from '../../src/hints/HintsProvider';
import { useFeatureHint } from '../../src/hints/useFeatureHint';
import { useHints } from '../../src/hints/HintsContext';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function withTheme(ui: React.ReactElement) {
  return ui;
}

describe('<FeatureHint>', () => {
  beforeEach(() => {
    installAtelierMock({ prefs: { get: async () => null, set: async (_k, v) => v } });
  });
  afterEach(() => {
    uninstallAtelierMock();
    vi.useRealTimers();
  });

  it('renders title, body, and Got it button when visible', async () => {
    render(
      withTheme(
        <>
          <button data-hint-anchor="refs.configure" type="button">
            References
          </button>
          <FeatureHint
            id="refs.configure"
            visible
            onDismiss={() => {}}
          />
        </>,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText('Link this field to another doc?')).toBeTruthy();
    });
    expect(screen.getByText(/Got it/)).toBeTruthy();
  });

  it('calls onDismiss when "Got it" is clicked', async () => {
    const onDismiss = vi.fn();
    render(
      withTheme(
        <>
          <button data-hint-anchor="refs.configure" type="button">
            References
          </button>
          <FeatureHint
            id="refs.configure"
            visible
            onDismiss={onDismiss}
          />
        </>,
      ),
    );
    await waitFor(() => screen.getByText(/Got it/));
    fireEvent.click(screen.getByText(/Got it/));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders nothing when visible is false', () => {
    const { container } = render(
      withTheme(
        <FeatureHint
          id="tabs.pin"
          visible={false}
          onDismiss={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[data-feature-hint]')).toBeNull();
  });
});

describe('HintsProvider + useFeatureHint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installAtelierMock({ prefs: { get: async () => null, set: async (_k, v) => v } });
  });
  afterEach(() => {
    uninstallAtelierMock();
    vi.useRealTimers();
  });

  it('only the first registered candidate becomes visible', async () => {
    function Probe() {
      const a = useFeatureHint('refs.configure', true);
      const b = useFeatureHint('tabs.pin', true);
      return (
        <div>
          <span data-testid="a">{a.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="b">{b.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    // Allow loaded promise to resolve, then advance the settle timer.
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('a').textContent).toBe('visible');
    expect(screen.getByTestId('b').textContent).toBe('hidden');
  });

  it('a hint is suppressed during the initial settle window', async () => {
    function Probe() {
      const h = useFeatureHint('refs.configure', true);
      return <span data-testid="h">{h.visible ? 'visible' : 'hidden'}</span>;
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('h').textContent).toBe('hidden');
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('h').textContent).toBe('visible');
  });

  it('the lower-priority hint wins even when it registers second', async () => {
    // `tabs.pin` (priority 20) mounts first here; `run.execute` (priority 0)
    // registers after it. `HintsProvider` must still pick `run.execute` —
    // priority beats registration order, otherwise the primary Run hint
    // could lose to whichever secondary hint happened to mount first.
    function Probe() {
      const secondary = useFeatureHint('tabs.pin', true);
      const primary = useFeatureHint('run.execute', true);
      return (
        <div>
          <span data-testid="secondary">{secondary.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="primary">{primary.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('primary').textContent).toBe('visible');
    expect(screen.getByTestId('secondary').textContent).toBe('hidden');
  });

  it('with a run already recorded, editing the filter makes run.execute visible and it outranks a secondary hint', async () => {
    // Mirrors `Workspace.tsx`'s wiring: a query-run key is recorded for the
    // filter that was actually run (`ranKey`, standing in for `lastRun`
    // being set); `run.execute`'s trigger reads the session count for the
    // *current* query's key (`editedKey`, standing in for the filter after
    // an edit). Zero means the query on screen has never itself been run,
    // even though something else in this tab has.
    const ranKey = 'find:c1:db:coll:{"a":1}';
    const editedKey = 'find:c1:db:coll:{"a":2}';
    function Probe() {
      const h = useHints();
      React.useEffect(() => {
        h.recordSessionEvent('queryRun', ranKey);
      }, [h]);
      const runExecute = useFeatureHint(
        'run.execute',
        h.getSessionEventCount('queryRun', editedKey) === 0,
      );
      const secondary = useFeatureHint('tabs.pin', true);
      return (
        <div>
          <span data-testid="run">{runExecute.visible ? 'visible' : 'hidden'}</span>
          <span data-testid="secondary">{secondary.visible ? 'visible' : 'hidden'}</span>
        </div>
      );
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('run').textContent).toBe('visible');
    expect(screen.getByTestId('secondary').textContent).toBe('hidden');
  });

  it('a dismissed hint stays hidden even when the trigger is true', async () => {
    installAtelierMock({
      prefs: {
        get: async () => ({ dismissedIds: ['refs.configure'] }) as never,
        set: async (_k, v) => v as never,
      },
    });
    function Probe() {
      const h = useFeatureHint('refs.configure', true);
      return <span data-testid="h">{h.visible ? 'visible' : 'hidden'}</span>;
    }
    render(
      withTheme(
        <HintsProvider>
          <Probe />
        </HintsProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('h').textContent).toBe('hidden');
  });
});
