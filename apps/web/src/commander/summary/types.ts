/** F07 "세션 요약 항목". The shape is fixed by the doc. */
export interface SessionSummary {
  roomCode: string;
  startedAt: number;
  endedAt: number;
  sttActiveMs: number;
  sttRecoveries: number;
  peakMembers: number;
  /** Keyed by party NUMBER (not id), the way the commander thinks of parties. */
  peakByParty: Record<string, number>;
  issued: { voice: number; manual: number };
  candidates: { shown: number; published: number };
  cancelled: { misrecognized: number; changed: number };
  corrected: number;
  latencyMs: { p50: number; p95: number };
}

/** What is persisted. `temp` marks a periodic save of a session that was never closed. */
export interface StoredSummary {
  summary: SessionSummary;
  temp: boolean;
  savedAt: number;
  /** Raw latencies, kept so that a reload can keep adding to the same percentile base. */
  latencies?: number[];
}
