import { LIMITS, type Command, type Party, type RoomSettings, type SttFeedOutcome } from '@winds/protocol';
import { parse, type CommandDraft, type Dictionary, type ParseResult } from '@winds/parser';
import type { RequestInput, SendPayload } from '../../net/RoomClient';
import type { AckInfo } from '../console/IssueTracker';
import { describeDraft, describePatch } from '../labels';
import type { MetricsSink } from '../metrics';
import type { TuningLog } from './tuningLog';

export const SUBTITLE_MAX = 5;
export const FEED_FLUSH_MS = 300;
/** protocol confidence is 0..1; the parser only reports HIGH/MEDIUM. */
export const CONFIDENCE_VALUE = { HIGH: 0.9, MEDIUM: 0.5 } as const;

export type ChipKind = 'ISSUED' | 'CANDIDATE' | 'CORRECTED' | 'CANCELLED' | 'DISCARDED';

/** Result chip next to a subtitle, e.g. "→ 3파티 방어 우측". Its ✓ comes from the ack of `clientCmdId`. */
export interface SubtitleChip {
  kind: ChipKind;
  label: string;
  clientCmdId?: string;
  candidateId?: string;
}

export interface SubtitleLine {
  id: string;
  text: string;
  at: number;
  chips: SubtitleChip[];
}

export interface Candidate {
  id: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  confidence: number;
  kind: 'ISSUE' | 'CORRECT';
  /** Human summary: "전체 집결 중앙" or "→ 우측 이동 (정정)". */
  label: string;
  draft?: CommandDraft;
  correctsId?: string;
  patch?: Partial<CommandDraft>;
}

/** What the button panel is filled with when a candidate is edited. correctsId is set for CORRECT candidates. */
export type EditedDraft = Partial<CommandDraft> & { correctsId?: string };

export interface PipelineSnapshot {
  subtitles: SubtitleLine[];
  partial: string;
  candidates: Candidate[];
}

export interface PipelineState {
  parties: Party[];
  settings: Pick<RoomSettings, 'targetlessAsAll'>;
  commands: Record<string, Command>;
}

export interface PipelineDeps {
  request(input: RequestInput, label: string, onAck?: (ack: AckInfo) => void): string;
  send(msg: SendPayload): boolean;
  getState(): PipelineState;
  getDictionary(): Dictionary;
  metrics: MetricsSink;
  tuningLog: TuningLog;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  uuid?: () => string;
}

interface LastVoice {
  clientCmdId: string;
  commandId?: string;
  issuedAt: number;
}

