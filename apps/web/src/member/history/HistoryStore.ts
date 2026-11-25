import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import {
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_ROOMS,
  type HistoryEntry,
  type RoomHistory,
} from './types';

/** Minimal async key-value surface; tests inject a memory one. */
export interface Kv {
  get(key: string): Promise<RoomHistory | undefined>;
  set(key: string, value: RoomHistory): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export const HISTORY_DB = 'winds.history';

export function idbKv(): Kv {
  let store: UseStore | null = null;
  // createStore opens IndexedDB immediately and throws where it is missing: build it lazily inside the guarded calls.
  const s = () => (store ??= createStore(HISTORY_DB, 'rooms'));
  return {
    get: (k) => get<RoomHistory>(k, s()),
    set: (k, v) => set(k, v, s()),
    del: (k) => del(k, s()),
    keys: async () => (await keys(s())).filter((k): k is string => typeof k === 'string'),
  };
}

export interface RecordOptions {
  /** Room event seq this batch belongs to. Events at or below the stored lastSeq are skipped. */
  eventSeq?: number;
  /** Snapshot-based sync: raises lastSeq to this value without skipping the batch. */
  snapshotSeq?: number;
  closed?: boolean;
}

export interface HistoryStoreOptions {
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
  maxRooms?: number;
}

/**
 * Local command history, one record per room code. Every failure (no IndexedDB, private mode, quota) is
 * swallowed: history is a convenience and must never break the HUD. `available` turns false after the first failure.
 */
export class HistoryStore {
  available = true;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly maxRooms: number;

  constructor(private readonly kv: Kv = idbKv(), opts: HistoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? HISTORY_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.maxRooms = opts.maxRooms ?? HISTORY_MAX_ROOMS;
  }

  private serial<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.chain.then(fn, fn).catch(() => {
      this.available = false;
      return fallback;
    });
    this.chain = run;
    return run;
  }

  private trim(h: RoomHistory): RoomHistory {
    const cutoff = this.now() - this.maxAgeMs;
    const entries = h.entries
      .filter((e) => e.issuedAt >= cutoff)
      .sort((a, b) => a.seq - b.seq)
      .slice(-this.maxEntries);
    return { ...h, entries };
  }

  /** Upsert entries by command id; a repeated record keeps an earlier transcript the new one lacks. */
  record(roomCode: string, entries: HistoryEntry[], opts: RecordOptions = {}): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      const cur = await this.kv.get(roomCode);
      if (opts.eventSeq !== undefined && cur && opts.eventSeq <= cur.lastSeq) return;
      const byId = new Map((cur?.entries ?? []).map((e) => [e.id, e]));
      for (const e of entries) {
        const old = byId.get(e.id);
        byId.set(e.id, old?.transcript && !e.transcript ? { ...e, transcript: old.transcript } : e);
      }
      const next = this.trim({
        roomCode,
        lastSeq: Math.max(cur?.lastSeq ?? 0, opts.eventSeq ?? 0, opts.snapshotSeq ?? 0),
        firstSeenAt: cur?.firstSeenAt ?? now,
        lastSeenAt: now,
        closed: opts.closed ?? cur?.closed ?? false,
        entries: [...byId.values()],
      });
      await this.kv.set(roomCode, next);
      await this.prune();
    }, undefined);
  }

  markClosed(roomCode: string): Promise<void> {
    return this.serial(async () => {
      const cur = await this.kv.get(roomCode);
      if (cur && !cur.closed) await this.kv.set(roomCode, { ...cur, closed: true, lastSeenAt: this.now() });
    }, undefined);
  }

  /** Drops expired entries, empty rooms and the oldest rooms beyond the cap. */
  private async prune(): Promise<void> {
    const rooms: RoomHistory[] = [];
    for (const k of await this.kv.keys()) {
      const h = await this.kv.get(k);
      if (!h) continue;
      const t = this.trim(h);
      if (t.entries.length === 0 || t.lastSeenAt < this.now() - this.maxAgeMs) {
        await this.kv.del(k);
        continue;
      }
      if (t.entries.length !== h.entries.length) await this.kv.set(k, t);
      rooms.push(t);
    }
    rooms.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const r of rooms.slice(this.maxRooms)) await this.kv.del(r.roomCode);
  }

  /** Newest-seen room first. Entries come back newest first. */
  listRooms(): Promise<RoomHistory[]> {
    return this.serial(async () => {
      const out: RoomHistory[] = [];
      for (const k of await this.kv.keys()) {
        const h = await this.kv.get(k);
        if (!h) continue;
        const t = this.trim(h);
        if (t.entries.length) out.push({ ...t, entries: [...t.entries].reverse() });
      }
      return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }, [] as RoomHistory[]);
  }

  clearAll(): Promise<void> {
    return this.serial(async () => {
      for (const k of await this.kv.keys()) await this.kv.del(k);
    }, undefined).then(() => this.notify());
  }

  /** Removes every stored transcript (used when "인식 원문 저장" is turned off). */
  stripTranscripts(): Promise<void> {
    return this.serial(async () => {
      for (const k of await this.kv.keys()) {
        const h = await this.kv.get(k);
        if (!h || !h.entries.some((e) => e.transcript !== undefined)) continue;
        await this.kv.set(k, { ...h, entries: h.entries.map(({ transcript: _t, ...rest }) => rest) });
      }
    }, undefined).then(() => this.notify());
  }

  /** Called after clearAll / stripTranscripts so open lists can reload. */
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}

let shared: HistoryStore | null = null;
export function getHistoryStore(): HistoryStore {
  return (shared ??= new HistoryStore());
}
/** tests */
export function setHistoryStore(s: HistoryStore | null): void {
  shared = s;
}
