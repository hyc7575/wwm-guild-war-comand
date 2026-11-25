import { DEFAULT_DICTIONARY, parse, type ParseResult } from '@winds/parser';
import { makeDefaultParties } from '@winds/protocol';
import {
  FakeEngine,
  MODEL_K2FSA_KO_2024,
  MODEL_KO_72M,
  SherpaOnnxEngine,
  SttSupervisor,
  WebSpeechEngine,
  statusLabel,
  type PrepareProgress,
  type SttEngine,
  type SupervisorState,
} from '@winds/stt';
import { decodeTo16kMono } from './audio-file';
import { baseName, cer, toGoldenJsonl, type EvalCaseIn, type EvalRowOut } from './metrics';

export type EngineKey = 'fake' | 'web-speech' | 'sherpa-72m' | 'sherpa-k2';
export const ENGINE_LABELS: Record<EngineKey, string> = {
  fake: 'Fake (텍스트 주입)',
  'web-speech': 'Web Speech (온디바이스)',
  'sherpa-72m': 'sherpa-onnx 72M (kangkyu chunk-16 int8)',
  'sherpa-k2': 'sherpa-onnx k2-fsa 2024-06-16 (비교 기준)',
};

export interface Row {
  id: number;
  at: number;
  kind: 'final';
  text: string;
  /** final 수신 시각 - endedAt */
  latencyMs: number;
  parse: string[];
}

export interface MemSample {
  at: number;
  usedMB?: number;
  totalMB?: number;
  wasmHeapMB?: number;
}

export interface BenchState {
  engineKey: EngineKey;
  support?: { ok: boolean; reason?: string };
  status: SupervisorState;
  statusText: string;
  progress?: PrepareProgress;
  partial: string;
  rows: Row[];
  level: number;
  chunks: number;
  audioMs: number;
  decodeMs: number;
  recoveries: number;
  activeListeningMs: number;
  mem: MemSample[];
  logs: string[];
  error?: string;
  evalRunning?: string;
  evalOut?: string;
}

const PARTIES = makeDefaultParties(5);

export function parseText(
  text: string,
  lastVoice?: Parameters<typeof parse>[1]['lastVoiceCommand'],
): ParseResult[] {
  return parse(text, {
    parties: PARTIES,
    dictionary: DEFAULT_DICTIONARY,
    now: Date.now(),
    lastVoiceCommand: lastVoice,
  });
}

export function summarize(r: ParseResult): string {
  const loc = (l?: { label?: string; id?: string }) => (l ? ` @${l.label ?? l.id}` : '');
  switch (r.kind) {
    case 'ISSUE': {
      const t = r.draft.target.kind === 'ALL' ? '전체' : r.draft.target.partyIds.join(',');
      return `ISSUE/${r.confidence} 대상=${t} 행동=${r.draft.action}${loc(r.draft.location)}`;
    }
    case 'CORRECT':
      return `CORRECT/${r.confidence} ${JSON.stringify(r.patch)}`;
    case 'CANCEL':
      return 'CANCEL';
    case 'NONE':
      return `NONE (${r.reason})`;
  }
}

function makeEngine(key: EngineKey): SttEngine {
  switch (key) {
    case 'fake':
      return new FakeEngine({ exposeGlobal: true });
    case 'web-speech':
      return new WebSpeechEngine();
    case 'sherpa-72m':
      return new SherpaOnnxEngine({ model: MODEL_KO_72M });
    case 'sherpa-k2':
      return new SherpaOnnxEngine({ model: MODEL_K2FSA_KO_2024 });
  }
}

declare global {
  interface Window {
    __windsBench?: Bench;
  }
}

