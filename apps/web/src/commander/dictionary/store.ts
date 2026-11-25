import { DEFAULT_DICTIONARY, DictionarySchema, mergeDictionaries, validateDictionaryImport, type Dictionary } from '@winds/parser';
import { emptyAllianceDictionary, planMerge } from './editing';

export const DICTIONARY_STORAGE_KEY = 'winds.allianceDictionary';
/** A stored dictionary that failed validation is kept here before the next save overwrites it. */
export const DICTIONARY_CORRUPT_KEY = 'winds.allianceDictionary.corrupt';

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
  private saveError: string | null = null;
  private loadNote: string | null = null;

  constructor(
    private readonly storage: StorageLike | undefined = browserStorage(),
    private readonly base: Dictionary = DEFAULT_DICTIONARY,
  ) {
    this.alliance = this.load();
  }

  private load(): Dictionary {
    let raw: string | null | undefined;
    try {
      raw = this.storage?.getItem(DICTIONARY_STORAGE_KEY);
      if (raw) {
        const r = validateDictionaryImport(JSON.parse(raw));
        if (r.ok) return r.dictionary;
      }
    } catch {
      /* corrupt or blocked storage: start empty */
    }
    if (raw) {
      // Do not lose the original: the next set() would overwrite it.
      try {
        this.storage?.setItem(DICTIONARY_CORRUPT_KEY, raw);
        this.loadNote = `저장된 사전을 읽지 못해 빈 사전으로 시작합니다. 원본은 "${DICTIONARY_CORRUPT_KEY}"에 백업했습니다.`;
      } catch {
        this.loadNote = '저장된 사전을 읽지 못해 빈 사전으로 시작합니다. 원본 백업에도 실패했습니다.';
      }
    }
    return emptyAllianceDictionary();
  }

  /** Set when the stored dictionary was unreadable at start (shown in the editor). */
  getLoadNote(): string | null {
    return this.loadNote;
  }

  /** Set when the last save to localStorage failed (the change only lives in this session). */
  getSaveError(): string | null {
    return this.saveError;
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
      this.saveError = null;
    } catch {
      // quota / private mode: keep it for this session and tell the editor
      this.saveError = '브라우저에 저장하지 못했습니다. 이 탭을 닫으면 변경이 사라집니다. 내보내기로 파일을 남겨 두세요.';
    }
    for (const l of [...this.listeners]) l();
  }

  /** Import: replace the alliance dictionary or merge the incoming one into it. */
  importDictionary(incoming: Dictionary, mode: 'overwrite' | 'merge'): void {
    this.set(mode === 'overwrite' ? incoming : planMerge(this.alliance, incoming, this.base).result);
  }

  /** What a merge import would change (shown before the user confirms). */
  previewMerge(incoming: Dictionary) {
    return planMerge(this.alliance, incoming, this.base);
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
