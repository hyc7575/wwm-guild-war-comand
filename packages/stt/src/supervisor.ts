import type {
  PrepareProgress,
  SttError,
  SttEvents,
  SttFinal,
  SttState,
  StartOptions,
  SttEngine,
} from './types';
import { listMicrophones } from './microphones';

/** 엔진 상태 + 복구 중 / 마이크 끊김 */
export type SupervisorState = SttState | 'RECOVERING' | 'DISCONNECTED';

/** FR-F02 상태 문구 */
export function statusLabel(s: SupervisorState): string {
  switch (s) {
    case 'IDLE':
    case 'PREPARING':
    case 'READY':
      return '준비 중';
    case 'LISTENING':
      return '듣는 중';
    case 'RECOVERING':
      return '복구 중';
    case 'DISCONNECTED':
      return '마이크 연결 끊김';
    case 'STOPPED':
      return '멈춤';
    case 'ERROR':
      return '오류';
  }
}

export interface SupervisorOptions {
  /** 오디오 프레임(level/partial/final)이 이 시간 동안 없으면 재시작. 기본 3000 */
  watchdogMs?: number;
  /** 이 횟수만큼 실패하면 ERROR. 기본 3 */
  maxFailures?: number;
  /** 실패를 세는 구간. 기본 60000 */
  failureWindowMs?: number;
  /** 재시작 전 대기. 기본 300 */
  restartDelayMs?: number;
  /** devicechange 감시용. 기본 navigator.mediaDevices */
  mediaDevices?: Pick<
    MediaDevices,
    'enumerateDevices' | 'addEventListener' | 'removeEventListener'
  >;
}

export interface SupervisorStats {
  recoveries: number;
  failures: number;
  /** LISTENING이었던 누적 시간(ms). 복구·끊김 중에는 세지 않는다 */
  activeListeningMs: number;
}

export interface SupervisorEvents extends SttEvents {
  supervisorState: SupervisorState;
  recovery: { reason: string; count: number };
}
type Name = keyof SupervisorEvents;

/** FR-F02-7: 엔진을 감싸 자동 복구한다 */
export class SttSupervisor {
  private listeners = new Map<Name, Set<(p: never) => void>>();
  private _state: SupervisorState = 'IDLE';
  private failureTimes: number[] = [];
  private recoveries = 0;
  private activeMs = 0;
  private listeningSince: number | undefined;
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private startOpts: StartOptions = {};
  private wantListening = false;
  private busy = false; // 복구 중복 방지
  private offs: (() => void)[] = [];
  private md: SupervisorOptions['mediaDevices'];
  private deviceChangeHandler = () => void this.onDeviceChange();
  private o: Required<Omit<SupervisorOptions, 'mediaDevices'>>;

  constructor(
    readonly engine: SttEngine,
    opts: SupervisorOptions = {},
  ) {
    this.o = {
      watchdogMs: opts.watchdogMs ?? 3000,
      maxFailures: opts.maxFailures ?? 3,
      failureWindowMs: opts.failureWindowMs ?? 60_000,
      restartDelayMs: opts.restartDelayMs ?? 300,
    };
    this.md =
      opts.mediaDevices ??
      (globalThis.navigator?.mediaDevices as SupervisorOptions['mediaDevices']);
    this.offs.push(
      engine.on('partial', (p) => {
        this.lastFrameAt = Date.now();
        this.emit('partial', p);
      }),
      engine.on('final', (f: SttFinal) => {
        this.lastFrameAt = Date.now();
        this.emit('final', f);
      }),
      engine.on('level', (l) => {
        this.lastFrameAt = Date.now();
        this.emit('level', l);
      }),
      engine.on('metrics', (m) => this.emit('metrics', m)),
      engine.on('log', (m) => this.emit('log', m)),
      engine.on('error', (e) => void this.onEngineError(e)),
    );
  }

  get state(): SupervisorState {
    return this._state;
  }

  get stats(): SupervisorStats {
    const live = this.listeningSince !== undefined ? Date.now() - this.listeningSince : 0;
    return {
      recoveries: this.recoveries,
      failures: this.failureTimes.length,
      activeListeningMs: this.activeMs + live,
    };
  }

  on<K extends Name>(event: K, cb: (payload: SupervisorEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb as (p: never) => void);
    return () => set.delete(cb as (p: never) => void);
  }

