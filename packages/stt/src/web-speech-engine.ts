import { EngineEmitter } from './emitter';
import type { PrepareProgress, StartOptions, SttEngine, SupportResult } from './types';

// 최소 타입. TS DOM 라이브러리에 온디바이스 API가 없어서 직접 선언한다.
interface SRAlternative {
  transcript: string;
}
interface SRResult {
  isFinal: boolean;
  length: number;
  [i: number]: SRAlternative | undefined;
}
interface SRResultEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SRResult | undefined };
}
interface SRErrorEvent {
  error: string;
  message?: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((e: SRResultEvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
export type AvailabilityStatus = 'unavailable' | 'downloadable' | 'downloading' | 'available';
export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?(opts: { langs: string[]; processLocally: boolean }): Promise<AvailabilityStatus>;
  install?(opts: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
const QUIET_ERRORS = new Set(['no-speech', 'aborted']);

export interface WebSpeechOptions {
  lang?: string;
  /** 생성자를 직접 주입(테스트용). 기본 globalThis.SpeechRecognition */
  ctor?: SpeechRecognitionCtor;
  /** 마이크를 직접 열어 음량 미터를 만들고 그 트랙을 start(track)에 넘긴다. 기본 true */
  micLevel?: boolean;
  /** 재시작 backoff 시작/상한(ms) */
  restartBaseMs?: number;
  restartMaxMs?: number;
}

/**
 * Chrome/Edge 온디바이스 Web Speech 어댑터.
 * 로컬 우선 원칙: 온디바이스가 불가능하면 클라우드로 조용히 넘어가지 않고 이유를 알리며 거부한다.
 */
export class WebSpeechEngine extends EngineEmitter implements SttEngine {
  readonly id = 'web-speech';
  readonly label = 'Web Speech (온디바이스)';
  private rec: SpeechRecognitionLike | undefined;
  private running = false;
  private startedAt = 0;
  private backoff: number;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stream: MediaStream | undefined;
  private audioCtx: AudioContext | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private prepared = false;

  constructor(private opts: WebSpeechOptions = {}) {
    super();
    this.backoff = opts.restartBaseMs ?? 250;
  }

  private get lang() {
    return this.opts.lang ?? 'ko-KR';
  }
  private get ctor(): SpeechRecognitionCtor | undefined {
    return (
      this.opts.ctor ??
      (globalThis as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      undefined
    );
  }
  private get avail() {
    return { langs: [this.lang], processLocally: true };
  }

  async isSupported(): Promise<SupportResult> {
    const C = this.ctor;
    if (!C || typeof C.available !== 'function') {
      return {
        ok: false,
        reason: '이 브라우저에는 온디바이스 음성인식 API가 없습니다 (Chrome/Edge 139 이상 필요).',
      };
    }
    let status: AvailabilityStatus;
    try {
      status = await C.available(this.avail);
    } catch (e) {
      return { ok: false, reason: `온디바이스 가용성 확인 실패: ${msg(e)}` };
    }
    if (status === 'unavailable') {
      return {
        ok: false,
        reason: `${this.lang} 온디바이스 음성인식을 쓸 수 없습니다. 클라우드 인식으로는 대신하지 않습니다.`,
      };
    }
    if (status === 'available') return { ok: true };
    // 개인정보 보호 때문에 install() 전에는 설치 여부와 무관하게 downloadable이 올 수 있다
    return {
      ok: true,
      reason: `언어 팩 설치가 필요할 수 있습니다 (${status}). '준비' 버튼(사용자 클릭)에서 설치합니다.`,
    };
  }

  /** 사용자 클릭 안에서 호출해야 한다(install()이 transient activation을 요구한다) */
  async prepare(onProgress?: (p: PrepareProgress) => void): Promise<void> {
    this.setState('PREPARING');
    try {
      const sup = await this.isSupported();
      if (!sup.ok) throw new Error(sup.reason);
      const C = this.ctor as SpeechRecognitionCtor;
      const status = await C.available!(this.avail);
      if (status !== 'available') {
        if (typeof C.install !== 'function')
          throw new Error('install() API가 없어 언어 팩을 설치할 수 없습니다.');
        onProgress?.({ phase: 'model', loaded: 0, total: 1 });
        const ok = await C.install(this.avail);
        if (!ok) throw new Error(`${this.lang} 온디바이스 언어 팩 설치에 실패했습니다.`);
      }
      onProgress?.({ phase: 'model', loaded: 1, total: 1 });
      this.prepared = true;
      this.setState('READY');
    } catch (e) {
      this.setState('ERROR');
      this.emit('error', { message: msg(e), code: 'prepare-failed', fatal: true });
      throw e;
    }
  }

  async start(opts: StartOptions = {}): Promise<void> {
    if (!this.prepared) throw new Error('prepare()를 먼저 호출하세요.');
    const C = this.ctor;
    if (!C) throw new Error('SpeechRecognition 없음');
    this.clearRestart();
    this.running = true;
    this.backoff = this.opts.restartBaseMs ?? 250;
    let track: MediaStreamTrack | undefined;
    if (this.opts.micLevel !== false && globalThis.navigator?.mediaDevices) {
      try {
        track = await this.openMic(opts.deviceId);
      } catch (e) {
        this.running = false;
        const name = (e as { name?: string }).name;
        const fatal = name === 'NotAllowedError' || name === 'SecurityError';
        this.emit('error', {
          message: `마이크를 열 수 없습니다: ${msg(e)}`,
          code: name ?? 'audio-capture',
          fatal,
        });
        this.setState('ERROR');
        throw e;
      }
    }
    const rec = new C();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = true;
    if (rec.processLocally !== true) {
      // 이 브라우저가 속성을 무시한다 = 클라우드로 갈 수 있다. 거부한다.
      this.running = false;
      this.closeMic();
      const message =
        '이 브라우저는 processLocally를 지원하지 않아 클라우드 인식이 될 수 있어 중단합니다.';
      this.emit('error', { message, code: 'on-device-unsupported', fatal: true });
      this.setState('ERROR');
      throw new Error(message);
    }
    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => this.onError(e);
    rec.onend = () => this.onEnd();
    this.rec = rec;
    this.beginSession(track);
    this.setState('LISTENING');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearRestart();
    const rec = this.rec;
    this.rec = undefined;
    if (rec) {
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.stop();
      } catch {
        /* 이미 멈춤 */
      }
    }
    this.closeMic();
    if (this.state === 'LISTENING' || this.state === 'ERROR') this.setState('STOPPED');
  }

  private beginSession(track?: MediaStreamTrack) {
    const rec = this.rec;
    if (!rec) return;
    this.startedAt = Date.now();
    try {
      if (track) {
        try {
          rec.start(track);
          return;
        } catch (e) {
          if ((e as { name?: string }).name === 'InvalidStateError') throw e;
          // start(track)을 지원하지 않으면 기본 마이크로 시작
        }
      }
      rec.start();
    } catch (e) {
      if ((e as { name?: string }).name !== 'InvalidStateError')
        this.failFatal('start-failed', msg(e));
    }
  }

  private onResult(e: SRResultEvent) {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r?.[0]?.transcript ?? '';
      if (!r) continue;
      if (r.isFinal) {
        const t = text.trim();
        if (t) this.emit('final', { text: t, endedAt: Date.now() });
        this.backoff = this.opts.restartBaseMs ?? 250;
      } else {
        interim += text;
      }
    }
    if (interim) this.emit('partial', { text: interim.trim() });
  }

  private onError(e: SRErrorEvent) {
    if (QUIET_ERRORS.has(e.error)) return; // end에서 재시작한다
    if (FATAL_ERRORS.has(e.error)) {
      this.failFatal(e.error, e.message || fatalText(e.error));
      return;
    }
    // audio-capture, network 등: 우리는 재시작하지 않고 감독자(Supervisor)가 판단한다
    this.running = false;
    this.clearRestart();
    this.emit('error', {
      message: e.message || `음성인식 오류: ${e.error}`,
      code: e.error,
      fatal: false,
    });
  }

  private failFatal(code: string, message: string) {
    this.running = false;
    this.clearRestart();
    this.closeMic();
    this.emit('error', { message, code, fatal: true });
    this.setState('ERROR');
  }

  /** Chrome은 연속 모드여도 스스로 세션을 끝낸다. 사용자가 멈춘 게 아니면 backoff 후 다시 시작 */
  private onEnd() {
    if (!this.running || !this.rec) return;
    const lived = Date.now() - this.startedAt;
    if (lived < 2000) this.backoff = Math.min(this.backoff * 2, this.opts.restartMaxMs ?? 5000);
    else this.backoff = this.opts.restartBaseMs ?? 250;
    this.clearRestart();
    this.restartTimer = setTimeout(() => {
      if (!this.running || !this.rec) return;
      this.beginSession(this.stream?.getAudioTracks()[0]);
    }, this.backoff);
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private async openMic(deviceId?: string): Promise<MediaStreamTrack> {
    this.closeMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    this.stream = stream;
    const track = stream.getAudioTracks()[0] as MediaStreamTrack;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      this.levelTimer = setInterval(() => {
        if (track.readyState !== 'live') return; // 끊기면 level이 멎어 감독자의 3초 감시가 동작한다
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        this.emit('level', Math.min(1, Math.sqrt(s / buf.length) * 3));
      }, 100);
    } catch {
      /* 미터만 포기 */
    }
    return track;
  }

  private closeMic() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = undefined;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function fatalText(code: string): string {
  switch (code) {
    case 'not-allowed':
      return '마이크 권한이 거부되었습니다.';
    case 'service-not-allowed':
      return '온디바이스 음성인식 언어 팩이 없거나 사용할 수 없습니다.';
    case 'language-not-supported':
      return '이 언어는 온디바이스 음성인식을 지원하지 않습니다.';
    default:
      return `음성인식 오류: ${code}`;
  }
}
