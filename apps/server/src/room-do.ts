import { DurableObject } from 'cloudflare:workers';
import {
  CreateRoomRequest,
  LIMITS,
  PING_STRING,
  PONG_STRING,
  normalizeRoomCode,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type EventMsg,
  type Presence,
  type Role,
  type ServerMessage,
  type SttState,
} from '@winds/protocol';
import {
  cancelCommand,
  canAdmin,
  canCommand,
  closeRoom,
  correctCommand,
  createRoomState,
  eventForRole,
  issueCommand,
  toSnapshot,
  updateParties,
  updateSettings,
  withClientCmd,
  type Result,
  type RoomState,
} from '@winds/room-core';
import { verifyHello } from './auth';
import type { Env } from './env';
import { commanderStale, dueCloseReason, helloExpired, planAlarm, type CloseReason } from './lifecycle';
import { computePresence, type ConnInfo } from './presence';
import { TokenBucket, ViolationCounter, bucketKind, peekClientCmdId } from './rateLimit';

interface Attachment {
  connectionId: string;
  clientId: string;
  role: Role;
  partyId: string | null;
  nickname?: string;
  helloDone: boolean;
  connectedAt: number;
}

const MAX_VIOLATIONS = 20;
const CLOSE_PROTOCOL = 4000;
const CLOSE_REPLACED = 4001;
const CLOSE_RATE = 4008;
const CLOSE_ROOM = 4002;
const CLOSE_STALE = 4009;

const STT_TYPE_RE = /"type"\s*:\s*"stt\.(?:feed|status)"/;

const REQUEST_TYPES = new Set([
  'command.issue',
  'command.correct',
  'command.cancel',
  'parties.update',
  'room.settings',
  'room.close',
]);

