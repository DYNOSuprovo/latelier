import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { notify } from '../../src/theme/notifications';

// docs/adr/0013 — the reusable `{ label, onClick }` action on a `notify.*`
// toast, first used by the aggregation stage-delete Undo toast. X13's write
// toasts reuse the same primitive, so it's tested on its own here rather
// than only indirectly through one caller.

afterEach(() => {
  notifications.clean();
});

describe('notify action primitive', () => {
  it('renders the action button, fires onClick once, and dismisses the toast', async () => {
    render(<div />);
    const onClick = vi.fn();
    notify.info('Removed thing', { action: { label: 'Undo', onClick } });

    const button = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });

  /**
   * MUTATION TARGET — have `show()` always call `notifications.show` (drop
   * the `hide` before it) and this goes red: mantine's own dedup guard
   * no-ops the second `show` call for a duplicate id, so the *first*
   * toast's stale closure survives and `firstClick` fires instead.
   */
  it('reusing the id replaces the toast instead of stacking a second one', async () => {
    render(<div />);
    const firstClick = vi.fn();
    const secondClick = vi.fn();

    const id = notify.info('First', { action: { label: 'Undo', onClick: firstClick } });
    notify.info('Second', { id, action: { label: 'Undo', onClick: secondClick } });

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(secondClick).toHaveBeenCalledTimes(1);
    expect(firstClick).not.toHaveBeenCalled();
  });

  it('a plain message with no action renders no action button', async () => {
    render(<div />);
    notify.success('Saved');
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
