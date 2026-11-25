import { useEffect, useState } from 'react';

/** Re-renders every `ms` with the current time (elapsed counters, countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function elapsedText(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s}초 전`;
  return `${Math.floor(s / 60)}분 ${s % 60}초 전`;
}
