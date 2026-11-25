import { EngineEmitter } from '../emitter';
import { ModelStore } from '../model-store';
import { DEFAULT_WASM_BASE, MODEL_KO_72M, type ModelSpec } from '../models';
import type { PrepareProgress, StartOptions, SttEngine, SupportResult } from '../types';
import { WORKER_SOURCE } from './worker-source';
import { WORKLET_NAME, WORKLET_SOURCE } from './worklet-source';

export interface SherpaOnnxOptions {
  model?: ModelSpec;
  /** 벤더 glue/wasm 위치. 기본 /vendor/sherpa-onnx/ (pnpm fetch:stt-wasm 으로 받음) */
  wasmBase?: string;
  store?: ModelStore;
  decodingMethod?: 'greedy_search' | 'modified_beam_search';
  /** 한 줄에 하나, 점수는 " :2.0". 넣으면 modified_beam_search를 쓴다 (cjkchar 모델에서만 지원) */
  hotwords?: string;
  hotwordsScore?: number;
  /** 발화 뒤 무음 길이(초). NFR-F02-2 기본 0.8 */
  endpointTrailingSilence?: number;
  /** 아무것도 인식 못 한 무음 길이(초). 기본 2.4 */
  rule1?: number;
  /** 발화 최대 길이(초). 기본 20 */
  rule3?: number;
  /** 세션 생성 뒤 MEMFS의 모델 사본을 지운다. 기본 true */
  freeModelFiles?: boolean;
  /** sherpa-onnx modelType 강제(기본: ONNX 메타데이터로 자동 판별). 예: 'zipformer', 'zipformer2' */
  modelType?: string;
  /** modelingUnit 강제(기본: 모델 명세 값) */
  modelingUnit?: 'cjkchar' | 'bpe' | 'cjkchar+bpe';
  /** wasm stderr를 log 이벤트로 내보낸다 */
  verbose?: boolean;
}

export interface TranscribeSegment {
  text: string;
  endSec: number;
}
export interface TranscribeResult {
  text: string;
  segments: TranscribeSegment[];
  audioMs: number;
  decodeMs: number;
  /** decodeMs / audioMs (낮을수록 빠름. 1 미만이어야 실시간) */
  rtf: number;
}

type WorkerMsg = { type: string; [k: string]: unknown };

