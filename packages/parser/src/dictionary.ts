import { z } from 'zod';
import { Action, type Party, type PartyId } from '@winds/protocol';

const ACTIONS = Action.options;

const exprList = z.array(z.string().min(1).max(40)).max(500);

/** F09 사전 스키마. 동맹 사전은 일부 필드만 적어도 된다(빠진 목록은 빈 배열). */
export const DictionarySchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(40),
  actions: z
    .object({
      GATHER: exprList.default([]),
      MOVE: exprList.default([]),
      ATTACK: exprList.default([]),
      DEFEND: exprList.default([]),
      RETREAT: exprList.default([]),
      SUPPORT: exprList.default([]),
      HOLD: exprList.default([]),
    })
    .default({}),
  targetAll: exprList.default([]),
  locations: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(20),
        aliases: exprList.default([]),
      }),
    )
    .max(100)
    .default([]),
  numberWords: z.record(z.string().min(1).max(10), z.number().int().min(0).max(99)).default({}),
  partySuffixes: exprList.default([]),
  correctionMarkers: exprList.default([]),
  cancelPhrases: exprList.default([]),
  /** 기본 사전의 표현 중 끄는 것 (F09 US-F09-1.3). mergeDictionaries(base, override)에서 base에 적용된다. */
  disabled: exprList.optional(),
});
export type Dictionary = z.infer<typeof DictionarySchema>;

export interface DictLocation {
  id: string;
  label: string;
  aliases: string[];
}

/** 사전 표현 비교용 형태: NFKC, 소문자, 공백·구두점 제거. */
export function compactExpression(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,!?~…·:;"'()[\]{}\-_/\\]+/g, '');
}

export const DEFAULT_DICTIONARY: Dictionary = DictionarySchema.parse({
  version: 1,
  name: '기본',
  actions: {
    GATHER: ['모여', '모이세요', '모여라', '뭉쳐', '집결', '모입시다', '모이자'],
    MOVE: ['가', '가세요', '이동', '넘어가', '이쪽으로', '와', '가자'],
    ATTACK: ['쳐', '때려', '들어가', '물어', '공격', '박아', '치세요', '쳐라'],
    DEFEND: ['지켜', '막아', '수비', '방어', '지키세요'],
    RETREAT: ['빠져', '빼', '후퇴', '뒤로 빠져', '빠지세요', '물러나', '철수'],
    SUPPORT: ['도와', '지원', '붙어줘', '도와주세요', '붙어'],
    HOLD: ['대기', '멈춰', '기다려', '홀드', '스탑', '정지'],
  },
  targetAll: ['다들', '전원', '모두', '전체', '다', '올파티'],
  locations: [
    { id: 'CENTER', label: '중앙', aliases: ['가운데', '미드', '중간'] },
    { id: 'LEFT', label: '좌측', aliases: ['왼쪽', '좌', '왼편'] },
    { id: 'RIGHT', label: '우측', aliases: ['오른쪽', '우', '오른편'] },
    { id: 'FRONT', label: '앞', aliases: ['앞쪽', '전방'] },
    { id: 'BACK', label: '뒤', aliases: ['뒤쪽', '후방'] },
  ],
  numberWords: {
    일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10, 십일: 11, 십이: 12,
    한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12,
    첫: 1,
  },
  partySuffixes: ['파티', '팟', '파'],
  correctionMarkers: ['말고', '아니', '아니고'],
  cancelPhrases: [
    '방금 거 취소',
    '방금꺼 취소',
    '취소 취소',
    '취소해',
    '명령 취소',
    '아까 거 취소',
    '방금 그거 취소',
    '아까 꺼 취소',
    '직전 명령 취소',
  ],
});

/** 약한(모호한) 행동 표현. 이 표현으로만 만들어진 명령은 확신도 중간이다. 대상·위치가 모두 없으면 명령으로 보지 않는다. */
export const WEAK_ACTION_EXPRESSIONS: ReadonlySet<string> = new Set(
  ['가자', '이쪽으로', '들어가', '와', '가', '붙어'].map(compactExpression),
);

// ---------------------------------------------------------------------------
// merge

function cleanList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const k = compactExpression(e);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * 기본 사전(base)과 동맹 사전(override)을 합친다. 같은 표현이 둘 다에 있으면 override가 이긴다.
 * - override.disabled 의 표현은 base에서 모든 목록(행동·전체·위치 별칭·정정어·취소어)에서 빠진다.
 * - override가 행동 X에 둔 표현은 base의 다른 행동에서 빠진다. (override 안의 중복은 건드리지 않는다. findDictionaryConflicts로 경고)
 * - 위치는 id가 같으면 합치고(label은 override), 다른 위치가 가진 같은 별칭은 base 쪽에서 빠진다.
 * 결과의 disabled 는 비운다.
 */
