import { describe, expect, it } from 'vitest';
import { LIMITS, parseClientMessage, PING_STRING, PONG_STRING } from '../src';

const j = (o: unknown) => JSON.stringify(o);
const ok = (o: unknown) => parseClientMessage(j(o)).ok;
const T = { kind: 'PARTIES', partyIds: ['p1'] };

const valid: Record<string, unknown> = {
  hello: { v: 1, type: 'hello', roomCode: 'ABC234', clientId: 'c1', role: 'MEMBER', lastSeq: 3 },
  'party.select': { v: 1, type: 'party.select', partyId: null },
  ping: { v: 1, type: 'ping' },
  'command.issue': { v: 1, type: 'command.issue', clientCmdId: 'a', target: T, action: 'ATTACK', source: 'VOICE', confidence: 0.9 },
  'command.correct': { v: 1, type: 'command.correct', clientCmdId: 'a', correctsId: 'c', location: null, source: 'MANUAL' },
  'command.cancel': { v: 1, type: 'command.cancel', clientCmdId: 'a', commandId: 'c' },
  'parties.update': { v: 1, type: 'parties.update', clientCmdId: 'a', baseVersion: 0, parties: [{ id: 'p1', number: 1, aliases: [], color: 'p1' }] },
  'room.settings': { v: 1, type: 'room.settings', clientCmdId: 'a', settings: { shareTranscript: true } },
  'room.close': { v: 1, type: 'room.close', clientCmdId: 'a' },
  'stt.status': { v: 1, type: 'stt.status', state: 'LISTENING' },
  'stt.feed': { v: 1, type: 'stt.feed', entries: [{ id: 'e', at: 1, text: 'x', outcome: 'ISSUED' }] },
};
const invalid: Record<string, unknown> = {
  hello: { v: 1, type: 'hello', roomCode: 'ABC234', clientId: 'c1', role: 'KING' },
  'party.select': { v: 1, type: 'party.select' },
  ping: { v: 2, type: 'ping' },
  'command.issue': { v: 1, type: 'command.issue', clientCmdId: 'a', target: { kind: 'PARTIES', partyIds: [] }, action: 'ATTACK', source: 'VOICE' },
  'command.correct': { v: 1, type: 'command.correct', clientCmdId: 'a', source: 'MANUAL' },
  'command.cancel': { v: 1, type: 'command.cancel', clientCmdId: 'a', commandId: 'c', reason: 'BAD' },
  'parties.update': { v: 1, type: 'parties.update', clientCmdId: 'a', baseVersion: 0, parties: [] },
  'room.settings': { v: 1, type: 'room.settings', clientCmdId: 'a', settings: { maxMembers: 999 } },
  'room.close': { v: 1, type: 'room.close' },
  'stt.status': { v: 1, type: 'stt.status', state: 'NOPE' },
  'stt.feed': { v: 1, type: 'stt.feed', entries: Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, at: 1, text: 'x', outcome: 'ISSUED' })) },
};

describe('client messages', () => {
  for (const k of Object.keys(valid)) {
    it(`${k} valid`, () => expect(ok(valid[k])).toBe(true));
    it(`${k} invalid`, () => expect(ok(invalid[k])).toBe(false));
  }
  it('unknown type rejected', () => expect(ok({ v: 1, type: 'nope' })).toBe(false));
  it('missing v rejected', () => expect(ok({ type: 'ping' })).toBe(false));
  it('bad JSON rejected', () => {
    const r = parseClientMessage('{oops');
    expect(r.ok).toBe(false);
  });
  it('ping/pong constants parse', () => {
    expect(parseClientMessage(PING_STRING).ok).toBe(true);
    expect(JSON.parse(PONG_STRING)).toEqual({ v: 1, type: 'pong' });
  });
  it('oversize party name rejected', () => {
    const m = JSON.parse(JSON.stringify(valid["parties.update"])) as any;
    m.parties[0].name = 'x'.repeat(11);
    expect(ok(m)).toBe(false);
    m.parties[0].name = 'x'.repeat(10);
    expect(ok(m)).toBe(true);
  });
  it('more than 12 parties rejected', () => {
    const m = JSON.parse(JSON.stringify(valid["parties.update"])) as any;
    m.parties = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, number: 1, aliases: [], color: 'p1' }));
    expect(ok(m)).toBe(false);
  });
});

describe('sub-commander hello', () => {
  const hello = (extra: object) => ({ v: 1, type: 'hello', roomCode: 'ABC234', clientId: 'c1', ...extra });
  it('accepts SUB_COMMANDER with subCommanderToken', () => {
    expect(ok(hello({ role: 'SUB_COMMANDER', subCommanderToken: 'tok' }))).toBe(true);
    expect(ok(hello({ role: 'OPERATOR', operatorToken: 'tok' }))).toBe(true);
  });
  it('rejects empty or oversized tokens', () => {
    expect(ok(hello({ role: 'SUB_COMMANDER', subCommanderToken: '' }))).toBe(false);
    expect(ok(hello({ role: 'SUB_COMMANDER', subCommanderToken: 'x'.repeat(129) }))).toBe(false);
    expect(ok(hello({ role: 'SUB_COMMANDER', subCommanderToken: 5 }))).toBe(false);
  });
  it('exposes a frame length cap above the largest legitimate frame', () => {
    const feed = { v: 1, type: 'stt.feed', entries: Array.from({ length: LIMITS.sttFeedMaxEntries }, (_, i) => ({ id: `e${i}`, at: 1, text: '가'.repeat(LIMITS.transcriptMax), outcome: 'ISSUED' })) };
    expect(LIMITS.maxFrameLength).toBe(8192);
    expect(JSON.stringify(feed).length).toBeLessThan(LIMITS.maxFrameLength);
  });
});
