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
      issued: { voice: 3, manual: 1, byRole: { COMMANDER: 0, SUB_COMMANDER: 0, OPERATOR: 0 } },
      candidates: { shown: 5, published: 2 },
      cancelled: { misrecognized: 1, changed: 2, byOthers: { SUB_COMMANDER: 0, OPERATOR: 0 } },
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

  const voiceIssued = (src: ReturnType<typeof fakeSource>, seq: number, id: string) =>
    src.set({
      commands: { ...src.source.getState().commands, [id]: { ...cmd(id, undefined), status: 'ACTIVE' } },
      lastEvent: { seq, kind: 'command.issued', commandId: id },
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
    expect(s.cancelled).toMatchObject({ misrecognized: 1, changed: 2 });
    col.dispose();
  });

  it('counts issued by issuer.role from command.issued events, and counts a cancel reason whoever cancelled', async () => {
    const { src, col, metrics } = setup();
    await col.start();
    const withIssuer = (id: string, role: 'COMMANDER' | 'SUB_COMMANDER' | 'OPERATOR'): Command => ({ ...cmd(id, undefined), status: 'ACTIVE', issuer: { role } });
    const issue = (seq: number, id: string, role: 'COMMANDER' | 'SUB_COMMANDER' | 'OPERATOR') =>
      src.set({ commands: { ...src.source.getState().commands, [id]: withIssuer(id, role) }, lastEvent: { seq, kind: 'command.issued', commandId: id } });
    issue(1, 'x1', 'COMMANDER');
    issue(2, 'x2', 'SUB_COMMANDER');
    issue(3, 'x3', 'SUB_COMMANDER');
    issue(4, 'x4', 'OPERATOR');
    src.set({ commands: { ...src.source.getState().commands, x5: { ...cmd('x5', undefined), issuer: undefined } }, lastEvent: { seq: 5, kind: 'command.issued', commandId: 'x5' } });
    src.set({ commands: { ...src.source.getState().commands, a: cmd('a', 'MISRECOGNIZED'), b: cmd('b', 'CHANGED'), c: cmd('c', 'CHANGED') }, lastEvent: { seq: 6, kind: 'command.cancelled', commandIds: ['a'], cancelledBy: 'SUB_COMMANDER' } });
    src.set({ lastEvent: { seq: 7, kind: 'command.cancelled', commandIds: ['b'], cancelledBy: 'COMMANDER' } });
    src.set({ lastEvent: { seq: 8, kind: 'command.cancelled', commandIds: ['c'] } });
    const s = col.snapshot().summary;
    expect(s.issued.voice).toBe(5); // every cmd() helper command has source VOICE
    expect(s.issued.byRole).toEqual({ COMMANDER: 1, SUB_COMMANDER: 2, OPERATOR: 1 });
    // reason counts whoever cancelled: the sub-order's MISRECOGNIZED cancel counts, byOthers counts the canceller
    expect(s.cancelled).toEqual({ misrecognized: 1, changed: 2, byOthers: { SUB_COMMANDER: 1, OPERATOR: 0 } });
    col.dispose();
  });

  it('counts an operator cancelling a misrecognized voice command as misrecognized, and the canceller separately', async () => {
    const { src, col } = setup();
    await col.start();
    src.set({ commands: { m: cmd('m', 'MISRECOGNIZED') }, lastEvent: { seq: 1, kind: 'command.cancelled', commandIds: ['m'], cancelledBy: 'OPERATOR' } });
    const s = col.snapshot().summary;
    expect(s.cancelled.misrecognized).toBe(1);
    expect(s.cancelled.byOthers).toEqual({ SUB_COMMANDER: 0, OPERATOR: 1 });
    col.dispose();
  });

  it('counts a voice command once when the same utterance is repeated (issued + repeated events)', async () => {
    const { src, col } = setup();
    await col.start();
    voiceIssued(src, 1, 'v1');
    src.set({ lastEvent: { seq: 2, kind: 'command.repeated', commandId: 'v1' } });
    expect(col.snapshot().summary.issued.voice).toBe(1);
    // a MANUAL command and a voice correction
    src.set({ commands: { ...src.source.getState().commands, k: { ...cmd('k', undefined), status: 'ACTIVE', source: 'MANUAL' } }, lastEvent: { seq: 3, kind: 'command.issued', commandId: 'k' } });
    expect(col.snapshot().summary.issued.voice).toBe(1);
    src.set({ commands: { ...src.source.getState().commands, c: { ...cmd('c', undefined), status: 'ACTIVE' } }, lastEvent: { seq: 4, kind: 'command.corrected', commandId: 'c' } });
    expect(col.snapshot().summary.issued.voice).toBe(2);
    col.dispose();
  });

  it('continues from an old temp save without byRole', async () => {
    const store = new MemorySummaryStore();
    const old = buildSessionSummary({
      roomCode: 'K7M2QX', startedAt: 1, endedAt: 2,
      metrics: { issuedVoice: 1, issuedManual: 0, candidateShown: 0, candidatePublished: 0, corrected: 0, latencies: [] },
      stt: { activeListeningMs: 0, recoveries: 0 }, peakMembers: 0, peakByParty: {}, cancelled: { misrecognized: 0, changed: 0 },
    });
    delete old.issued.byRole;
    delete old.cancelled.byOthers;
    await store.saveTemp({ summary: old, temp: true, savedAt: 2 });
    const { src, col } = setup(store);
    await col.start();
    src.set({ commands: { z: { ...cmd('z', undefined), issuer: { role: 'OPERATOR' } } }, lastEvent: { seq: 1, kind: 'command.issued', commandId: 'z' } });
    const s = col.snapshot().summary;
    expect(s.issued.byRole).toEqual({ COMMANDER: 0, SUB_COMMANDER: 0, OPERATOR: 1 });
    expect(s.cancelled.byOthers).toEqual({ SUB_COMMANDER: 0, OPERATOR: 0 });
    col.dispose();
  });

  it('saves a temp copy every minute and stops after the final save', async () => {
    const { src, col, store, metrics } = setup();
    await col.start();
    voiceIssued(src, 1, 'v1');
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
    voiceIssued(a.src, 1, 'v1');
    a.src.set({ presence: presence(6) });
    await a.col.saveTemp();
    a.col.dispose();

    vi.setSystemTime(Date.now() + 120_000);
    const b = setup(store);
    await b.col.start();
    voiceIssued(b.src, 1, 'v2');
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
    voiceIssued(a.src, 1, 'v1');
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
