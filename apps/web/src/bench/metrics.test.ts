import { describe, expect, it } from 'vitest';
import { cer, parseCasesJsonl, toGoldenJsonl } from './metrics';

describe('bench metrics', () => {
  it('CER은 공백을 무시하고 글자 단위로 센다', () => {
    expect(cer('삼 파티 앞으로', '삼파티앞으로')).toBe(0);
    expect(cer('삼파티', '이파티')).toBeCloseTo(1 / 3);
    expect(cer('', '')).toBe(0);
    expect(cer('', '가')).toBe(1);
  });

  it('케이스 JSONL을 읽고 골든 형식으로 내보낸다', () => {
    const cases = parseCasesJsonl(
      '# 주석\n{"id":"a","text":"삼파티 앞으로","expect":[{"kind":"NONE"}]}\n\n{"audioUrl":"x.wav","expect":[{"kind":"NONE"}]}',
    );
    expect(cases).toHaveLength(2);
    const out = toGoldenJsonl([{ id: 'a', text: '삼파티', expect: [{ kind: 'NONE' }] }]);
    expect(JSON.parse(out.trim())).toMatchObject({ id: 'a', text: '삼파티' });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('expect/text 없는 행은 거부한다', () => {
    expect(() => parseCasesJsonl('{"text":"a"}')).toThrow(/expect/);
    expect(() => parseCasesJsonl('{"expect":[{"kind":"NONE"}]}')).toThrow(/text 또는 audioUrl/);
  });
});
