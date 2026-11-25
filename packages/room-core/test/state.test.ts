import { describe, expect, it } from 'vitest';
import { LIMITS, type Party, type Presence } from '@winds/protocol';
import {
  cancelCommand,
  closeRoom,
  correctCommand,
  createRoomState,
  currentCommandId,
  eventForRole,
  issueCommand,
  SNAPSHOT_TRANSCRIPT_COMMANDS,
  toSnapshot,
  updateParties,
  updateSettings,
  withClientCmd,
  type Result,
  type RoomState,
} from '../src';

let idn = 0;
const newId = () => `c${++idn}`;
const T0 = 1_000_000;
const ctx = (now = T0) => ({ now, newId });

function mk(n = 3): RoomState {
  idn = 0;
  return createRoomState({
    code: 'ABC234',
    now: T0,
    parties: Array.from({ length: n }, () => ({})),
    commanderTokenHash: 'h1',
    operatorTokenHash: 'h2',
  });
}
function ok(r: Result): Extract<Result, { ok: true }> {
  if (!r.ok) throw new Error('expected ok, got ' + r.error);
  return r;
}
const ALL = { kind: 'ALL' } as const;
const P = (...ids: string[]) => ({ kind: 'PARTIES', partyIds: ids }) as const;
const CEN = { id: 'CENTER', label: '중앙' };
const RIGHT = { id: 'RIGHT', label: '우측' };
const cur = (s: RoomState) => s.parties.map((p) => currentCommandId(s, p.id));
const get = (s: RoomState, id: string) => s.commands.find((c) => c.id === id)!;
const issue = (s: RoomState, input: Parameters<typeof issueCommand>[1], now = T0, id: () => string = newId) =>
  ok(issueCommand(s, input, { now, newId: id }));

