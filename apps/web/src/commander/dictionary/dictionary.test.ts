import { describe, expect, it } from 'vitest';
import { DEFAULT_DICTIONARY, findDictionaryConflicts, mergeDictionaries, parse } from '@winds/parser';
import { makeDefaultParties } from '@winds/protocol';
import {
  addActionExpression,
  addLocation,
  addLocationAlias,
  emptyAllianceDictionary,
  findActionOwner,
  mergeAlliance,
  planMerge,
  removeLocationAlias,
  setBaseDisabled,
} from './editing';
import { DICTIONARY_CORRUPT_KEY, DICTIONARY_STORAGE_KEY, DictionaryStore } from './store';
import { suggestFromTuningLog } from './suggest';

const memStorage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const parties = makeDefaultParties(3);
const kind = (text: string, dict = DEFAULT_DICTIONARY) => parse(text, { parties, dictionary: dict, now: 0 })[0];

describe('editing', () => {
  it('adding an expression moves it from another alliance action and re-enables it', () => {
    let d = addActionExpression(emptyAllianceDictionary(), 'MOVE', '박아');
    d = setBaseDisabled(d, '박아', true);
    d = addActionExpression(d, 'ATTACK', '박아');
    expect(d.actions.MOVE).toEqual([]);
    expect(d.actions.ATTACK).toEqual(['박아']);
    expect(d.disabled).toEqual([]);
  });
  it('findActionOwner sees the built-in owner (conflict prompt)', () => {
    expect(findActionOwner(DEFAULT_DICTIONARY, '들어가', 'MOVE')).toBe('ATTACK');
    expect(findActionOwner(DEFAULT_DICTIONARY, '들어가', 'ATTACK')).toBeUndefined();
  });
  it('merged: alliance wins over the built-in action, disabled switches a built-in expression off', () => {
    const d = addActionExpression(emptyAllianceDictionary(), 'MOVE', '들어가');
    const merged = mergeDictionaries(DEFAULT_DICTIONARY, d);
    expect(merged.actions.MOVE).toContain('들어가');
    expect(merged.actions.ATTACK).not.toContain('들어가');
    expect(findDictionaryConflicts(merged)).toEqual([]);
    const off = mergeDictionaries(DEFAULT_DICTIONARY, setBaseDisabled(emptyAllianceDictionary(), '후퇴', true));
    expect(off.actions.RETREAT).not.toContain('후퇴');
  });
  it('conflicts inside the alliance dictionary are reported', () => {
    const d = emptyAllianceDictionary();
    d.actions.ATTACK = ['치자'];
    d.actions.MOVE = ['치 자'];
    expect(findDictionaryConflicts(d)).toHaveLength(1);
  });
  it('locations: custom location, alias on a base location, alias removal drops empty override', () => {
    let d = addLocation(emptyAllianceDictionary(), '북문', ['위쪽 문']);
    expect(d.locations[0]).toMatchObject({ id: 'CUSTOM_1', label: '북문' });
    d = addLocationAlias(d, 'CENTER', '중앙', '한가운데');
    const merged = mergeDictionaries(DEFAULT_DICTIONARY, d);
    expect(merged.locations.find((l) => l.id === 'CENTER')!.aliases).toContain('한가운데');
    const ids = new Set(DEFAULT_DICTIONARY.locations.map((l) => l.id));
    d = removeLocationAlias(d, 'CENTER', '한가운데', ids);
    expect(d.locations.map((l) => l.id)).toEqual(['CUSTOM_1']);
  });
  it('mergeAlliance unions disabled and keeps both sets of expressions', () => {
    const a = setBaseDisabled(addActionExpression(emptyAllianceDictionary(), 'ATTACK', '박아넣어'), '쳐', true);
    const b = setBaseDisabled(addActionExpression(emptyAllianceDictionary('B'), 'ATTACK', '찍어'), '때려', true);
    const m = mergeAlliance(a, b);
    expect(m.actions.ATTACK).toEqual(['박아넣어', '찍어']);
    expect(m.disabled).toEqual(['쳐', '때려']);
  });
});

