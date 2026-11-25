import { useCallback, useSyncExternalStore } from 'react';
import { useConsole } from '../console/ConsoleProvider';
import type { PresetRun } from './runner';
import type { Preset } from './schema';
import { getPresetStore, type PresetStore } from './store';

export function usePresetList(store: PresetStore = getPresetStore()): Preset[] {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The latest preset run (null before the first one); re-renders on every step update. */
export function useLatestRun(): PresetRun | null {
  const { presets } = useConsole();
  useSyncExternalStore(presets.subscribe, presets.getVersion);
  return presets.latest() ?? null;
}