describe('createRoomState', () => {
  it('assigns stable ids, empty stacks, hashes, expiry', () => {
    const s = createRoomState({
      code: 'ABC234', now: T0, parties: [{ name: '돌격' }, { aliases: ['수비조'] }],
      settings: { shareTranscript: true }, commanderTokenHash: 'a', operatorTokenHash: 'b',
    });
    expect(s.parties.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(s.parties[0]!.name).toBe('돌격');
    expect(s.parties[1]!.aliases).toEqual(['수비조']);
    expect(s.slots).toEqual({ p1: [], p2: [] });
    expect(s.settings.shareTranscript).toBe(true);
    expect(s.expiresAt).toBe(T0 + LIMITS.roomMaxLifetimeMs);
    expect(s.partyConfigVersion).toBe(1);
    expect(s.seq).toBe(0);
  });
});

describe('§3.1 example table', () => {
  it('①②③ then cancel ③ restores ① for 1·2 and ② for 3', () => {
    let s = mk();
    s = issue(s, { target: ALL, action: 'GATHER', location: CEN, source: 'VOICE' }).state;
    const c1 = s.commands[0]!.id;
    expect(cur(s)).toEqual([c1, c1, c1]);
    s = issue(s, { target: P('p3'), action: 'DEFEND', location: RIGHT, source: 'VOICE' }, T0 + 1000).state;
    const c2 = s.commands[1]!.id;
    expect(cur(s)).toEqual([c1, c1, c2]);
    s = issue(s, { target: P('p1', 'p2'), action: 'ATTACK', source: 'VOICE' }, T0 + 2000).state;
    const c3 = s.commands[2]!.id;
    expect(cur(s)).toEqual([c3, c3, c2]);
    expect(get(s, c1).status).toBe('SUPERSEDED');
    expect(get(s, c2).status).toBe('ACTIVE');
    expect(get(s, c3).status).toBe('ACTIVE');
    const r = ok(cancelCommand(s, { commandId: c3 }, ctx(T0 + 3000)));
    s = r.state;
    expect(cur(s)).toEqual([c1, c1, c2]);
    expect(get(s, c1).status).toBe('ACTIVE');
    expect(get(s, c3).status).toBe('CANCELLED');
    expect(get(s, c3).cancelReason).toBe('MISRECOGNIZED');
    expect(r.events[0]!.kind).toBe('command.cancelled');
  });
});

describe('issue', () => {
  it('rejects unknown parties and unknown support parties', () => {
    const s = mk();
    expect(issueCommand(s, { target: P('zz'), action: 'MOVE', source: 'MANUAL' }, ctx())).toEqual({ ok: false, error: 'UNKNOWN_PARTY' });
    expect(issueCommand(s, { target: ALL, action: 'SUPPORT', supportPartyIds: ['nope'], source: 'MANUAL' }, ctx())).toEqual({ ok: false, error: 'UNKNOWN_PARTY' });
  });
  it('does not mutate the input state', () => {
    const s = mk();
    const snap = JSON.stringify(s);
    issue(s, { target: ALL, action: 'MOVE', source: 'MANUAL' });
    expect(JSON.stringify(s)).toBe(snap);
  });
  it('emits issued event with seq == command.seq and slots', () => {
    const r = issue(mk(), { target: ALL, action: 'MOVE', source: 'MANUAL', transcript: 'hi' });
    const ev = r.events[0]!;
    expect(ev.kind).toBe('command.issued');
    if (ev.kind === 'command.issued') {
      expect(ev.seq).toBe(1);
      expect(ev.payload.command.seq).toBe(1);
      expect(ev.payload.slots).toEqual(r.state.slots);
    }
    expect(r.ack.commandId).toBe(r.state.commands[0]!.id);
  });
});

describe('repeat', () => {
  const base = { target: ALL, action: 'GATHER', location: CEN, source: 'VOICE' } as const;
  it('within 10s becomes command.repeated', () => {
    let s = issue(mk(), base).state;
    const r = issue(s, base, T0 + 9000);
    expect(r.state.commands).toHaveLength(1);
    expect(r.events[0]!.kind).toBe('command.repeated');
    expect(r.ack.note).toBe('REPEATED');
    expect(r.state.commands[0]!.repeatCount).toBe(1);
    expect(r.state.commands[0]!.repeatedAt).toBe(T0 + 9000);
    // window slides from repeatedAt
    const r2 = issue(r.state, base, T0 + 18000);
    expect(r2.state.commands).toHaveLength(1);
    expect(r2.state.commands[0]!.repeatCount).toBe(2);
    s = r2.state;
  });
  it('after 10s is a new command', () => {
    const s = issue(mk(), base).state;
    const r = issue(s, base, T0 + 10_001);
    expect(r.state.commands).toHaveLength(2);
    expect(r.events[0]!.kind).toBe('command.issued');
  });
  it('different location is a new command', () => {
    const s = issue(mk(), base).state;
    const r = issue(s, { ...base, location: RIGHT }, T0 + 1000);
    expect(r.state.commands).toHaveLength(2);
  });
  it('different target / support set is new; same set order-insensitive is repeat', () => {
    let s = issue(mk(), { target: P('p1', 'p2'), action: 'SUPPORT', supportPartyIds: ['p3'], source: 'VOICE' }).state;
    expect(issue(s, { target: P('p1'), action: 'SUPPORT', supportPartyIds: ['p3'], source: 'VOICE' }, T0 + 1).state.commands).toHaveLength(2);
    s = issue(mk(), { target: P('p1', 'p2'), action: 'MOVE', source: 'VOICE' }).state;
    expect(issue(s, { target: P('p2', 'p1'), action: 'MOVE', source: 'VOICE' }, T0 + 1).events[0]!.kind).toBe('command.repeated');
    s = issue(mk(), { target: P('p1'), action: 'SUPPORT', supportPartyIds: ['p2'], source: 'VOICE' }).state;
    expect(issue(s, { target: P('p1'), action: 'SUPPORT', supportPartyIds: ['p3'], source: 'VOICE' }, T0 + 1).state.commands).toHaveLength(2);
  });
  it('does not repeat onto a non-ACTIVE command', () => {
    let s = issue(mk(), base).state;
    s = issue(s, { target: ALL, action: 'ATTACK', source: 'VOICE' }, T0 + 1000).state; // supersedes ①
    const r = issue(s, base, T0 + 2000);
    expect(r.state.commands).toHaveLength(3);
  });
});

describe('correct', () => {
  it('replaces in place keeping position under a later command', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', location: CEN, source: 'VOICE' }).state;
    const c1 = s.commands[0]!.id;
    s = issue(s, { target: P('p3'), action: 'DEFEND', source: 'VOICE' }, T0 + 1000).state;
    const c2 = s.commands[1]!.id;
    const r = ok(correctCommand(s, { correctsId: c1, action: 'MOVE', location: null, source: 'MANUAL' }, ctx(T0 + 2000)));
    const c3 = r.ack.commandId!;
    expect(r.state.slots).toEqual({ p1: [c3], p2: [c3], p3: [c3, c2] });
    expect(get(r.state, c1).status).toBe('CORRECTED');
    expect(get(r.state, c3).correctsId).toBe(c1);
    expect(get(r.state, c3).location).toBeUndefined();
    expect(get(r.state, c3).action).toBe('MOVE');
    expect(get(r.state, c3).status).toBe('ACTIVE');
    expect(get(r.state, c2).status).toBe('ACTIVE');
    expect(r.events[0]!.kind).toBe('command.corrected');
  });
  it('merges unchanged fields from the original', () => {
    let s = issue(mk(), { target: P('p1'), action: 'ATTACK', location: CEN, source: 'VOICE' }).state;
    const r = ok(correctCommand(s, { correctsId: s.commands[0]!.id, action: 'DEFEND', source: 'VOICE' }, ctx(T0 + 1)));
    const n = get(r.state, r.ack.commandId!);
    expect(n.location).toEqual(CEN);
    expect(n.target).toEqual(P('p1'));
  });
  it('changing target 3 parties -> 4 parties (add, remove)', () => {
    let s = mk(4);
    s = issue(s, { target: P('p1', 'p2', 'p3'), action: 'ATTACK', source: 'VOICE' }).state;
    const c1 = s.commands[0]!.id;
    const r = ok(correctCommand(s, { correctsId: c1, target: P('p1', 'p2', 'p3', 'p4'), source: 'VOICE' }, ctx(T0 + 1)));
    const n = r.ack.commandId!;
    expect(r.state.slots).toEqual({ p1: [n], p2: [n], p3: [n], p4: [n] });
    // and shrinking removes from dropped parties, revealing what is below
    let s2 = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s2.commands[0]!.id;
    s2 = issue(s2, { target: P('p1', 'p2'), action: 'ATTACK', source: 'VOICE' }, T0 + 20_000).state;
    const b = s2.commands[1]!.id;
    const r2 = ok(correctCommand(s2, { correctsId: b, target: P('p1'), source: 'VOICE' }, ctx(T0 + 21_000)));
    const n2 = r2.ack.commandId!;
    expect(r2.state.slots).toEqual({ p1: [a, n2], p2: [a], p3: [a] });
  });
  it('ALL correction does not give later-added parties the command', () => {
    let s = issue(mk(2), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const added: Party[] = [...s.parties, { id: 'x', number: 3, aliases: [], color: 'p3' }];
    s = ok(updateParties(s, { baseVersion: 1, parties: added }, ctx(T0 + 1))).state;
    const r = ok(correctCommand(s, { correctsId: s.commands[0]!.id, action: 'MOVE', source: 'VOICE' }, ctx(T0 + 2)));
    expect(r.state.slots.x).toEqual([]);
  });
  it('superseded / cancelled / corrected original => issued as new, CORRECTION_AS_NEW', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const c1 = s.commands[0]!.id;
    s = issue(s, { target: ALL, action: 'ATTACK', source: 'VOICE' }, T0 + 1000).state;
    expect(get(s, c1).status).toBe('SUPERSEDED');
    const r = ok(correctCommand(s, { correctsId: c1, action: 'RETREAT', source: 'VOICE' }, ctx(T0 + 2000)));
    expect(r.ack.note).toBe('CORRECTION_AS_NEW');
    expect(r.events[0]!.kind).toBe('command.issued');
    expect(get(r.state, r.ack.commandId!).action).toBe('RETREAT');
    expect(get(r.state, c1).status).toBe('SUPERSEDED');
    // cancelled
    const c2 = s.commands[1]!.id;
    const cs = ok(cancelCommand(s, { commandId: c2 }, ctx(T0 + 3000))).state;
    expect(ok(correctCommand(cs, { correctsId: c2, source: 'VOICE' }, ctx(T0 + 4000))).ack.note).toBe('CORRECTION_AS_NEW');
  });
  it('unknown id => UNKNOWN_COMMAND; unknown party => UNKNOWN_PARTY', () => {
    const s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    expect(correctCommand(s, { correctsId: 'nope', source: 'VOICE' }, ctx())).toEqual({ ok: false, error: 'UNKNOWN_COMMAND' });
    expect(correctCommand(s, { correctsId: s.commands[0]!.id, target: P('zz'), source: 'VOICE' }, ctx())).toEqual({ ok: false, error: 'UNKNOWN_PARTY' });
  });
});

