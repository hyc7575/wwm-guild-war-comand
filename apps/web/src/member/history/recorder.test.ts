import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { makeDefaultParties, type Command, type ServerMessage } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { HistoryStore } from './HistoryStore';
import { startHistoryRecorder } from './recorder';
import { memoryKv } from './testUtil';
import type { Kv } from './HistoryStore';

const NOW = Date.now();
const cmd = (id: string, seq: number, over: Partial<Command> = {}): Command => ({
  id, seq, target: { kind: 'PARTIES', partyIds: ['p2'] }, action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL',
  issuedAt: NOW, repeatCount: 0, issuer: { role: 'COMMANDER' }, ...over,
});
const send = (m: ServerMessage) => act(() => useRoomStore.getState().receive(m));
const welcome = (commands: Command[], seq = 10): ServerMessage => ({
  v: 1, type: 'welcome', role: 'MEMBER', memberId: 'm',
  snapshot: {
    seq, roomCode: 'ABC234', status: 'OPEN',
    settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false },
    parties: makeDefaultParties(4), partyConfigVersion: 1, slots: { p1: [], p2: [], p3: [], p4: [] }, commands,
    presence: { total: 1, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' }, expiresAt: NOW + 1e7,
  },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

let history: HistoryStore;
let stop: () => void;
let saveT = false;
beforeEach(() => {
  history = new HistoryStore(memoryKv());
  saveT = false;
  useRoomStore.getState().attach('ABC234', 'MEMBER');
  stop = startHistoryRecorder({ history, saveTranscript: () => saveT });
});
const failingKv = (): Kv => ({
  get: async () => { throw new Error('quota'); },
  set: async () => { throw new Error('quota'); },
  del: async () => undefined,
  keys: async () => [],
});
afterEach(() => {
  stop();
  useRoomStore.getState().reset();
});

describe('startHistoryRecorder', () => {
  it('records the snapshot, then events; duplicates do not double up; no ids/tokens stored', async () => {
    send(welcome([cmd('a', 1)]));
    const ev: ServerMessage = { v: 1, type: 'event', seq: 11, kind: 'command.issued', payload: { command: cmd('b', 2, { transcript: '비밀 원문' }), slots: { p1: [], p2: ['b'], p3: [], p4: [] } } };
    send(ev);
    send(ev);
    await flush();
    const [room] = await history.listRooms();
    expect(room?.entries.map((x) => x.id)).toEqual(['b', 'a']);
    expect(room?.entries[0]).toMatchObject({ target: [2], issuerRole: 'COMMANDER' });
    expect(JSON.stringify(room)).not.toContain('비밀 원문');
    expect(JSON.stringify(room)).not.toMatch(/clientId|token|memberId/);
  });

  it('applies cancel/correct events and stores transcript only when enabled', async () => {
    saveT = true;
    send(welcome([cmd('a', 1, { transcript: '원문A' })]));
    send({ v: 1, type: 'event', seq: 11, kind: 'command.cancelled', payload: { commandIds: ['a'], reason: 'CHANGED', slots: { p1: [], p2: [], p3: [], p4: [] }, cancelledBy: 'COMMANDER' } } as ServerMessage);
    await flush();
    const [room] = await history.listRooms();
    expect(room?.entries[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'CHANGED', transcript: '원문A' });
  });

  it('a reconnect snapshot only adds commands that were missed and marks closed', async () => {
    send(welcome([cmd('a', 1)]));
    send(welcome([cmd('a', 1), cmd('c', 3)], 20));
    send({ v: 1, type: 'room.closed' } as ServerMessage);
    await flush();
    const [room] = await history.listRooms();
    expect(room?.entries.map((x) => x.id)).toEqual(['c', 'a']);
    expect(room?.closed).toBe(true);
  });

  it('a recorder started after welcome still records the commands already in the snapshot', async () => {
    stop();
    send(welcome([cmd('a', 1), cmd('b', 2)]));
    const late = new HistoryStore(memoryKv());
    stop = startHistoryRecorder({ history: late, saveTranscript: () => false });
    await flush();
    const [room] = await late.listRooms();
    expect(room?.entries.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('stops writing once the store is unavailable', async () => {
    stop();
    const bad = new HistoryStore(failingKv());
    const spy = vi.spyOn(bad, 'record');
    stop = startHistoryRecorder({ history: bad, saveTranscript: () => false });
    send(welcome([cmd('a', 1)]));
    await flush();
    expect(bad.available).toBe(false);
    send({ v: 1, type: 'event', seq: 11, kind: 'command.issued', payload: { command: cmd('b', 2), slots: { p1: [], p2: ['b'], p3: [], p4: [] } } });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
