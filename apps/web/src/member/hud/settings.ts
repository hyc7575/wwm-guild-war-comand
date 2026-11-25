import { create } from 'zustand';

/** Member-local HUD settings, persisted in localStorage (F05 FR-F05-5/6/7/9/10). */
export interface HudSettings {
  soundOn: boolean;
  /** 0..1 */
  volume: number;
  vibrationOn: boolean;
  wakeLockOn: boolean;
  /** 0 | 1 | 2 -> 100% / 115% / 130% */
  fontStep: 0 | 1 | 2;
  /** force reduced motion even if the OS does not ask for it */
  reduceMotion: boolean;
  /** F06: parties with a command first, idle ones shrunk when 8+ parties (default: party-number order) */
  activeFirst: boolean;
}

export const DEFAULT_HUD_SETTINGS: HudSettings = {
  soundOn: true,
  volume: 0.6,
  vibrationOn: true,
  wakeLockOn: true,
  fontStep: 0,
  reduceMotion: false,
  activeFirst: false,
};

export const FONT_SCALE = [1, 1.15, 1.3] as const;
const KEY = 'winds.hud.settings.v1';

function load(): HudSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_HUD_SETTINGS;
    const o = JSON.parse(raw) as Partial<HudSettings>;
    const d = DEFAULT_HUD_SETTINGS;
    return {
      soundOn: typeof o.soundOn === 'boolean' ? o.soundOn : d.soundOn,
      volume: typeof o.volume === 'number' ? Math.min(1, Math.max(0, o.volume)) : d.volume,
      vibrationOn: typeof o.vibrationOn === 'boolean' ? o.vibrationOn : d.vibrationOn,
      wakeLockOn: typeof o.wakeLockOn === 'boolean' ? o.wakeLockOn : d.wakeLockOn,
      fontStep: o.fontStep === 1 || o.fontStep === 2 ? o.fontStep : 0,
      reduceMotion: typeof o.reduceMotion === 'boolean' ? o.reduceMotion : d.reduceMotion,
      activeFirst: typeof o.activeFirst === 'boolean' ? o.activeFirst : d.activeFirst,
    };
  } catch {
    return DEFAULT_HUD_SETTINGS;
  }
}

function save(s: HudSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode etc.: keep in memory only */
  }
}

interface Store {
  settings: HudSettings;
  update(patch: Partial<HudSettings>): void;
  /** re-read localStorage (tests) */
  reload(): void;
}

export const useHudSettings = create<Store>((set, get) => ({
  settings: load(),
  update(patch) {
    const settings = { ...get().settings, ...patch };
    save(settings);
    set({ settings });
  },
  reload() {
    set({ settings: load() });
  },
}));