describe('cancel', () => {
  it('restores below command', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    s = issue(s, { target: ALL, action: 'ATTACK', source: 'VOICE' }, T0 + 20_000).state;
    const b = s.commands[1]!.id;
    s = ok(cancelCommand(s, { commandId: b }, ctx(T0 + 21_000))).state;
    expect(cur(s)).toEqual([a, a, a]);
    expect(get(s, a).status).toBe('ACTIVE');
  });
  it('below older than 15 min empties the stack', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    const later = T0 + LIMITS.cancelRestoreMaxAgeMs + 1000;
    s = issue(s, { target: P('p1'), action: 'ATTACK', source: 'VOICE' }, later).state;
    const b = s.commands[1]!.id;
    s = ok(cancelCommand(s, { commandId: b }, ctx(later + 1000))).state;
    expect(s.slots.p1).toEqual([]);
    expect(cur(s)).toEqual([undefined, a, a]);
  });
  it('below younger than 15 min is restored', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    const later = T0 + LIMITS.cancelRestoreMaxAgeMs - 1000;
    s = issue(s, { target: P('p1'), action: 'ATTACK', source: 'VOICE' }, later).state;
    s = ok(cancelCommand(s, { commandId: s.commands[1]!.id }, ctx(later + 500))).state;
    expect(currentCommandId(s, 'p1')).toBe(a);
  });
  it('cancel of a non-top command only removes it', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    s = issue(s, { target: ALL, action: 'ATTACK', source: 'VOICE' }, T0 + 20_000).state;
    const b = s.commands[1]!.id;
    expect(get(s, a).status).toBe('SUPERSEDED');
    // even if the top is old, non-top cancel does not empty
    const r = ok(cancelCommand(s, { commandId: a }, ctx(T0 + LIMITS.cancelRestoreMaxAgeMs * 2)));
    expect(cur(r.state)).toEqual([b, b, b]);
    expect(r.state.slots.p1).toEqual([b]);
    expect(get(r.state, a).status).toBe('CANCELLED');
  });
  it('double cancel is ok without event; unknown is an error', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    const r1 = ok(cancelCommand(s, { commandId: a }, ctx(T0 + 1)));
    const seq = r1.state.seq;
    const r2 = ok(cancelCommand(r1.state, { commandId: a }, ctx(T0 + 2)));
    expect(r2.events).toEqual([]);
    expect(r2.ack.note).toBe('ALREADY_CANCELLED');
    expect(r2.state.seq).toBe(seq);
    expect(cancelCommand(s, { commandId: 'zz' }, ctx())).toEqual({ ok: false, error: 'UNKNOWN_COMMAND' });
  });
  it('auto reason: VOICE <30s MISRECOGNIZED; VOICE >=30s CHANGED; MANUAL CHANGED; explicit wins', () => {
    const mkOne = (source: 'VOICE' | 'MANUAL') => issue(mk(), { target: ALL, action: 'GATHER', source }).state;
    const reasonOf = (s: RoomState, now: number, reason?: 'CHANGED' | 'MISRECOGNIZED') =>
      get(ok(cancelCommand(s, { commandId: s.commands[0]!.id, reason }, ctx(now))).state, s.commands[0]!.id).cancelReason;
    expect(reasonOf(mkOne('VOICE'), T0 + 29_000)).toBe('MISRECOGNIZED');
    expect(reasonOf(mkOne('VOICE'), T0 + 30_000)).toBe('CHANGED');
    expect(reasonOf(mkOne('MANUAL'), T0 + 1000)).toBe('CHANGED');
    expect(reasonOf(mkOne('VOICE'), T0 + 1000, 'CHANGED')).toBe('CHANGED');
  });
});

