import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebSpeechEngine,
  type AvailabilityStatus,
  type SpeechRecognitionCtor,
} from '../src/web-speech-engine';

class MockRec {
  static instances: MockRec[] = [];
  static status: AvailabilityStatus = 'available';
  static installOk = true;
  static installCalls = 0;
  static availableArgs: unknown[] = [];
  static ignoreProcessLocally = false;
  static async available(o: unknown) {
    MockRec.availableArgs.push(o);
    return MockRec.status;
  }
  static async install() {
    MockRec.installCalls++;
    if (MockRec.installOk) MockRec.status = 'available';
    return MockRec.installOk;
  }
  lang = '';
  continuous = false;
  interimResults = false;
  _pl = false;
  get processLocally() {
    return this._pl;
  }
  set processLocally(v: boolean) {
    if (!MockRec.ignoreProcessLocally) this._pl = v;
  }
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  starts = 0;
  stops = 0;
  constructor() {
    MockRec.instances.push(this);
  }
  start() {
    this.starts++;
  }
  stop() {
    this.stops++;
  }
  abort() {}
  emitResult(items: { text: string; final: boolean }[], resultIndex = 0) {
    const results = items.map((i) => Object.assign([{ transcript: i.text }], { isFinal: i.final }));
    this.onresult?.({ resultIndex, results });
  }
}

const Ctor = MockRec as unknown as SpeechRecognitionCtor;
const make = () =>
  new WebSpeechEngine({ ctor: Ctor, micLevel: false, restartBaseMs: 100, restartMaxMs: 800 });

beforeEach(() => {
  vi.useFakeTimers();
  MockRec.instances = [];
  MockRec.status = 'available';
  MockRec.installOk = true;
  MockRec.installCalls = 0;
  MockRec.availableArgs = [];
  MockRec.ignoreProcessLocally = false;
});
afterEach(() => vi.useRealTimers());

describe('WebSpeechEngine 가용성', () => {
  it('API가 없으면 지원하지 않는다고 알린다', async () => {
    const r = await new WebSpeechEngine({ ctor: undefined, micLevel: false }).isSupported();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/139/);
  });

  it('available({langs:[ko-KR], processLocally:true})로 확인한다', async () => {
    await make().isSupported();
    expect(MockRec.availableArgs[0]).toEqual({ langs: ['ko-KR'], processLocally: true });
  });

  it('unavailable이면 거부하고 클라우드로 대신하지 않는다고 말한다', async () => {
    MockRec.status = 'unavailable';
    const e = make();
    const r = await e.isSupported();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/클라우드/);
    await expect(e.prepare()).rejects.toThrow();
    expect(e.state).toBe('ERROR');
    expect(MockRec.installCalls).toBe(0);
  });

  it('downloadable이면 prepare에서 install()한다', async () => {
    MockRec.status = 'downloadable';
    const e = make();
    expect((await e.isSupported()).ok).toBe(true);
    await e.prepare();
    expect(MockRec.installCalls).toBe(1);
    expect(e.state).toBe('READY');
  });

  it('install 실패면 prepare가 실패한다', async () => {
    MockRec.status = 'downloadable';
    MockRec.installOk = false;
    const e = make();
    await expect(e.prepare()).rejects.toThrow(/설치/);
    expect(e.state).toBe('ERROR');
  });

  it('prepare 없이 start하면 거부한다', async () => {
    await expect(make().start()).rejects.toThrow(/prepare/);
  });

  it('processLocally를 무시하는 브라우저에서는 시작을 거부한다(클라우드 방지)', async () => {
    MockRec.ignoreProcessLocally = true;
    const e = make();
    await e.prepare();
    const errors: { code?: string; fatal: boolean }[] = [];
    e.on('error', (x) => errors.push(x));
    await expect(e.start()).rejects.toThrow(/클라우드/);
    expect(errors[0]).toMatchObject({ code: 'on-device-unsupported', fatal: true });
  });
});

describe('WebSpeechEngine 인식', () => {
  async function started() {
    const e = make();
    await e.prepare();
    await e.start();
    return { e, rec: MockRec.instances[0]! };
  }

  it('설정: ko-KR, continuous, interimResults, processLocally', async () => {
    const { rec, e } = await started();
    expect(rec).toMatchObject({
      lang: 'ko-KR',
      continuous: true,
      interimResults: true,
      processLocally: true,
      starts: 1,
    });
    expect(e.state).toBe('LISTENING');
  });

  it('중간 결과는 partial, 확정은 final로 낸다', async () => {
    const { rec, e } = await started();
    const partials: string[] = [];
    const finals: string[] = [];
    e.on('partial', (p) => partials.push(p.text));
    e.on('final', (f) => finals.push(f.text));
    rec.emitResult([{ text: '삼 파티', final: false }]);
    rec.emitResult([{ text: '삼 파티 거점 앞', final: true }]);
    expect(partials).toEqual(['삼 파티']);
    expect(finals).toEqual(['삼 파티 거점 앞']);
  });

  it('end가 오면 backoff 후 같은 인스턴스를 다시 start한다', async () => {
    const { rec, e } = await started();
    rec.onend?.();
    expect(rec.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(rec.starts).toBe(2);
    expect(e.state).toBe('LISTENING');
  });

  it('세션이 금방 끝나기를 반복하면 backoff가 늘어난다', async () => {
    const { rec } = await started();
    rec.onend?.(); // 1회: 200ms
    await vi.advanceTimersByTimeAsync(150);
    expect(rec.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(rec.starts).toBe(2);
    rec.onend?.(); // 2회: 400ms
    await vi.advanceTimersByTimeAsync(300);
    expect(rec.starts).toBe(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(rec.starts).toBe(3);
  });

  it('stop() 뒤의 end는 재시작하지 않는다', async () => {
    const { rec, e } = await started();
    const onend = rec.onend;
    await e.stop();
    onend?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.starts).toBe(1);
    expect(rec.stops).toBe(1);
    expect(e.state).toBe('STOPPED');
  });

  it.each(['not-allowed', 'service-not-allowed', 'language-not-supported'])(
    '%s는 치명 오류: 재시작하지 않고 ERROR',
    async (code) => {
      const { rec, e } = await started();
      const errors: { code?: string; fatal: boolean }[] = [];
      e.on('error', (x) => errors.push(x));
      rec.onerror?.({ error: code });
      rec.onend?.();
      await vi.advanceTimersByTimeAsync(5000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code, fatal: true });
      expect(e.state).toBe('ERROR');
      expect(rec.starts).toBe(1);
    },
  );

  it.each(['no-speech', 'aborted'])('%s는 정상 재시작으로 본다(오류 이벤트 없음)', async (code) => {
    const { rec, e } = await started();
    const errors: unknown[] = [];
    e.on('error', (x) => errors.push(x));
    rec.onerror?.({ error: code });
    rec.onend?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toHaveLength(0);
    expect(rec.starts).toBe(2);
    expect(e.state).toBe('LISTENING');
  });

  it('audio-capture는 비치명 오류로 알리고 스스로 재시작하지 않는다(감독자가 판단)', async () => {
    const { rec, e } = await started();
    const errors: { fatal: boolean; code?: string }[] = [];
    e.on('error', (x) => errors.push(x));
    rec.onerror?.({ error: 'audio-capture' });
    rec.onend?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors[0]).toMatchObject({ code: 'audio-capture', fatal: false });
    expect(rec.starts).toBe(1);
  });
});
