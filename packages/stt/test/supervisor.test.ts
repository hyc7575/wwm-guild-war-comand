import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../src/fake-engine';
import { SttSupervisor, statusLabel, type SupervisorState } from '../src/supervisor';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup(opts = {}) {
  const engine = new FakeEngine({ levelIntervalMs: 100 });
  const sup = new SttSupervisor(engine, { restartDelayMs: 100, ...opts, mediaDevices: undefined });
  const states: SupervisorState[] = [];
  sup.on('supervisorState', (s) => states.push(s));
  await sup.prepare();
  await sup.start();
  return { engine, sup, states };
}

describe('SttSupervisor 자동 복구 (FR-F02-7)', () => {
  it('정상일 때는 복구하지 않고 LISTENING을 유지한다', async () => {
    const { sup, engine } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sup.state).toBe('LISTENING');
    expect(sup.stats.recoveries).toBe(0);
    expect(engine.startCount).toBe(1);
    await sup.stop();
  });

  it('오디오 프레임이 3초 없으면 재시작한다', async () => {
    const { sup, engine } = await setup();
    engine.freeze();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sup.stats.recoveries).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sup.stats.recoveries).toBe(1);
    expect(engine.startCount).toBe(2); // start()에서 frozen이 풀린다
    expect(sup.state).toBe('LISTENING');
    await sup.stop();
  });

  it('엔진 오류(비치명)는 재시작한다', async () => {
    const { sup, engine } = await setup();
    engine.fail('boom');
    await vi.advanceTimersByTimeAsync(500);
    expect(sup.stats.recoveries).toBe(1);
    expect(sup.state).toBe('LISTENING');
    await sup.stop();
  });

  it('치명 오류는 재시작하지 않고 ERROR로 멈춘다', async () => {
    const { sup, engine } = await setup();
    engine.fail('권한 거부', true);
    await vi.advanceTimersByTimeAsync(500);
    expect(sup.state).toBe('ERROR');
    expect(sup.stats.recoveries).toBe(0);
    expect(engine.startCount).toBe(1);
  });

  it('1분 안에 3번 실패하면 ERROR로 멈추고 더 재시작하지 않는다', async () => {
    const { sup, engine } = await setup();
    const errors: string[] = [];
    sup.on('error', (e) => errors.push(e.code ?? ''));
    for (let i = 0; i < 3; i++) {
      engine.fail('boom');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sup.state).toBe('ERROR');
    expect(sup.stats.recoveries).toBe(2); // 3번째 실패는 복구 대신 중단
    expect(errors).toContain('too-many-failures');
    const starts = engine.startCount;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.startCount).toBe(starts);
  });

  it('실패가 60초 간격으로 벌어지면 누적하지 않는다', async () => {
    const { sup, engine } = await setup();
    for (let i = 0; i < 4; i++) {
      engine.fail('boom');
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(sup.state).toBe('LISTENING');
    expect(sup.stats.recoveries).toBe(4);
    await sup.stop();
  });

  it('재시작(start) 자체가 계속 실패해도 3회에서 ERROR가 된다', async () => {
    const { sup, engine } = await setup();
    engine.failNextStarts = 5;
    engine.fail('boom');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sup.state).toBe('ERROR');
  });

  it('복구 횟수와 실제 듣는 시간을 센다(복구 중 시간은 제외)', async () => {
    const { sup, engine } = await setup();
    await vi.advanceTimersByTimeAsync(5000);
    engine.fail('boom');
    await vi.advanceTimersByTimeAsync(100); // 복구 중
    await vi.advanceTimersByTimeAsync(5000);
    await sup.stop();
    const { activeListeningMs, recoveries } = sup.stats;
    expect(recoveries).toBe(1);
    expect(activeListeningMs).toBeGreaterThan(9000);
    expect(activeListeningMs).toBeLessThan(10_500);
  });

  it('stop() 후에는 워치독이 동작하지 않는다', async () => {
    const { sup, engine } = await setup();
    await sup.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sup.state).toBe('STOPPED');
    expect(engine.startCount).toBe(1);
  });

  it('final/partial도 프레임으로 본다', async () => {
    const { sup, engine } = await setup({ watchdogMs: 1000 });
    engine.freeze();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(600);
      await engine.inject('말');
    }
    expect(sup.stats.recoveries).toBe(0);
    await sup.stop();
  });
});

describe('마이크 연결 끊김 (devicechange)', () => {
  function fakeMd(initial: { deviceId: string }[]) {
    let devices = initial;
    let handler: (() => void) | undefined;
    return {
      set(next: { deviceId: string }[]) {
        devices = next;
        handler?.();
      },
      md: {
        enumerateDevices: async () =>
          devices.map((d) => ({ kind: 'audioinput', label: 'mic', ...d }) as MediaDeviceInfo),
        addEventListener: (_: string, h: () => void) => (handler = h),
        removeEventListener: () => (handler = undefined),
      } as unknown as Pick<
        MediaDevices,
        'enumerateDevices' | 'addEventListener' | 'removeEventListener'
      >,
    };
  }

  it('사용 중인 마이크가 사라지면 DISCONNECTED, 돌아오면 다시 듣는다', async () => {
    const m = fakeMd([{ deviceId: 'a' }, { deviceId: 'b' }]);
    const engine = new FakeEngine({ levelIntervalMs: 100 });
    const sup = new SttSupervisor(engine, { mediaDevices: m.md });
    await sup.prepare();
    await sup.start({ deviceId: 'a' });
    m.set([{ deviceId: 'b' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(sup.state).toBe('DISCONNECTED');
    expect(statusLabel(sup.state)).toBe('마이크 연결 끊김');
    // 끊김은 워치독 실패로 세지 않는다
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sup.state).toBe('DISCONNECTED');
    expect(sup.stats.recoveries).toBe(0);
    m.set([{ deviceId: 'a' }, { deviceId: 'b' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(sup.state).toBe('LISTENING');
    await sup.stop();
  });

  it('다른 마이크가 빠지는 것은 무시한다', async () => {
    const m = fakeMd([{ deviceId: 'a' }, { deviceId: 'b' }]);
    const sup = new SttSupervisor(new FakeEngine(), { mediaDevices: m.md });
    await sup.prepare();
    await sup.start({ deviceId: 'a' });
    m.set([{ deviceId: 'a' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(sup.state).toBe('LISTENING');
    await sup.stop();
  });
});

describe('statusLabel', () => {
  it('FR-F02 상태 문구로 바꾼다', () => {
    expect(statusLabel('PREPARING')).toBe('준비 중');
    expect(statusLabel('LISTENING')).toBe('듣는 중');
    expect(statusLabel('STOPPED')).toBe('멈춤');
    expect(statusLabel('ERROR')).toBe('오류');
  });
});