describe('updateParties', () => {
  const party = (id: string, number: number, name?: string): Party => ({ id, number, aliases: [], color: 'p1', ...(name ? { name } : {}) });
  it('VERSION_CONFLICT', () => {
    const s = mk();
    expect(updateParties(s, { baseVersion: 0, parties: s.parties }, ctx())).toEqual({ ok: false, error: 'VERSION_CONFLICT' });
  });
  it('validates count and unique ids', () => {
    const s = mk();
    expect(updateParties(s, { baseVersion: 1, parties: [] }, ctx())).toMatchObject({ ok: false });
    expect(updateParties(s, { baseVersion: 1, parties: [party('a', 1), party('a', 2)] }, ctx())).toMatchObject({ ok: false });
    const many = Array.from({ length: 13 }, (_, i) => party(`q${i}`, i + 1));
    expect(updateParties(s, { baseVersion: 1, parties: many }, ctx())).toMatchObject({ ok: false });
  });
  it('add: new empty stack, ALL not applied, version bumped', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const r = ok(updateParties(s, { baseVersion: 1, parties: [...s.parties, party('p4', 99)] }, ctx(T0 + 1)));
    expect(r.state.slots.p4).toEqual([]);
    expect(r.state.parties[3]!.number).toBe(4);
    expect(r.state.partyConfigVersion).toBe(2);
    expect(r.events[0]!.kind).toBe('parties.updated');
  });
  it('remove: command only on removed party is CANCELLED/PARTY_REMOVED; shared ones survive', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    s = issue(s, { target: P('p3'), action: 'DEFEND', source: 'VOICE' }, T0 + 1000).state;
    const b = s.commands[1]!.id;
    const r = ok(updateParties(s, { baseVersion: 1, parties: s.parties.filter((p) => p.id !== 'p3') }, ctx(T0 + 2000)));
    expect(r.state.slots).toEqual({ p1: [a], p2: [a] });
    expect(get(r.state, b).status).toBe('CANCELLED');
    expect(get(r.state, b).cancelReason).toBe('PARTY_REMOVED');
    expect(get(r.state, a).status).toBe('ACTIVE');
    const ev = r.events[0]!;
    if (ev.kind === 'parties.updated') expect(ev.payload.cancelledCommandIds).toEqual([b]);
  });
  it('rename and reorder keep stacks by id and renumber', () => {
    let s = issue(mk(), { target: P('p1'), action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    const [p1, p2, p3] = s.parties;
    const r = ok(updateParties(s, { baseVersion: 1, parties: [p3!, { ...p1!, name: '돌격' }, p2!] }, ctx(T0 + 1)));
    expect(r.state.parties.map((p) => [p.id, p.number])).toEqual([['p3', 1], ['p1', 2], ['p2', 3]]);
    expect(r.state.slots.p1).toEqual([a]);
    expect(get(r.state, a).status).toBe('ACTIVE');
  });
});

