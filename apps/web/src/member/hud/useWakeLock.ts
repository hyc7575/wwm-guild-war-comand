import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
}

/** FR-F05-7: keep the screen on while enabled; re-acquire when the tab becomes visible again. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!enabled || !wl) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible' || sentinel) return;
      try {
        const s = await wl.request('screen');
        if (cancelled) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        /* denied (low battery etc.) */
      }
    };
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
