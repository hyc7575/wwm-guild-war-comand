import { get, set } from 'idb-keyval';

export interface TuningEntry {
  at: number;
  text: string;
  reason: string;
}

/** Where NONE results go: kept only in the commander's browser, input for the F09 dictionary tuning. */
export interface TuningLog {
  add(entry: TuningEntry): Promise<void> | void;
}

export const TUNING_LOG_MAX = 500;
const KEY = 'winds.tuningLog';

/** IndexedDB ring buffer (newest last). Failures (private mode) are swallowed. */
export class IdbTuningLog implements TuningLog {
  private chain: Promise<void> = Promise.resolve();

  add(entry: TuningEntry): Promise<void> {
    // Serialize read-modify-write so rapid utterances do not lose entries.
    this.chain = this.chain.then(async () => {
      try {
        const cur = (await get<TuningEntry[]>(KEY)) ?? [];
        await set(KEY, [...cur, entry].slice(-TUNING_LOG_MAX));
      } catch {
        /* no storage available */
      }
    });
    return this.chain;
  }

  async read(): Promise<TuningEntry[]> {
    try {
      return (await get<TuningEntry[]>(KEY)) ?? [];
    } catch {
      return [];
    }
  }
}

/** Test / fallback implementation. */
export class MemoryTuningLog implements TuningLog {
  entries: TuningEntry[] = [];
  add(entry: TuningEntry): void {
    this.entries = [...this.entries, entry].slice(-TUNING_LOG_MAX);
  }
}
