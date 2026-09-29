import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionSummary, CollectionTab } from '@shared/types';

const now = '2026-07-31T12:00:00.000Z';

const CONNECTIONS: ConnectionSummary[] = [
  {
    id: 'c1',
    name: 'Prod',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'connected',
  },
];

const TAB: CollectionTab = {
  id: 't1',
  kind: 'collection',
  connectionId: 'c1',
  dbName: 'db',
  collection: 'orders',
  position: 0,
  isActive: true,
  openedAt: now,
  pinned: false,
  state: {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  },
};

/** Mount the Workspace with one collection tab open — the state that renders
 *  a `PanelResizeHandle`, which is what makes this spec reproduce the defect. */
async function mountWithTabOpen(): Promise<void> {
  installAtelierMock({
    tabs: { list: async () => [TAB] },
    conn: { list: async () => CONNECTIONS },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Routes>
        <Route path="/workspace" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText('Close orders')).toBeTruthy());
}

afterEach(() => {
  uninstallAtelierMock();
});

// `react-resizable-panels` hit-tests document-level pointer events
// against bounding rects. jsdom reports every rect as zeros and every synthetic
// pointer event carries clientX/clientY of 0, so without the panel-rect stub in
// `tests/helpers/jsdomSetup.ts` every pointer-down in the document matches the
// handle: it focuses itself and calls preventDefault, and the click never
// reaches the field it was aimed at. Delete that stub and both tests below
// fail. The handle only renders once a collection tab is open, which is why the
// mount above is not just scenery.
describe(' a pointer interaction in a Workspace with a tab open keeps its focus', () => {
  it('clicking a field focuses that field, not the resize handle', async () => {
    await mountWithTabOpen();
    // The handle is present — otherwise this spec would prove nothing.
    expect(screen.getByRole('separator', { name: 'Resize Query Builder' })).toBeTruthy();

    const field = screen.getByLabelText('Filter collections');
    await userEvent.click(field);

    expect(document.activeElement).toBe(field);
  });

  it('typing after a click lands in the clicked field', async () => {
    await mountWithTabOpen();

    const field = screen.getByLabelText('Filter collections') as HTMLInputElement;
    await userEvent.click(field);
    await userEvent.keyboard('ord');

    expect(field.value).toBe('ord');
  });
});