export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private stt: SttState = 'OFF';
  private buckets = new Map<string, TokenBucket>();
  private violations = new Map<string, ViolationCounter>();
  /** Last real (non-auto-response) message per connection; in-memory, lost on hibernation. */
  private lastMsgAt = new Map<string, number>();
  private lastPresenceAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** No COMMANDER_ABSENT close before this: sockets are gone after a restart and need time to reconnect. */
  private readonly graceUntil = Date.now() + LIMITS.restartGraceMs;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_STRING, PONG_STRING));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomState>('room')) ?? null;
      this.stt = (await ctx.storage.get<SttState>('stt')) ?? 'OFF';
      // Liveness ticks write this small key instead of the whole room.
      const seen = await ctx.storage.get<number>('commanderSeenAt');
      if (this.room && seen !== undefined) {
        this.room.lastCommanderSeenAt = Math.max(this.room.lastCommanderSeenAt, seen);
      }
    });
  }

  // ------------------------------------------------------------ HTTP (from Worker)

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') return this.init(request);
    if (url.pathname === '/info') {
      const r = this.room;
      if (!r || r.status !== 'OPEN') return new Response('not found', { status: 404 });
      return Response.json({
        code: r.code,
        status: r.status,
        parties: r.parties,
        expiresAt: r.expiresAt,
      });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      if (!this.room || this.room.status !== 'OPEN') return new Response('not found', { status: 404 });
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      const att: Attachment = {
        connectionId: crypto.randomUUID(),
        clientId: '',
        role: 'MEMBER',
        partyId: null,
        helloDone: false,
        connectedAt: Date.now(),
      };
      server.serializeAttachment(att);
      await this.rescheduleAlarm(); // hello deadline
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('not found', { status: 404 });
  }

  private async init(request: Request): Promise<Response> {
    if (this.room) return new Response('exists', { status: 409 });
    const body = (await request.json()) as {
      code: string;
      parties: CreateRoomRequest['parties'];
      settings?: CreateRoomRequest['settings'];
      commanderTokenHash: string;
      operatorTokenHash: string;
      subCommanderTokenHash: string;
    };
    const now = Date.now();
    const state = createRoomState({ ...body, now });
    this.room = state;
    this.stt = 'OFF';
    await this.persist();
    await this.ctx.storage.put('stt', this.stt);
    await this.rescheduleAlarm();
    return Response.json({ expiresAt: state.expiresAt }, { status: 201 });
  }

  // ------------------------------------------------------------ helpers

  private async persist(): Promise<void> {
    if (this.room) await this.ctx.storage.put('room', this.room);
  }

  private liveSockets(): { ws: WebSocket; att: Attachment }[] {
    const out: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.helloDone) out.push({ ws, att });
    }
    return out;
  }

  private commanderOnline(): boolean {
    return this.liveSockets().some((c) => c.att.role === 'COMMANDER');
  }

  private send(ws: WebSocket, msg: ServerMessage | Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string = code): void {
    this.send(ws, { v: 1, type: 'error', code, message });
  }

  /** Error for a request: an `ack` with error when the client sent a clientCmdId, else `error`. */
  private reject(ws: WebSocket, code: ErrorCode, clientCmdId: string | undefined, message: string = code): void {
    if (clientCmdId) this.send(ws, { v: 1, type: 'ack', clientCmdId, error: code });
    else this.sendError(ws, code, message);
  }

  private failAndClose(ws: WebSocket, code: ErrorCode, closeCode: number, message: string = code): void {
    this.sendError(ws, code, message);
    try {
      ws.close(closeCode, code);
    } catch {
      /* ignore */
    }
  }

  private presence(): Presence {
    const conns: ConnInfo[] = this.liveSockets().map((c) => ({
      role: c.att.role,
      partyId: c.att.partyId,
    }));
    return computePresence(conns, this.room?.parties.map((p) => p.id) ?? [], this.stt);
  }

  /** At most one presence broadcast per throttle window; one trailing send if requested inside it. */
  private schedulePresence(): void {
    if (this.presenceTimer) return;
    const wait = this.lastPresenceAt + LIMITS.presenceThrottleMs - Date.now();
    if (wait <= 0) {
      this.sendPresenceNow();
      return;
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresenceNow();
    }, wait);
  }

  private sendPresenceNow(): void {
    this.lastPresenceAt = Date.now();
    const p = { v: 1, type: 'presence', ...this.presence() };
    for (const { ws } of this.liveSockets()) this.send(ws, p);
  }

  private broadcastEvents(events: EventMsg[]): void {
    if (!events.length || !this.room) return;
    const settings = this.room.settings;
    const live = this.liveSockets();
    for (const ev of events) {
      const cache = new Map<boolean, string>();
      for (const { ws, att } of live) {
        const member = att.role === 'MEMBER';
        let s = cache.get(member);
        if (s === undefined) {
          s = JSON.stringify(eventForRole(ev, settings, member ? 'MEMBER' : 'COMMANDER'));
          cache.set(member, s);
        }
        try {
          ws.send(s);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async rescheduleAlarm(): Promise<void> {
    if (!this.room) return;
    let oldest: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && !att.helloDone) oldest = Math.min(oldest ?? Infinity, att.connectedAt ?? Date.now());
    }
    await this.ctx.storage.setAlarm(
      planAlarm({
        expiresAt: this.room.expiresAt,
        lastCommanderSeenAt: this.room.lastCommanderSeenAt,
        commanderOnline: this.commanderOnline(),
        oldestPendingHelloAt: oldest,
        now: Date.now(),
        graceUntil: this.graceUntil,
      }),
    );
  }

  // ------------------------------------------------------------ WebSocket handlers

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return this.failAndClose(ws, 'INVALID_MESSAGE', CLOSE_PROTOCOL);
    if (typeof data !== 'string') {
      return att.helloDone
        ? this.sendError(ws, 'INVALID_MESSAGE', 'binary not supported')
        : this.failAndClose(ws, 'INVALID_MESSAGE', CLOSE_PROTOCOL);
    }
    const oversize = data.length > LIMITS.maxFrameLength;

    if (!att.helloDone) {
      if (oversize) return this.failAndClose(ws, 'INVALID_MESSAGE', CLOSE_PROTOCOL, 'frame too large');
      const first = parseClientMessage(data);
      if (!first.ok || first.msg.type !== 'hello') {
        return this.failAndClose(ws, 'INVALID_MESSAGE', CLOSE_PROTOCOL, 'first message must be hello');
      }
      return this.onHello(ws, att, first.msg);
    }

    const now = Date.now();
    this.lastMsgAt.set(att.connectionId, now);
    // Rate limiting runs before JSON.parse so a flood of frames costs a regex, not a parse. The kind
    // comes from the raw text (quotes inside string values are escaped, so a literal "type":"stt.x"
    // can only be structural); once parsed, a mismatch is charged to the real bucket too.
    const preKind = STT_TYPE_RE.test(data) ? 'stt' : 'cmd';
    const cmdIdOf = (): string | undefined => (oversize ? undefined : peekClientCmdId(data));
    if (!this.takeToken(att, preKind, now)) return this.rateLimited(ws, att, now, cmdIdOf());
    if (oversize) return this.sendError(ws, 'INVALID_MESSAGE', 'frame too large');
    const parsed = parseClientMessage(data);
    if (parsed.ok && bucketKind(parsed.msg.type) !== preKind) {
      if (!this.takeToken(att, bucketKind(parsed.msg.type), now)) return this.rateLimited(ws, att, now, cmdIdOf());
    }
    const cmdId = parsed.ok ? (parsed.msg as { clientCmdId?: string }).clientCmdId : cmdIdOf();
    if (!parsed.ok) return this.reject(ws, 'INVALID_MESSAGE', cmdId, parsed.error);
    const msg = parsed.msg;
    if (!this.room || this.room.status !== 'OPEN') {
      return this.failAndClose(ws, 'ROOM_NOT_FOUND', CLOSE_ROOM);
    }
    const isCommander = att.role === 'COMMANDER';

    switch (msg.type) {
      case 'hello':
        return this.sendError(ws, 'INVALID_MESSAGE', 'already greeted');
      case 'ping':
        return this.send(ws, { v: 1, type: 'pong' });
      case 'party.select': {
        if (msg.partyId !== null && !this.room.parties.some((p) => p.id === msg.partyId)) {
          return this.sendError(ws, 'UNKNOWN_PARTY');
        }
        ws.serializeAttachment({ ...att, partyId: msg.partyId } satisfies Attachment);
        this.schedulePresence();
        return;
      }
      case 'stt.status':
        if (!isCommander) return this.sendError(ws, 'FORBIDDEN');
        this.stt = msg.state;
        await this.ctx.storage.put('stt', this.stt);
        this.schedulePresence();
        return;
      case 'stt.feed': {
        if (!isCommander) return this.sendError(ws, 'FORBIDDEN');
        const relay = JSON.stringify({ v: 1, type: 'stt.feed', entries: msg.entries, from: att.role });
        for (const c of this.liveSockets()) {
          if (c.ws !== ws && canCommand(c.att.role)) {
            try {
              c.ws.send(relay);
            } catch {
              /* ignore */
            }
          }
        }
        return;
      }
      default:
        break;
    }

    if (!REQUEST_TYPES.has(msg.type)) return;
    const req = msg as Extract<ClientMessage, { clientCmdId: string }>;
    const allowed =
      msg.type === 'command.issue' || msg.type === 'command.correct' || msg.type === 'command.cancel'
        ? canCommand(att.role)
        : canAdmin(att.role);
    if (!allowed) return this.reject(ws, 'FORBIDDEN', req.clientCmdId);
    await this.handleRequest(ws, att, req);
  }

  private takeToken(att: Attachment, kind: 'stt' | 'cmd', now: number): boolean {
    const bucketKey = `${att.connectionId}:${kind}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      const roleRate =
        att.role === 'COMMANDER'
          ? LIMITS.commanderRatePerSec
          : att.role === 'OPERATOR' || att.role === 'SUB_COMMANDER'
            ? LIMITS.operatorRatePerSec
            : LIMITS.memberRatePerSec;
      // stt.* has its own budget so a multi-clause utterance cannot starve command requests.
      const rate = kind === 'stt' && att.role !== 'MEMBER' ? LIMITS.sttRatePerSec : roleRate;
      bucket = new TokenBucket(rate, now);
      this.buckets.set(bucketKey, bucket);
    }
    return bucket.take(now);
  }

  private rateLimited(ws: WebSocket, att: Attachment, now: number, cmdId: string | undefined): void {
    let counter = this.violations.get(att.connectionId);
    if (!counter) {
      counter = new ViolationCounter(LIMITS.violationDecayMs);
      this.violations.set(att.connectionId, counter);
    }
    if (counter.hit(now) >= MAX_VIOLATIONS) return this.failAndClose(ws, 'RATE_LIMITED', CLOSE_RATE);
    return this.reject(ws, 'RATE_LIMITED', cmdId);
  }

  private async handleRequest(
    ws: WebSocket,
    att: Attachment,
    msg: Extract<ClientMessage, { clientCmdId: string }>,
  ): Promise<void> {
    const room = this.room!;
    // issuer comes from the authenticated connection, never from the client payload.
    const ctx = {
      now: Date.now(),
      newId: () => crypto.randomUUID().slice(0, 12),
      role: att.role,
      ...(att.role === 'COMMANDER' || att.role === 'SUB_COMMANDER' || att.role === 'OPERATOR'
        ? { issuer: { role: att.role } }
        : {}),
    };
    const run = (s: RoomState): Result => {
      switch (msg.type) {
        case 'command.issue':
          return issueCommand(s, msg, ctx);
        case 'command.correct':
          return correctCommand(s, msg, ctx);
        case 'command.cancel':
          return cancelCommand(s, msg, ctx);
        case 'parties.update':
          return updateParties(s, msg, ctx);
        case 'room.settings':
          return updateSettings(s, msg.settings, ctx);
        case 'room.close':
          return closeRoom(s, ctx);
      }
    };
    const r = withClientCmd(room, msg.clientCmdId, run);
    const ack: Record<string, unknown> = { v: 1, type: 'ack', clientCmdId: msg.clientCmdId };
    if (!r.ok) {
      ack.error = r.error;
      if (r.state) {
        this.room = r.state;
        await this.persist();
      }
      return this.send(ws, ack);
    }
    if (r.ack.commandId) ack.commandId = r.ack.commandId;
    if (r.ack.note) ack.note = r.ack.note;
    const duplicate = r.state === room;
    if (!duplicate) {
      this.room = r.state;
      if (msg.type !== 'room.close') await this.persist();
    }
    if (msg.type === 'room.close') {
      this.send(ws, ack);
      if (!duplicate) await this.closeAll('COMMANDER_CLOSED');
      return;
    }
    this.broadcastEvents(r.events);
    this.send(ws, ack);
    if (msg.type === 'parties.update' && r.events.length) this.schedulePresence();
  }

  private async onHello(
    ws: WebSocket,
    att: Attachment,
    hello: Extract<ClientMessage, { type: 'hello' }>,
  ): Promise<void> {
    const pre = this.room;
    if (!pre || pre.status !== 'OPEN' || normalizeRoomCode(hello.roomCode) !== pre.code) {
      return this.failAndClose(ws, 'ROOM_NOT_FOUND', CLOSE_ROOM);
    }
    if (!(await verifyHello(hello, pre))) return this.failAndClose(ws, 'UNAUTHORIZED', CLOSE_PROTOCOL);
    // State may have changed while hashing (room closed, socket closed, duplicate hello).
    const room = this.room;
    if (!room || room.status !== 'OPEN' || ws.readyState !== 1) {
      return this.failAndClose(ws, 'ROOM_NOT_FOUND', CLOSE_ROOM);
    }
    const cur = ws.deserializeAttachment() as Attachment | null;
    if (!cur || cur.helloDone) return;

    const others = this.liveSockets().filter((c) => c.ws !== ws);
    const replace = (c: { ws: WebSocket; att: Attachment }) => {
      this.send(c.ws, { v: 1, type: 'session.replaced' });
      c.ws.serializeAttachment({ ...c.att, helloDone: false });
      try {
        c.ws.close(CLOSE_REPLACED, 'session.replaced');
      } catch {
        /* ignore */
      }
    };
    if (hello.role === 'COMMANDER') {
      for (const c of others) if (c.att.role === 'COMMANDER') replace(c);
    } else {
      // Same browser reconnecting before the old socket is reaped: only the same clientId AND
      // role is a duplicate. An operator tab and a member tab from one browser coexist.
      for (const c of others) {
        if (c.att.role === hello.role && c.att.clientId === hello.clientId) replace(c);
      }
      const nonCommander = this.liveSockets().filter(
        (c) => c.ws !== ws && c.att.role !== 'COMMANDER',
      ).length;
      if (nonCommander >= room.settings.maxMembers) {
        return this.failAndClose(ws, 'ROOM_FULL', CLOSE_ROOM);
      }
    }

    const next: Attachment = {
      connectionId: att.connectionId,
      clientId: hello.clientId,
      role: hello.role,
      partyId: null,
      helloDone: true,
      connectedAt: cur.connectedAt ?? Date.now(),
      ...(hello.nickname ? { nickname: hello.nickname } : {}),
    };
    ws.serializeAttachment(next);

    // Only the COMMANDER keeps the room alive and drives the "commander disconnected" state;
    // SUB_COMMANDER/OPERATOR connections deliberately have no effect on lifecycle (unchanged).
    if (hello.role === 'COMMANDER') {
      room.lastCommanderSeenAt = Date.now();
      await this.persist();
      await this.rescheduleAlarm();
    }
    this.send(ws, {
      v: 1,
      type: 'welcome',
      role: hello.role,
      memberId: att.connectionId,
      snapshot: toSnapshot(room, this.presence(), hello.role),
    });
    this.schedulePresence();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000, reason);
    } catch {
      /* already closed */
    }
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) {
      this.buckets.delete(`${att.connectionId}:cmd`);
      this.buckets.delete(`${att.connectionId}:stt`);
      this.violations.delete(att.connectionId);
      this.lastMsgAt.delete(att.connectionId);
    }
    if (!this.room) return;
    if (att?.role === 'COMMANDER' && att.helloDone) await this.commanderGone();
    this.schedulePresence();
  }

  /** Commander socket(s) are all gone: record last-seen, STT off, re-plan the alarm. */
  private async commanderGone(): Promise<void> {
    if (!this.room || this.commanderOnline()) return;
    this.room.lastCommanderSeenAt = Date.now();
    this.stt = 'OFF';
    await this.persist();
    await this.ctx.storage.put('stt', this.stt);
    await this.rescheduleAlarm();
  }

  // ------------------------------------------------------------ lifecycle

  async alarm(): Promise<void> {
    if (!this.room) return;
    const now = Date.now();
    let commanderDropped = false;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      if (!att.helloDone) {
        if (helloExpired(att.connectedAt ?? now, now)) {
          this.failAndClose(ws, 'INVALID_MESSAGE', CLOSE_PROTOCOL, 'hello timeout');
        }
      } else if (att.role === 'COMMANDER') {
        // Pings are auto-answered without waking us, so a half-open socket is invisible unless
        // we look at the auto-response timestamp. The client pings every 15s.
        const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
        if (commanderStale(auto, this.lastMsgAt.get(att.connectionId) ?? null, att.connectedAt ?? now, now)) {
          ws.serializeAttachment({ ...att, helloDone: false } satisfies Attachment);
          try {
            ws.close(CLOSE_STALE, 'commander stale');
          } catch {
            /* ignore */
          }
          commanderDropped = true;
        }
      }
    }
    if (commanderDropped) {
      await this.commanderGone();
      this.schedulePresence();
    }
    const online = this.commanderOnline();
    if (online) {
      // Persist liveness each tick so a DO restart does not see an hours-old lastCommanderSeenAt.
      this.room.lastCommanderSeenAt = now;
      await this.ctx.storage.put('commanderSeenAt', now);
    }
    const reason = dueCloseReason(this.room, online, now, this.graceUntil);
    if (reason) await this.closeAll(reason);
    else await this.rescheduleAlarm();
  }

  private async closeAll(reason: CloseReason): Promise<void> {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    const msg = JSON.stringify({ v: 1, type: 'room.closed', reason });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        ws.close(1000, 'room closed');
      } catch {
        /* ignore */
      }
    }
    this.room = null;
    this.stt = 'OFF';
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