  private emit<K extends Name>(event: K, payload: SupervisorEvents[K]) {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        (cb as (p: SupervisorEvents[K]) => void)(payload);
      } catch (e) {
        console.error('[stt] listener error', e);
      }
    }
  }

  private setState(next: SupervisorState) {
    if (this._state === next) return;
    const now = Date.now();
    if (this._state === 'LISTENING' && this.listeningSince !== undefined) {
      this.activeMs += now - this.listeningSince;
      this.listeningSince = undefined;
    }
    this._state = next;
    if (next === 'LISTENING') {
      this.listeningSince = now;
      this.lastFrameAt = now;
    }
    this.emit('supervisorState', next);
    // 엔진 상태 이벤트와 같은 이름으로도 내보낸다(UI가 SttState만 보고 싶을 때)
    if (next !== 'RECOVERING' && next !== 'DISCONNECTED') this.emit('state', next);
  }

  async isSupported() {
    return this.engine.isSupported();
  }

  async prepare(onProgress?: (p: PrepareProgress) => void): Promise<void> {
    this.setState('PREPARING');
    try {
      await this.engine.prepare(onProgress);
      this.setState('READY');
    } catch (e) {
      this.setState('ERROR');
      this.emit('error', { message: errMsg(e), fatal: true });
      throw e;
    }
  }

  async start(opts: StartOptions = {}): Promise<void> {
    this.startOpts = opts;
    this.wantListening = true;
    this.failureTimes = [];
    this.md?.addEventListener('devicechange', this.deviceChangeHandler);
    try {
      await this.engine.start(opts);
    } catch (e) {
      await this.recover(`start 실패: ${errMsg(e)}`);
      return;
    }
    this.setState('LISTENING');
    this.armWatchdog();
  }

  async stop(): Promise<void> {
    this.wantListening = false;
    this.disarmWatchdog();
    this.md?.removeEventListener('devicechange', this.deviceChangeHandler);
    try {
      await this.engine.stop();
    } finally {
      if (this._state !== 'ERROR') this.setState('STOPPED');
    }
  }

  dispose(): void {
    this.disarmWatchdog();
    this.md?.removeEventListener('devicechange', this.deviceChangeHandler);
    for (const off of this.offs) off();
    this.offs = [];
    this.wantListening = false;
  }

  private armWatchdog() {
    this.disarmWatchdog();
    const every = Math.max(50, Math.min(500, Math.floor(this.o.watchdogMs / 4)));
    this.watchdog = setInterval(() => {
      if (this._state !== 'LISTENING' || this.busy) return;
      if (Date.now() - this.lastFrameAt >= this.o.watchdogMs) {
        void this.recover(`오디오 프레임 없음 ${this.o.watchdogMs}ms`);
      }
    }, every);
  }

  private disarmWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async onEngineError(e: SttError) {
    this.emit('error', e);
    if (!this.wantListening || this.busy) return;
    if (e.fatal) {
      await this.giveUp(e.message);
      return;
    }
    await this.recover(e.message);
  }

  private async giveUp(_message: string) {
    this.wantListening = false;
    this.disarmWatchdog();
    this.setState('ERROR');
    try {
      await this.engine.stop();
    } catch {
      /* 이미 오류 상태 */
    }
    this.setState('ERROR');
  }

  /** 실패 1회를 기록하고, 한도 미만이면 stop → 대기 → start 로 복구한다. 재시작이 또 실패하면 같은 규칙으로 반복한다 */
  private async recover(reason: string): Promise<void> {
    if (this.busy || !this.wantListening) return;
    this.busy = true;
    try {
      let why = reason;
      for (;;) {
        const now = Date.now();
        this.failureTimes = this.failureTimes.filter((t) => now - t < this.o.failureWindowMs);
        this.failureTimes.push(now);
        if (this.failureTimes.length >= this.o.maxFailures) {
          this.emit('error', {
            message: `${Math.round(this.o.failureWindowMs / 1000)}초 안에 ${this.failureTimes.length}번 실패해 음성인식을 멈춥니다 (${why})`,
            code: 'too-many-failures',
            fatal: true,
          });
          await this.giveUp(why);
          return;
        }
        this.recoveries++;
        this.setState('RECOVERING');
        this.emit('recovery', { reason: why, count: this.recoveries });
        this.disarmWatchdog();
        try {
          await this.engine.stop();
        } catch {
          /* 멈추다 실패해도 다시 시작을 시도한다 */
        }
        await sleep(this.o.restartDelayMs);
        if (!this.wantListening) return;
        try {
          await this.engine.start(this.startOpts);
        } catch (e) {
          why = `재시작 실패: ${errMsg(e)}`;
          continue;
        }
        this.setState('LISTENING');
        this.armWatchdog();
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private async onDeviceChange() {
    if (!this.wantListening) return;
    const mics = await listMicrophones(this.md as Pick<MediaDevices, 'enumerateDevices'>).catch(
      () => undefined,
    );
    if (!mics) return;
    const id = this.startOpts.deviceId;
    const present = id ? mics.some((m) => m.deviceId === id) : mics.length > 0;
    if (!present && this._state !== 'DISCONNECTED') {
      this.busy = true; // 감시·복구가 끼어들지 못하게 한다
      this.disarmWatchdog();
      this.setState('DISCONNECTED');
      try {
        await this.engine.stop();
      } catch {
        /* 장치가 이미 사라졌다 */
      } finally {
        this.busy = false;
      }
    } else if (present && this._state === 'DISCONNECTED') {
      // 돌아오면 이어서 듣는다. 실패 한도는 처음부터 센다
      this.failureTimes = [];
      this.busy = true;
      try {
        await this.engine.start(this.startOpts);
        this.setState('LISTENING');
        this.armWatchdog();
      } catch (e) {
        this.busy = false;
        await this.recover(`마이크 복귀 후 시작 실패: ${errMsg(e)}`);
      } finally {
        this.busy = false;
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
