import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { CompactHud } from './CompactHud';
import { copyStyles, createPipAdapter, PIP_DEFAULT_SIZE, type PipAdapter, type PipWindowHandle } from './pipAdapter';
import { usePipWindow } from './usePipWindow';

function fakeHandle() {
  const doc = document.implementation.createHTMLDocument('pip');
  const cbs: Array<() => void> = [];
  let closed = false;
  const fire = () => {
    if (closed) return;
    closed = true;
    cbs.forEach((c) => c());
  };
  const handle: PipWindowHandle = {
    window: { document: doc } as unknown as Window,
    close: vi.fn(fire),
    onClose(cb) {
      cbs.push(cb);
      return () => undefined;
    },
  };
  return { handle, userClose: fire };
}
function fakeAdapter(supported = true) {
  const f = fakeHandle();
  const adapter: PipAdapter = { isSupported: () => supported, open: vi.fn(async () => f.handle) };
  return { adapter, ...f };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
});

describe('createPipAdapter', () => {
  it('reports unsupported without the API and rejects open()', async () => {
    const a = createPipAdapter();
    expect(a.isSupported()).toBe(false);
    await expect(a.open()).rejects.toThrow('PIP_UNSUPPORTED');
  });

  it('opens with the default size, copies styles and reports pagehide as close', async () => {
    const doc = document.implementation.createHTMLDocument('pip');
    const listeners: Record<string, () => void> = {};
    const win = { document: doc, close: vi.fn(), addEventListener: (n: string, f: () => void) => (listeners[n] = f) } as unknown as Window;
    const requestWindow = vi.fn(async () => win);
    (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = { requestWindow };
    const style = document.createElement('style');
    style.textContent = '.x{color:red}';
    document.head.appendChild(style);

    const a = createPipAdapter();
    expect(a.isSupported()).toBe(true);
    const h = await a.open();
    expect(requestWindow).toHaveBeenCalledWith({ width: PIP_DEFAULT_SIZE.width, height: PIP_DEFAULT_SIZE.height });
    expect(doc.head.querySelectorAll('style').length).toBeGreaterThan(0);
    const onClose = vi.fn();
    h.onClose(onClose);
    listeners.pagehide!();
    listeners.pagehide!();
    expect(onClose).toHaveBeenCalledTimes(1);
    style.remove();
  });

  it('copyStyles falls back to <link> for sheets whose rules are not readable', () => {
    const to = document.implementation.createHTMLDocument('t');
    const from = {
      styleSheets: [
        {
          get cssRules(): never {
            throw new Error('SecurityError');
          },
          href: 'https://x.test/a.css',
        },
      ],
      documentElement: document.createElement('html'),
    } as unknown as Document;
    copyStyles(from, to);
    expect(to.head.querySelector('link')?.getAttribute('href')).toBe('https://x.test/a.css');
  });
});

describe('usePipWindow', () => {
  it('open -> win set; user close -> back to null', async () => {
    const { adapter, userClose } = fakeAdapter();
    const { result } = renderHook(() => usePipWindow(adapter));
    expect(result.current.supported).toBe(true);
    await act(() => result.current.open());
    expect(result.current.win).not.toBeNull();
    act(() => userClose());
    expect(result.current.win).toBeNull();
  });

  it('close() closes the window', async () => {
    const { adapter, handle } = fakeAdapter();
    const { result } = renderHook(() => usePipWindow(adapter));
    await act(() => result.current.open());
    act(() => result.current.close());
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(result.current.win).toBeNull();
  });

  it('unsupported: open() sets an error and never calls the adapter', async () => {
    const { adapter } = fakeAdapter(false);
    const { result } = renderHook(() => usePipWindow(adapter));
    expect(result.current.supported).toBe(false);
    await act(() => result.current.open());
    expect(adapter.open).not.toHaveBeenCalled();
    expect(result.current.error).toBe('UNSUPPORTED');
  });

  it('open failure is reported, state stays closed', async () => {
    const { adapter } = fakeAdapter();
    adapter.open = vi.fn(async () => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => usePipWindow(adapter));
    await act(() => result.current.open());
    expect(result.current.error).toBe('OPEN_FAILED');
    expect(result.current.win).toBeNull();
  });

  it('closes the PiP when the page hides or the component unmounts', async () => {
    const a1 = fakeAdapter();
    const r1 = renderHook(() => usePipWindow(a1.adapter));
    await act(() => r1.result.current.open());
    window.dispatchEvent(new Event('pagehide'));
    expect(a1.handle.close).toHaveBeenCalled();
    r1.unmount();

    const a2 = fakeAdapter();
    const r2 = renderHook(() => usePipWindow(a2.adapter));
    await act(() => r2.result.current.open());
    r2.unmount();
    expect(a2.handle.close).toHaveBeenCalled();
  });
});

describe('usePipWindow unmount while opening', () => {
  it('closes a window that arrives after the HUD unmounted', async () => {
    const f = fakeHandle();
    let resolve!: (h: PipWindowHandle) => void;
    const adapter: PipAdapter = { isSupported: () => true, open: () => new Promise<PipWindowHandle>((r) => (resolve = r)) };
    const { result, unmount } = renderHook(() => usePipWindow(adapter));
    let p!: Promise<void>;
    act(() => {
      p = result.current.open();
    });
    unmount();
    await act(async () => {
      resolve(f.handle);
      await p;
    });
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });
});

describe('CompactHud', () => {
  const parties = makeDefaultParties(4);
  const command: Command = {
    id: 'c1',
    seq: 1,
    target: { kind: 'PARTIES', partyIds: [parties[2]!.id] },
    action: 'DEFEND',
    location: { id: 'RIGHT', label: '우측' },
    status: 'ACTIVE',
    source: 'MANUAL',
    issuedAt: 1000,
    repeatCount: 0,
  };
  const presence = { total: 5, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'LISTENING' as const };
  const base = { connection: 'CONNECTED' as const, hasSnapshot: true, presence, parties, myParty: parties[2], command, now: 3000, fontScale: 1.3, onReturn: vi.fn() };

  it('shows my command, applies the font scale, returns on button', () => {
    const onReturn = vi.fn();
    render(<CompactHud {...base} onReturn={onReturn} flashing />);
    expect(screen.getByTestId('pip-card')).toBeInTheDocument();
    expect(screen.getByTestId('pip-card-action')).toHaveTextContent('방어');
    expect(screen.getByTestId('pip-card-location')).toHaveTextContent('우측');
    expect(screen.getByTestId('pip-hud').style.getPropertyValue('--hud-fs')).toBe('1.3');
    fireEvent.click(screen.getByTestId('pip-return'));
    expect(onReturn).toHaveBeenCalled();
  });

  it('connection banners', () => {
    const { rerender } = render(<CompactHud {...base} connection="RECONNECTING" dimmed />);
    expect(screen.getByTestId('pip-banner-reconnecting')).toBeInTheDocument();
    rerender(<CompactHud {...base} connection="OFFLINE" dimmed />);
    expect(screen.getByTestId('pip-banner-offline')).toBeInTheDocument();
  });

  it('no party chosen shows a hint, audio-blocked shows the unlock button', () => {
    const unlock = vi.fn();
    render(<CompactHud {...base} myParty={undefined} audioBlocked onUnlockAudio={unlock} />);
    expect(screen.getByTestId('pip-unselected-hint')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pip-enable-sound'));
    expect(unlock).toHaveBeenCalled();
  });

  it('shows the main-order / voice status like the status bar (FR-F10-6, FR-F05-11)', () => {
    const { rerender } = render(<CompactHud {...base} />);
    expect(screen.getByTestId('pip-status-commander')).toHaveTextContent('듣는 중');
    rerender(<CompactHud {...base} presence={{ ...presence, commanderOnline: false }} />);
    expect(screen.getByTestId('pip-status-commander')).toHaveTextContent('메인오더 연결 끊김');
    rerender(<CompactHud {...base} presence={{ ...presence, sttState: 'OFF' }} />);
    expect(screen.getByTestId('pip-status-commander')).toHaveTextContent('음성인식 꺼짐');
    rerender(<CompactHud {...base} connection="RECONNECTING" presence={{ ...presence, commanderOnline: false }} />);
    expect(screen.queryByTestId('pip-status-commander')).toBeNull();
  });
});
