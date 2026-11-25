/** 엔진 상태. UI 문구 매핑은 supervisor.ts 의 statusLabel 참고 */
export type SttState = 'IDLE' | 'PREPARING' | 'READY' | 'LISTENING' | 'STOPPED' | 'ERROR';

export interface SttFinal {
  text: string;
  /** 발화 시작(epoch ms). 알 수 없으면 생략 */
  startedAt?: number;
  /**
   * 발화가 끝난 시각(epoch ms). sherpa-onnx는 "마지막으로 인식 텍스트가 바뀐 시각"(= 말이 끝난 시각의 근사)이다.
   * 그래서 (final 수신 시각 - endedAt)이 엔드포인트 지연이다. Web Speech/Fake는 final 시각 그대로다.
   */
  endedAt: number;
}

export interface SttError {
  message: string;
  code?: string;
  /** true면 재시도해도 소용없다(권한 거부, 온디바이스 불가 등). Supervisor는 바로 ERROR로 멈춘다 */
  fatal: boolean;
}

export interface SttMetrics {
  /** 이번 청크의 오디오 길이(ms) */
  audioMs: number;
  /** 이번 청크 디코딩에 걸린 시간(ms) */
  decodeMs: number;
}

export interface SttEvents {
  partial: { text: string };
  final: SttFinal;
  /** 0..1 RMS 음량. 오디오 프레임이 흐르는 증거로도 쓴다(3초 감시) */
  level: number;
  state: SttState;
  error: SttError;
  /** (선택) sherpa-onnx 워커의 청크별 디코딩 시간. 벤치용 */
  metrics: SttMetrics;
  /** (선택) 진단 로그. 스모크 테스트와 벤치용 */
  log: string;
}

export type SttEventName = keyof SttEvents;

export interface PrepareProgress {
  phase: 'model' | 'wasm' | 'init';
  file?: string;
  loaded: number;
  total: number;
}

export interface SupportResult {
  ok: boolean;
  reason?: string;
}

export interface StartOptions {
  deviceId?: string;
}

export interface SttEngine {
  readonly id: string;
  readonly label: string;
  isSupported(): Promise<SupportResult>;
  /** 다운로드·캐시·초기화. Web Speech의 install()은 사용자 클릭 안에서 호출해야 한다 */
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<void>;
  start(opts?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  /** 구독 해제 함수를 돌려준다 */
  on<K extends SttEventName>(event: K, cb: (payload: SttEvents[K]) => void): () => void;
  readonly state: SttState;
}
