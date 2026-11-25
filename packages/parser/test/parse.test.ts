import { describe, expect, it } from 'vitest';
import { makeDefaultParties } from '@winds/protocol';
import { DEFAULT_DICTIONARY, normalize, parse, type ParseContext } from '../src/index';

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  parties: makeDefaultParties(6),
  dictionary: DEFAULT_DICTIONARY,
  now: 100_000,
  ...over,
});

describe('parse', () => {
  it('근거(evidence)는 정규화 문자열의 오프셋과 일치한다', () => {
    const text = '일 파티,  중앙으로 모여';
    const t = normalize(text);
    const [r] = parse(text, ctx());
    expect(r?.kind).toBe('ISSUE');
    if (r?.kind !== 'ISSUE') return;
    expect(r.evidence.map((e) => [e.slot, e.text, e.value])).toEqual([
      ['target', '1파티', 'p1'],
      ['location', '중앙', 'CENTER'],
      ['action', '모여', 'GATHER'],
    ]);
    for (const e of r.evidence) expect(t.slice(e.start, e.end)).toBe(e.text);
  });

  it('지원 근거는 support 슬롯', () => {
    const [r] = parse('2파티 1파티 지원', ctx());
    if (r?.kind !== 'ISSUE') throw new Error('ISSUE 기대');
    expect(r.evidence.map((e) => e.slot)).toEqual(['target', 'support', 'action']);
  });

  it('순수·결정적: 같은 입력은 같은 결과, 입력을 바꾸지 않는다', () => {
    const c = ctx();
    const snap = JSON.stringify(c);
    const a = parse('1파티 중앙, 3파티 오른쪽 지켜', c);
    const b = parse('1파티 중앙, 3파티 오른쪽 지켜', c);
    expect(a).toEqual(b);
    expect(JSON.stringify(c)).toBe(snap);
  });

  it('문장당 5ms 이하 (FR-F03-11)', () => {
    const c = ctx();
    const s = '1파티 중앙, 3파티 오른쪽 지켜 아니 2파티 말고 4파티 도와줘 그리고 전원 뒤로 빠져';
    parse(s, c); // warm-up
    const n = 300;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) parse(s, c);
    expect((performance.now() - t0) / n).toBeLessThan(5);
  });

  it('빈 문자열·공백은 NONE', () => {
    expect(parse('   ', ctx())).toEqual([{ kind: 'NONE', reason: '빈 발화' }]);
  });

  it('방에 없는 파티는 NONE 사유에 번호를 담는다', () => {
    const [r] = parse('9파티 쳐', ctx());
    expect(r).toMatchObject({ kind: 'NONE' });
    expect((r as { reason: string }).reason).toContain('9');
  });
});
