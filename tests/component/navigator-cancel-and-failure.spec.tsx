import type React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, act, waitFor, navigatorRoot } from '../helpers/render';
import {
  DbCollectionNavigator,
  type DbCollectionNavigatorProps,
} from '../../src/pages/Workspace/DbCollectionNavigator';
import {
  connectionFixture,
  installAtelierMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';
import type { CollectionInfo } from '../../shared/ipc';
import type { ConnectionRuntime } from '@shared/types';

// X16.6 — Cancel a hung connect, and show a failure where it happened.
//
// Every fixture here holds more than one Connection on purpose. "The other
// roots are unaffected" and "cancelling one leaves the others alone" cannot
// fail against a single-Connection tree, and — the point of mutation 3 — an
// error rendered above all roots passes a one-root test exactly as well as an
// error rendered on the root that failed.

const PROD = connectionFixture({ id: 'c1', name: 'Prod', color: '#1A6835' });
const STAGING = connectionFixture({ id: 'c2', name: 'Staging', color: '#8A5A00' });

const colls = (...names: string[]): CollectionInfo[] =>
  names.map((n) => ({
    name: n,
    type: 'collection' as const,
    documentCount: 0,
    sizeBytes: 0,
    indexCount: 0,
    capped: false,
  }));

function mount(
  props: Partial<DbCollectionNavigatorProps> & { wrap?: (n: React.ReactElement) => React.ReactElement } = {},
) {
  const { wrap = (n) => n, ...navProps } = props;
  const baseProps: DbCollectionNavigatorProps = {
    connectionsWithTabs: new Set(),
    connections: [PROD, STAGING],
    focusedConnectionId: null,
    activeDbName: null,
    activeCollection: null,
    onOpenCollection: vi.fn(),
    onOpenAggregation: vi.fn(),
    ...navProps,
  };
  return render(wrap(<DbCollectionNavigator {...baseProps} />));
}

const root = navigatorRoot;

/**
 * Every failure panel on screen, keyed by the Connection it says it belongs
 * to. This is the assertion that discriminates: a failure rendered above all
 * roots names no Connection at all, and one rendered on the wrong root names
 * the wrong Connection — both of which a bare `getByText(message)` accepts.
 */
function failuresByConnection(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of screen.queryAllByTestId('nav-connection-error')) {
    out[el.getAttribute('data-connection-id') ?? '(unattributed)'] = el.textContent ?? '';
  }
  return out;
}

/**
 * The roots and failure panels in the order they appear down the navigator,
 * as `root:<connectionId>` / `failure:<connectionId>`. Attribution alone is not
 * enough to catch a failure hoisted above every root — the panel still knows
 * which Connection it describes, it is just no longer *where* that Connection
 * is. Where it sits in the column is what a person actually reads.
 */
function rootsAndFailuresInOrder(): string[] {
  const nodes = document.querySelectorAll<HTMLElement>(
    '[data-testid="nav-connection"], [data-testid="nav-connection-error"]',
  );
  return [...nodes].map(
    (el) =>
      `${el.dataset.testid === 'nav-connection-error' ? 'failure' : 'root'}:${el.getAttribute('data-connection-id')}`,
  );
}

/** A live `mongo:status-event` stream, the way the pool drives one. */
function statusStream() {
  const listeners = new Set<(r: ConnectionRuntime) => void>();
  const onStatus = ((cb: (r: ConnectionRuntime) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }) as never;
  return {
    onStatus,
    ready: () => waitFor(() => expect(listeners.size).toBeGreaterThan(0)),
    emit: (r: ConnectionRuntime) =>
      act(async () => {
        for (const cb of listeners) cb(r);
      }),
  };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('DbCollectionNavigator — Cancel a hung connect (X16 §4.3)', () => {
  it('offers Cancel on the root of the Connection that is connecting, and on no other', () => {
    installAtelierMock();
    mount({ connections: [PROD, { ...STAGING, status: 'connecting' }] });

    expect(
      within(root('Staging')).getByRole('button', { name: 'Cancel connecting to Staging' }),
    ).toBeTruthy();
    // Prod has nothing in flight, so it offers nothing that could be mistaken
    // for a Cancel.
    expect(within(root('Prod')).queryByRole('button', { name: /^Cancel/ })).toBeNull();
  });

  it('Cancel disconnects that Connection and leaves the other one connected', async () => {
    const disconnect = vi.fn(async (id: string) => ({ id }));
    installAtelierMock({ mongo: { disconnect } });
    mount({ connections: [PROD, { ...STAGING, status: 'connecting' }] });

    await act(async () => {
      fireEvent.click(
        within(root('Staging')).getByRole('button', { name: 'Cancel connecting to Staging' }),
      );
    });

    // Exactly one call, for the id on the row that was clicked. A Cancel wired
    // to the wrong id would still be "a call to disconnect".
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith('c2');
    // Prod is still the connected root a person can read and browse.
    expect(root('Prod').getAttribute('aria-label')).toContain('Connected');
  });

  it('Cancel does not also expand or collapse the root it sits on', async () => {
    installAtelierMock();
    mount({ connections: [PROD, { ...STAGING, status: 'connecting' }] });
    expect(root('Staging').getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(
        within(root('Staging')).getByRole('button', { name: 'Cancel connecting to Staging' }),
      );
    });

    expect(root('Staging').getAttribute('aria-expanded')).toBe('false');
  });

  it('a root that is connecting says so, and its subtree stops contradicting it', async () => {
    installAtelierMock();
    mount({
      connectionsWithTabs: new Set(),
      connections: [PROD, { ...STAGING, status: 'connecting' }],
      focusedConnectionId: 'c2',
    });

    await waitFor(() => expect(root('Staging').getAttribute('aria-expanded')).toBe('true'));
    expect(root('Staging').getAttribute('aria-label')).toContain('Connecting');
    // A leftover this fixes: the root said "connecting" while the row under
    // it said the Connection was not connected at all.
    expect(screen.queryByText('Not connected. Nothing to browse.')).toBeNull();
    expect(screen.getByText('Connecting…')).toBeTruthy();
  });
});