describe('settings & close', () => {
  it('merges partial settings and emits', () => {
    const r = ok(updateSettings(mk(), { shareTranscript: true }));
    expect(r.state.settings.shareTranscript).toBe(true);
    expect(r.state.settings.maxMembers).toBe(LIMITS.maxMembers);
    expect(r.events[0]!.kind).toBe('settings.updated');
  });
  it('closeRoom marks CLOSED', () => {
    expect(ok(closeRoom(mk())).state.status).toBe('CLOSED');
  });
});

describe('idempotency', () => {
  it('duplicate clientCmdId returns same ack, no events, no state change', () => {
    const s = mk();
    const r1 = ok(withClientCmd(s, 'k1', (x) => issueCommand(x, { target: ALL, action: 'MOVE', source: 'MANUAL' }, ctx())));
    expect(r1.events).toHaveLength(1);
    const r2 = ok(withClientCmd(r1.state, 'k1', (x) => issueCommand(x, { target: ALL, action: 'ATTACK', source: 'MANUAL' }, ctx(T0 + 5))));
    expect(r2.events).toEqual([]);
    expect(r2.ack).toEqual(r1.ack);
    expect(r2.state).toBe(r1.state);
    expect(r2.state.commands).toHaveLength(1);
  });
  it('remembers errors and bounds history to 200', () => {
    const s = mk();
    const r = withClientCmd(s, 'e1', (x) => issueCommand(x, { target: P('zz'), action: 'MOVE', source: 'MANUAL' }, ctx()));
    expect(r.ok).toBe(false);
    const st = (r as { state: RoomState }).state;
    expect(withClientCmd(st, 'e1', (x) => issueCommand(x, { target: ALL, action: 'MOVE', source: 'MANUAL' }, ctx()))).toEqual({ ok: false, error: 'UNKNOWN_PARTY' });
    let cur2 = s;
    for (let i = 0; i < 250; i++) cur2 = ok(withClientCmd(cur2, `k${i}`, (x) => updateSettings(x, {}))).state;
    expect(cur2.recentClientCmds).toHaveLength(200);
    expect(cur2.recentClientCmds[0]!.clientCmdId).toBe('k50');
  });
});

