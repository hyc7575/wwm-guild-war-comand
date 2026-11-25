import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPipAdapter, type PipAdapter, type PipWindowHandle } from './pipAdapter';

export interface PipState {
  supported: boolean;
  /** the open PiP window, or null (render the normal HUD) */
  win: Window | null;
  error: string | null;
  open(): Promise<void>;
  close(): void;
}

/** Owns the PiP window lifecycle: open on demand, fall back when closed, close with the page. */
export function usePipWindow(adapter?: PipAdapter): PipState {
  const ad = useMemo(() => adapter ?? createPipAdapter(), [adapter]);
  const [win, setWin] = useState<Window | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<PipWindowHandle | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const opening = useRef(false);

  const release = useCallback(() => {
    unsub.current?.();
    unsub.current = null;
    handle.current = null;
    setWin(null);
  }, []);

  const close = useCallback(() => {
    const h = handle.current;
    unsub.current?.();
    unsub.current = null;
    handle.current = null;
    setWin(null);
    h?.close();
  }, []);

  const open = useCallback(async () => {
    if (handle.current || opening.current) return;
    if (!ad.isSupported()) {
      setError('UNSUPPORTED');
      return;
    }
    opening.current = true;
    setError(null);
    try {
      const h = await ad.open();
      handle.current = h;
      unsub.current = h.onClose(release);
      setWin(h.window);
    } catch {
      setError('OPEN_FAILED');
    } finally {
      opening.current = false;
    }
  }, [ad, release]);

  // closing the main page (reload, tab close, route change) closes the PiP too
  useEffect(() => {
    const onHide = () => handle.current?.close();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      const h = handle.current;
      unsub.current?.();
      handle.current = null;
      h?.close();
    };
  }, []);

  return { supported: ad.isSupported(), win, error, open, close };
}
