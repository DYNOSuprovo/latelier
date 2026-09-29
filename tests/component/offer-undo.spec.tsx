import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { offerUndo } from '../../src/pages/Workspace/offerUndo';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { UndoResult } from '../../shared/types';

afterEach(() => {
  notifications.clean();
  uninstallAtelierMock();
});

describe('offerUndo — the success toast of a Reversible write', () => {
  it('Undo calls audit:undo with the entry id, reports the restore, then re-runs', async () => {
    const undo = vi.fn(async (): Promise<UndoResult> => ({ restored: 1, skipped: 0 }));
    installAtelierMock({ audit: { undo } });
    const onUndone = vi.fn();
    render(<div />);

    offerUndo('Document deleted', 'entry-1', onUndone);
    expect(await screen.findByText('Document deleted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Restored 1 document')).toBeTruthy();
    expect(undo).toHaveBeenCalledWith({ entryId: 'entry-1' });
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it('a changed target is explained in words, not as its code, and nothing re-runs', async () => {
    installAtelierMock({
      audit: {
        undo: async () => Promise.reject({ code: 'AUDIT_TARGET_CHANGED', message: 'AUDIT_TARGET_CHANGED' }),
      },
    });
    const onUndone = vi.fn();
    render(<div />);

    offerUndo('Document updated', 'entry-2', onUndone);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(await screen.findByText(/has changed since/)).toBeTruthy();
    expect(screen.getByText(/made outside L'Atelier can't be unwound from here/)).toBeTruthy();
    expect(screen.queryByText('AUDIT_TARGET_CHANGED')).toBeNull();
    expect(onUndone).not.toHaveBeenCalled();
  });

  it('shows nothing when the write was not recorded Reversible', async () => {
    render(<div />);

    offerUndo('Document deleted', undefined, () => {});

    await waitFor(() => expect(screen.queryByText('Document deleted')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
