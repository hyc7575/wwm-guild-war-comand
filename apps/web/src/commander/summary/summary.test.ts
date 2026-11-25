import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { SessionMetrics } from '../metrics';
import { buildSessionSummary, percentile } from './build';
import { SessionSummaryCollector, TEMP_SAVE_MS, type CollectorSource, type CollectorState } from './collector';
import { MemorySummaryStore, mergeFinals } from './store';
import type { StoredSummary } from './types';

const presence = (total: number, byParty: Record<string, number> = {}) => ({
  total,
  byParty,
  unassigned: 0,
  commanderOnline: true,
  operatorsOnline: 0,
  sttState: 'OFF' as const,
});

function fakeSource() {
  let state: CollectorState = {
    presence: presence(0),
    parties: makeDefaultParties(3),
    commands: {},
    roomStatus: 'OPEN',
    lastEvent: null,
  };
  const subs = new Set<(s: CollectorState) => void>();
  const source: CollectorSource = {
    getState: () => state,
    subscribe: (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
  return {
    source,
    set(p: Partial<CollectorState>) {
      state = { ...state, ...p };
      subs.forEach((f) => f(state));
    },
  };
}

describe('percentile / buildSessionSummary', () => {
  it('uses nearest rank and 0 for empty', () => {
    expect(percentile([], 50)).toBe(0);
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(v, 50)).toBe(1000);
    expect(percentile(v, 95)).toBe(1900);
    expect(percentile([300, 100, 200], 50)).toBe(200);
  });

  it('builds the F07 shape', () => {
    const s = buildSessionSummary({
      roomCode: 'K7M2QX',
      startedAt: 1,
      endedAt: 2,
      metrics: { issuedVoice: 3, issuedManual: 1, candidateShown: 5, candidatePublished: 2, corrected: 1, latencies: [100, 200, 300, 400] },
      stt: { activeListeningMs: 1234.4, recoveries: 2 },
      peakMembers: 9,
      peakByParty: { '1': 4 },
      cancelled: { misrecognized: 1, changed: 2 },
    });
    expect(s).toEqual({
      roomCode: 'K7M2QX',
      startedAt: 1,
      endedAt: 2,
      sttActiveMs: 1234,
      sttRecoveries: 2,
      peakMembers: 9,
      peakByParty: { '1': 4 },
      issued: { voice: 3, manual: 1 },
      candidates: { shown: 5, published: 2 },
      cancelled: { misrecognized: 1, changed: 2 },
      corrected: 1,
      latencyMs: { p50: 200, p95: 400 },
    });
  });
});

describe('mergeFinals', () => {
  const f = (code: string, endedAt: number): StoredSummary => ({ temp: false, savedAt: endedAt, summary: { ...buildSessionSummary({ roomCode: code, startedAt: 0, endedAt, metrics: { issuedVoice: 0, issuedManual: 0, candidateShown: 0, candidatePublished: 0, corrected: 0, latencies: [] }, stt: { activeListeningMs: 0, recoveries: 0 }, peakMembers: 0, peakByParty: {}, cancelled: { misrecognized: 0, changed: 0 } }) } });
  it('keeps the newest 20 and replaces the same room', () => {
    let list: StoredSummary[] = [];
    for (let i = 0; i < 25; i++) list = mergeFinals(list, f(`R${i}`, i));
    expect(list).toHaveLength(20);
    expect(list[0]!.summary.roomCode).toBe('R5');
    list = mergeFinals(list, f('R10', 100));
    expect(list).toHaveLength(20);
    expect(list.filter((x) => x.summary.roomCode === 'R10')).toHaveLength(1);
  });
});

describe('SessionSummaryCollector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const cmd = (id: string, reason: Command['cancelReason']): Command => ({
    id, seq: 1, target: { kind: 'ALL' }, action: 'ATTACK', status: 'CANCELLED', cancelReason: reason, source: 'VOICE', issuedAt: 1, repeatCount: 0,
  });

  function setup(store = new MemorySummaryStore(), metrics = new SessionMetrics()) {
    const src = fakeSource();
    const col = new SessionSummaryCollector({ roomCode: 'K7M2QX', source: src.source, store, getMetrics: () => metrics.snapshot() });
    return { src, col, store, metrics };
  }

  it('tracks peaks (party keyed by number) and the cancel split', async () => {
    const { src, col } = setup();
    await col.start();
    src.set({ presence: presence(5, { p1: 2, p3: 3 }) });
    src.set({ presence: presence(8, { p1: 5, p3: 1 }) });
    src.set({ presence: presence(2, { p1: 0 }) });
    src.set({
      commands: { a: cmd('a', 'MISRECOGNIZED'), b: cmd('b', 'CHANGED'), c: cmd('c', 'PARTY_REMOVED'), d: cmd('d', 'CHANGED') },
      lastEvent: { seq: 7, kind: 'command.cancelled', commandIds: ['a', 'b', 'c', 'd'] },
    });
    const s = col.snapshot().summary;
    expect(s.peakMembers).toBe(8);
    expect(s.peakByParty).toEqual({ '1': 5, '3': 3 });
    expect(s.cancelled).toEqual({ misrecognized: 1, changed: 2 });
    col.dispose();
  });

  it('saves a temp copy every minute and stops after the final save', async () => {
    const { col, store, metrics } = setup();
    await col.start();
    metrics.issuedVoice();
    metrics.latency(250);
    await vi.advanceTimersByTimeAsync(TEMP_SAVE_MS);
    expect((await store.loadTemp('K7M2QX'))?.summary.issued.voice).toBe(1);
    metrics.issuedManual();
    await vi.advanceTimersByTimeAsync(TEMP_SAVE_MS);
    expect((await store.loadTemp('K7M2QX'))?.summary.issued.manual).toBe(1);

    await col.finalize();
    await col.finalize(); // idempotent
    expect(store.finals).toHaveLength(1);
    expect(store.finals[0]!.summary.latencyMs).toEqual({ p50: 250, p95: 250 });
    expect(await store.loadTemp('K7M2QX')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TEMP_SAVE_MS * 2);
    expect(await store.loadTemp('K7M2QX')).toBeUndefined();
    expect(col.getFinal()?.roomCode).toBe('K7M2QX');
  });

  it('finalizes when the room closes and uses supervisor stats', async () => {
    const { src, col, store } = setup();
    col.setSttStats(() => ({ activeListeningMs: 5000, recoveries: 2 }));
    await col.start();
    src.set({ roomStatus: 'CLOSED' });
    await col.finalize();
    expect(store.finals[0]!.summary).toMatchObject({ sttActiveMs: 5000, sttRecoveries: 2 });
  });

  it('continues from the last temp save after a reload', async () => {
    const store = new MemorySummaryStore();
    const a = setup(store);
    await a.col.start();
    a.metrics.issuedVoice();
    a.src.set({ presence: presence(6) });
    await a.col.saveTemp();
    a.col.dispose();

    vi.setSystemTime(Date.now() + 120_000);
    const b = setup(store);
    await b.col.start();
    b.metrics.issuedVoice();
    const s = b.col.snapshot().summary;
    expect(s.issued.voice).toBe(2);
    expect(s.peakMembers).toBe(6);
    expect(s.startedAt).toBe((await store.loadTemp('K7M2QX'))!.summary.startedAt);
    b.col.dispose();
  });

  it('does not overwrite an existing final when a closed room is reopened', async () => {
    const store = new MemorySummaryStore();
    const a = setup(store);
    await a.col.start();
    a.metrics.issuedVoice();
    await a.col.finalize();
    const b = setup(store);
    await b.col.start();
    b.src.set({ roomStatus: 'CLOSED' });
    await b.col.finalize();
    expect(store.finals).toHaveLength(1);
    expect(store.finals[0]!.summary.issued.voice).toBe(1);
    expect(b.col.getFinal()?.issued.voice).toBe(1);
  });
});
