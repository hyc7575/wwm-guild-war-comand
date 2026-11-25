import { describe, expect, it } from 'vitest';
import {
  CreateRoomRequest, generateRoomCode, isValidRoomCode, makeDefaultParties, normalizeRoomCode,
  parseServerMessage, ROOM_CODE_ALPHABET, DEFAULT_ROOM_SETTINGS, PARTY_COLORS,
} from '../src';

const parties = makeDefaultParties(3);
const slots = { p1: ['c1'], p2: ['c1'], p3: [] };
const command = {
  id: 'c1', seq: 1, target: { kind: 'ALL' }, action: 'GATHER', status: 'ACTIVE',
  source: 'VOICE', issuedAt: 1, repeatCount: 0,
};
const presence = { total: 1, byParty: { p1: 1 }, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' };
const snapshot = {
  seq: 1, roomCode: 'ABC234', status: 'OPEN', settings: DEFAULT_ROOM_SETTINGS, parties,
  partyConfigVersion: 0, slots, commands: [command], presence, expiresAt: 10,
};
const ev = (kind: string, payload: unknown) => ({ v: 1, type: 'event', seq: 2, kind, payload });

const samples: Record<string, unknown> = {
  welcome: { v: 1, type: 'welcome', role: 'MEMBER', memberId: 'm', snapshot },
  snapshot: { v: 1, type: 'snapshot', ...snapshot },
  'event issued': ev('command.issued', { command, slots }),
  'event repeated': ev('command.repeated', { commandId: 'c1', repeatedAt: 5, repeatCount: 1 }),
  'event corrected': ev('command.corrected', { command, correctedId: 'c0', slots }),
  'event cancelled': ev('command.cancelled', { commandIds: ['c1'], reason: 'CHANGED', slots }),
  'event parties': ev('parties.updated', { parties, partyConfigVersion: 1, slots, cancelledCommandIds: [] }),
  'event settings': ev('settings.updated', { settings: DEFAULT_ROOM_SETTINGS }),
  ack: { v: 1, type: 'ack', clientCmdId: 'a', commandId: 'c1', note: 'REPEATED' },
  'ack error': { v: 1, type: 'ack', clientCmdId: 'a', error: 'FORBIDDEN' },
  presence: { v: 1, type: 'presence', ...presence },
  pong: { v: 1, type: 'pong' },
  error: { v: 1, type: 'error', code: 'RATE_LIMITED', message: 'slow down' },
  'room.closed': { v: 1, type: 'room.closed', reason: 'EXPIRED' },
  'session.replaced': { v: 1, type: 'session.replaced' },
  'stt.feed': { v: 1, type: 'stt.feed', from: 'COMMANDER', entries: [{ id: 'e', at: 1, text: 't', outcome: 'CANDIDATE', summary: 's' }] },
};

describe('server messages round trip', () => {
  for (const [k, m] of Object.entries(samples)) {
    it(k, () => {
      const r = parseServerMessage(JSON.stringify(m));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.msg).toMatchObject(m as object);
    });
  }
  it('rejects unknown and bad json', () => {
    expect(parseServerMessage('{"v":1,"type":"zzz"}').ok).toBe(false);
    expect(parseServerMessage('nope').ok).toBe(false);
  });
  it('rejects cancelled event with no ids', () => {
    expect(parseServerMessage(JSON.stringify(ev('command.cancelled', { commandIds: [], reason: 'CHANGED', slots }))).ok).toBe(false);
  });
});

describe('room code', () => {
  it('alphabet excludes confusing chars', () => {
    for (const c of '0O1IL') expect(ROOM_CODE_ALPHABET).not.toContain(c);
  });
  it('generates valid 6-char codes', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateRoomCode();
      expect(c).toHaveLength(6);
      expect(isValidRoomCode(c)).toBe(true);
    }
    expect(generateRoomCode(() => 0.999999)).toHaveLength(6);
  });
  it('normalize / validate', () => {
    expect(normalizeRoomCode('  abc234 ')).toBe('ABC234');
    expect(isValidRoomCode('ABC23')).toBe(false);
    expect(isValidRoomCode('ABCO34')).toBe(false);
  });
});

describe('helpers', () => {
  it('makeDefaultParties', () => {
    expect(PARTY_COLORS).toHaveLength(12);
    expect(makeDefaultParties(12)).toHaveLength(12);
    expect(makeDefaultParties(99)).toHaveLength(12);
    expect(makeDefaultParties(2)[1]).toMatchObject({ id: 'p2', number: 2 });
  });
  it('CreateRoomRequest bounds', () => {
    expect(CreateRoomRequest.safeParse({ parties: [] }).success).toBe(false);
    expect(CreateRoomRequest.safeParse({ parties: [{ name: 'a' }] }).success).toBe(true);
    expect(CreateRoomRequest.safeParse({ parties: [{ name: 'x'.repeat(11) }] }).success).toBe(false);
  });
});
