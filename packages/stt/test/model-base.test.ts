import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, modelBaseUrl, modelFileUrl, setModelBase } from '../src/models';

const m = MODELS['ko-72m'];
const f = m.files[0]!;

afterEach(() => setModelBase(undefined));

describe('모델 base URL', () => {
  it('기본값은 Hugging Face 고정 리비전이다', () => {
    expect(modelBaseUrl(m)).toBe(m.baseUrl);
    expect(modelFileUrl(m, f)).toBe(`${m.baseUrl}/${f.name}`);
    expect(m.baseUrl).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}$/);
  });
  it('오버라이드하면 파일명은 유지하고 base만 바뀐다', () => {
    setModelBase('https://models.example.com/stt');
    expect(modelFileUrl(m, f)).toBe(`https://models.example.com/stt/${f.name}`);
  });
  it('끝 슬래시와 공백을 정리한다', () => {
    setModelBase('  https://models.example.com/stt///  ');
    expect(modelFileUrl(m, f)).toBe(`https://models.example.com/stt/${f.name}`);
  });
  it('빈 값·undefined는 기본값으로 되돌린다', () => {
    setModelBase('https://x.test');
    setModelBase('');
    expect(modelBaseUrl(m)).toBe(m.baseUrl);
    setModelBase('https://x.test');
    setModelBase(undefined);
    expect(modelBaseUrl(m)).toBe(m.baseUrl);
  });
});