describe('cap and seq', () => {
  it('caps commands at 50, dropping oldest non-top and removing from stacks', () => {
    let s = mk(1);
    for (let i = 0; i < 60; i++) {
      s = issue(s, { target: ALL, action: i % 2 ? 'MOVE' : 'ATTACK', location: { id: `L${i}`, label: 'x' }, source: 'MANUAL' }, T0 + i * 20_000).state;
    }
    expect(s.commands).toHaveLength(LIMITS.maxCommands);
    expect(s.slots.p1).toHaveLength(LIMITS.maxCommands);
    const ids = new Set(s.commands.map((c) => c.id));
    expect(s.slots.p1!.every((id) => ids.has(id))).toBe(true);
    expect(s.commands[0]!.id).toBe('c11');
  });
  it('keeps a top command even when oldest', () => {
    let s = mk(2);
    s = issue(s, { target: P('p2'), action: 'HOLD', source: 'MANUAL' }).state;
    const keep = s.commands[0]!.id;
    for (let i = 0; i < 55; i++) s = issue(s, { target: P('p1'), action: 'MOVE', location: { id: `L${i}`, label: 'x' }, source: 'MANUAL' }, T0 + i * 20_000).state;
    expect(s.commands.some((c) => c.id === keep)).toBe(true);
    expect(s.commands).toHaveLength(LIMITS.maxCommands);
  });
  it('seq increments by exactly one per emitted event', () => {
    let s = mk();
    const seqs: number[] = [];
    const push = (r: Result) => { const o = ok(r); o.events.forEach((e) => seqs.push(e.seq)); return o.state; };
    s = push(issueCommand(s, { target: ALL, action: 'GATHER', source: 'VOICE' }, ctx()));
    s = push(issueCommand(s, { target: ALL, action: 'GATHER', source: 'VOICE' }, ctx(T0 + 1))); // repeat
    s = push(correctCommand(s, { correctsId: s.commands[0]!.id, action: 'MOVE', source: 'VOICE' }, ctx(T0 + 2)));
    s = push(updateSettings(s, { shareTranscript: true }));
    s = push(cancelCommand(s, { commandId: s.commands[1]!.id }, ctx(T0 + 3)));
    s = push(cancelCommand(s, { commandId: s.commands[1]!.id }, ctx(T0 + 4))); // no event
    s = push(updateParties(s, { baseVersion: 1, parties: s.parties }, ctx(T0 + 5)));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.seq).toBe(6);
  });
});

