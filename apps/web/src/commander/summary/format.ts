import type { SessionSummary } from './types';

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분 ${s}초`;
  return `${s}초`;
}

export const fmtDateTime = (t: number) => new Date(t).toLocaleString('ko-KR', { hour12: false });

export const fmtLatency = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`);

/** Published / shown, or "-" when nothing was shown. */
export function publishRate(s: SessionSummary): string {
  return s.candidates.shown ? `${Math.round((s.candidates.published / s.candidates.shown) * 100)}%` : '-';
}