/** 벤치 로직(React 밖). Playwright 스모크가 window.__windsBench 로 상태를 읽는다 */
export class Bench {
  state: BenchState;
  engine!: SttEngine;
  sup!: SttSupervisor;
  deviceId?: string;
  private subs = new Set<() => void>();
  private rowSeq = 0;
  private memTimer: ReturnType<typeof setInterval> | undefined;
  private offs: (() => void)[] = [];
  private lastVoice: Parameters<typeof parse>[1]['lastVoiceCommand'];
  /** 스모크용 카운터 */
  counts = { partial: 0, final: 0, level: 0, metrics: 0, error: 0 };

  constructor() {
    this.state = {
      engineKey: 'fake',
      status: 'IDLE',
      statusText: statusLabel('IDLE'),
      partial: '',
      rows: [],
      level: 0,
      chunks: 0,
      audioMs: 0,
      decodeMs: 0,
      recoveries: 0,
      activeListeningMs: 0,
      mem: [],
      logs: [],
    };
    this.setEngine('fake');
    if (typeof window !== 'undefined') window.__windsBench = this;
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  private set(p: Partial<BenchState>) {
    this.state = { ...this.state, ...p };
    for (const f of this.subs) f();
  }
  private log(s: string) {
    const line = `${new Date().toLocaleTimeString()} ${s}`;
    this.set({ logs: [...this.state.logs.slice(-199), line] });
  }

  async setEngine(key: EngineKey) {
    await this.teardown();
    this.engine = makeEngine(key);
    this.sup = new SttSupervisor(this.engine);
    this.counts = { partial: 0, final: 0, level: 0, metrics: 0, error: 0 };
    this.set({
      engineKey: key,
      support: undefined,
      progress: undefined,
      partial: '',
      rows: [],
      level: 0,
      chunks: 0,
      audioMs: 0,
      decodeMs: 0,
      recoveries: 0,
      activeListeningMs: 0,
      error: undefined,
      status: 'IDLE',
      statusText: statusLabel('IDLE'),
    });
    const s = this.sup;
    this.offs.push(
      s.on('supervisorState', (st) => {
        this.set({ status: st, statusText: statusLabel(st) });
        this.log(`상태 -> ${st}`);
        this.sample();
      }),
      s.on('partial', (p) => {
        this.counts.partial++;
        this.set({ partial: p.text });
      }),
      s.on('final', (f) => {
        this.counts.final++;
        const now = Date.now();
        const results = parseText(f.text, this.lastVoice);
        const row: Row = {
          id: ++this.rowSeq,
          at: now,
          kind: 'final',
          text: f.text,
          latencyMs: Math.max(0, now - f.endedAt),
          parse: results.map(summarize),
        };
        this.set({ rows: [row, ...this.state.rows].slice(0, 200), partial: '' });
      }),
      s.on('level', (l) => {
        this.counts.level++;
        this.set({ level: l, activeListeningMs: this.sup.stats.activeListeningMs });
      }),
      s.on('metrics', (m) => {
        this.counts.metrics++;
        this.set({
          chunks: this.state.chunks + 1,
          audioMs: this.state.audioMs + m.audioMs,
          decodeMs: this.state.decodeMs + m.decodeMs,
        });
      }),
      s.on('log', (m) => this.log(m)),
      s.on('error', (e) => {
        this.counts.error++;
        this.set({ error: e.message });
        this.log(`오류(${e.fatal ? '치명' : '복구 시도'}): ${e.message}`);
      }),
      s.on('recovery', (r) => {
        this.set({ recoveries: r.count });
        this.log(`자동 복구 #${r.count}: ${r.reason}`);
      }),
    );
  }

  private async teardown() {
    for (const o of this.offs) o();
    this.offs = [];
    if (this.memTimer) clearInterval(this.memTimer);
    this.memTimer = undefined;
    if (this.sup) {
      try {
        await this.sup.stop();
      } catch {
        /* ignore */
      }
      this.sup.dispose();
    }
    if (this.engine instanceof SherpaOnnxEngine) await this.engine.dispose();
  }

  async checkSupport() {
    const r = await this.sup.isSupported();
    this.set({ support: r });
    this.log(`isSupported: ${r.ok ? 'OK' : 'NO'}${r.reason ? ` - ${r.reason}` : ''}`);
    return r;
  }

  /** 사용자 클릭에서 호출해야 한다(Web Speech install) */
  async prepare() {
    this.set({ error: undefined, progress: undefined });
    const t0 = performance.now();
    try {
      await this.sup.prepare((p) => this.set({ progress: p }));
      this.log(`prepare 완료 ${Math.round(performance.now() - t0)}ms`);
      if (this.engine instanceof SherpaOnnxEngine)
        this.log(
          `WASM 힙 ${(this.engine.heapBytes / 1048576).toFixed(0)}MB, init ${this.engine.initMs}ms`,
        );
    } catch (e) {
      this.log(`prepare 실패: ${(e as Error).message}`);
    }
    this.sample();
  }

  async start() {
    this.set({ error: undefined });
    await this.sup.start({ deviceId: this.deviceId });
    this.sample();
    if (!this.memTimer) this.memTimer = setInterval(() => this.sample(), 60_000);
  }

  async stop() {
    await this.sup.stop();
    this.set({
      recoveries: this.sup.stats.recoveries,
      activeListeningMs: this.sup.stats.activeListeningMs,
    });
    if (this.memTimer) clearInterval(this.memTimer);
    this.memTimer = undefined;
  }

  async injectFake(text: string) {
    if (this.engine instanceof FakeEngine) await this.engine.inject(text, { partialSteps: 2 });
  }

  sample() {
    const pm = (
      performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    ).memory;
    const m: MemSample = {
      at: Date.now(),
      usedMB: pm ? pm.usedJSHeapSize / 1048576 : undefined,
      totalMB: pm ? pm.totalJSHeapSize / 1048576 : undefined,
      wasmHeapMB:
        this.engine instanceof SherpaOnnxEngine ? this.engine.heapBytes / 1048576 : undefined,
    };
    this.set({ mem: [...this.state.mem.slice(-59), m] });
  }

  /** 파일로 평가: 케이스(JSONL)와 사용자가 고른 오디오 파일들 */
  async evaluate(cases: EvalCaseIn[], audioFiles: File[]): Promise<string> {
    const rows: EvalRowOut[] = [];
    const byName = new Map(audioFiles.map((f) => [f.name, f]));
    const sherpa = this.engine instanceof SherpaOnnxEngine ? this.engine : undefined;
    let i = 0;
    for (const c of cases) {
      i++;
      this.set({ evalRunning: `${i}/${cases.length} ${c.id ?? ''}` });
      const { audioUrl, ...rest } = c;
      let text = c.text ?? '';
      const out: EvalRowOut = { ...rest, text, expect: c.expect };
      if (audioUrl) {
        if (!sherpa) throw new Error('오디오 평가는 sherpa-onnx 엔진을 선택하고 준비해야 합니다');
        const file = byName.get(baseName(audioUrl));
        const buf = file ? await file.arrayBuffer() : await (await fetch(audioUrl)).arrayBuffer();
        const { samples, sampleRate } = await decodeTo16kMono(buf);
        const r = await sherpa.transcribeFile(samples, sampleRate);
        if (c.text !== undefined) {
          out.ref = c.text;
          out.cer = cer(c.text, r.text);
        }
        out.text = r.text;
        out.stt = {
          engine: sherpa.id,
          audioMs: Math.round(r.audioMs),
          decodeMs: Math.round(r.decodeMs),
          rtf: Number(r.rtf.toFixed(3)),
        };
        out.audioUrl = audioUrl;
      }
      rows.push(out);
    }
    const jsonl = toGoldenJsonl(rows);
    this.set({ evalRunning: undefined, evalOut: jsonl });
    this.log(`파일 평가 완료: ${rows.length}건`);
    return jsonl;
  }

  async dispose() {
    await this.teardown();
    if (typeof window !== 'undefined' && window.__windsBench === this) delete window.__windsBench;
  }
}