export function mergeDictionaries(base: Dictionary, override: Dictionary): Dictionary {
  const off = new Set((override.disabled ?? []).map(compactExpression));
  const keep = (e: string) => !off.has(compactExpression(e));

  const overrideActionOf = new Map<string, Action>();
  for (const a of ACTIONS) for (const e of override.actions[a]) overrideActionOf.set(compactExpression(e), a);

  const actions = {} as Record<Action, string[]>;
  for (const a of ACTIONS) {
    const fromBase = base.actions[a].filter((e) => {
      if (!keep(e)) return false;
      const o = overrideActionOf.get(compactExpression(e));
      return o === undefined || o === a;
    });
    actions[a] = cleanList([...fromBase, ...override.actions[a]]);
  }

  // 위치
  const overrideAliasOwner = new Map<string, string>();
  for (const l of override.locations)
    for (const e of [l.label, ...l.aliases]) overrideAliasOwner.set(compactExpression(e), l.id);
  const locs = new Map<string, DictLocation>();
  for (const l of base.locations) {
    const aliases = l.aliases.filter((e) => {
      if (!keep(e)) return false;
      const o = overrideAliasOwner.get(compactExpression(e));
      return o === undefined || o === l.id;
    });
    locs.set(l.id, { id: l.id, label: l.label, aliases });
  }
  for (const l of override.locations) {
    const prev = locs.get(l.id);
    locs.set(l.id, {
      id: l.id,
      label: l.label,
      aliases: cleanList([...(prev?.aliases ?? []), ...l.aliases]),
    });
  }

  return {
    version: 1,
    name: override.name,
    actions,
    targetAll: cleanList([...base.targetAll.filter(keep), ...override.targetAll]),
    locations: [...locs.values()],
    numberWords: { ...base.numberWords, ...override.numberWords },
    partySuffixes: cleanList([...base.partySuffixes, ...override.partySuffixes]),
    correctionMarkers: cleanList([...base.correctionMarkers.filter(keep), ...override.correctionMarkers]),
    cancelPhrases: cleanList([...base.cancelPhrases.filter(keep), ...override.cancelPhrases]),
  };
}

// ---------------------------------------------------------------------------
// conflicts

export interface DictionaryConflict {
  /** 공백을 뺀 정규형 */
  expression: string;
  actions: Action[];
}

/** 같은 표현이 두 행동 이상에 등록된 곳을 찾는다 (FR-F09-7). 공백·대소문자 차이는 같은 표현으로 본다. */
export function findDictionaryConflicts(dict: Dictionary): DictionaryConflict[] {
  const owners = new Map<string, Action[]>();
  for (const a of ACTIONS) {
    for (const e of dict.actions[a]) {
      const k = compactExpression(e);
      if (!k) continue;
      const list = owners.get(k) ?? [];
      if (!list.includes(a)) list.push(a);
      owners.set(k, list);
    }
  }
  return [...owners.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([expression, actions]) => ({ expression, actions }));
}

// ---------------------------------------------------------------------------
// party lexicon

export interface PartyLexiconEntry {
  /** 공백 제거된 정규형 표현 */
  expression: string;
  partyId: PartyId;
  number: number;
  kind: 'number' | 'name' | 'alias';
}

/**
 * FR-F09-2: 방의 파티 번호·이름·별칭을 partyId로 매핑하는 표현 목록.
 * 번호는 접미사별("1파티","1팟","1파") 표현으로 넣는다. 같은 표현이 여러 파티에 있으면 앞 파티가 가진다.
 */
export function buildPartyLexicon(
  parties: readonly Party[],
  suffixes: readonly string[] = DEFAULT_DICTIONARY.partySuffixes,
): PartyLexiconEntry[] {
  const out: PartyLexiconEntry[] = [];
  const seen = new Set<string>();
  const add = (raw: string, p: Party, kind: PartyLexiconEntry['kind']) => {
    const expression = compactExpression(raw);
    if (!expression || seen.has(expression)) return;
    seen.add(expression);
    out.push({ expression, partyId: p.id, number: p.number, kind });
  };
  for (const p of parties) for (const s of suffixes) add(`${p.number}${s}`, p, 'number');
  for (const p of parties) {
    if (p.name) add(p.name, p, 'name');
    for (const al of p.aliases) add(al, p, 'alias');
  }
  return out;
}
