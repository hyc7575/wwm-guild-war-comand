/** Events the commander session records for the (later) session summary (F07 FR-F07-8). */
export type CancelOrigin = 'VOICE' | 'MANUAL';

export interface MetricsSink {
  issuedVoice(): void;
  issuedManual(): void;
  candidateShown(): void;
  candidatePublished(): void;
  cancelled(origin: CancelOrigin): void;
  corrected(): void;
  /** Milliseconds from the end of the utterance to the server ack. */
  latency(ms: number): void;
}

export interface MetricsSnapshot {
  issuedVoice: number;
  issuedManual: number;
  candidateShown: number;
  candidatePublished: number;
  cancelledVoice: number;
  cancelledManual: number;
  corrected: number;
  latencies: number[];
}

/** In-memory sink. Persisting it into a session summary is a later task. */
export class SessionMetrics implements MetricsSink {
  private d: MetricsSnapshot = {
    issuedVoice: 0,
    issuedManual: 0,
    candidateShown: 0,
    candidatePublished: 0,
    cancelledVoice: 0,
    cancelledManual: 0,
    corrected: 0,
    latencies: [],
  };

  issuedVoice() {
    this.d.issuedVoice++;
  }
  issuedManual() {
    this.d.issuedManual++;
  }
  candidateShown() {
    this.d.candidateShown++;
  }
  candidatePublished() {
    this.d.candidatePublished++;
  }
  cancelled(origin: CancelOrigin) {
    if (origin === 'VOICE') this.d.cancelledVoice++;
    else this.d.cancelledManual++;
  }
  corrected() {
    this.d.corrected++;
  }
  latency(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.d.latencies.push(ms);
  }

  snapshot(): MetricsSnapshot {
    return { ...this.d, latencies: [...this.d.latencies] };
  }

  /** Median latency, or null when nothing was measured. */
  medianLatency(): number | null {
    const l = [...this.d.latencies].sort((a, b) => a - b);
    if (!l.length) return null;
    const mid = Math.floor(l.length / 2);
    return l.length % 2 ? l[mid]! : Math.round((l[mid - 1]! + l[mid]!) / 2);
  }
}

export const NOOP_METRICS: MetricsSink = {
  issuedVoice() {},
  issuedManual() {},
  candidateShown() {},
  candidatePublished() {},
  cancelled() {},
  corrected() {},
  latency() {},
};
