import { del, get, getMany, keys, set } from 'idb-keyval';
import type { StoredSummary } from './types';

export const SUMMARY_LIST_KEY = 'winds.summaries';
export const SUMMARY_TEMP_PREFIX = 'winds.summary.temp.';
export const SUMMARY_KEEP = 20;

export const tempKey = (roomCode: string) => `${SUMMARY_TEMP_PREFIX}${roomCode.toUpperCase()}`;

export interface SummaryStore {
  saveTemp(s: StoredSummary): Promise<void>;
  loadTemp(roomCode: string): Promise<StoredSummary | undefined>;
  listTemps(): Promise<StoredSummary[]>;
  deleteTemp(roomCode: string): Promise<void>;
  /** Saves the final summary (replacing one of the same room), drops the temp save, keeps the newest 20. */
  saveFinal(s: StoredSummary): Promise<void>;
  /** Newest first. */
  listFinals(): Promise<StoredSummary[]>;
}

/** Keeps the newest `keep` finals; a final for the same room replaces the older one. */
export function mergeFinals(list: StoredSummary[], next: StoredSummary, keep = SUMMARY_KEEP): StoredSummary[] {
  const rest = list.filter((x) => x.summary.roomCode !== next.summary.roomCode);
  return [...rest, next].sort((a, b) => a.summary.endedAt - b.summary.endedAt).slice(-keep);
}

/** IndexedDB. Failures (private mode, no storage) are swallowed: the summary is a convenience. */
export class IdbSummaryStore implements SummaryStore {
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.chain.then(fn, fn).catch(() => fallback);
    this.chain = run;
    return run;
  }

  saveTemp(s: StoredSummary) {
    return this.serial(() => set(tempKey(s.summary.roomCode), s), undefined);
  }
  loadTemp(roomCode: string) {
    return this.serial(() => get<StoredSummary>(tempKey(roomCode)), undefined);
  }
  listTemps() {
    return this.serial(async () => {
      const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(SUMMARY_TEMP_PREFIX));
      return ((await getMany<StoredSummary>(ks)) ?? []).filter((x): x is StoredSummary => !!x);
    }, [] as StoredSummary[]);
  }
  deleteTemp(roomCode: string) {
    return this.serial(() => del(tempKey(roomCode)), undefined);
  }
  saveFinal(s: StoredSummary) {
    return this.serial(async () => {
      const cur = (await get<StoredSummary[]>(SUMMARY_LIST_KEY)) ?? [];
      await set(SUMMARY_LIST_KEY, mergeFinals(cur, s));
      await del(tempKey(s.summary.roomCode));
    }, undefined);
  }
  async listFinals() {
    const cur = await this.serial(async () => (await get<StoredSummary[]>(SUMMARY_LIST_KEY)) ?? [], [] as StoredSummary[]);
    return [...cur].sort((a, b) => b.summary.endedAt - a.summary.endedAt);
  }
}

export class MemorySummaryStore implements SummaryStore {
  temps = new Map<string, StoredSummary>();
  finals: StoredSummary[] = [];
  async saveTemp(s: StoredSummary) {
    this.temps.set(tempKey(s.summary.roomCode), s);
  }
  async loadTemp(roomCode: string) {
    return this.temps.get(tempKey(roomCode));
  }
  async listTemps() {
    return [...this.temps.values()];
  }
  async deleteTemp(roomCode: string) {
    this.temps.delete(tempKey(roomCode));
  }
  async saveFinal(s: StoredSummary) {
    this.finals = mergeFinals(this.finals, s);
    this.temps.delete(tempKey(s.summary.roomCode));
  }
  async listFinals() {
    return [...this.finals].sort((a, b) => b.summary.endedAt - a.summary.endedAt);
  }
}

let shared: SummaryStore | undefined;
export function defaultSummaryStore(): SummaryStore {
  return (shared ??= new IdbSummaryStore());
}
