import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PING_STRING, makeDefaultParties, type ServerMessage, type Snapshot } from '@winds/protocol';
import {
  RoomClient,
  backoffBase,
  type ConnectionStatus,
  type RoomClientEnv,
  type UnsentCommand,
  type WebSocketLike,
} from './RoomClient';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  closed = false;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
  sentMsgs(type: string): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m.type === type);
  }
}

function snapshot(seq = 5): Snapshot {
  return {
    seq,
    roomCode: 'ABC234',
    status: 'OPEN',
    settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false },
    parties: makeDefaultParties(3),
    partyConfigVersion: 1,
    slots: {},
    commands: [],
    presence: { total: 1, byParty: {}, unassigned: 1, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' },
    expiresAt: 0,
  };
}
const welcome = (seq = 5): ServerMessage => ({ v: 1, type: 'welcome', role: 'MEMBER', memberId: 'm1', snapshot: snapshot(seq) });
const ev = (seq: number): ServerMessage => ({
  v: 1,
  type: 'event',
  seq,
  kind: 'settings.updated',
  payload: { settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false } },
});

function makeEnv() {
  const listeners = new Map<string, Set<() => void>>();
  const state = { online: true, visible: true };
  const env: RoomClientEnv = {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return () => listeners.get(type)!.delete(fn);
    },
    isOnline: () => state.online,
    isVisible: () => state.visible,
  };
  const fire = (type: string) => listeners.get(type)?.forEach((f) => f());
  return { env, state, fire };
}

