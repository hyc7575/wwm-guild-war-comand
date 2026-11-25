import { create } from 'zustand';

/** Per-browser history options (localStorage). Transcript saving is off by default. */
const KEY = 'winds.history.settings.v1';

function load(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as { saveTranscript?: unknown }).saveTranscript === true;
  } catch {
    return false;
  }
}

interface Store {
  saveTranscript: boolean;
  setSaveTranscript(v: boolean): void;
  reload(): void;
}

export const useHistorySettings = create<Store>((set) => ({
  saveTranscript: load(),
  setSaveTranscript(v) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ saveTranscript: v }));
    } catch {
      /* memory only */
    }
    set({ saveTranscript: v });
  },
  reload: () => set({ saveTranscript: load() }),
}));
