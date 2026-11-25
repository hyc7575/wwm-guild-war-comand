import type { Command, Party, Presence, Role } from '@winds/protocol';
import type { MetricsSnapshot } from '../metrics';
import { buildSessionSummary } from './build';
import type { SummaryStore } from './store';
import type { SessionSummary, StoredSummary } from './types';

export const TEMP_SAVE_MS = 60_000;

export interface CollectorState {
  presence: Presence;
  parties: Party[];
  commands: Record<string, Command>;
  roomStatus: 'OPEN' | 'CLOSED';
  lastEvent: { seq: number; kind: string; commandId?: string; commandIds?: string[]; cancelledBy?: Role } | null;
}

export interface CollectorSource {
  getState(): CollectorState;
  subscribe(fn: (s: CollectorState) => void): () => void;
}

export interface CollectorOptions {
  roomCode: string;
  source: CollectorSource;
  store: SummaryStore;
  getMetrics: () => MetricsSnapshot;
  now?: () => number;
  intervalMs?: number;
}

type SttStats = { activeListeningMs: number; recoveries: number };

/**
 * Accumulates what the F07 session summary needs for one room, saves a temp copy every minute and the
 * final copy when the room closes. After a reload it continues from the last temp save of the same room.
 */
export class SessionSummaryCollector {
  private readonly now: () => number;
  private startedAt: number;
  private peakMembers = 0;
  private peakByParty: Record<string, number> = {};
  private cancelled = { misrecognized: 0, changed: 0 };
  private issuedByRole = { COMMANDER: 0, SUB_COMMANDER: 0, OPERATOR: 0 };
  private cancelledByOthers = { SUB_COMMANDER: 0, OPERATOR: 0 };
  private seenCancels = new Set<string>();
  private lastSeq = -1;
  private sttStats: () => SttStats = () => ({ activeListeningMs: 0, recoveries: 0 });
  private base: StoredSummary | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsub: (() => void) | undefined;
  private final: SessionSummary | undefined;
  private finalizing: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  private ready: Promise<void> = Promise.resolve();

