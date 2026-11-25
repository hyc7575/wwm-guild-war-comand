import { DEFAULT_DICTIONARY, type Dictionary } from './dictionary';

/**
 * 정규화 (F03 1단계).
 *
 * 1. NFKC(전각→반각), 영문 소문자, 공백 정리
 * 2. 파티 번호 표현을 `N파티`로 통일한다. 숫자 말은 "바로 뒤에 파티/팟/파(+선택 '번')가 올 때만" 숫자로 본다.
 *    지원하는 형태:
 *    - `1파티`, `1팟`, `1파`, `1 파티`, `1번 파티`, `일파티`, `일팟`, `일 파티`, `십이파티`, `첫 파티`, `두 파티`
 *    - 여러 개: `1,2파티` `1·2파티` `1 2 파티` `1/2파티` `1과 2파티` `1하고 2파티` `1이랑 2파티` `1 그리고 2파티` → `1파티 2파티`
 *    - 숫자 범위: `1~3파티` `1-3파티` `1에서 3파티` `1부터 3파티` → `1파티 2파티 3파티` (숫자만, 최대 12)
 *    - "이 파티"처럼 지시어 `이` + 공백 + 파티는 숫자로 보지 않는다. 붙여 쓴 `이파티`는 2파티.
 *    - 지원하지 않음: 한자어 숫자를 붙여 쓴 `일이파티`(= 1,2 인지 알 수 없다), 숫자 말 사이 공백 없는 나열, `1파티~3파티` 형태 범위
 *    - 한글 바로 뒤에 붙은 숫자 말(`서일파티`)은 단어의 일부일 수 있어 건드리지 않는다. 아라비아 숫자는 앞 글자와 상관없이 변환한다.
 * 3. 구두점은 공백으로 바꾸고 공백을 한 칸으로 줄인다.
 *
 * 매칭에서의 `start/end` 오프셋은 이 함수의 결과 문자열 기준이다.
 */
export type NormalizeDictionary = Pick<Dictionary, 'numberWords' | 'partySuffixes'>;

interface Compiled {
  groupRe: RegExp;
  rangeRe: RegExp;
  sepRe: RegExp;
  numberWords: Record<string, number>;
}

const cache = new WeakMap<object, Compiled>();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (list: string[]) => [...list].sort((a, b) => b.length - a.length).map(esc).join('|');

const CONNECTORS = ['및', '그리고', '하고', '이랑', '랑', '과', '와', ',', '·', '・', '/', '&', '+'];
const PARTICLE_START = '는은가를도만랑이께에으로';

function compile(dict: NormalizeDictionary): Compiled {
  const hit = cache.get(dict);
  if (hit) return hit;
  const words = Object.keys(dict.numberWords);
  const num = `(?:${alt(words)}|\\d{1,2})`;
  const suf = alt(dict.partySuffixes.length ? dict.partySuffixes : ['파티']);
  const sep = `(?:\\s*(?:${alt(CONNECTORS)})\\s*|\\s+)`;
  const compiled: Compiled = {
    groupRe: new RegExp(`(?<!\\d)(${num}(?:${sep}${num})*)(\\s*)(?:번\\s*)?(${suf})`, 'gu'),
    rangeRe: new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:~|-|–|에서|부터)\\s*(\\d{1,2})\\s*(?:번\\s*)?(?:${suf})`, 'gu'),
    sepRe: new RegExp(sep, 'u'),
    numberWords: dict.numberWords,
  };
  cache.set(dict, compiled);
  return compiled;
}

const isHangul = (ch: string | undefined) => !!ch && /[가-힣]/.test(ch);

function joinParties(nums: number[], before: string | undefined): string {
  const body = nums.map((n) => `${n}파티`).join(' ');
  return before !== undefined && before !== ' ' ? ` ${body}` : body;
}

export function normalize(text: string, dict: NormalizeDictionary = DEFAULT_DICTIONARY): string {
  const c = compile(dict);
  let s = text.normalize('NFKC').toLowerCase();

  // 범위: 1~3파티
  s = s.replace(c.rangeRe, (m, a: string, b: string, offset: number, whole: string) => {
    const lo = Number(a);
    const hi = Number(b);
    if (!(lo >= 1 && hi > lo && hi - lo < 12)) return m;
    const nums: number[] = [];
    for (let n = lo; n <= hi; n++) nums.push(n);
    return joinParties(nums, whole[offset - 1]);
  });

  // 번호(들) + 접미사
  s = s.replace(
    c.groupRe,
    (m, group: string, gap: string, suffix: string, offset: number, whole: string) => {
      const tokens = group.split(c.sepRe).filter((x) => x.length > 0);
      const nums: number[] = [];
      for (const tk of tokens) {
        const v = /^\d+$/.test(tk) ? Number(tk) : c.numberWords[tk];
        if (v === undefined || v < 1) return m;
        nums.push(v);
      }
      if (nums.length === 0) return m;
      const first = tokens[0] ?? '';
      const last = tokens[tokens.length - 1] ?? '';
      const prev = whole[offset - 1];
      // 한글 단어 안에 든 숫자 말은 건드리지 않는다
      if (!/^\d/.test(first) && isHangul(prev)) return m;
      // "이 파티", "이번 파티": 지시어 이 (+ 공백 / 번)
      if (last === '이' && (gap.length > 0 || m.slice(group.length).startsWith('번'))) return m;
      // 접미사 "파"는 뒤에 한글이 이어지면(조사 제외) 다른 단어의 일부로 본다
      if (suffix === '파') {
        const next = whole[offset + m.length];
        if (isHangul(next) && !PARTICLE_START.includes(next as string)) return m;
      }
      return joinParties(nums, prev);
    },
  );

  s = s.replace(/[.,!?~…·:;"'()[\]{}\-_/\\]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
