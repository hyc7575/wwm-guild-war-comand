import { describe, expect, it } from 'vitest';
import { HistoryStore } from './HistoryStore';
import { memoryKv } from './testUtil';
import type { HistoryEntry } from './types';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const e = (id: string, seq: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, seq, issuedAt: T0, target: 'ALL', action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL', repeatCount: 0, ...over,
});

describe('HistoryStore', () => {
  it('upserts by id (dedup) and keeps an earlier transcript', async () => {
    const h = new HistoryStore(memoryKv(), { now: () => T0 });
    await h.record('ROOM', [e('a', 1, { transcript: '공격' })], { eventSeq: 5 });
    await h.record('ROOM', [e('a', 1, { status: 'CANCELLED' })], { eventSeq: 6 });
    const [r] = await h.listRooms();
    expect(r?.entries).toHaveLength(1);
    expect(r?.entries[0]).toMatchObject({ status: 'CANCELLED', transcript: '공격' });
  });

  it('skips events at or below the stored seq, but snapshots still top up', async () => {
    const h = new HistoryStore(memoryKv(), { now: () => T0 });
    await h.record('ROOM', [e('a', 1)], { eventSeq: 5 });
    await h.record('ROOM', [e('b', 2)], { eventSeq: 5 });
    expect((await h.listRooms())[0]?.entries.map((x) => x.id)).toEqual(['a']);
    await h.record('ROOM', [e('b', 2)], { snapshotSeq: 5 });
    expect((await h.listRooms())[0]?.entries.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('keeps the newest N entries and drops entries older than the age limit', async () => {
    let now = T0;
    const h = new HistoryStore(memoryKv(), { now: () => now, maxEntries: 3, maxAgeMs: 7 * DAY });
    await h.record('ROOM', [1, 2, 3, 4, 5].map((n) => e(`c${n}`, n)), { snapshotSeq: 5 });
    expect((await h.listRooms())[0]?.entries.map((x) => x.id)).toEqual(['c5', 'c4', 'c3']);
    now = T0 + 8 * DAY;
    expect(await h.listRooms()).toEqual([]);
  });

  it('prunes old rooms beyond the cap and expired rooms', async () => {
    let now = T0;
    const kv = memoryKv();
    const h = new HistoryStore(kv, { now: () => now, maxRooms: 2 });
    for (const [i, code] of ['A', 'B', 'C'].entries()) {
      now = T0 + i * 1000;
      await h.record(code, [e(`x${code}`, 1, { issuedAt: now })]);
    }
    expect([...kv.data.keys()].sort()).toEqual(['B', 'C']);
  });

  it('marks closed and clears everything', async () => {
    const h = new HistoryStore(memoryKv(), { now: () => T0 });
    await h.record('ROOM', [e('a', 1)]);
    await h.markClosed('ROOM');
    expect((await h.listRooms())[0]?.closed).toBe(true);
    await h.clearAll();
    expect(await h.listRooms()).toEqual([]);
  });

  it('swallows storage failures and flags unavailable', async () => {
    const bad = { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); }, del: async () => undefined, keys: async () => { throw new Error('x'); } };
    const h = new HistoryStore(bad);
    await expect(h.record('R', [e('a', 1)])).resolves.toBeUndefined();
    expect(await h.listRooms()).toEqual([]);
    expect(h.available).toBe(false);
  });
});
