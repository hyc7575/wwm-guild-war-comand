export interface IssuedByRole {
  COMMANDER: number;
  SUB_COMMANDER: number;
  OPERATOR: number;
}
export interface CancelledByOthers {
  SUB_COMMANDER: number;
  OPERATOR: number;
}

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
  /**
   * `byRole` counts command.issued events by issuer.role only (never the local request metrics).
   * Optional: summaries saved before the SUB_COMMANDER role do not have it (read with `?? 0`).
   */
  issued: { voice: number; manual: number; byRole?: IssuedByRole };
  candidates: { shown: number; published: number };
  /** misrecognized/changed = cancels by the main commander only (KR3). Others are counted by role below. */
  cancelled: { misrecognized: number; changed: number; byOthers?: CancelledByOthers };
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