interface FeedEntry {
  id: string;
  at: number;
  text: string;
  outcome: SttFeedOutcome;
  summary?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * F03 pipeline for the commander browser: STT final text -> parse -> issue / correct / cancel /
 * candidate / tuning log. Framework-free; the STT engine calls onFinalTranscript/onPartialTranscript.
 */
export class CommandPipeline {
  private snap: PipelineSnapshot = { subtitles: [], partial: '', candidates: [] };
  private listeners = new Set<() => void>();
  private lastVoice?: LastVoice;
  private feedQueue: FeedEntry[] = [];
  private feedTimer: unknown = null;
  private candidateTimers = new Map<string, unknown>();
  private seq = 0;
  private disposed = false;

  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (id: unknown) => void;
  private readonly uuid: () => string;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setT = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearT = deps.clearTimer ?? ((id) => globalThis.clearTimeout(id as number));
    this.uuid = deps.uuid ?? (() => `${this.now().toString(36)}${(this.seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  }

  // ---------- public ----------

  getSnapshot(): PipelineSnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onPartialTranscript(text: string): void {
    if (this.disposed) return;
    this.set({ partial: text });
  }

  onFinalTranscript(rawText: string, opts: { endedAt: number }): void {
    if (this.disposed) return;
    const text = rawText.trim();
    if (!text) return;
    const now = this.now();
    const state = this.deps.getState();
    const results = parse(text, {
      parties: state.parties,
      dictionary: this.deps.getDictionary(),
      lastVoiceCommand: this.resolveLastVoice(state),
      now,
      options: { targetlessAsAll: state.settings.targetlessAsAll },
    });

    const line: SubtitleLine = { id: this.uuid(), text, at: now, chips: [] };
    // Candidates are added after the line so a re-render never shows a candidate without its line.
    for (const r of results) this.handleResult(r, line, text, opts.endedAt, state.parties);
    this.set({ partial: '', subtitles: [...this.snap.subtitles, line].slice(-SUBTITLE_MAX) });
  }

  publishCandidate(id: string): void {
    const c = this.snap.candidates.find((x) => x.id === id);
    if (!c) return;
    this.removeCandidate(id);
    const base = { source: 'VOICE' as const, transcript: clip(c.text, LIMITS.transcriptMax), confidence: c.confidence };
    let clientCmdId: string;
    if (c.kind === 'ISSUE' && c.draft) {
      clientCmdId = this.issue(c.draft, base, c.label);
    } else if (c.kind === 'CORRECT' && c.correctsId && c.patch) {
      clientCmdId = this.correct(c.correctsId, c.patch, base, c.label);
    } else return;
    this.deps.metrics.candidatePublished();
    this.queueFeed(c.text, 'ISSUED', `후보 발행 · ${c.label}`);
    this.retag(id, { kind: 'ISSUED', label: c.label, clientCmdId });
  }

  /** Removes the candidate and returns what the button panel should be filled with. */
  editCandidate(id: string): EditedDraft | undefined {
    const c = this.snap.candidates.find((x) => x.id === id);
    if (!c) return undefined;
    this.removeCandidate(id);
    if (c.kind === 'ISSUE') return c.draft;
    const base = this.deps.getState().commands[c.correctsId ?? ''];
    return {
      ...(base
        ? {
            target: base.target,
            action: base.action,
            location: base.location,
            ...(base.supportPartyIds?.length ? { supportPartyIds: base.supportPartyIds } : {}),
          }
        : {}),
      ...(c.patch ?? {}),
      // Keep the link so publishing the edited candidate is still a correction (command.correct).
      ...(c.correctsId ? { correctsId: c.correctsId } : {}),
    };
  }

  dismissCandidate(id: string): void {
    this.removeCandidate(id);
  }

  /** Flush pending feed entries now and stop timers. */
  dispose(): void {
    this.flushFeed();
    this.disposed = true;
    for (const t of this.candidateTimers.values()) this.clearT(t);
    this.candidateTimers.clear();
    this.listeners.clear();
  }

  // ---------- result handling ----------

  private handleResult(r: ParseResult, line: SubtitleLine, text: string, endedAt: number, parties: Party[]): void {
    const m = this.deps.metrics;
    switch (r.kind) {
      case 'ISSUE': {
        const label = describeDraft(r.draft, parties);
        if (r.confidence === 'HIGH') {
          const id = this.issue(r.draft, this.voiceFields(text, r.confidence), label, endedAt);
          line.chips.push({ kind: 'ISSUED', label, clientCmdId: id });
          this.queueFeed(text, 'ISSUED', label);
        } else {
          const c = this.addCandidate({ kind: 'ISSUE', text, label, confidence: CONFIDENCE_VALUE.MEDIUM, draft: r.draft });
          line.chips.push({ kind: 'CANDIDATE', label, candidateId: c.id });
          this.queueFeed(text, 'CANDIDATE', `후보 · ${label}`);
        }
        return;
      }
      case 'CORRECT': {
        const label = `${describePatch(r.patch, parties)} (정정)`;
        if (r.confidence === 'HIGH') {
          const id = this.correct(r.correctsId, r.patch, this.voiceFields(text, r.confidence), label, endedAt);
          m.corrected();
          line.chips.push({ kind: 'CORRECTED', label, clientCmdId: id });
          this.queueFeed(text, 'CORRECTED', label);
        } else {
          const c = this.addCandidate({
            kind: 'CORRECT',
            text,
            label,
            confidence: CONFIDENCE_VALUE.MEDIUM,
            correctsId: r.correctsId,
            patch: r.patch,
          });
          line.chips.push({ kind: 'CANDIDATE', label, candidateId: c.id });
          this.queueFeed(text, 'CANDIDATE', `후보 · ${label}`);
        }
        return;
      }
      case 'CANCEL': {
        const target = this.deps.getState().commands[r.commandId];
        const label = target ? `${describeDraft(target, parties)} 취소` : '직전 명령 취소';
        const id = this.deps.request({ type: 'command.cancel', commandId: r.commandId }, label);
        this.lastVoice = undefined;
        m.cancelled('VOICE');
        line.chips.push({ kind: 'CANCELLED', label, clientCmdId: id });
        this.queueFeed(text, 'CANCELLED', label);
        return;
      }
      case 'NONE': {
        void this.deps.tuningLog.add({ at: this.now(), text, reason: r.reason });
        this.queueFeed(text, 'DISCARDED', clip(r.reason, 100));
        return;
      }
    }
  }

  private voiceFields(text: string, c: 'HIGH' | 'MEDIUM') {
    return { source: 'VOICE' as const, transcript: clip(text, LIMITS.transcriptMax), confidence: CONFIDENCE_VALUE[c] };
  }

  private issue(
    draft: CommandDraft,
    base: { source: 'VOICE'; transcript: string; confidence: number },
    label: string,
    endedAt?: number,
  ): string {
    const issuedAt = this.now();
    const id = this.deps.request(
      {
        type: 'command.issue',
        target: draft.target,
        action: draft.action,
        ...(draft.location ? { location: draft.location } : {}),
        ...(draft.supportPartyIds?.length ? { supportPartyIds: draft.supportPartyIds } : {}),
        ...base,
      },
      label,
      (ack) => this.onVoiceAck(id, ack, endedAt),
    );
    this.lastVoice = { clientCmdId: id, issuedAt };
    return id;
  }

  private correct(
    correctsId: string,
    patch: Partial<CommandDraft>,
    base: { source: 'VOICE'; transcript: string; confidence: number },
    label: string,
    endedAt?: number,
  ): string {
    const issuedAt = this.now();
    const id = this.deps.request(
      {
        type: 'command.correct',
        correctsId,
        ...(patch.target ? { target: patch.target } : {}),
        ...(patch.action ? { action: patch.action } : {}),
        ...(patch.location ? { location: patch.location } : {}),
        ...(patch.supportPartyIds?.length ? { supportPartyIds: patch.supportPartyIds } : {}),
        ...base,
      },
      label,
      (ack) => this.onVoiceAck(id, ack, endedAt),
    );
    this.lastVoice = { clientCmdId: id, issuedAt };
    return id;
  }

  private onVoiceAck(clientCmdId: string, ack: AckInfo, endedAt: number | undefined): void {
    if (ack.error) {
      if (this.lastVoice?.clientCmdId === clientCmdId) this.lastVoice = undefined;
      return;
    }
    if (this.lastVoice?.clientCmdId === clientCmdId && ack.commandId) this.lastVoice.commandId = ack.commandId;
    if (endedAt !== undefined) this.deps.metrics.latency(ack.at - endedAt);
  }

  /** Last VOICE command this pipeline issued, once acked and still live. */
  private resolveLastVoice(state: PipelineState): { command: Command; issuedAt: number } | undefined {
    const lv = this.lastVoice;
    if (!lv?.commandId) return undefined;
    const command = state.commands[lv.commandId];
    if (!command || command.status === 'CANCELLED' || command.status === 'CORRECTED') return undefined;
    return { command, issuedAt: lv.issuedAt };
  }

  // ---------- candidates ----------

  private addCandidate(c: Omit<Candidate, 'id' | 'createdAt' | 'expiresAt'>): Candidate {
    const createdAt = this.now();
    const cand: Candidate = { ...c, id: this.uuid(), createdAt, expiresAt: createdAt + LIMITS.candidateTtlMs };
    this.deps.metrics.candidateShown();
    this.candidateTimers.set(
      cand.id,
      this.setT(() => this.removeCandidate(cand.id), LIMITS.candidateTtlMs),
    );
    // Not through set(): onFinalTranscript publishes the snapshot once, after the subtitle line is final.
    this.snap = { ...this.snap, candidates: [...this.snap.candidates, cand] };
    return cand;
  }

  private removeCandidate(id: string): void {
    const t = this.candidateTimers.get(id);
    if (t !== undefined) this.clearT(t);
    this.candidateTimers.delete(id);
    if (this.snap.candidates.some((c) => c.id === id)) {
      this.set({ candidates: this.snap.candidates.filter((c) => c.id !== id) });
    }
  }

  private retag(candidateId: string, chip: SubtitleChip): void {
    this.set({
      subtitles: this.snap.subtitles.map((l) =>
        l.chips.some((c) => c.candidateId === candidateId)
          ? { ...l, chips: l.chips.map((c) => (c.candidateId === candidateId ? chip : c)) }
          : l,
      ),
    });
  }

  // ---------- operator feed (stt.feed) ----------

  private queueFeed(text: string, outcome: SttFeedOutcome, summary?: string): void {
    this.feedQueue.push({
      id: this.uuid(),
      at: this.now(),
      text: clip(text, LIMITS.transcriptMax),
      outcome,
      ...(summary ? { summary: clip(summary, 100) } : {}),
    });
    if (this.feedTimer === null) {
      this.feedTimer = this.setT(() => {
        this.feedTimer = null;
        this.flushFeed();
      }, FEED_FLUSH_MS);
    }
  }

  private flushFeed(): void {
    if (this.feedTimer !== null) {
      this.clearT(this.feedTimer);
      this.feedTimer = null;
    }
    while (this.feedQueue.length) {
      const entries = this.feedQueue.splice(0, LIMITS.sttFeedMaxEntries);
      this.deps.send({ type: 'stt.feed', entries });
    }
  }

  private set(patch: Partial<PipelineSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
