import type { SessionSummary } from './types';

export function summaryFileName(s: SessionSummary): string {
  const d = new Date(s.endedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `winds-summary-${s.roomCode}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** FR-F07-9: download the summary as a JSON file. */
export function downloadSummaryJson(s: SessionSummary): void {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = summaryFileName(s);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
