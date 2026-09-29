import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MongoShellPane } from '../../src/pages/Workspace/MongoShellPane';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ShellOutputEvent, ShellSessionInfo } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <MongoShellPane
      connectionId="c1"
      connectionName="Local"
      height={260}
      onClose={() => {}}
    />,
  );
}

describe('MongoShellPane', () => {
  it('starts a session on mount and posts user input through mshell.write', async () => {
    const writeSpy = vi.fn(async () => undefined);
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: writeSpy,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    const input = await screen.findByLabelText('Mongo shell input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));

    fireEvent.change(input, { target: { value: 'db.runCommand({ ping: 1 })' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledWith({
        sessionId: 's1',
        data: 'db.runCommand({ ping: 1 })\n',
      });
    });
  });

  it('renders streamed stdout in the output area', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'hello world\n' });

    const output = await screen.findByTestId('mongo-shell-output');
    await waitFor(() => expect(output.textContent).toContain('hello world'));
  });

  it('renders an error banner when start rejects', async () => {
    installAtelierMock({
      mshell: {
        start: async () => {
          throw { code: 'INTERNAL', message: 'connect failed' };
        },
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    await waitFor(() => {
      expect(screen.getByTestId('mongo-shell-output').textContent).toMatch(
        /\[error\] connect failed/,
      );
    });
  });

  // ─── Performance regression guard ─────────────────────────────────────
  //
  // Each `stdout` event runs `setBuffer((prev) => prev + chunk)` and a
  // `useEffect` that reads `scrollHeight` + sets `scrollTop`. A regression
  // that drops the 200 KB cap on the buffer (or replaces the slice-from-front
  // with naive append) means a chatty shell session pegs renderer memory.
  // This test fires 1500 chunks rapidly and asserts the buffer respects the
  // cap and stays responsive.
  it('honours the 200 KB buffer cap under a burst of output events', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    // 1500 chunks × 200 bytes = 300 KB total. The component is capped at
    // 200 KB; the oldest chunks must be discarded.
    const chunk = 'x'.repeat(200) + '\n';
    const totalChunks = 1500;
    const t0 = Date.now();
    for (let i = 0; i < totalChunks; i++) {
      outputCb!({ sessionId: 's1', kind: 'stdout', data: chunk });
    }
    const dispatchMs = Date.now() - t0;

    // Pure dispatch into the React state setter must stay snappy even
    // under a burst — well under 1 s for 1500 events.
    expect(dispatchMs).toBeLessThan(1000);

    // Wait for the final flush + the component to render the final buffer.
    const output = await screen.findByTestId('mongo-shell-output');
    await waitFor(() => {
      expect(output.textContent?.length ?? 0).toBeGreaterThan(0);
    });

    // The buffer in state has the cap applied; the rendered DOM may be a
    // touch larger because of any leading framing / status text the pane
    // adds. Assert the rendered text doesn't blow past the cap by a wide
    // margin — i.e., the slice-from-front is firing.
    const len = output.textContent?.length ?? 0;
    expect(len).toBeLessThan(220_000);
    expect(len).toBeGreaterThan(150_000);
  });

  // ─── Stick-to-bottom scrolling ─────────────────────────────────────────
  //
  // jsdom never lays out content, so scrollHeight/clientHeight/scrollTop are
  // all 0 by default. Stub them via Object.defineProperty on the output
  // <pre> to simulate a scrolled-up viewport before dispatching output.

  function stubScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      writable: true,
      value: metrics.scrollTop,
    });
  }

  it('keeps following new output when the user was at the bottom', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate a viewport where the user is pinned to the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    fireEvent.scroll(output);

    // The next chunk grows scrollHeight; a pinned user should be scrolled
    // to follow it.
    stubScrollMetrics(output, { scrollHeight: 600, clientHeight: 200, scrollTop: 300 });
    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'more output\n' });

    await waitFor(() => expect(output.textContent).toContain('more output'));
    expect(output.scrollTop).toBe(600);
  });

  it('leaves scrollTop unchanged when the user has scrolled up', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate the user having scrolled up, away from the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 50 });
    fireEvent.scroll(output);

    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'more output\n' });

    await waitFor(() => expect(output.textContent).toContain('more output'));
    // scrollTop must stay put — no forced jump to the bottom.
    expect(output.scrollTop).toBe(50);
  });

  it('re-pins to the bottom when the user submits a command while scrolled up', async () => {
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    const input = await screen.findByLabelText('Mongo shell input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate the user having scrolled up, away from the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 50 });
    fireEvent.scroll(output);
    expect(output.scrollTop).toBe(50);

    // Submitting a command — even while scrolled up — must surface its
    // echo and output, like a real terminal.
    fireEvent.change(input, { target: { value: 'db.stats()' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(output.textContent).toContain('db.stats()'));
    expect(output.scrollTop).toBe(output.scrollHeight);
  });
});
