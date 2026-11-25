import { describe, expect, it } from 'vitest';
import { DEFAULT_CALLWORD_CONFIG, extractCallword, sanitizeCallwordConfig, sanitizeCallwords, type CallwordConfig } from '../src';

const on = (over: Partial<CallwordConfig> = {}): CallwordConfig => ({ ...DEFAULT_CALLWORD_CONFIG, enabled: true, ...over });

describe('extractCallword', () => {
  it('is off by default and passes the whole text through', () => {
    expect(DEFAULT_CALLWORD_CONFIG.enabled).toBe(false);
    expect(extractCallword('3파티 방어', DEFAULT_CALLWORD_CONFIG)).toEqual({ kind: 'COMMAND', text: '3파티 방어' });
  });
  it('takes what follows the call word', () => {
    expect(extractCallword('오더 3파티 우측 방어', on())).toEqual({ kind: 'COMMAND', text: '3파티 우측 방어' });
    expect(extractCallword('오더, 3파티 우측 방어', on())).toEqual({ kind: 'COMMAND', text: '3파티 우측 방어' });
  });
  it('allows one or two fillers before it, not three', () => {
    expect(extractCallword('자 오더 전체 집결', on())).toEqual({ kind: 'COMMAND', text: '전체 집결' });
    expect(extractCallword('아 자 오더 전체 집결', on())).toEqual({ kind: 'COMMAND', text: '전체 집결' });
    expect(extractCallword('아 아 자 오더 전체 집결', on())).toEqual({ kind: 'NONE' });
  });
  it('ignores sentences without the call word', () => {
    expect(extractCallword('3파티 우측 방어', on())).toEqual({ kind: 'NONE' });
    expect(extractCallword('3파티 우측 방어 오더', on())).toEqual({ kind: 'NONE' });
  });
  it('a filler with a digit is a command fragment, not a filler', () => {
    expect(extractCallword('1파티 오더 방어', on())).toEqual({ kind: 'NONE' });
  });
  it('a Korean-numeral or dictionary-slot filler is a command fragment too', () => {
    for (const t of ['일파티 오더 공격', '삼 파티 오더 후퇴', '1파티 오더 공격', '일 파티 오더 방어', '공격 오더 전체']) {
      expect(extractCallword(t, on()), t).toEqual({ kind: 'NONE' });
    }
    expect(extractCallword('자 오더 일파티 공격', on())).toEqual({ kind: 'COMMAND', text: '일파티 공격' });
  });
  it('does not match words that merely contain the call word', () => {
    expect(extractCallword('오더링 전체 집결', on())).toEqual({ kind: 'NONE' });
  });
  it('only the call word means CALL_ONLY', () => {
    expect(extractCallword('오더', on())).toEqual({ kind: 'CALL_ONLY' });
    expect(extractCallword('자 오더.', on())).toEqual({ kind: 'CALL_ONLY' });
  });
  it('accepts custom words and aliases only when configured', () => {
    expect(extractCallword('어더 전체 집결', on())).toEqual({ kind: 'NONE' });
    expect(extractCallword('어더 전체 집결', on({ aliases: ['어더', '오다'] }))).toEqual({ kind: 'COMMAND', text: '전체 집결' });
    expect(extractCallword('대장 전체 집결', on({ words: ['대장', '오더'] }))).toEqual({ kind: 'COMMAND', text: '전체 집결' });
  });
});

describe('sanitize', () => {
  it('caps at 3 call words, dedupes and trims', () => {
    expect(sanitizeCallwords([' 오더 ', '오더', '대장', '', '본부', '넷째'])).toEqual(['오더', '대장', '본부']);
  });
  it('falls back to the default word and disabled on junk', () => {
    expect(sanitizeCallwordConfig(null)).toEqual(DEFAULT_CALLWORD_CONFIG);
    expect(sanitizeCallwordConfig({ enabled: 'yes', words: [1], aliases: ['어더'] })).toEqual({ enabled: false, words: ['오더'], aliases: ['어더'] });
  });
});
