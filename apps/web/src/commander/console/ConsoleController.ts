import type { Action, Location, Party, RoomSettingsPatch, SttState, Target } from '@winds/protocol';
import { DEFAULT_DICTIONARY, parse, type CommandDraft, type Dictionary } from '@winds/parser';
import type { RequestInput, SendPayload, UnsentCommand } from '../../net/RoomClient';
import type { AckRecord } from '../../state/roomReducer';
import type { RoomStore } from '../../state/roomStore';
import { describeDraft } from '../labels';
import { SessionMetrics, type MetricsSink } from '../metrics';
import type { SessionSummaryCollector } from '../summary/collector';
import { CommandPipeline } from '../pipeline/CommandPipeline';
import { IdbTuningLog, type TuningLog } from '../pipeline/tuningLog';
import { IssueTracker, type AckInfo } from './IssueTracker';
import { findLastActive } from './selectors';

export interface ConsoleClient {
  request(input: RequestInput): string;
  send(msg: SendPayload): boolean;
}

export interface ConsoleStore {
  getState(): Pick<RoomStore, 'parties' | 'settings' | 'commands' | 'slots' | 'ackLog' | 'ackCounter' | 'dismissUnsent'>;
  subscribe(fn: (s: ReturnType<ConsoleStore['getState']>, prev: ReturnType<ConsoleStore['getState']>) => void): () => void;
}

export interface ConsoleOptions {
  client: ConsoleClient;
  store: ConsoleStore;
  tuningLog?: TuningLog;
  metrics?: MetricsSink;
  /** Dictionary getter: the default one now, merged with the alliance dictionary (F09) later. */
  getDictionary?: () => Dictionary;
  now?: () => number;
  /** F07 session summary collector (commander console only). */
  summary?: SessionSummaryCollector;
}

export interface ManualDraft {
  target: Target;
  action: Action;
  location?: Location;
}

export interface TextPreview {
  drafts: CommandDraft[];
  labels: string[];
}

/** Wires client + store + tracker + pipeline for one console session. Framework-free. */
export class ConsoleController {
  readonly tracker: IssueTracker;
  readonly pipeline: CommandPipeline;
  readonly metrics: MetricsSink;
  readonly summary: SessionSummaryCollector | undefined;
  private readonly getDictionary: () => Dictionary;
  private readonly now: () => number;
  private readonly inFlightCancels = new Set<string>();
  private lastAckN: number;
  private readonly unsub: () => void;

  constructor(private readonly o: ConsoleOptions) {
    this.now = o.now ?? (() => Date.now());
    this.getDictionary = o.getDictionary ?? (() => DEFAULT_DICTIONARY);
    this.metrics = o.metrics ?? new SessionMetrics();
    this.summary = o.summary;
    this.tracker = new IssueTracker({ client: o.client, now: this.now });
    this.pipeline = new CommandPipeline({
      request: (input, label, onAck) => this.tracker.request(input, label, onAck),
      send: (msg) => o.client.send(msg),
      getState: () => {
        const s = o.store.getState();
        return { parties: s.parties, settings: s.settings, commands: s.commands };
      },
      getDictionary: this.getDictionary,
      metrics: this.metrics,
      tuningLog: o.tuningLog ?? new IdbTuningLog(),
      now: this.now,
    });
    this.lastAckN = o.store.getState().ackCounter;
    this.unsub = o.store.subscribe((s) => this.pumpAcks(s.ackLog, s.ackCounter));
  }

  dispose(): void {
    this.unsub();
    this.pipeline.dispose();
  }

  private pumpAcks(log: AckRecord[], counter: number): void {
    if (counter === this.lastAckN) return;
    for (const a of log) if (a.n > this.lastAckN) this.tracker.handleAck(a);
    this.lastAckN = counter;
  }

  private get parties(): Party[] {
    return this.o.store.getState().parties;
  }

  /** Dictionary locations for the button panel, in the F08 order (좌측 중앙 우측 앞 뒤, then the rest). */
  locations(): Location[] {
    const dict = this.getDictionary().locations;
    const preferred = ['LEFT', 'CENTER', 'RIGHT', 'FRONT', 'BACK'];
    const head = preferred.flatMap((id) => dict.filter((l) => l.id === id));
    const rest = dict.filter((l) => !preferred.includes(l.id));
    return [...head, ...rest].map((l) => ({ id: l.id, label: l.label }));
  }

