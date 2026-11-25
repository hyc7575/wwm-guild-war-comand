import { EngineEmitter } from './emitter';
import type { PrepareProgress, StartOptions, SttEngine, SupportResult } from './types';

export interface FakeEngineOptions {
  /** true면 window.__windsFakeStt 에 노출(Playwright에서 발화 주입) */
  exposeGlobal?: boolean;
  /** level 이벤트 주기(ms). 0이면 내보내지 않는다. 기본 100 */
  levelIntervalMs?: number;
  /** 부분 결과 사이 간격(ms). 기본 0(동기 아님, 같은 틱 순서대로) */
  partialIntervalMs?: number;
}

export interface InjectOptions {
  /** 부분 결과를 몇 단계로 쪼갤지. 기본 0(바로 final) */
  partialSteps?: number;
}

export interface FakeSttGlobal {
  inject(text: string, opts?: InjectOptions): Promise<void>;
  engine: FakeEngine;
}

declare global {
  interface Window {
    __windsFakeStt?: FakeSttGlobal;
  }
}

/** 개발·테스트용 엔진. 텍스트를 직접 주입한다 */
export class FakeEngine extends EngineEmitter implements SttEngine {
  readonly id = 'fake';
  readonly label = 'Fake (텍스트 주입)';
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private frozen = false;
  private level = 0.2;
  /** start()가 몇 번 불렸는지(테스트용) */
  startCount = 0;
  /** 다음 start()를 실패시킬 횟수(테스트용) */
  failNextStarts = 0;

  constructor(private opts: FakeEngineOptions = {}) {
    super();
    if (opts.exposeGlobal && typeof window !== 'undefined') {
      window.__windsFakeStt = { inject: (t, o) => this.inject(t, o), engine: this };
    }
  }

  async isSupported(): Promise<SupportResult> {
    return { ok: true };
  }

  async prepare(onProgress?: (p: PrepareProgress) => void): Promise<void> {
    this.setState('PREPARING');
    onProgress?.({ phase: 'init', loaded: 1, total: 1 });
    this.setState('READY');
  }

  async start(_opts?: StartOptions): Promise<void> {
    this.startCount++;
    if (this.failNextStarts > 0) {
      this.failNextStarts--;
      this.setState('ERROR');
      throw new Error('fake start failure');
    }
    this.frozen = false;
    this.setState('LISTENING');
    this.startLevelTimer();
  }

  async stop(): Promise<void> {
    this.stopLevelTimer();
    if (this.state === 'LISTENING' || this.state === 'ERROR') this.setState('STOPPED');
  }

  /** 오디오 프레임이 끊긴 상황을 흉내낸다(level 이벤트 중단) */
  freeze(): void {
    this.frozen = true;
  }

  /** 엔진 오류를 흉내낸다 */
  fail(message = 'fake error', fatal = false): void {
    this.emit('error', { message, code: 'fake', fatal });
  }

  setLevel(v: number): void {
    this.level = v;
  }

  /** 발화 주입. partialSteps가 있으면 글자를 나눠 partial을 먼저 내보낸다 */
  async inject(text: string, opts: InjectOptions = {}): Promise<void> {
    if (this.state !== 'LISTENING') return;
    const steps = Math.max(0, opts.partialSteps ?? 0);
    const startedAt = Date.now();
    const chars = [...text];
    for (let i = 1; i <= steps; i++) {
      const upto = Math.ceil((chars.length * i) / (steps + 1));
      this.emit('partial', { text: chars.slice(0, upto).join('') });
      if (this.opts.partialIntervalMs)
        await new Promise((r) => setTimeout(r, this.opts.partialIntervalMs));
    }
    this.emit('partial', { text });
    this.emit('final', { text, startedAt, endedAt: Date.now() });
  }

  private startLevelTimer() {
    this.stopLevelTimer();
    const ms = this.opts.levelIntervalMs ?? 100;
    if (ms <= 0) return;
    this.levelTimer = setInterval(() => {
      if (!this.frozen) this.emit('level', this.level);
    }, ms);
  }

  private stopLevelTimer() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
  }
}
