import { DEFAULT_CALLWORD_CONFIG, sanitizeCallwordConfig, type CallwordConfig } from '@winds/parser';

export const CALLWORD_KEY = 'winds.callword';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Call-word settings live only in this browser (localStorage); the server never sees them. Default: off. */
export function loadCallword(store: Store | undefined = defaultStore()): CallwordConfig {
  try {
    const raw = store?.getItem(CALLWORD_KEY);
    return raw ? sanitizeCallwordConfig(JSON.parse(raw)) : { ...DEFAULT_CALLWORD_CONFIG, words: [...DEFAULT_CALLWORD_CONFIG.words] };
  } catch {
    return { ...DEFAULT_CALLWORD_CONFIG, words: [...DEFAULT_CALLWORD_CONFIG.words] };
  }
}

export function saveCallword(cfg: CallwordConfig, store: Store | undefined = defaultStore()): CallwordConfig {
  const clean = sanitizeCallwordConfig(cfg);
  try {
    store?.setItem(CALLWORD_KEY, JSON.stringify(clean));
  } catch {
    /* ignore: setting just won't persist */
  }
  return clean;
}
