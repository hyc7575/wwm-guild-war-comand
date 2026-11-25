import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../src/fake-engine';
import type { SttFinal, SttState } from '../src/types';

afterEach(() => vi.useRealTimers());

describe('FakeEngine', () => {
  it('prepare -> READY, start -> LISTENING, stop -> STOPPED 순서로 state를 낸다', async () => {
    const e = new FakeEngine();
    const states: SttState[] = [];
    e.on('state', (s) => states.push(s));
    await e.prepare();
    await e.start();
    await e.stop();
    expect(states).toEqual(['PREPARING', 'READY', 'LISTENING', 'STOPPED']);
  });

  it('inject는 partial을 먼저 내고 마지막에 final을 낸다', async () => {
    const e = new FakeEngine({ levelIntervalMs: 0 });
    await e.prepare();
    await e.start();
    const partials: string[] = [];
    const finals: SttFinal[] = [];
    e.on('partial', (p) => partials.push(p.text));
    e.on('final', (f) => finals.push(f));
    await e.inject('삼파티 거점 앞으로', { partialSteps: 2 });
    expect(partials.length).toBe(3);
    expect(partials.at(-1)).toBe('삼파티 거점 앞으로');
    expect(partials[0]!.length).toBeLessThan(partials[1]!.length);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('삼파티 거점 앞으로');
    expect(finals[0]!.endedAt).toBeGreaterThan(0);
  });

  it('LISTENING이 아니면 inject를 무시한다', async () => {
    const e = new FakeEngine();
    const finals: SttFinal[] = [];
    e.on('final', (f) => finals.push(f));
    await e.inject('무시');
    expect(finals).toHaveLength(0);
  });

  it('level을 주기적으로 내고 freeze하면 멈춘다', async () => {
    vi.useFakeTimers();
    const e = new FakeEngine({ levelIntervalMs: 100 });
    await e.prepare();
    await e.start();
    const levels: number[] = [];
    e.on('level', (l) => levels.push(l));
    vi.advanceTimersByTime(350);
    expect(levels).toHaveLength(3);
    e.freeze();
    vi.advanceTimersByTime(1000);
    expect(levels).toHaveLength(3);
    await e.stop();
  });

  it('exposeGlobal이면 window.__windsFakeStt로 주입할 수 있다', async () => {
    const win: Record<string, unknown> = {};
    vi.stubGlobal('window', win);
    const e = new FakeEngine({ exposeGlobal: true });
    expect((win as { __windsFakeStt?: unknown }).__windsFakeStt).toBeDefined();
    await e.prepare();
    await e.start();
    const finals: string[] = [];
    e.on('final', (f) => finals.push(f.text));
    await (win as { __windsFakeStt: { inject(t: string): Promise<void> } }).__windsFakeStt.inject(
      '전체 후퇴',
    );
    expect(finals).toEqual(['전체 후퇴']);
    await e.stop();
    vi.unstubAllGlobals();
  });

  it('구독 해제 함수가 동작한다', async () => {
    const e = new FakeEngine({ levelIntervalMs: 0 });
    await e.prepare();
    await e.start();
    const got: string[] = [];
    const off = e.on('final', (f) => got.push(f.text));
    await e.inject('a');
    off();
    await e.inject('b');
    expect(got).toEqual(['a']);
  });
});