describe('planMerge', () => {
  const withLoc = (name: string, label: string, aliases: string[] = []) => ({ ...emptyAllianceDictionary(name), locations: [{ id: 'CUSTOM_1', label, aliases }] });
  it('renumbers a clashing CUSTOM_1 and keeps both places (labels and aliases kept)', () => {
    const mine = withLoc('나', '다리', ['브릿지']);
    const theirs = withLoc('너', '성문', ['게이트']);
    const { result, diff } = planMerge(mine, theirs, DEFAULT_DICTIONARY);
    expect(result.locations).toEqual([
      { id: 'CUSTOM_1', label: '다리', aliases: ['브릿지'] },
      { id: 'CUSTOM_2', label: '성문', aliases: ['게이트'] },
    ]);
    expect(diff.renamedLocations).toEqual([{ from: 'CUSTOM_1', to: 'CUSTOM_2', label: '성문', clashedWith: '다리' }]);
  });
  it('importing the same place again does not duplicate it', () => {
    const mine = withLoc('나', '다리');
    const { result, diff } = planMerge(mine, withLoc('너', '다리', ['교량']), DEFAULT_DICTIONARY);
    expect(result.locations).toEqual([{ id: 'CUSTOM_1', label: '다리', aliases: ['교량'] }]);
    expect(diff.renamedLocations).toEqual([]);
  });
  it('reports an expression whose action moves', () => {
    const mine = addActionExpression(emptyAllianceDictionary(), 'ATTACK', '찍어');
    const theirs = addActionExpression(emptyAllianceDictionary('B'), 'DEFEND', '찍어');
    const { result, diff } = planMerge(mine, theirs, DEFAULT_DICTIONARY);
    expect(diff.movedExpressions).toEqual([{ expression: '찍어', from: 'ATTACK', to: 'DEFEND' }]);
    expect(result.actions.DEFEND).toContain('찍어');
    expect(result.actions.ATTACK).not.toContain('찍어');
  });
  it('store merge applies the renumbering', () => {
    const s = new DictionaryStore(memStorage());
    s.set(withLoc('나', '다리'));
    s.importDictionary(withLoc('너', '성문'), 'merge');
    expect(s.getAlliance().locations.map((l) => l.id)).toEqual(['CUSTOM_1', 'CUSTOM_2']);
  });
});

describe('DictionaryStore', () => {
  it('backs up an unreadable stored dictionary before the next save overwrites it', () => {
    const storage = memStorage({ [DICTIONARY_STORAGE_KEY]: '{"version":1,"name":""}' });
    const s = new DictionaryStore(storage);
    expect(storage.getItem(DICTIONARY_CORRUPT_KEY)).toBe('{"version":1,"name":""}');
    expect(s.getLoadNote()).toContain(DICTIONARY_CORRUPT_KEY);
    s.set(addActionExpression(s.getAlliance(), 'ATTACK', '찍어'));
    expect(storage.getItem(DICTIONARY_CORRUPT_KEY)).toBe('{"version":1,"name":""}');
  });
  it('a failing setItem is reported, the change stays in memory', () => {
    const storage = { ...memStorage(), setItem: () => { throw new Error('quota'); } };
    const s = new DictionaryStore(storage);
    s.set(addActionExpression(s.getAlliance(), 'ATTACK', '찍어'));
    expect(s.getSaveError()).toBeTruthy();
    expect(s.getAlliance().actions.ATTACK).toEqual(['찍어']);
  });
  it('saved change shows up in getMerged immediately and parses; persists across instances', () => {
    const storage = memStorage();
    const s = new DictionaryStore(storage);
    let n = 0;
    s.subscribe(() => n++);
    expect(kind('1파티 박아넣어')).toMatchObject({ kind: 'NONE' });
    const before = s.getMerged();
    s.set(addActionExpression(s.getAlliance(), 'ATTACK', '박아넣어'));
    expect(n).toBe(1);
    expect(s.getMerged()).not.toBe(before);
    expect(s.getMerged()).toBe(s.getMerged());
    expect(kind('1파티 박아넣어', s.getMerged())).toMatchObject({ kind: 'ISSUE', draft: { action: 'ATTACK' } });
    expect(new DictionaryStore(storage).getAlliance().actions.ATTACK).toEqual(['박아넣어']);
  });
  it('corrupt storage falls back to empty; invalid set throws and changes nothing', () => {
    const s = new DictionaryStore(memStorage({ [DICTIONARY_STORAGE_KEY]: '{oops' }));
    expect(s.getAlliance().actions.ATTACK).toEqual([]);
    expect(() => s.set(addActionExpression(s.getAlliance(), 'ATTACK', 'x'.repeat(41)))).toThrow();
    expect(s.getAlliance().actions.ATTACK).toEqual([]);
  });
});

describe('suggestFromTuningLog', () => {
  const log = (...texts: string[]) => texts.map((text, i) => ({ at: i, text, reason: 'x' }));
  it('suggests repeated unknown words only', () => {
    const r = suggestFromTuningLog(log('북문 찍어', '1파티 찍어 가', '찍어 한번만'), DEFAULT_DICTIONARY);
    expect(r.map((s) => [s.word, s.count])).toEqual([['찍어', 3]]);
  });
  it('words already in the dictionary or counted once are skipped', () => {
    expect(suggestFromTuningLog(log('쳐 쳐', '쳐'), DEFAULT_DICTIONARY)).toEqual([]);
  });
});
