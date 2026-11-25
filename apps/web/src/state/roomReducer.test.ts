import { describe, expect, it } from 'vitest';
import { makeDefaultParties, type Command, type ServerMessage, type Snapshot } from '@winds/protocol';
import { applyServerMessage, initialRoomData, selectCurrentCommand, type RoomData } from './roomStore';

const cmd = (id: string, over: Partial<Command> = {}): Command => ({
  id, seq: 1, target: { kind: 'ALL' }, action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL',
  issuedAt: 1000, repeatCount: 0, ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  seq: 10, roomCode: 'ABC234', status: 'OPEN',
  settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false },
  parties: makeDefaultParties(3), partyConfigVersion: 1,
  slots: { p1: ['c1'], p2: [], p3: [] }, commands: [cmd('c1')],
  presence: { total: 2, byParty: { p1: 1 }, unassigned: 1, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' },
  expiresAt: 99, ...over,
});

const welcome = (s = snap()): ServerMessage => ({ v: 1, type: 'welcome', role: 'MEMBER', memberId: 'm', snapshot: s });
const apply = (s: RoomData, m: ServerMessage) => applyServerMessage(s, m);
const base = () => apply(initialRoomData(), welcome());

describe('applyServerMessage', () => {
  it('welcome replaces everything from the snapshot', () => {
    const s = base();
    expect(s.hasSnapshot).toBe(true);
    expect(s.role).toBe('MEMBER');
    expect(s.seq).toBe(10);
    expect(s.parties).toHaveLength(3);
    expect(s.commands.c1?.action).toBe('ATTACK');
    expect(selectCurrentCommand(s, 'p1')?.id).toBe('c1');
    expect(selectCurrentCommand(s, 'p2')).toBeNull();
    // snapshot replaces, not merges
    const s2 = apply(s, { v: 1, type: 'snapshot', ...snap({ seq: 20, slots: { p1: [] }, commands: [] }) });
    expect(s2.seq).toBe(20);
    expect(s2.commands).toEqual({});
    expect(selectCurrentCommand(s2, 'p1')).toBeNull();
  });

  it('command.issued uses payload.slots as-is (last of stack is current)', () => {
    const c2 = cmd('c2', { seq: 11 });
    // deliberately odd slots: the reducer must not "fix" them
    const slots = { p1: ['c1', 'c2'], p2: ['c2'], p3: [] };
    const s = apply(base(), { v: 1, type: 'event', seq: 11, kind: 'command.issued', payload: { command: c2, slots } });
    expect(s.seq).toBe(11);
    expect(s.slots).toBe(slots);
    expect(selectCurrentCommand(s, 'p1')?.id).toBe('c2');
    expect(selectCurrentCommand(s, 'p2')?.id).toBe('c2');
  });

  it('command.repeated updates repeat fields; unknown id is ignored', () => {
    const s = apply(base(), { v: 1, type: 'event', seq: 11, kind: 'command.repeated', payload: { commandId: 'c1', repeatedAt: 5, repeatCount: 2 } });
    expect(s.commands.c1).toMatchObject({ repeatedAt: 5, repeatCount: 2 });
    const s2 = apply(s, { v: 1, type: 'event', seq: 12, kind: 'command.repeated', payload: { commandId: 'nope', repeatedAt: 5, repeatCount: 1 } });
    expect(s2.seq).toBe(12);
  });

  it('command.corrected marks old CORRECTED and takes server slots', () => {
    const c2 = cmd('c2', { correctsId: 'c1' });
    const slots = { p1: ['c2'], p2: [], p3: [] };
    const s = apply(base(), { v: 1, type: 'event', seq: 11, kind: 'command.corrected', payload: { command: c2, correctedId: 'c1', slots } });
    expect(s.commands.c1?.status).toBe('CORRECTED');
    expect(selectCurrentCommand(s, 'p1')?.id).toBe('c2');
  });

  it('command.cancelled marks cancelled with reason and takes server slots', () => {
    const s = apply(base(), { v: 1, type: 'event', seq: 11, kind: 'command.cancelled', payload: { commandIds: ['c1'], reason: 'CHANGED', slots: { p1: [], p2: [], p3: [] } } });
    expect(s.commands.c1).toMatchObject({ status: 'CANCELLED', cancelReason: 'CHANGED' });
    expect(selectCurrentCommand(s, 'p1')).toBeNull();
  });

  it('parties.updated replaces parties/slots, cancels commands, raises a notice', () => {
    const s = apply(base(), {
      v: 1, type: 'event', seq: 11, kind: 'parties.updated',
      payload: { parties: makeDefaultParties(2), partyConfigVersion: 2, slots: { p1: [], p2: [] }, cancelledCommandIds: ['c1'] },
    });
    expect(s.parties).toHaveLength(2);
    expect(s.partyConfigVersion).toBe(2);
    expect(s.commands.c1).toMatchObject({ status: 'CANCELLED', cancelReason: 'PARTY_REMOVED' });
    expect(s.notice?.kind).toBe('PARTIES_CHANGED');
    expect(s.notice?.text).toBe('파티 구성이 바뀌었습니다');
  });

  it('removing my party reopens the picker', () => {
    const mine = { ...base(), myPartyId: 'p3' };
    const s = apply(mine, {
      v: 1, type: 'event', seq: 11, kind: 'parties.updated',
      payload: { parties: makeDefaultParties(2), partyConfigVersion: 2, slots: {}, cancelledCommandIds: [] },
    });
    expect(s.myPartyId).toBeNull();
    expect(s.needsPartyPick).toBe(true);
    expect(s.notice?.kind).toBe('MY_PARTY_REMOVED');
  });

  it('keeps my party when it still exists; reconnect snapshot also reconciles', () => {
    const mine = { ...base(), myPartyId: 'p2' };
    const s = apply(mine, {
      v: 1, type: 'event', seq: 11, kind: 'parties.updated',
      payload: { parties: makeDefaultParties(3), partyConfigVersion: 2, slots: {}, cancelledCommandIds: [] },
    });
    expect(s.myPartyId).toBe('p2');
    const gone = apply({ ...mine, myPartyId: 'p9' }, welcome());
    expect(gone.needsPartyPick).toBe(true);
  });

  it('settings.updated', () => {
    const s = apply(base(), { v: 1, type: 'event', seq: 11, kind: 'settings.updated', payload: { settings: { maxMembers: 10, shareTranscript: true, targetlessAsAll: false } } });
    expect(s.settings.shareTranscript).toBe(true);
  });

  it('presence', () => {
    const s = apply(base(), { v: 1, type: 'presence', total: 9, byParty: { p1: 4 }, unassigned: 5, commanderOnline: false, operatorsOnline: 1, sttState: 'LISTENING' });
    expect(s.presence).toEqual({ total: 9, byParty: { p1: 4 }, unassigned: 5, commanderOnline: false, operatorsOnline: 1, sttState: 'LISTENING' });
    expect(s.seq).toBe(10); // presence does not carry seq
  });

  it('room.closed, stt.feed (capped), error, ack', () => {
    expect(apply(base(), { v: 1, type: 'room.closed', reason: 'EXPIRED' }).roomStatus).toBe('CLOSED');
    const entries = Array.from({ length: 15 }, (_, i) => ({ id: `e${i}`, at: i, text: 't', outcome: 'ISSUED' as const }));
    let s = apply(base(), { v: 1, type: 'stt.feed', from: 'COMMANDER', entries });
    s = apply(s, { v: 1, type: 'stt.feed', from: 'COMMANDER', entries });
    expect(s.sttFeed).toHaveLength(20);
    s = apply(s, { v: 1, type: 'error', code: 'RATE_LIMITED', message: 'slow' });
    expect(s.lastError).toEqual({ code: 'RATE_LIMITED', message: 'slow' });
    s = apply(s, { v: 1, type: 'ack', clientCmdId: 'x', note: 'REPEATED' });
    expect(s.lastAck?.note).toBe('REPEATED');
  });

  it('does not mutate the input state', () => {
    const before = base();
    const frozen = JSON.stringify(before);
    apply(before, { v: 1, type: 'event', seq: 11, kind: 'command.cancelled', payload: { commandIds: ['c1'], reason: 'CHANGED', slots: {} } });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
