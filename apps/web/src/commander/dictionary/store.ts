import { DEFAULT_DICTIONARY, DictionarySchema, mergeDictionaries, validateDictionaryImport, type Dictionary } from '@winds/parser';
import { emptyAllianceDictionary, mergeAlliance } from './editing';

export const DICTIONARY_STORAGE_KEY = 'winds.allianceDictionary';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The alliance dictionary of this browser (F09). Console-local: never sent to the server.
 * getMerged() is what the parser pipeline reads, so a change applies from the next utterance.
 */
export class DictionaryStore {
  private alliance: Dictionary;
  private mergedCache: { src: Dictionary; value: Dictionary } | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: StorageLike | undefined = browserStorage(),
    private readonly base: Dictionary = DEFAULT_DICTIONARY,
  ) {
    this.alliance = this.load();
  }

  private load(): Dictionary {
    try {
      const raw = this.storage?.getItem(DICTIONARY_STORAGE_KEY);
      if (raw) {
        const r = validateDictionaryImport(JSON.parse(raw));
        if (r.ok) return r.dictionary;
      }
    } catch {
      /* corrupt or blocked storage: start empty */
    }
    return emptyAllianceDictionary();
  }

  getBase(): Dictionary {
    return this.base;
  }

  getAlliance(): Dictionary {
    return this.alliance;
  }

  /** Stable object until the alliance dictionary changes (the parser caches compiled dictionaries per object). */
  getMerged = (): Dictionary => {
    if (this.mergedCache?.src !== this.alliance) {
      this.mergedCache = { src: this.alliance, value: mergeDictionaries(this.base, this.alliance) };
    }
    return this.mergedCache.value;
  };

  /** Validates, persists and notifies. Throws when the dictionary violates the schema (nothing changes). */
  set(next: Dictionary): void {
    const checked = DictionarySchema.parse(next);
    this.alliance = checked;
    try {
      this.storage?.setItem(DICTIONARY_STORAGE_KEY, JSON.stringify(checked));
    } catch {
      /* quota / private mode: keep it for this session */
    }
    for (const l of [...this.listeners]) l();
  }

  /** Import: replace the alliance dictionary or merge the incoming one into it. */
  importDictionary(incoming: Dictionary, mode: 'overwrite' | 'merge'): void {
    this.set(mode === 'overwrite' ? incoming : mergeAlliance(this.alliance, incoming));
  }

  reset(): void {
    this.set(emptyAllianceDictionary(this.alliance.name));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

let shared: DictionaryStore | undefined;
/** The one store of this browser tab. */
export function getDictionaryStore(): DictionaryStore {
  return (shared ??= new DictionaryStore());
}