describe('DbCollectionNavigator — a failure surfaces where it happened (X16 §4.2)', () => {
  it('renders the failed connect and its Retry on that Connection’s own root, and nowhere else', async () => {
    const stream = statusStream();
    installAtelierMock({
      meta: {
        listDatabases: async () => [{ name: 'shop', sizeOnDisk: 1, empty: false }],
        listCollections: async () => colls('orders'),
      },
      // No backfill answer: the message must come off the live stream.
      mongo: { onStatus: stream.onStatus, status: (async () => { throw new Error('unavailable'); }) as never },
    });
    // Prod is Open and expanded; Staging is the one that fails.
    mount({ connections: [PROD, { ...STAGING, status: 'error' }], focusedConnectionId: 'c1' });
    await stream.ready();
    await screen.findByTestId('nav-db-shop');

    await stream.emit({
      id: 'c2',
      status: 'error',
      errorMessage: 'getaddrinfo ENOTFOUND staging.internal',
    });

    const failures = failuresByConnection();
    expect(Object.keys(failures)).toEqual(['c2']);
    expect(failures.c2).toContain('getaddrinfo ENOTFOUND staging.internal');
    expect(
      screen.getByRole('button', { name: 'Retry connecting to Staging' }),
    ).toBeTruthy();
    // And it is *on* Staging's root — directly under it, below Prod's whole
    // section — rather than floating above both roots the way an earlier revision had to
    // leave it.
    expect(rootsAndFailuresInOrder()).toEqual(['root:c1', 'root:c2', 'failure:c2']);

    // Prod is untouched: still expanded, still listing its databases, with no
    // failure of its own and no Retry pointing at it.
    expect(root('Prod').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('nav-db-shop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prod/ })).toBeNull();
  });

  it('says the Connection failed in words, not by the colour of its rail', async () => {
    const stream = statusStream();
    installAtelierMock({ mongo: { onStatus: stream.onStatus } });
    mount({ connections: [PROD, { ...STAGING, status: 'error' }] });
    await stream.ready();

    // A failed root reads differently from a merely dormant one — with five
    // Connections open, "Not connected" on both is no answer to "which is down".
    expect(root('Staging').getAttribute('aria-label')).toContain('Connection failed');
    expect(within(root('Staging')).getByText('failed')).toBeTruthy();
    expect(root('Prod').getAttribute('aria-label')).not.toContain('failed');
  });

  it('reads the message off mongo:status for a failure that predates the mount', async () => {
    // A launch-restore connect that failed emits its event before this
    // component subscribes. One existing-channel read closes that hole.
    const status = vi.fn(async (id: string) => ({
      id,
      status: 'error' as const,
      errorMessage: 'Authentication failed.',
    }));
    installAtelierMock({ mongo: { status } });
    mount({ connections: [PROD, { ...STAGING, status: 'error' }] });

    await waitFor(() =>
      expect(failuresByConnection().c2).toContain('Authentication failed.'),
    );
    expect(status).toHaveBeenCalledWith('c2');
    // Prod is connected, so nothing was read for it.
    expect(status).toHaveBeenCalledTimes(1);
  });

  describe('Re-enter password (#396)', () => {
    const unreadable = {
      id: 'c2',
      status: 'error' as const,
      errorCode: 'SECRET_UNREADABLE' as const,
      errorMessage: "This connection's saved password can't be read on this install. Re-enter it.",
    };

    it('an unreadable saved password offers Re-enter password, which opens the edit form focused on it', async () => {
      const stream = statusStream();
      installAtelierMock({ mongo: { onStatus: stream.onStatus } });
      const onEditConnection = vi.fn();
      const parentClick = vi.fn();
      mount({ connections: [PROD, { ...STAGING, status: 'error' }], onEditConnection, wrap: (n) => <div onClick={parentClick}>{n}</div> });
      await stream.ready();
      await stream.emit(unreadable);

      const button = screen.getByRole('button', { name: 'Re-enter password for Staging' });
      fireEvent.click(button);

      expect(onEditConnection).toHaveBeenCalledTimes(1);
      expect(onEditConnection).toHaveBeenCalledWith('c2', button, { focus: 'password' });
      expect(parentClick).not.toHaveBeenCalled();
    });

    it('the code survives the launch-time backfill read too', async () => {
      const status = vi.fn(async () => unreadable);
      installAtelierMock({ mongo: { status } });
      mount({ connections: [PROD, { ...STAGING, status: 'error' }], onEditConnection: vi.fn() });

      expect(await screen.findByRole('button', { name: 'Re-enter password for Staging' })).toBeTruthy();
    });

    it('an ordinary AUTH failure offers no such button', async () => {
      const stream = statusStream();
      installAtelierMock({ mongo: { onStatus: stream.onStatus } });
      mount({ connections: [PROD, { ...STAGING, status: 'error' }], onEditConnection: vi.fn() });
      await stream.ready();
      await stream.emit({ id: 'c2', status: 'error', errorCode: 'AUTH', errorMessage: 'Authentication failed.' });

      expect(screen.getByRole('button', { name: 'Retry connecting to Staging' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Re-enter password/ })).toBeNull();
    });
  });

  it('Retry re-attempts the connect for the Connection the error is shown on', async () => {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({ mongo: { connect } });
    mount({ connections: [PROD, { ...STAGING, status: 'error' }] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry connecting to Staging' }));
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith('c2');
  });

  it('a failed root shows its error instead of a second, vaguer "nothing to browse"', async () => {
    const stream = statusStream();
    installAtelierMock({ mongo: { onStatus: stream.onStatus } });
    mount({ connections: [PROD, { ...STAGING, status: 'error' }], focusedConnectionId: 'c2' });
    await stream.ready();
    await waitFor(() => expect(root('Staging').getAttribute('aria-expanded')).toBe('true'));

    expect(screen.queryByText('Not connected. Nothing to browse.')).toBeNull();
    expect(failuresByConnection().c2).toContain('Could not connect');
  });

  it('a db-list failure also lands on its own root, not above every root', async () => {
    // The other half of that same leftover: this error used to render above all
    // roots because it is variable-height. Two Connections again, so "on the
    // right root" is a claim that can fail.
    const stream = statusStream();
    installAtelierMock({
      meta: {
        listDatabases: (async () => {
          throw { code: 'DB_ERROR', message: 'not authorized on admin' };
        }) as never,
        listCollections: async () => colls('orders'),
      },
      mongo: { onStatus: stream.onStatus },
    });
    mount({ connections: [PROD, STAGING], focusedConnectionId: 'c2' });

    await waitFor(() => expect(failuresByConnection().c2).toBeDefined());
    expect(Object.keys(failuresByConnection())).toEqual(['c2']);
    expect(failuresByConnection().c2).toContain('not authorized on admin');
    expect(
      screen.getByRole('button', { name: 'Retry loading databases for Staging' }),
    ).toBeTruthy();
    expect(rootsAndFailuresInOrder()).toEqual(['root:c1', 'root:c2', 'failure:c2']);
  });

  // #66 — a failure row is a placeholder (like a skeleton or an empty
  // state): it carries no `id` and nothing an `aria-activedescendant` could
  // land on, so arrow navigation now steps over it entirely instead of
  // visiting it. This replaces the old two-hop "Down onto the failure row,
  // then Down again" version of this same test.
  it('keyboard: Down skips a root’s own failure row and reaches the next root directly', async () => {
    const stream = statusStream();
    installAtelierMock({ mongo: { onStatus: stream.onStatus } });
    mount({ connections: [{ ...PROD, status: 'error' }, STAGING] });
    await stream.ready();
    await screen.findByTestId('nav-connection-error');

    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'Home' }); // Prod's root
    expect(tree.getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c1');

    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // straight to Staging's root, not Prod's failure row
    expect(tree.getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c2');

    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(root('Staging').getAttribute('aria-expanded')).toBe('true');
    expect(root('Prod').getAttribute('aria-expanded')).toBe('false');

    // And Up from Staging's root goes straight back to Prod's, same skip.
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    expect(tree.getAttribute('aria-activedescendant')).toBe('navigator-row-conn:c1');
  });
});