export class SherpaOnnxEngine extends EngineEmitter implements SttEngine {
  readonly id: string;
  readonly label: string;
  private model: ModelSpec;
  private store: ModelStore;
  private worker: Worker | undefined;
  private urls: string[] = [];
  private ctx: AudioContext | undefined;
  private mediaStream: MediaStream | undefined;
  private node: AudioWorkletNode | undefined;
  private waiters = new Map<
    string,
    { resolve: (m: WorkerMsg) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private progressCb: ((p: PrepareProgress) => void) | undefined;
  /** 진단 로그(wasm-initialized, model-written, recognizer-created ...) */
  readonly diagnostics: string[] = [];
  initMs = 0;
  /** prepare 완료 직후 WASM 힙 크기(바이트). 메모리 비교용 */
  heapBytes = 0;
  audioChunks = 0;

  constructor(private opts: SherpaOnnxOptions = {}) {
    super();
    this.model = opts.model ?? MODEL_KO_72M;
    this.id = `sherpa:${this.model.id}`;
    this.label = this.model.label;
    this.store = opts.store ?? new ModelStore();
  }

  private get wasmBase(): string {
    const b = this.opts.wasmBase ?? DEFAULT_WASM_BASE;
    const abs = new URL(
      b.endsWith('/') ? b : `${b}/`,
      globalThis.location?.href ?? 'http://localhost/',
    ).href;
    return abs; // Blob 워커 안에서는 상대 경로가 풀리지 않으므로 절대 URL로 넘긴다
  }

  async isSupported(): Promise<SupportResult> {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')
      return { ok: false, reason: 'Web Worker/WebAssembly 미지원' };
    if (typeof AudioWorkletNode === 'undefined')
      return { ok: false, reason: 'AudioWorklet 미지원' };
    if (!globalThis.navigator?.mediaDevices?.getUserMedia)
      return { ok: false, reason: '마이크 API(getUserMedia) 없음 (HTTPS 또는 localhost 필요)' };
    if (this.opts.hotwords && !this.model.supportsHotwords)
      return {
        ok: false,
        reason: '이 모델은 bpe 핫워드(bpe.vocab)가 필요해 핫워드를 지원하지 않습니다',
      };
    try {
      const r = await fetch(`${this.wasmBase}sherpa-onnx-wasm-web.js`, { method: 'HEAD' });
      const ct = r.headers.get('content-type') ?? '';
      if (!r.ok || ct.includes('html'))
        return { ok: false, reason: 'WASM 자산이 없습니다. `pnpm fetch:stt-wasm`을 실행하세요.' };
    } catch (e) {
      return { ok: false, reason: `WASM 자산 확인 실패: ${(e as Error).message}` };
    }
    return { ok: true };
  }

  async isModelCached(): Promise<boolean> {
    return this.store.isCached(this.model);
  }

  async prepare(onProgress?: (p: PrepareProgress) => void): Promise<void> {
    if (
      this.worker &&
      (this.state === 'READY' || this.state === 'STOPPED' || this.state === 'LISTENING')
    )
      return;
    this.setState('PREPARING');
    this.progressCb = onProgress;
    try {
      const sup = await this.isSupported();
      if (!sup.ok) throw new Error(sup.reason);
      const files = await this.store.load(this.model, (p) =>
        onProgress?.({ phase: 'model', file: p.file, loaded: p.loaded, total: p.total }),
      );
      const worker = this.spawnWorker();
      const ready = new Promise<void>(
        (resolve, reject) => (this.readyWaiter = { resolve, reject }),
      );
      const list = this.model.files.map((f) => ({
        role: f.role,
        name: f.name,
        data: files[f.name] as ArrayBuffer,
      }));
      worker.postMessage(
        {
          type: 'init',
          wasmBase: this.wasmBase,
          files: list,
          modelingUnit: this.opts.modelingUnit ?? this.model.modelingUnit,
          decodingMethod: this.opts.decodingMethod,
          hotwords: this.opts.hotwords,
          hotwordsScore: this.opts.hotwordsScore,
          rule1: this.opts.rule1 ?? 2.4,
          rule2: this.opts.endpointTrailingSilence ?? 0.8,
          rule3: this.opts.rule3 ?? 20,
          freeModelFiles: this.opts.freeModelFiles,
          verbose: this.opts.verbose,
          modelType: this.opts.modelType,
        },
        list.map((f) => f.data), // 복사 없이 넘긴다
      );
      await ready;
      onProgress?.({ phase: 'init', loaded: 1, total: 1 });
      this.setState('READY');
    } catch (e) {
      this.terminateWorker();
      this.setState('ERROR');
      this.emit('error', { message: (e as Error).message, code: 'prepare-failed', fatal: true });
      throw e;
    }
  }

  async start(opts: StartOptions = {}): Promise<void> {
    if (
      !this.worker ||
      (this.state !== 'READY' && this.state !== 'STOPPED' && this.state !== 'ERROR')
    ) {
      throw new Error(`start()는 READY/STOPPED 상태에서만 가능합니다 (현재 ${this.state})`);
    }
    try {
      await this.openAudio(opts.deviceId);
      this.worker.postMessage({ type: 'start' });
      this.setState('LISTENING');
    } catch (e) {
      this.closeAudio();
      const name = (e as { name?: string }).name;
      const fatal = name === 'NotAllowedError' || name === 'SecurityError';
      this.emit('error', {
        message: `마이크 시작 실패: ${(e as Error).message}`,
        code: name,
        fatal,
      });
      this.setState('ERROR');
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.state !== 'LISTENING' && this.state !== 'ERROR') return;
    this.closeAudio();
    if (this.worker) {
      try {
        await this.request({ type: 'stop' }, 'stopped', 3000);
      } catch {
        /* 워커가 응답하지 않아도 오디오는 닫았다 */
      }
    }
    this.setState('STOPPED');
  }

  /** 이미 있는 PCM(Float32, [-1,1])을 스트리밍 인식해 결과를 돌려준다. 벤치/골든 평가용 */
  async transcribeFile(
    samples: Float32Array,
    sampleRate: number,
    onProgress?: (done: number) => void,
  ): Promise<TranscribeResult> {
    if (!this.worker || this.state === 'IDLE' || this.state === 'PREPARING')
      throw new Error('prepare()를 먼저 호출하세요');
    const copy = samples.slice(); // 호출자의 배열을 detach하지 않는다
    const id = `t${++this.seq}`;
    const off = onProgress ? this.progressListeners.add(id, onProgress) : undefined;
    try {
      const m = await this.request(
        { type: 'transcribe', samples: copy, sampleRate, id },
        'transcribed',
        10 * 60_000,
        [copy.buffer],
        id,
      );
      return m.result as TranscribeResult;
    } finally {
      off?.();
    }
  }

  async dispose(): Promise<void> {
    this.closeAudio();
    this.terminateWorker();
    this.setState('IDLE');
  }

  // ---- 내부 ----

  private progressListeners = {
    map: new Map<string, (d: number) => void>(),
    add: (id: string, cb: (d: number) => void) => {
      this.progressListeners.map.set(id, cb);
      return () => void this.progressListeners.map.delete(id);
    },
  };

  private spawnWorker(): Worker {
    this.terminateWorker();
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    this.urls.push(url);
    const w = new Worker(url); // 클래식 워커: importScripts 사용
    w.onmessage = (e: MessageEvent<WorkerMsg>) => this.onWorker(e.data);
    w.onerror = (e) => {
      const message = `워커 오류: ${e.message || '알 수 없음'}`;
      this.readyWaiter?.reject(new Error(message));
      this.readyWaiter = undefined;
      this.emit('error', { message, code: 'worker-error', fatal: false });
    };
    this.worker = w;
    return w;
  }

  private terminateWorker() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    for (const w of this.waiters.values()) w.reject(new Error('worker terminated'));
    this.waiters.clear();
  }