  constructor(private readonly o: CollectorOptions) {
    this.now = o.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  setSttStats(fn: () => SttStats): void {
    this.sttStats = fn;
  }

  /** The final summary once the room is closed (also notifies subscribers). */
  getFinal(): SessionSummary | undefined {
    return this.final;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  start(): Promise<void> {
    this.ready = this.o.store.loadTemp(this.o.roomCode).then((t) => {
      if (t && !this.finalizing) {
        this.base = t;
        this.startedAt = Math.min(this.startedAt, t.summary.startedAt);
      }
    });
    this.observe(this.o.source.getState());
    this.unsub = this.o.source.subscribe((s) => this.observe(s));
    this.timer = setInterval(() => void this.saveTemp(), this.o.intervalMs ?? TEMP_SAVE_MS);
    return this.ready;
  }

  private observe(s: CollectorState): void {
    this.peakMembers = Math.max(this.peakMembers, s.presence.total);
    for (const [pid, n] of Object.entries(s.presence.byParty)) {
      const num = s.parties.find((p) => p.id === pid)?.number;
      if (num === undefined) continue;
      const k = String(num);
      this.peakByParty[k] = Math.max(this.peakByParty[k] ?? 0, n);
    }
    const ev = s.lastEvent;
    if (ev && ev.seq !== this.lastSeq) {
      this.lastSeq = ev.seq;
      if (ev.kind === 'command.issued' && ev.commandId) {
        // Counted from the event's issuer.role only. A command without issuer (old room) is not counted by role.
        const role = s.commands[ev.commandId]?.issuer?.role;
        if (role) this.issuedByRole[role]++;
      }
      if (ev.kind === 'command.cancelled') {
        // No cancelledBy = the main commander (old servers). Others are kept out of the KR3 numbers.
        const by = ev.cancelledBy;
        const other = by === 'SUB_COMMANDER' || by === 'OPERATOR' ? by : undefined;
        for (const id of ev.commandIds ?? []) {
          if (this.seenCancels.has(id)) continue;
          this.seenCancels.add(id);
          const reason = s.commands[id]?.cancelReason;
          if (other) {
            if (reason === 'MISRECOGNIZED' || reason === 'CHANGED') this.cancelledByOthers[other]++;
          } else if (reason === 'MISRECOGNIZED') this.cancelled.misrecognized++;
          else if (reason === 'CHANGED') this.cancelled.changed++;
          // PARTY_REMOVED is a structural edit, not a commander decision: not counted.
        }
      }
    }
    if (s.roomStatus === 'CLOSED') void this.finalize();
  }

  /** Current numbers as a summary (base from before a reload + this page's numbers). */
  snapshot(): StoredSummary {
    const m = this.o.getMetrics();
    const b = this.base?.summary;
    const stt = this.sttStats();
    const latencies = [...(this.base?.latencies ?? []), ...m.latencies];
    const peakByParty = { ...(b?.peakByParty ?? {}) };
    for (const [k, v] of Object.entries(this.peakByParty)) peakByParty[k] = Math.max(peakByParty[k] ?? 0, v);
    const now = this.now();
    const summary = buildSessionSummary({
      roomCode: this.o.roomCode,
      startedAt: this.startedAt,
      endedAt: now,
      metrics: {
        issuedVoice: m.issuedVoice + (b?.issued.voice ?? 0),
        issuedManual: m.issuedManual + (b?.issued.manual ?? 0),
        candidateShown: m.candidateShown + (b?.candidates.shown ?? 0),
        candidatePublished: m.candidatePublished + (b?.candidates.published ?? 0),
        corrected: m.corrected + (b?.corrected ?? 0),
        latencies,
      },
      stt: {
        activeListeningMs: stt.activeListeningMs + (b?.sttActiveMs ?? 0),
        recoveries: stt.recoveries + (b?.sttRecoveries ?? 0),
      },
      peakMembers: Math.max(this.peakMembers, b?.peakMembers ?? 0),
      peakByParty,
      cancelled: {
        misrecognized: this.cancelled.misrecognized + (b?.cancelled.misrecognized ?? 0),
        changed: this.cancelled.changed + (b?.cancelled.changed ?? 0),
      },
      issuedByRole: {
        COMMANDER: this.issuedByRole.COMMANDER + (b?.issued.byRole?.COMMANDER ?? 0),
        SUB_COMMANDER: this.issuedByRole.SUB_COMMANDER + (b?.issued.byRole?.SUB_COMMANDER ?? 0),
        OPERATOR: this.issuedByRole.OPERATOR + (b?.issued.byRole?.OPERATOR ?? 0),
      },
      cancelledByOthers: {
        SUB_COMMANDER: this.cancelledByOthers.SUB_COMMANDER + (b?.cancelled.byOthers?.SUB_COMMANDER ?? 0),
        OPERATOR: this.cancelledByOthers.OPERATOR + (b?.cancelled.byOthers?.OPERATOR ?? 0),
      },
    });
    return { summary, temp: true, savedAt: now, latencies };
  }

  async saveTemp(): Promise<void> {
    if (this.finalizing) return;
    await this.ready;
    if (this.finalizing) return;
    await this.o.store.saveTemp(this.snapshot());
  }

  /** Final save. Idempotent: the first call wins (room.close sent, then room.closed received). */
  finalize(): Promise<void> {
    if (this.finalizing) return this.finalizing;
    this.stopTimer();
    this.finalizing = (async () => {
      await this.ready;
      // Reloading an already closed room must not overwrite the real summary with an empty one.
      const prior = (await this.o.store.listFinals()).find((f) => f.summary.roomCode === this.o.roomCode);
      if (prior) {
        this.final = prior.summary;
        for (const fn of this.listeners) fn();
        return;
      }
      const stored: StoredSummary = { ...this.snapshot(), temp: false };
      this.final = stored.summary;
      for (const fn of this.listeners) fn();
      await this.o.store.saveFinal(stored);
    })();
    return this.finalizing;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Leaving the console without closing the room: keep a last temp save. */
  dispose(): void {
    this.stopTimer();
    this.unsub?.();
    this.unsub = undefined;
    void this.saveTemp();
  }
}