describe('snapshot / transcript filtering', () => {
  const presence: Presence = { total: 0, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' };
  it('strips transcript for MEMBER unless shareTranscript', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE', transcript: '전체 집결' }).state;
    expect(toSnapshot(s, presence, 'MEMBER').commands[0]!.transcript).toBeUndefined();
    expect(toSnapshot(s, presence, 'COMMANDER').commands[0]!.transcript).toBe('전체 집결');
    expect(toSnapshot(s, presence, 'OPERATOR').commands[0]!.transcript).toBe('전체 집결');
    s = ok(updateSettings(s, { shareTranscript: true })).state;
    expect(toSnapshot(s, presence, 'MEMBER').commands[0]!.transcript).toBe('전체 집결');
    expect(s.commands[0]!.transcript).toBe('전체 집결'); // state untouched
  });
  it('eventForRole strips transcript from issued events for members', () => {
    const r = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE', transcript: 'x' });
    const ev = r.events[0]!;
    const m = eventForRole(ev, r.state.settings, 'MEMBER');
    expect(m.kind === 'command.issued' && m.payload.command.transcript).toBeUndefined();
    const c = eventForRole(ev, r.state.settings, 'COMMANDER');
    expect(c.kind === 'command.issued' && c.payload.command.transcript).toBe('x');
  });
});

// UTF-8 byte length (BMP only; enough for Hangul + ASCII).
const utf8Bytes = (str: string) => [...str].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x80 ? 1 : ch.charCodeAt(0) < 0x800 ? 2 : 3), 0);

