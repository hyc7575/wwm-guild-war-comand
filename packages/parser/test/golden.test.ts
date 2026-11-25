import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { computeMetrics, describeOutcome, evaluate, loadPath, TARGETS } from '../scripts/golden-lib';

const dir = fileURLToPath(new URL('./golden', import.meta.url));
const cases = loadPath(dir);

describe('golden cases', () => {
  it('케이스가 충분히 있다', () => {
    expect(cases.length).toBeGreaterThanOrEqual(70);
  });

  for (const c of cases) {
    const name = `${c.source}:${c.line} ${c.text || '(빈 문자열)'}`;
    if (c.knownFailure) {
      // 고쳐지면 이 테스트가 실패해 knownFailure 표시를 지우게 만든다
      it.fails(`[known] ${name}`, () => {
        const o = evaluate(c);
        expect(o.pass, describeOutcome(o)).toBe(true);
      });
    } else {
      it(name, () => {
        const o = evaluate(c);
        expect(o.pass, describeOutcome(o)).toBe(true);
      });
    }
  }

  it('F03 품질 목표를 만족한다', () => {
    const m = computeMetrics(cases.map((c) => evaluate(c)));
    expect(m.recall).toBeGreaterThanOrEqual(TARGETS.recall);
    expect(m.precision).toBeGreaterThanOrEqual(TARGETS.precision);
    expect(m.falseIssueRate).toBeLessThan(TARGETS.falseIssue);
  });
});
