import type { RequestInput } from '../../net/RoomClient';

export const ACK_DELAY_MS = 2000;
const MAX_ENTRIES = 20;

export interface AckInfo {
  commandId?: string;
  error?: string;
  note?: string;
  /** Local time the ack was handled. */
  at: number;
}

export interface TrackedRequest {
  clientCmdId: string;
  label: string;
  sentAt: number;
  ack?: AckInfo;
}

export type AckStatus = 'PENDING' | 'DELAYED' | 'ACKED' | 'ERROR';

/** US-F04-2: pending -> spinner, acked -> check, >2s without ack -> "전송 지연", error -> reason. */
export function ackStatus(entry: Pick<TrackedRequest, 'sentAt' | 'ack'>, now: number): AckStatus {
  if (entry.ack) return entry.ack.error ? 'ERROR' : 'ACKED';
  return now - entry.sentAt > ACK_DELAY_MS ? 'DELAYED' : 'PENDING';
}

interface TrackerDeps {
  client: { request(input: RequestInput): string };
  now?: () => number;
}

type AckCallback = (ack: AckInfo) => void;

/** Sends client requests and remembers them until their ack arrives. Framework-free. */
export class IssueTracker {
  private entries: TrackedRequest[] = [];
  private callbacks = new Map<string, AckCallback[]>();
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: TrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Send `input` and track it. `onAck` fires once when the ack for this request arrives. */
  request(input: RequestInput, label: string, onAck?: AckCallback): string {
    const id = this.deps.client.request(input);
    this.track(id, label, onAck);
    return id;
  }

  /** Track a request that was already sent (e.g. an unsent command re-sent from the store). */
  track(clientCmdId: string, label: string, onAck?: AckCallback): void {
    this.entries = [...this.entries, { clientCmdId, label, sentAt: this.now() }].slice(-MAX_ENTRIES);
    if (onAck) this.callbacks.set(clientCmdId, [...(this.callbacks.get(clientCmdId) ?? []), onAck]);
    this.emit();
  }

  /** Feed every server ack here (wired from the store). */
  handleAck(ack: { clientCmdId: string; commandId?: string; error?: string; note?: string }): void {
    const info: AckInfo = {
      at: this.now(),
      ...(ack.commandId !== undefined ? { commandId: ack.commandId } : {}),
      ...(ack.error !== undefined ? { error: ack.error } : {}),
      ...(ack.note !== undefined ? { note: ack.note } : {}),
    };
    this.entries = this.entries.map((e) => (e.clientCmdId === ack.clientCmdId && !e.ack ? { ...e, ack: info } : e));
    const cbs = this.callbacks.get(ack.clientCmdId);
    if (cbs) {
      this.callbacks.delete(ack.clientCmdId);
      for (const cb of cbs) cb(info);
    }
    this.emit();
  }

  get(clientCmdId: string): TrackedRequest | undefined {
    return this.entries.find((e) => e.clientCmdId === clientCmdId);
  }

  getEntries(): TrackedRequest[] {
    return this.entries;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
