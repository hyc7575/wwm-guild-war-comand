import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './schema';
import { PresetStore } from './store';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('PresetStore', () => {
  it('persists to winds.presets, keeps ids across a reload and notifies subscribers', () => {
    const st = mem();
    const a = new PresetStore(st);
    const fn = vi.fn();
    a.subscribe(fn);
    a.set([{ id: 'x1', name: 'A작전', shortcut: 'F1', steps: [{ all: true, parties: [], action: 'GATHER' }] }]);
    expect(fn).toHaveBeenCalledOnce();
    expect(st.m.has(STORAGE_KEY)).toBe(true);
    const b = new PresetStore(st);
    expect(b.get()).toEqual(a.get());
    expect(b.findByShortcut('F1')?.id).toBe('x1');
  });

  it('keeps a half-edited draft (empty name, no target) across a reload', () => {
    const st = mem();
    new PresetStore(st).set([{ id: 'd', name: '', steps: [{ all: false, parties: [], action: 'HOLD' }] }]);
    expect(new PresetStore(st).get()).toHaveLength(1);
  });

  it('survives corrupt storage and drops only the bad entry', () => {
    const bad = mem();
    bad.setItem(STORAGE_KEY, '{nope');
    expect(new PresetStore(bad).get()).toEqual([]);
    const part = mem();
    part.setItem(STORAGE_KEY, JSON.stringify({ version: 1, presets: [{ id: 'g', name: 'ok', steps: [{ parties: [1], action: 'HOLD' }] }, { name: 1 }] }));
    expect(new PresetStore(part).get().map((p) => p.id)).toEqual(['g']);
  });

  it('works without storage', () => {
    const s = new PresetStore(undefined);
    s.set([{ id: 'a', name: 'n', steps: [] }]);
    expect(s.get()).toHaveLength(1);
  });
});
