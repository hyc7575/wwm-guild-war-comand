import { describe, expect, it } from 'vitest';
import { makeDefaultParties } from '@winds/protocol';
import {
  buildPartyLexicon,
  DEFAULT_DICTIONARY,
  DictionarySchema,
  findDictionaryConflicts,
  mergeDictionaries,
  parse,
} from '../src/index';

const alliance = (over: Record<string, unknown>) => DictionarySchema.parse({ version: 1, name: '동맹', ...over });

describe('DictionarySchema', () => {
  it('기본 사전이 스키마를 통과하고 F03 표를 담는다', () => {
    expect(DictionarySchema.safeParse(DEFAULT_DICTIONARY).success).toBe(true);
    expect(DEFAULT_DICTIONARY.actions.RETREAT).toContain('뒤로 빠져');
    expect(DEFAULT_DICTIONARY.locations.map((l) => l.id)).toEqual(['CENTER', 'LEFT', 'RIGHT', 'FRONT', 'BACK']);
  });
  it('일부 필드만 있는 동맹 사전을 허용하고 빠진 목록은 빈 배열', () => {
    const d = alliance({ actions: { ATTACK: ['박아넣어'] } });
    expect(d.actions.GATHER).toEqual([]);
    expect(d.targetAll).toEqual([]);
  });
  it('형식이 틀리면 거절', () => {
    expect(DictionarySchema.safeParse({ version: 2, name: 'x' }).success).toBe(false);
    expect(DictionarySchema.safeParse({ version: 1, name: 'x', actions: { ATTACK: 'x' } }).success).toBe(false);
  });
});

describe('mergeDictionaries', () => {
  it('동맹 사전이 이긴다: override의 표현은 base의 다른 행동에서 빠진다', () => {
    const m = mergeDictionaries(DEFAULT_DICTIONARY, alliance({ actions: { MOVE: ['들어가'] } }));
    expect(m.actions.MOVE).toContain('들어가');
    expect(m.actions.ATTACK).not.toContain('들어가');
    expect(m.actions.ATTACK).toContain('쳐');
    expect(m.name).toBe('동맹');
  });
  it('공백만 다른 표현도 같은 표현으로 본다', () => {
    const m = mergeDictionaries(DEFAULT_DICTIONARY, alliance({ actions: { ATTACK: ['뒤로빠져'] } }));
    expect(m.actions.RETREAT).not.toContain('뒤로 빠져');
  });
  it('disabled 는 기본 사전 표현을 끈다', () => {
    const m = mergeDictionaries(DEFAULT_DICTIONARY, alliance({ disabled: ['박아', '다'] }));
    expect(m.actions.ATTACK).not.toContain('박아');
    expect(m.targetAll).not.toContain('다');
    expect(m.disabled).toBeUndefined();
  });
  it('위치는 id로 합치고 별칭 소유권이 옮겨간다', () => {
    const m = mergeDictionaries(
      DEFAULT_DICTIONARY,
      alliance({
        locations: [
          { id: 'CENTER', label: '중앙', aliases: ['한가운데'] },
          { id: 'guild:north', label: '북문', aliases: ['위쪽 문', '중간'] },
        ],
      }),
    );
    const center = m.locations.find((l) => l.id === 'CENTER');
    expect(center?.aliases).toEqual(expect.arrayContaining(['가운데', '미드', '한가운데']));
    expect(center?.aliases).not.toContain('중간');
    expect(m.locations.find((l) => l.id === 'guild:north')?.label).toBe('북문');
  });
  it('합친 사전으로 파싱한다 (거점 + 표현 교체)', () => {
    const m = mergeDictionaries(
      DEFAULT_DICTIONARY,
      alliance({
        actions: { MOVE: ['들어가'] },
        locations: [{ id: 'guild:north', label: '북문', aliases: ['위쪽 문'] }],
      }),
    );
    const r = parse('3파티 북문으로 들어가', { parties: makeDefaultParties(6), dictionary: m, now: 0 });
    expect(r[0]).toMatchObject({
      kind: 'ISSUE',
      draft: { action: 'MOVE', location: { id: 'guild:north', label: '북문' } },
    });
  });
  it('base를 변경하지 않는다', () => {
    const before = JSON.stringify(DEFAULT_DICTIONARY);
    mergeDictionaries(DEFAULT_DICTIONARY, alliance({ actions: { MOVE: ['들어가'] }, disabled: ['박아'] }));
    expect(JSON.stringify(DEFAULT_DICTIONARY)).toBe(before);
  });
});

describe('findDictionaryConflicts', () => {
  it('기본 사전에는 충돌이 없다', () => {
    expect(findDictionaryConflicts(DEFAULT_DICTIONARY)).toEqual([]);
  });
  it('두 행동에 걸친 표현을 찾는다', () => {
    const d = alliance({ actions: { MOVE: ['들어 가'], ATTACK: ['들어가', '쳐'], DEFEND: ['쳐'] } });
    const c = findDictionaryConflicts(d);
    expect(c).toEqual([
      { expression: '들어가', actions: ['MOVE', 'ATTACK'] },
      { expression: '쳐', actions: ['ATTACK', 'DEFEND'] },
    ]);
  });
});

describe('buildPartyLexicon', () => {
  const parties = makeDefaultParties(3);
  parties[1] = { ...parties[1]!, name: '돌격', aliases: ['돌격대', '돌격 조'] };
  const lex = buildPartyLexicon(parties);
  it('번호·이름·별칭을 partyId로 매핑한다', () => {
    const find = (e: string) => lex.find((x) => x.expression === e);
    expect(find('1파티')).toMatchObject({ partyId: 'p1', kind: 'number' });
    expect(find('2팟')).toMatchObject({ partyId: 'p2' });
    expect(find('돌격')).toMatchObject({ partyId: 'p2', kind: 'name' });
    expect(find('돌격대')).toMatchObject({ partyId: 'p2', kind: 'alias' });
    expect(find('돌격조')).toMatchObject({ partyId: 'p2' }); // 공백 제거
  });
  it('중복 표현은 앞 파티가 가진다', () => {
    const ps = makeDefaultParties(2).map((p) => ({ ...p, aliases: ['본대'] }));
    const l = buildPartyLexicon(ps).filter((x) => x.expression === '본대');
    expect(l).toHaveLength(1);
    expect(l[0]?.partyId).toBe('p1');
  });
});
