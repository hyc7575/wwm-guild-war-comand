import type { MetricsSnapshot } from '../metrics';
import type { SessionSummary } from './types';

/** Nearest-rank percentile (p in 0..100). Empty input gives 0. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export interface SummaryInput {
  roomCode: string;
  startedAt: number;
  endedAt: number;
  metrics: Pick<MetricsSnapshot, 'issuedVoice' | 'issuedManual' | 'candidateShown' | 'candidatePublished' | 'corrected' | 'latencies'>;
  stt: { activeListeningMs: number; recoveries: number };
  peakMembers: number;
  /** Keyed by party number. */
  peakByParty: Record<string, number>;
  cancelled: { misrecognized: number; changed: number };
}

export function buildSessionSummary(i: SummaryInput): SessionSummary {
  return {
    roomCode: i.roomCode,
    startedAt: i.startedAt,
    endedAt: i.endedAt,
    sttActiveMs: Math.round(i.stt.activeListeningMs),
    sttRecoveries: i.stt.recoveries,
    peakMembers: i.peakMembers,
    peakByParty: { ...i.peakByParty },
    issued: { voice: i.metrics.issuedVoice, manual: i.metrics.issuedManual },
    candidates: { shown: i.metrics.candidateShown, published: i.metrics.candidatePublished },
    cancelled: { ...i.cancelled },
    corrected: i.metrics.corrected,
    latencyMs: { p50: percentile(i.metrics.latencies, 50), p95: percentile(i.metrics.latencies, 95) },
  };
}
