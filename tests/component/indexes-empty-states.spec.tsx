import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import { IndexesTab } from '../../src/pages/IndexesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// The disconnected/empty-pick states this file used to cover here belonged
// to `IndexesHost`, the Connection Manager's Indexes-tab picker — deleted
// along with that tab (W16 Tier 2, ADR 0003; the index surface is now the
// collection tab's Structure view, which is namespace-scoped and has no
// picker to be empty).
describe('IndexesTab — error states', () => {
  it('shows an UNAUTHORIZED-specific banner when index:list throws', async () => {
    installAtelierMock({
      index: {
        list: async () => {
          throw { code: 'UNAUTHORIZED', message: 'not authorized on alpha' };
        },
      },
    });
    render(<IndexesTab connectionId="c1" dbName="alpha" collection="people" />);
    await waitFor(() => {
      expect(
        screen.getByText(/lacks the privilege to read indexes on alpha\.people/),
      ).toBeTruthy();
    });
  });
});