describe('review fixes', () => {
  const noPresence: Presence = { total: 0, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' };

  it('repeat: "1-2 attack", "2 defend", "1-2 attack" re-issues instead of repeating', () => {
    let s = issue(mk(), { target: P('p1', 'p2'), action: 'ATTACK', source: 'VOICE' }).state;
    s = issue(s, { target: P('p2'), action: 'DEFEND', source: 'VOICE' }, T0 + 2000).state;
    const r = issue(s, { target: P('p1', 'p2'), action: 'ATTACK', source: 'VOICE' }, T0 + 4000);
    expect(r.events[0]!.kind).toBe('command.issued');
    expect(r.ack.note).toBeUndefined();
    const top = currentCommandId(r.state, 'p2')!;
    expect(get(r.state, top).action).toBe('ATTACK');
  });
  it('repeat: ALL X -> 3 Y -> ALL X re-issues; plain ALL X x2 still repeats', () => {
    let s = issue(mk(), { target: ALL, action: 'GATHER', source: 'VOICE' }).state;
    expect(issue(s, { target: ALL, action: 'GATHER', source: 'VOICE' }, T0 + 1000).ack.note).toBe('REPEATED');
    s = issue(s, { target: P('p3'), action: 'ATTACK', source: 'VOICE' }, T0 + 2000).state;
    const r = issue(s, { target: ALL, action: 'GATHER', source: 'VOICE' }, T0 + 4000);
    expect(r.events[0]!.kind).toBe('command.issued');
    expect(r.state.commands).toHaveLength(3);
    expect(cur(r.state).every((x) => x === r.ack.commandId)).toBe(true);
  });

  it('correct: deleted party in the original target is dropped, not UNKNOWN_PARTY', () => {
    let s = issue(mk(), { target: P('p1', 'p2'), action: 'ATTACK', source: 'VOICE' }).state;
    const orig = s.commands[0]!.id;
    s = ok(updateParties(s, { baseVersion: 1, parties: s.parties.filter((p) => p.id !== 'p2') }, ctx(T0 + 1000))).state;
    const r = ok(correctCommand(s, { correctsId: orig, action: 'DEFEND', source: 'MANUAL' }, ctx(T0 + 2000)));
    const cmd = r.state.commands.find((c) => c.id === r.ack.commandId)!;
    expect(cmd.target).toEqual({ kind: 'PARTIES', partyIds: ['p1'] });
  });
  it('correct: nothing left and no patch target -> UNKNOWN_PARTY; patch target works', () => {
    let s = issue(mk(), { target: P('p2'), action: 'ATTACK', source: 'VOICE' }).state;
    const orig = s.commands[0]!.id;
    s = ok(updateParties(s, { baseVersion: 1, parties: s.parties.filter((p) => p.id !== 'p2') }, ctx(T0 + 1000))).state;
    expect(correctCommand(s, { correctsId: orig, action: 'DEFEND', source: 'MANUAL' }, ctx(T0 + 2000))).toMatchObject({ ok: false, error: 'UNKNOWN_PARTY' });
    expect(correctCommand(s, { correctsId: orig, target: P('p1'), source: 'MANUAL' }, ctx(T0 + 2000)).ok).toBe(true);
  });
  it('correct: deleted support party ids are dropped', () => {
    let s = issue(mk(), { target: P('p1'), action: 'ATTACK', supportPartyIds: ['p2', 'p3'], source: 'VOICE' }).state;
    const orig = s.commands[0]!.id;
    s = ok(updateParties(s, { baseVersion: 1, parties: s.parties.filter((p) => p.id !== 'p2') }, ctx(T0 + 1000))).state;
    const r = ok(correctCommand(s, { correctsId: orig, action: 'DEFEND', source: 'MANUAL' }, ctx(T0 + 2000)));
    expect(r.state.commands.find((c) => c.id === r.ack.commandId)!.supportPartyIds).toEqual(['p3']);
  });

  it('cancel restore age uses max(issuedAt, repeatedAt) of the command below', () => {
    let s = issue(mk(), { target: P('p1'), action: 'GATHER', source: 'VOICE' }).state;
    const a = s.commands[0]!.id;
    const repeatedAt = T0 + 14 * 60_000;
    s.commands[0]!.repeatedAt = repeatedAt;
    const later = T0 + LIMITS.cancelRestoreMaxAgeMs + 60_000; // 16 min after issue, 2 min after repeat
    s = issue(s, { target: P('p1'), action: 'ATTACK', source: 'VOICE' }, later - 1000).state;
    const b = s.commands[1]!.id;
    s = ok(cancelCommand(s, { commandId: b }, ctx(later))).state;
    expect(s.slots.p1).toEqual([a]);
  });

  it('snapshot: worst case (50 cmds, 200 Hangul chars, 12 parties) stays under 32KB and keeps only the newest transcripts', () => {
    let s = createRoomState({
      code: 'ABC234', now: T0, parties: Array.from({ length: 12 }, () => ({ name: '가나다라마바사아자차', aliases: ['가나다라마바사아', '자차카타파하갸냐'] })),
      commanderTokenHash: 'h'.repeat(64), operatorTokenHash: 'h'.repeat(64),
    });
    const ids = s.parties.map((p) => p.id);
    let n = 0;
    const longIds = () => `abcdef${String(++n).padStart(6, '0')}`; // real ids are 12 chars
    for (let i = 0; i < LIMITS.maxCommands; i++) {
      s = issue(s, {
        target: ALL, action: 'ATTACK', source: 'VOICE', supportPartyIds: ids.slice(0, 3),
        location: { id: 'CENTER', label: '가나다라마바사아자차카타파하갸냐댜랴먀뱌샤' }, confidence: 0.123456789,
        transcript: '가'.repeat(LIMITS.transcriptMax),
      }, T0 + i * 20_000, longIds).state;
    }
    expect(s.commands).toHaveLength(LIMITS.maxCommands);
    for (const role of ['COMMANDER', 'OPERATOR'] as const) {
      const snap = toSnapshot(s, noPresence, role);
      expect(snap.commands.filter((c) => c.transcript !== undefined)).toHaveLength(SNAPSHOT_TRANSCRIPT_COMMANDS);
      expect(snap.commands.slice(-SNAPSHOT_TRANSCRIPT_COMMANDS).every((c) => c.transcript !== undefined)).toBe(true);
      expect(utf8Bytes(JSON.stringify({ type: 'welcome', snapshot: snap }))).toBeLessThan(32 * 1024);
    }
  });
});
