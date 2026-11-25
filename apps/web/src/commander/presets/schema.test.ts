import { describe, expect, it } from 'vitest';
import { presetShortcutOf, serializePresets, shortcutConflicts, validatePresets, type Preset } from './schema';

const p = (over: Partial<Preset> = {}): Preset => ({
  id: 'a',
  name: 'A작전',
  steps: [{ all: false, parties: [1, 2], action: 'ATTACK', location: { id: 'CENTER', label: '중앙' } }],
  ...over,
});

describe('validatePresets', () => {
  it('round-trips an export and regenerates ids', () => {
    const r = validatePresets(JSON.parse(serializePresets([p({ shortcut: 'F1' })])));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.presets[0]).toMatchObject({ name: 'A작전', shortcut: 'F1' });
      expect(r.presets[0]!.id).not.toBe('a');
    }
  });

  it.each([
    ['not an array', { presets: 'x' }],
    ['unknown action', [{ name: 'x', steps: [{ parties: [1], action: 'NUKE' }] }]],
    ['party out of range', [{ name: 'x', steps: [{ parties: [13], action: 'HOLD' }] }]],
    ['no target', [{ name: 'x', steps: [{ parties: [], action: 'HOLD' }] }]],
    ['empty name', [{ name: ' ', steps: [{ parties: [1], action: 'HOLD' }] }]],
    ['too many steps', [{ name: 'x', steps: Array.from({ length: 13 }, () => ({ parties: [1], action: 'HOLD' })) }]],
    ['bad shortcut', [{ name: 'x', shortcut: 'F5', steps: [{ parties: [1], action: 'HOLD' }] }]],
    ['bad version', { version: 9, presets: [] }],
    ['long location', [{ name: 'x', steps: [{ parties: [1], action: 'HOLD', location: { id: 'a', label: 'x'.repeat(21) } }] }]],
  ])('rejects %s', (_n, input) => {
    expect(validatePresets(input).ok).toBe(false);
  });

  it('drops a duplicated shortcut within a file with a warning', () => {
    const r = validatePresets([p({ shortcut: 'F1' }), p({ name: 'B', shortcut: 'F1' })]);
    expect(r.ok && r.presets[1]!.shortcut).toBeUndefined();
    expect(r.ok && r.warnings).toHaveLength(1);
  });

  it('lenient mode accepts half-edited drafts', () => {
    expect(validatePresets([{ name: '', steps: [{ parties: [], action: 'HOLD' }] }], { lenient: true }).ok).toBe(true);
  });
});

describe('shortcutConflicts', () => {
  it('reports presets sharing a key', () => {
    const m = shortcutConflicts([p({ id: '1', shortcut: 'F2' }), p({ id: '2', name: 'B', shortcut: 'F2' }), p({ id: '3', name: 'C' })]);
    expect(m.get('1')).toEqual(['B']);
    expect(m.get('2')).toEqual(['A작전']);
    expect(m.has('3')).toBe(false);
  });
});

describe('presetShortcutOf', () => {
  it('maps F-keys and Shift+digit; leaves bare digits, F5, F12 and modified keys alone', () => {
    expect(presetShortcutOf({ key: 'F1', code: 'F1' })).toBe('F1');
    expect(presetShortcutOf({ key: '!', code: 'Digit1', shiftKey: true })).toBe('Shift+1');
    expect(presetShortcutOf({ key: '1', code: 'Digit1' })).toBeNull();
    expect(presetShortcutOf({ key: 'F5', code: 'F5' })).toBeNull();
    expect(presetShortcutOf({ key: 'F12', code: 'F12' })).toBeNull();
    expect(presetShortcutOf({ key: 'F1', code: 'F1', ctrlKey: true })).toBeNull();
  });
});
