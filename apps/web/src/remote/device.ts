import { useEffect } from 'react';

/** Haptic feedback; silently ignored where the Vibration API is missing (iOS Safari). */
export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

/** Keeps the screen on while mounted. Re-acquires after the tab becomes visible again. Unsupported or denied: ignored. */
export function useWakeLock(): void {
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let alive = true;
    const acquire = () => {
      wl.request('screen').then(
        (s) => {
          if (alive) sentinel = s;
          else void s.release().catch(() => {});
        },
        () => {},
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, []);
}
