import { PRESET_LIMITS, STORAGE_KEY, serializePresets, validatePresets, type Preset } from './schema';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Presets of this browser (console-local, shared across rooms, never sent to the server). */
export class PresetStore {
  private presets: Preset[];
  private listeners = new Set<() => void>();

  constructor(private readonly storage: StorageLike | undefined = browserStorage()) {
    this.presets = this.load();
  }

  private load(): Preset[] {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const body = JSON.parse(raw) as { presets?: unknown };
        if (Array.isArray(body.presets)) {
          // One bad entry must not drop the rest.
          return body.presets.flatMap((p) => {
            const r = validatePresets([p], { keepIds: true, lenient: true });
            return r.ok ? r.presets : [];
          });
        }
      }
    } catch {
      /* corrupt or blocked storage: start empty */
    }
    return [];
  }

  get = (): Preset[] => this.presets;

  find(id: string): Preset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  findByShortcut(shortcut: string): Preset | undefined {
    return this.presets.find((p) => p.shortcut === shortcut);
  }

  set(next: Preset[]): void {
    this.presets = next.slice(0, PRESET_LIMITS.maxPresets);
    try {
      // Same shape as the export file, but ids are kept so edits survive a reload.
      const body = JSON.parse(serializePresets(this.presets)) as { version: number; presets: Array<Record<string, unknown>> };
      body.presets = body.presets.map((p, i) => ({ id: this.presets[i]!.id, ...p }));
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(body));
    } catch {
      /* storage full or blocked: keep the in-memory copy */
    }
    for (const l of [...this.listeners]) l();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

let singleton: PresetStore | undefined;
export function getPresetStore(): PresetStore {
  return (singleton ??= new PresetStore());
}