function setup(opts: { role?: 'MEMBER' | 'COMMANDER' | 'SUB_COMMANDER'; token?: string } = {}) {
  const e = makeEnv();
  const statuses: ConnectionStatus[] = [];
  const messages: ServerMessage[] = [];
  const unsent: UnsentCommand[] = [];
  const resolved: string[] = [];
  let n = 0;
  const client = new RoomClient({
    url: 'ws://x/api/rooms/ABC234/ws',
    roomCode: 'ABC234',
    clientId: 'client-1',
    role: opts.role ?? 'MEMBER',
    token: opts.token,
    WebSocketImpl: FakeWS,
    env: e.env,
    random: () => 0.5, // jitter factor exactly 1.0
    uuid: () => `cmd-${++n}`,
    handlers: {
      onStatus: (s) => statuses.push(s),
      onMessage: (m) => messages.push(m),
      onUnsent: (u) => unsent.push(u),
      onUnsentResolved: (id) => resolved.push(id),
    },
  });
  const sock = () => FakeWS.instances[FakeWS.instances.length - 1]!;
  const connectOk = (seq = 5) => {
    sock().open();
    sock().recv(welcome(seq));
  };
  return { client, e, statuses, messages, unsent, resolved, sock, connectOk };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomClient', () => {
  it('maps a SUB_COMMANDER token to subCommanderToken in hello', () => {
    const t = setup({ role: 'SUB_COMMANDER', token: 'subtok' });
    t.client.start();
    t.sock().open();
    const hello = t.sock().sentMsgs('hello')[0]!;
    expect(hello).toMatchObject({ role: 'SUB_COMMANDER', subCommanderToken: 'subtok' });
    expect(hello.operatorToken).toBeUndefined();
    expect(hello.commanderToken).toBeUndefined();
  });

  it('sends hello with clientId/role/token and becomes CONNECTED on welcome', () => {
    const t = setup({ role: 'COMMANDER', token: 'tok' });
    t.client.start();
    expect(t.client.getStatus()).toBe('CONNECTING');
    t.sock().open();
    const hello = t.sock().sentMsgs('hello')[0]!;
    expect(hello).toMatchObject({ v: 1, roomCode: 'ABC234', clientId: 'client-1', role: 'COMMANDER', commanderToken: 'tok' });
    expect(hello.lastSeq).toBeUndefined();
    t.sock().recv(welcome(5));
    expect(t.client.getStatus()).toBe('CONNECTED');
    expect(t.client.getLastSeq()).toBe(5);
  });

  it('backoff sequence is 0.5s x2 capped at 8s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffBase)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    const t = setup();
    t.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeWS.instances.length;
      t.sock().drop();
      expect(t.client.getStatus()).toBe('RECONNECTING');
      // find the exact delay: nothing opens 1ms before, a socket exists after
      const expected = backoffBase(i);
      vi.advanceTimersByTime(expected - 1);
      expect(FakeWS.instances.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances.length).toBe(before + 1);
      delays.push(expected);
    }
    expect(delays.at(-1)).toBe(8000);
  });

  it('applies +-20% jitter', () => {
    const e = makeEnv();
    const c = new RoomClient({
      url: 'u', roomCode: 'A', clientId: 'c', role: 'MEMBER', WebSocketImpl: FakeWS, env: e.env, random: () => 1,
    });
    c.start();
    FakeWS.instances[0]!.drop();
    vi.advanceTimersByTime(599);
    expect(FakeWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances.length).toBe(2); // 500 * 1.2
  });

  it('backoff resets after a successful welcome', () => {
    const t = setup();
    t.client.start();
    t.sock().drop();
    vi.advanceTimersByTime(500);
    t.sock().drop();
    vi.advanceTimersByTime(1000);
    t.connectOk();
    t.sock().drop();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances.length).toBe(4);
  });

  it('heartbeat: pings every 15s; no inbound for 35s -> RECONNECTING', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    vi.advanceTimersByTime(15_000);
    expect(t.sock().sent.filter((s) => s === PING_STRING)).toHaveLength(1);
    vi.advanceTimersByTime(15_000);
    expect(t.sock().sent.filter((s) => s === PING_STRING)).toHaveLength(2);
    expect(t.client.getStatus()).toBe('CONNECTED');
    // last inbound was the welcome at t=0; at 35s the link is dead
    vi.advanceTimersByTime(5_000);
    expect(t.client.getStatus()).toBe('RECONNECTING');
  });

  it('pong keeps the link alive', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(15_000);
      t.sock().recv('{"v":1,"type":"pong"}');
    }
    expect(t.client.getStatus()).toBe('CONNECTED');
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('seq gap -> reconnect immediately with lastSeq', () => {
    const t = setup();
    t.client.start();
    t.connectOk(5);
    t.sock().recv(ev(6));
    expect(t.client.getLastSeq()).toBe(6);
    const first = t.sock();
    first.recv(ev(8)); // gap (7 missing)
    expect(t.client.getStatus()).toBe('RECONNECTING');
    expect(FakeWS.instances).toHaveLength(2); // no backoff wait
    expect(first.closed).toBe(true);
    t.sock().open();
    expect(t.sock().sentMsgs('hello')[0]).toMatchObject({ lastSeq: 6 });
    // the gapped event was not delivered
    expect(t.messages.filter((m) => m.type === 'event')).toHaveLength(1);
  });

  it('ignores duplicate / old seq events', () => {
    const t = setup();
    t.client.start();
    t.connectOk(5);
    t.sock().recv(ev(5));
    t.sock().recv(ev(4));
    expect(t.messages.filter((m) => m.type === 'event')).toHaveLength(0);
    expect(t.client.getStatus()).toBe('CONNECTED');
  });

  it('resends on ack timeout with the same clientCmdId, stops after ack', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    const id = t.client.request({ type: 'command.cancel', commandId: 'c1' });
    expect(t.sock().sentMsgs('command.cancel')).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    const sent = t.sock().sentMsgs('command.cancel');
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.clientCmdId)).toEqual([id, id]);
    t.sock().recv({ v: 1, type: 'ack', clientCmdId: id });
    vi.advanceTimersByTime(10_000);
    expect(t.sock().sentMsgs('command.cancel')).toHaveLength(2);
    expect(t.client.pendingCount()).toBe(0);
    expect(t.messages.some((m) => m.type === 'ack')).toBe(true);
  });

  it('gives up resending after repeated missing acks and reports unsent', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    t.client.request({ type: 'command.cancel', commandId: 'c1' });
    // keep the link alive while waiting
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2000);
      t.sock().recv('{"v":1,"type":"pong"}');
    }
    expect(t.unsent).toHaveLength(1);
    expect(t.unsent[0]!.reason).toBe('NO_ACK');
  });

  it('offline queue: <=10s old is sent after reconnect, older is reported unsent', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    t.sock().drop();
    expect(t.client.getStatus()).toBe('RECONNECTING');
    const oldId = t.client.request({ type: 'command.cancel', commandId: 'old' });
    vi.advanceTimersByTime(4000);
    const freshId = t.client.request({ type: 'command.cancel', commandId: 'fresh' });
    // old is now 4s old, then wait until it is 10.5s (fresh is 6.5s)
    vi.advanceTimersByTime(6500);
    expect(t.unsent.map((u) => u.clientCmdId)).toEqual([oldId]);
    expect(t.unsent[0]!.reason).toBe('STALE');
    // reconnect (fresh is 6.5s old)
    t.connectOk();
    const sent = t.sock().sentMsgs('command.cancel');
    expect(sent.map((m) => m.clientCmdId)).toEqual([freshId]);
    expect(t.unsent).toHaveLength(1);
  });

  it('queued command exactly 10s old is still sent on welcome', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.sock().drop();
    const id = t.client.request({ type: 'command.cancel', commandId: 'x' });
    vi.advanceTimersByTime(500); // retry fires -> new socket
    vi.advanceTimersByTime(9500 - 1); // total just before expiry
    // fast-forward system clock to age == 10000 without firing the expiry timer: use welcome now
    t.sock().open();
    vi.setSystemTime(Date.now() + 1);
    t.sock().recv(welcome());
    expect(t.sock().sentMsgs('command.cancel').map((m) => m.clientCmdId)).toEqual([id]);
  });

  it('stops reconnecting on room.closed', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    t.sock().recv({ v: 1, type: 'room.closed', reason: 'COMMANDER_CLOSED' });
    expect(t.client.getStatus()).toBe('CLOSED');
    expect(t.client.getCloseReason()).toBe('ROOM_CLOSED');
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.messages.at(-1)!.type).toBe('room.closed');
  });

  it.each(['ROOM_NOT_FOUND', 'UNAUTHORIZED'] as const)('stops on %s error', (code) => {
    const t = setup();
    t.client.start();
    t.sock().open();
    t.sock().recv({ v: 1, type: 'error', code, message: 'x' });
    expect(t.client.getStatus()).toBe('CLOSED');
    expect(t.client.getCloseReason()).toBe(code);
    t.sock().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('session.replaced -> REPLACED and no reconnect', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    t.sock().recv({ v: 1, type: 'session.replaced' });
    expect(t.client.getStatus()).toBe('REPLACED');
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('re-sends party.select after every welcome once a party was chosen', () => {
    const t = setup();
    t.client.start();
    t.client.selectParty('p2'); // not connected yet: remembered, not sent
    t.connectOk();
    expect(t.sock().sentMsgs('party.select')).toEqual([{ v: 1, type: 'party.select', partyId: 'p2' }]);
    t.sock().drop();
    vi.advanceTimersByTime(500);
    t.connectOk();
    expect(t.sock().sentMsgs('party.select')).toEqual([{ v: 1, type: 'party.select', partyId: 'p2' }]);
  });

  it('does not send party.select if nothing was chosen', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    expect(t.sock().sentMsgs('party.select')).toHaveLength(0);
  });

  it('visibilitychange visible retries immediately while RECONNECTING', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    t.sock().drop();
    // advance backoff a few rounds so the wait is long
    vi.advanceTimersByTime(500);
    t.sock().drop();
    expect(FakeWS.instances).toHaveLength(2);
    t.e.fire('visibilitychange');
    expect(FakeWS.instances).toHaveLength(3); // no waiting for the 1s backoff
  });

  it('visibilitychange hidden does nothing', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    t.sock().drop();
    t.e.state.visible = false;
    t.e.fire('visibilitychange');
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('visible after a long freeze while CONNECTED forces a reconnect', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    vi.setSystemTime(Date.now() + 60_000); // timers did not run, clock moved
    t.e.fire('visibilitychange');
    expect(t.client.getStatus()).toBe('RECONNECTING');
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('offline -> OFFLINE (no retry timer); online -> immediate retry', () => {
    const t = setup();
    t.client.start();
    t.connectOk();
    t.e.state.online = false;
    t.e.fire('offline');
    expect(t.client.getStatus()).toBe('OFFLINE');
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    t.e.state.online = true;
    t.e.fire('online');
    expect(t.client.getStatus()).toBe('RECONNECTING');
    expect(FakeWS.instances).toHaveLength(2);
    t.sock().open();
    t.sock().recv(welcome());
    expect(t.client.getStatus()).toBe('CONNECTED');
  });

  it('request while CLOSED is reported unsent immediately', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    t.sock().recv({ v: 1, type: 'room.closed', reason: 'EXPIRED' });
    t.client.request({ type: 'command.cancel', commandId: 'c' });
    expect(t.unsent[0]!.reason).toBe('CLOSED');
  });

  it('ignores messages and close events from a socket that is no longer current', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    const old = t.sock();
    old.drop();
    vi.advanceTimersByTime(500);
    t.connectOk(); // fresh socket, CONNECTED
    expect(FakeWS.instances).toHaveLength(2);
    // stale socket (handlers detached) tries to speak
    old.onmessage?.({ data: JSON.stringify({ v: 1, type: 'session.replaced' }) });
    old.onclose?.();
    old.recv({ v: 1, type: 'room.closed', reason: 'EXPIRED' });
    expect(t.client.getStatus()).toBe('CONNECTED');
    expect(t.messages.some((m) => m.type === 'session.replaced' || m.type === 'room.closed')).toBe(false);
  });

  it('re-sends the last stt.status after every welcome', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    t.client.send({ type: 'stt.status', state: 'LISTENING' });
    expect(t.sock().sentMsgs('stt.status')).toHaveLength(1);
    t.sock().drop();
    vi.advanceTimersByTime(500);
    t.connectOk();
    expect(t.sock().sentMsgs('stt.status')).toEqual([{ v: 1, type: 'stt.status', state: 'LISTENING' }]);
    t.client.send({ type: 'stt.status', state: 'OFF' });
    t.sock().drop();
    vi.advanceTimersByTime(1000);
    t.connectOk();
    expect(t.sock().sentMsgs('stt.status')).toEqual([{ v: 1, type: 'stt.status', state: 'OFF' }]);
  });

  it('does not send stt.status after welcome if none was ever sent', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    expect(t.sock().sentMsgs('stt.status')).toHaveLength(0);
  });

  it('resend(clientCmdId) reuses the original id and clears the unsent entry', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    const id = t.client.request({ type: 'command.cancel', commandId: 'c1' });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2000);
      t.sock().recv('{"v":1,"type":"pong"}');
    }
    expect(t.unsent.map((u) => u.clientCmdId)).toEqual([id]);
    const before = t.sock().sentMsgs('command.cancel').length;
    expect(t.client.resend(id)).toBe(id);
    expect(t.resolved).toEqual([id]);
    const sent = t.sock().sentMsgs('command.cancel');
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.clientCmdId).toBe(id);
    expect(t.client.resend('nope')).toBeNull();
  });

  it('a late ack for an already-unsent item emits onUnsentResolved and blocks a stale resend', () => {
    const t = setup({ role: 'COMMANDER', token: 't' });
    t.client.start();
    t.connectOk();
    const id = t.client.request({ type: 'command.cancel', commandId: 'c1' });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2000);
      t.sock().recv('{"v":1,"type":"pong"}');
    }
    expect(t.unsent).toHaveLength(1);
    t.sock().recv({ v: 1, type: 'ack', clientCmdId: id, commandId: 'c1' });
    expect(t.resolved).toEqual([id]);
    expect(t.client.resend(id)).toBeNull(); // already applied: nothing to re-send
  });
});