  private onWorker(m: WorkerMsg) {
    switch (m.type) {
      case 'progress':
        this.progressCb?.({
          phase: m.phase as 'wasm',
          file: m.file as string,
          loaded: m.loaded as number,
          total: m.total as number,
        });
        break;
      case 'log':
        this.diagnostics.push(m.message as string);
        this.emit('log', m.message as string);
        break;
      case 'ready':
        this.initMs = m.initMs as number;
        this.heapBytes = m.heapBytes as number;
        this.readyWaiter?.resolve();
        this.readyWaiter = undefined;
        break;
      case 'partial':
        this.emit('partial', { text: m.text as string });
        break;
      case 'final':
        this.emit('final', {
          text: m.text as string,
          startedAt: m.startedAt as number | undefined,
          endedAt: m.endedAt as number,
        });
        break;
      case 'metrics':
        this.emit('metrics', { audioMs: m.audioMs as number, decodeMs: m.decodeMs as number });
        break;
      case 'transcribe-progress':
        this.progressListeners.map.get(m.id as string)?.(m.done as number);
        break;
      case 'stopped':
      case 'transcribed': {
        const key = (m.id as string | undefined) ?? m.type;
        this.waiters.get(key)?.resolve(m);
        this.waiters.delete(key);
        break;
      }
      case 'error': {
        const err = new Error(m.message as string);
        if (this.readyWaiter && m.phase === 'init') {
          this.readyWaiter.reject(err);
          this.readyWaiter = undefined;
        } else if (m.id && this.waiters.has(m.id as string)) {
          this.waiters.get(m.id as string)?.reject(err);
          this.waiters.delete(m.id as string);
        } else {
          this.emit('error', { message: err.message, code: 'worker', fatal: false });
        }
        break;
      }
    }
  }

  private request(
    msg: Record<string, unknown>,
    _reply: string,
    timeoutMs: number,
    transfer: Transferable[] = [],
    id?: string,
  ): Promise<WorkerMsg> {
    const key = id ?? (_reply === 'stopped' ? 'stopped' : _reply);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`${msg.type as string} 응답 시간 초과`));
      }, timeoutMs);
      this.waiters.set(key, {
        resolve: (m) => (clearTimeout(t), resolve(m)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.worker?.postMessage(msg, transfer);
    });
  }

  private async openAudio(deviceId?: string) {
    this.closeAudio();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    this.mediaStream = stream;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      ctx = new AudioContext(); // 이 샘플레이트를 거부하면 워클릿이 16kHz로 리샘플한다
    }
    this.ctx = ctx;
    this.emit(
      'log',
      `AudioContext sampleRate=${ctx.sampleRate}${ctx.sampleRate === 16000 ? '' : ' (워클릿 리샘플)'}`,
    );
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { chunkSamples: 1600 },
    });
    this.node = node;
    this.audioChunks = 0;
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    this.worker?.postMessage({ type: 'audio-port', port: ch.port2 }, [ch.port2]);
    node.port.onmessage = (e: MessageEvent<{ level?: number }>) => {
      if (typeof e.data.level === 'number') {
        this.audioChunks++;
        this.emit('level', Math.min(1, e.data.level * 3));
      }
    };
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination); // 연결돼 있어야 process()가 돈다
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private closeAudio() {
    try {
      this.node?.port.postMessage({ stop: true });
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    this.node = undefined;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = undefined;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }
}