  // ---------- manual issue / cancel ----------

  issueManual(d: ManualDraft, source: 'MANUAL' = 'MANUAL'): string {
    const id = this.tracker.request(
      {
        type: 'command.issue',
        target: d.target,
        action: d.action,
        ...(d.location ? { location: d.location } : {}),
        source,
      },
      describeDraft(d, this.parties),
    );
    this.metrics.issuedManual();
    return id;
  }

  cancelCommand(commandId: string): string {
    const cmd = this.o.store.getState().commands[commandId];
    const label = cmd ? `${describeDraft(cmd, this.parties)} 취소` : '명령 취소';
    this.inFlightCancels.add(commandId);
    this.metrics.cancelled('MANUAL');
    return this.tracker.request({ type: 'command.cancel', commandId }, label, (ack) => {
      // Success: the cancel event removes it from the slots. Failure: allow trying again.
      if (ack.error) this.inFlightCancels.delete(commandId);
    });
  }

  /** FR-F08-6. Repeated calls walk back, even before the previous cancel event has arrived. */
  cancelLast(): string | undefined {
    const s = this.o.store.getState();
    for (const id of [...this.inFlightCancels]) {
      const c = s.commands[id];
      if (!c || c.status === 'CANCELLED') this.inFlightCancels.delete(id);
    }
    const last = findLastActive(s, this.inFlightCancels);
    return last ? this.cancelCommand(last.id) : undefined;
  }

  // ---------- text command (FR-F08-4) ----------

  previewText(text: string): TextPreview {
    const t = text.trim();
    if (!t) return { drafts: [], labels: [] };
    const s = this.o.store.getState();
    const results = parse(t, {
      parties: s.parties,
      dictionary: this.getDictionary(),
      now: this.now(),
      // The commander confirms with Enter, so a targetless command may default to ALL.
      options: { targetlessAsAll: true },
    });
    const drafts = results.flatMap((r) => (r.kind === 'ISSUE' ? [r.draft] : []));
    return { drafts, labels: drafts.map((d) => describeDraft(d, s.parties)) };
  }

  issueText(text: string): number {
    const { drafts } = this.previewText(text);
    for (const d of drafts) this.issueManual(d);
    return drafts.length;
  }

  // ---------- room admin (commander only; the server rejects OPERATOR) ----------

  updateParties(baseVersion: number, parties: Party[], onAck: (ack: AckInfo) => void): string {
    return this.tracker.request({ type: 'parties.update', baseVersion, parties }, '파티 구성 적용', onAck);
  }

  updateSettings(settings: RoomSettingsPatch): string {
    return this.tracker.request({ type: 'room.settings', settings }, '방 설정 변경');
  }

  closeRoom(): string {
    // FR-F07-8: save the final summary just before the close request leaves.
    void this.summary?.finalize();
    return this.tracker.request({ type: 'room.close' }, '방 종료');
  }

  /** F02: tell the server the STT state (fire and forget; resent by the STT panel after reconnects). */
  sendSttStatus(state: SttState): boolean {
    return this.o.client.send({ type: 'stt.status', state });
  }

  // ---------- unsent (F10) ----------

  resend(item: UnsentCommand): void {
    this.o.store.getState().dismissUnsent(item.clientCmdId);
    this.tracker.request(item.msg, describeRequest(item.msg, this.parties));
  }

  discard(item: UnsentCommand): void {
    this.o.store.getState().dismissUnsent(item.clientCmdId);
  }
}

export function describeRequest(msg: RequestInput, parties: Party[]): string {
  switch (msg.type) {
    case 'command.issue':
      return describeDraft(msg, parties);
    case 'command.cancel':
      return '명령 취소';
    case 'command.correct':
      return '명령 정정';
    case 'parties.update':
      return '파티 구성 적용';
    case 'room.settings':
      return '방 설정 변경';
    case 'room.close':
      return '방 종료';
  }
}
