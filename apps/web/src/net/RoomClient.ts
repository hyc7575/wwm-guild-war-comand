import {
  LIMITS,
  PING_STRING,
  parseServerMessage,
  type ClientMessage,
  type PartyId,
  type Role,
  type ServerMessage,
} from '@winds/protocol';

/**
 * Framework-free WebSocket client implementing F10 (connection state) and F04 (ack / resend).
 *
 * Reconnect strategy: the server always answers `hello` with a full snapshot, so we never ask
 * for "missed events". A seq gap is repaired the same way: drop the socket and reconnect
 * (immediately, no backoff) sending `lastSeq`; the protocol has no explicit snapshot request.
 */

export type ConnectionStatus =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'OFFLINE'
  | 'CLOSED'
  | 'REPLACED';

export type CloseReason =
  | 'ROOM_CLOSED'
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'ROOM_FULL'
  | 'LOCAL';

/** Client requests that carry a clientCmdId and expect an `ack`. */
export type RequestMsg = Extract<ClientMessage, { clientCmdId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestInput = DistributiveOmit<RequestMsg, 'v' | 'clientCmdId'>;

/** Fire-and-forget messages (no ack). */
export type SendInput = Extract<ClientMessage, { type: 'party.select' | 'stt.status' | 'stt.feed' }>;
export type SendPayload = DistributiveOmit<SendInput, 'v'>;

export interface UnsentCommand {
  clientCmdId: string;
  msg: RequestInput;
  createdAt: number;
  reason: 'STALE' | 'NO_ACK' | 'CLOSED';
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface RoomClientEnv {
  /** Subscribe to `online` | `offline` | `visibilitychange`. Returns unsubscribe. */
  on(type: 'online' | 'offline' | 'visibilitychange', fn: () => void): () => void;
  isOnline(): boolean;
  isVisible(): boolean;
}

export interface RoomClientHandlers {
  onStatus?(status: ConnectionStatus, closeReason: CloseReason | null): void;
  /** Every server message except pong. `event` messages are delivered only when in sequence. */
  onMessage?(msg: ServerMessage): void;
  onUnsent?(item: UnsentCommand): void;
  /** A late ack arrived (or the item was re-sent / discarded) for a command already reported unsent. */
  onUnsentResolved?(clientCmdId: string): void;
}

export interface RoomClientOptions {
  url: string;
  roomCode: string;
  clientId: string;
  role: Role;
  token?: string;
  nickname?: string;
  WebSocketImpl?: WebSocketCtor;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  random?: () => number;
  uuid?: () => string;
  env?: RoomClientEnv;
  handlers?: RoomClientHandlers;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8000;
export const BACKOFF_JITTER = 0.2;
export const ACK_TIMEOUT_MS = 2000;
export const MAX_RESENDS = 4;
const MAX_UNSENT_KEPT = 100;
const WS_OPEN = 1;

/** Base delay (before jitter) for the n-th retry, n starting at 0. */
export function backoffBase(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export function defaultEnv(): RoomClientEnv {
  return {
    on(type, fn) {
      const target: EventTarget = type === 'visibilitychange' ? document : window;
      target.addEventListener(type, fn);
      return () => target.removeEventListener(type, fn);
    },
    isOnline: () => navigator.onLine !== false,
    isVisible: () => document.visibilityState !== 'hidden',
  };
}

interface Pending {
  id: string;
  msg: RequestInput;
  createdAt: number;
  resends: number;
  timer: unknown;
  expiry: unknown;
}

export class RoomClient {
  private readonly o: RoomClientOptions;
  private readonly WS: WebSocketCtor;
  private readonly env: RoomClientEnv;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (id: unknown) => void;
  private readonly rand: () => number;
  private readonly uuid: () => string;
  private handlers: RoomClientHandlers;

  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = 'CONNECTING';
  private closeReason: CloseReason | null = null;
  private started = false;
  private stopped = false;
  private lastSeq: number | undefined;
  private attempt = 0;
  private lastRx = 0;
  private partyChoice: PartyId | null = null;
  /** Last stt.status passed to send(); re-sent after every welcome (server resets STT on commander close). */
  private lastStt: Extract<SendPayload, { type: 'stt.status' }> | null = null;
  /** Items reported unsent, kept so resend() can reuse the original clientCmdId. */
  private unsentItems = new Map<string, UnsentCommand>();

  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private deadTimer: unknown = null;
  private unsubs: Array<() => void> = [];
  private pending = new Map<string, Pending>();

  constructor(options: RoomClientOptions) {
    this.o = options;
    this.WS = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    this.env = options.env ?? defaultEnv();
    this.now = options.now ?? (() => Date.now());
    this.setT = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearT = options.clearTimer ?? ((id) => globalThis.clearTimeout(id as number));
    this.rand = options.random ?? Math.random;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.handlers = options.handlers ?? {};
  }

  // ---------- public API ----------

  getStatus(): ConnectionStatus {
    return this.status;
  }
  getCloseReason(): CloseReason | null {
    return this.closeReason;
  }
  getLastSeq(): number | undefined {
    return this.lastSeq;
  }
  setHandlers(h: RoomClientHandlers): void {
    this.handlers = h;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubs = [
      this.env.on('online', () => this.onOnline()),
      this.env.on('offline', () => this.onOffline()),
      this.env.on('visibilitychange', () => this.onVisibility()),
    ];
    if (!this.env.isOnline()) {
      this.setStatus('OFFLINE');
      return;
    }
    this.connect();
  }

  /** Local teardown (unmount). Does not notify handlers. */
  stop(): void {
    this.stopped = true;
    this.handlers = {};
    this.teardown();
    for (const p of this.pending.values()) this.clearPending(p);
    this.pending.clear();
  }

  /** Remember the chosen party; sent now if connected and re-sent after every welcome. */
  selectParty(partyId: PartyId | null): void {
    this.partyChoice = partyId;
    this.send({ type: 'party.select', partyId });
  }

  /** Fire-and-forget send. Returns false when not connected (message is dropped). */
  send(msg: SendPayload): boolean {
    if (msg.type === 'stt.status') this.lastStt = msg;
    if (this.status !== 'CONNECTED' || !this.ws) return false;
    this.rawSend({ v: 1, ...msg } as ClientMessage);
    return true;
  }

  /**
   * Request that expects an `ack`. Assigns clientCmdId, resends after 2s without ack (same id,
   * server dedupes), queues while disconnected. Returns the clientCmdId.
   */
  request(input: RequestInput, opts: { clientCmdId?: string } = {}): string {
    const id = opts.clientCmdId ?? this.uuid();
    if (this.pending.has(id)) return id;
    if (this.status === 'CLOSED' || this.status === 'REPLACED') {
      this.reportUnsent({ clientCmdId: id, msg: input, createdAt: this.now(), reason: 'CLOSED' });
      return id;
    }
    const p: Pending = { id, msg: input, createdAt: this.now(), resends: 0, timer: null, expiry: null };
    this.pending.set(id, p);
    if (this.status === 'CONNECTED') this.transmit(p);
    else this.scheduleExpiry(p);
    return id;
  }

  /**
   * Re-send an item that was reported unsent, keeping its original clientCmdId so the server
   * dedupes if the first attempt actually landed. Accepts the id or the reported item.
   * Returns the id, or null when the item is unknown.
   */
  resend(item: string | UnsentCommand): string | null {
    const id = typeof item === 'string' ? item : item.clientCmdId;
    const known = this.unsentItems.get(id) ?? (typeof item === 'string' ? undefined : item);
    if (!known) return null;
    if (this.unsentItems.delete(id)) this.handlers.onUnsentResolved?.(id);
    return this.request(known.msg, { clientCmdId: id });
  }

  /** Forget an unsent item the user discarded (a later ack for it is then ignored). */
  discardUnsent(clientCmdId: string): void {
    this.unsentItems.delete(clientCmdId);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  // ---------- connection ----------

  private setStatus(s: ConnectionStatus, reason: CloseReason | null = null): void {
    if (this.stopped) return;
    if (this.status === s && this.closeReason === reason) return;
    this.status = s;
    this.closeReason = reason;
    this.handlers.onStatus?.(s, reason);
  }

  private connect(): void {
    if (this.stopped) return;
    this.cancelRetry();
    this.detachSocket();
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.o.url);
    } catch {
      this.dropped();
      return;
    }
    this.ws = ws;
    this.lastRx = this.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.rawSend({
        v: 1,
        type: 'hello',
        roomCode: this.o.roomCode,
        clientId: this.o.clientId,
        role: this.o.role,
        ...(this.o.role === 'COMMANDER' && this.o.token ? { commanderToken: this.o.token } : {}),
        ...(this.o.role === 'OPERATOR' && this.o.token ? { operatorToken: this.o.token } : {}),
        ...(this.o.role === 'SUB_COMMANDER' && this.o.token ? { subCommanderToken: this.o.token } : {}),
        ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}),
        ...(this.o.nickname ? { nickname: this.o.nickname } : {}),
      });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onRaw(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.dropped();
    };
    ws.onerror = () => {
      // `close` follows an error; nothing to do here.
    };
    // The dead timer also covers a socket that never opens.
    this.armDeadTimer();
  }

  private detachSocket(): void {
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private teardown(): void {
    this.cancelRetry();
    this.detachSocket();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /** Socket lost (close, error, heartbeat timeout, seq gap). */
  private dropped(immediate = false): void {
    if (this.stopped || this.status === 'CLOSED' || this.status === 'REPLACED') return;
    this.detachSocket();
    this.suspendPending();
    if (!this.env.isOnline()) {
      this.setStatus('OFFLINE');
      return;
    }
    this.setStatus('RECONNECTING');
    if (immediate) {
      this.connect();
      return;
    }
    const base = backoffBase(this.attempt++);
    const delay = Math.round(base * (1 + (this.rand() * 2 - 1) * BACKOFF_JITTER));
    this.retryTimer = this.setT(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      this.clearT(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Terminal state: no more reconnects. */
  private finish(status: 'CLOSED' | 'REPLACED', reason: CloseReason | null): void {
    this.detachSocket();
    this.cancelRetry();
    for (const p of [...this.pending.values()]) {
      this.pending.delete(p.id);
      this.clearPending(p);
      this.reportUnsent({ clientCmdId: p.id, msg: p.msg, createdAt: p.createdAt, reason: 'CLOSED' });
    }
    this.setStatus(status, reason);
  }

  private onOnline(): void {
    if (this.stopped || this.status === 'CLOSED' || this.status === 'REPLACED') return;
    if (this.status === 'OFFLINE' || this.status === 'RECONNECTING') {
      this.attempt = 0;
      this.setStatus('RECONNECTING');
      this.connect();
    }
  }

  private onOffline(): void {
    if (this.stopped || this.status === 'CLOSED' || this.status === 'REPLACED') return;
    this.cancelRetry();
    this.detachSocket();
    this.suspendPending();
    this.setStatus('OFFLINE');
  }

  private onVisibility(): void {
    if (this.stopped || !this.env.isVisible()) return;
    if (this.status === 'RECONNECTING') {
      this.connect();
    } else if (this.status === 'CONNECTED') {
      // Timers are frozen while the screen is off, so the socket may be a zombie.
      // Silent for longer than one ping interval means no pong arrived: reconnect now.
      if (this.now() - this.lastRx > LIMITS.pingIntervalMs) this.dropped(true);
      else this.rawSendString(PING_STRING);
    }
  }

  // ---------- heartbeat ----------

  private startHeartbeat(): void {
    this.clearPing();
    const tick = () => {
      this.pingTimer = this.setT(() => {
        if (this.ws && this.ws.readyState === WS_OPEN) this.rawSendString(PING_STRING);
        tick();
      }, LIMITS.pingIntervalMs);
    };
    tick();
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      this.clearT(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private armDeadTimer(): void {
    if (this.deadTimer !== null) this.clearT(this.deadTimer);
    this.deadTimer = this.setT(() => {
      this.deadTimer = null;
      this.dropped();
    }, LIMITS.pongTimeoutMs);
  }

  private clearHeartbeat(): void {
    this.clearPing();
    if (this.deadTimer !== null) {
      this.clearT(this.deadTimer);
      this.deadTimer = null;
    }
  }

  // ---------- inbound ----------

  private onRaw(data: unknown): void {
    this.lastRx = this.now();
    this.armDeadTimer(); // any inbound traffic proves the link is alive
    if (typeof data !== 'string') return;
    const r = parseServerMessage(data);
    if (!r.ok) return;
    this.handle(r.msg);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'pong':
        return;
      case 'welcome': {
        this.lastSeq = msg.snapshot.seq;
        this.attempt = 0;
        this.setStatus('CONNECTED');
        this.handlers.onMessage?.(msg);
        if (this.partyChoice !== null) this.send({ type: 'party.select', partyId: this.partyChoice });
        if (this.lastStt) this.send(this.lastStt);
        this.flushQueue();
        return;
      }
      case 'snapshot':
        this.lastSeq = msg.seq;
        this.handlers.onMessage?.(msg);
        return;
      case 'event': {
        const last = this.lastSeq ?? 0;
        if (msg.seq <= last) return; // duplicate / already covered by the snapshot
        if (msg.seq !== last + 1) {
          this.dropped(true); // gap: reconnect with lastSeq to receive a fresh snapshot
          return;
        }
        this.lastSeq = msg.seq;
        this.handlers.onMessage?.(msg);
        return;
      }
      case 'ack': {
        const p = this.pending.get(msg.clientCmdId);
        if (p) {
          this.pending.delete(p.id);
          this.clearPending(p);
        }
        if (this.unsentItems.delete(msg.clientCmdId)) this.handlers.onUnsentResolved?.(msg.clientCmdId);
        this.handlers.onMessage?.(msg);
        return;
      }
      case 'room.closed':
        this.handlers.onMessage?.(msg);
        this.finish('CLOSED', 'ROOM_CLOSED');
        return;
      case 'session.replaced':
        this.handlers.onMessage?.(msg);
        this.finish('REPLACED', null);
        return;
      case 'error': {
        this.handlers.onMessage?.(msg);
        if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'UNAUTHORIZED' || msg.code === 'ROOM_FULL') {
          this.finish('CLOSED', msg.code);
        }
        return;
      }
      default:
        this.handlers.onMessage?.(msg);
    }
  }

  // ---------- outbound / pending commands ----------

  private rawSend(msg: ClientMessage): void {
    this.rawSendString(JSON.stringify(msg));
  }

  private rawSendString(s: string): void {
    try {
      this.ws?.send(s);
    } catch {
      /* socket closing; close handler will follow */
    }
  }

  private transmit(p: Pending): void {
    this.cancelPendingTimers(p);
    this.rawSend({ v: 1, clientCmdId: p.id, ...p.msg } as ClientMessage);
    p.timer = this.setT(() => {
      p.timer = null;
      if (!this.pending.has(p.id) || this.status !== 'CONNECTED') return;
      if (p.resends >= MAX_RESENDS) {
        this.pending.delete(p.id);
        this.reportUnsent({ clientCmdId: p.id, msg: p.msg, createdAt: p.createdAt, reason: 'NO_ACK' });
        return;
      }
      p.resends++;
      this.transmit(p); // same clientCmdId
    }, ACK_TIMEOUT_MS);
  }

  /** Connection lost: stop ack timers, keep items queued for the next welcome. */
  private suspendPending(): void {
    for (const p of this.pending.values()) {
      this.cancelPendingTimers(p);
      p.resends = 0;
      this.scheduleExpiry(p);
    }
  }

  private scheduleExpiry(p: Pending): void {
    if (p.expiry !== null) this.clearT(p.expiry);
    const remaining = LIMITS.offlineQueueMaxAgeMs - (this.now() - p.createdAt);
    p.expiry = this.setT(() => {
      p.expiry = null;
      if (!this.pending.has(p.id) || this.status === 'CONNECTED') return;
      this.pending.delete(p.id);
      this.reportUnsent({ clientCmdId: p.id, msg: p.msg, createdAt: p.createdAt, reason: 'STALE' });
    }, Math.max(0, remaining) + 1);
  }

  private flushQueue(): void {
    for (const p of [...this.pending.values()]) {
      if (p.expiry !== null) {
        this.clearT(p.expiry);
        p.expiry = null;
      }
      if (this.now() - p.createdAt > LIMITS.offlineQueueMaxAgeMs) {
        this.pending.delete(p.id);
        this.reportUnsent({ clientCmdId: p.id, msg: p.msg, createdAt: p.createdAt, reason: 'STALE' });
      } else {
        this.transmit(p);
      }
    }
  }

  private cancelPendingTimers(p: Pending): void {
    if (p.timer !== null) this.clearT(p.timer);
    p.timer = null;
    if (p.expiry !== null) this.clearT(p.expiry);
    p.expiry = null;
  }

  private clearPending(p: Pending): void {
    this.cancelPendingTimers(p);
  }

  private reportUnsent(item: UnsentCommand): void {
    this.unsentItems.set(item.clientCmdId, item);
    if (this.unsentItems.size > MAX_UNSENT_KEPT) {
      this.unsentItems.delete(this.unsentItems.keys().next().value as string);
    }
    this.handlers.onUnsent?.(item);
  }
}
