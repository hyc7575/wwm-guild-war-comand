import type { SttState } from '@winds/protocol';
import { classifyError, toServerState, type ErrorKind, type UiSttState } from './status';

type Stt = typeof import('@winds/stt');
type MicInfo = { deviceId: string; label: string };
type Supervisor = InstanceType<Stt['SttSupervisor']>;

/** The lib is loaded on demand so the member bundle (and the commander entry) never contain it. */
export const loadStt = (): Promise<Stt> => import('@winds/stt');

export type EngineChoice = 'sherpa-72m' | 'web-speech' | 'fake';
export const ENGINE_OPTIONS: Array<{ value: EngineChoice; label: string }> = [
  { value: 'sherpa-72m', label: 'sherpa-onnx 72M (기본)' },
  { value: 'web-speech', label: 'Chrome 온디바이스' },
  { value: 'fake', label: '가짜 엔진 (개발용)' },
];
const ENGINE_KEY = 'winds.stt.engine';

export interface SttSnapshot {
  engine: EngineChoice;
  state: UiSttState;
  progress?: { phase: string; loaded: number; total: number };
  level: number;
  partial: string;
  lastFinal?: { text: string; at: number };
  recoveries: number;
  error?: string;
  errorKind?: ErrorKind;
  /** The commander reloaded while STT was running: offer the big restart button. */
  needsRestart: boolean;
  /** Set when STT was stopped by the app: "다른 탭에서 열렸습니다" / "방이 종료되었습니다". */
  halted?: 'replaced' | 'closed';
  busy: boolean;
  mics: MicInfo[];
  deviceId?: string;
}

export interface SttControllerOptions {
  roomKey: string;
  sink: { onFinal(text: string, o: { endedAt: number }): void; onPartial(text: string): void };
  /** Called when the mapped server state changes (and on `resendState`). */
  onServerState(s: SttState): void;
  load?: () => Promise<Stt>;
  allowFake?: boolean;
  initialEngine?: EngineChoice;
  session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  local?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
}

function safeStorage(kind: 'sessionStorage' | 'localStorage') {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
}

/** Framework-free owner of the engine + supervisor for the commander console. */
export class SttController {
  private snap: SttSnapshot;
  private subs = new Set<() => void>();
  private sup: Supervisor | undefined;
  private offs: Array<() => void> = [];
  private baseMs = 0;
  private baseRecoveries = 0;
  private lastSent: SttState | undefined;
  private stt: Stt | undefined;
  private disposed = false;
  private readonly load: () => Promise<Stt>;
  private readonly session;
  private readonly local;
  private readonly now: () => number;

  constructor(private readonly o: SttControllerOptions) {
    this.load = o.load ?? loadStt;
    this.session = o.session ?? safeStorage('sessionStorage');
    this.local = o.local ?? safeStorage('localStorage');
    this.now = o.now ?? (() => Date.now());
    let engine = o.initialEngine ?? ((this.read(this.local, ENGINE_KEY) as EngineChoice | null) || 'sherpa-72m');
    if (engine === 'fake' && !o.allowFake) engine = 'sherpa-72m';
    this.snap = {
      engine,
      state: 'IDLE',
      level: 0,
      partial: '',
      recoveries: 0,
      needsRestart: this.read(this.session, this.flagKey) === '1',
      busy: false,
      mics: [],
    };
  }

  private get flagKey() {
    return `winds.stt.running.${this.o.roomKey}`;
  }
  private read(s: Pick<Storage, 'getItem'> | undefined, k: string): string | null {
    try {
      return s?.getItem(k) ?? null;
    } catch {
      return null;
    }
  }

  // ---------- store contract ----------
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(p: Partial<SttSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const fn of [...this.subs]) fn();
  }

  /** Numbers for the session summary (sums over engine switches). */
  getStats(): { activeListeningMs: number; recoveries: number } {
    const s = this.sup?.stats;
    return {
      activeListeningMs: this.baseMs + (s?.activeListeningMs ?? 0),
      recoveries: this.baseRecoveries + (s?.recoveries ?? 0),
    };
  }

  // ---------- actions ----------
  setEngine(engine: EngineChoice): void {
    if (this.snap.busy || this.isRunning()) return;
    try {
      this.local?.setItem(ENGINE_KEY, engine);
    } catch {
      /* ignore */
    }
    this.set({ engine, error: undefined, errorKind: undefined, state: 'IDLE', progress: undefined });
  }

  setMic(deviceId: string | undefined): void {
    this.set({ deviceId });
    void this.load().then((m) => m.rememberMic(deviceId));
  }

  /** Reads the mic list (labels appear once permission was given) and the remembered mic. */
  async refreshMics(): Promise<void> {
    try {
      const m = this.stt ?? (this.stt = await this.load());
      const mics = await m.listMicrophones();
      const remembered = m.getRememberedMic();
      const deviceId = this.snap.deviceId ?? (remembered && mics.some((x) => x.deviceId === remembered) ? remembered : undefined);
      if (!this.disposed) this.set({ mics, deviceId });
    } catch {
      /* no mic API: the selector stays empty */
    }
  }

  isRunning(): boolean {
    const s = this.snap.state;
    return s === 'LISTENING' || s === 'RECOVERING' || s === 'DISCONNECTED' || s === 'PREPARING' || s === 'READY';
  }

  /** Must be called from a click handler (user gesture): Web Speech language pack install needs it. */
  async start(): Promise<void> {
    if (this.snap.busy || this.snap.state === 'LISTENING') return;
    this.set({ busy: true, error: undefined, errorKind: undefined, needsRestart: false, halted: undefined, progress: undefined, state: 'PREPARING' });
    this.emitServer();
    try {
      const stt = (this.stt ??= await this.load());
      this.teardown();
      const engine = this.makeEngine(stt);
      const sup = new stt.SttSupervisor(engine);
      this.sup = sup;
      this.wire(sup);
      const support = await sup.isSupported();
      if (!support.ok) {
        this.fail(support.reason ?? '이 브라우저에서는 쓸 수 없는 엔진입니다', 'unsupported', 'ERROR');
        return;
      }
      await sup.prepare((p) => this.set({ progress: { phase: p.phase, loaded: p.loaded, total: p.total } }));
      await sup.start(this.snap.deviceId ? { deviceId: this.snap.deviceId } : {});
      this.writeFlag(true);
      this.set({ progress: undefined });
      void this.refreshMics(); // labels are filled after the permission prompt
    } catch (e) {
      // prepare() / start() already emitted `error` through the supervisor; make sure something is visible.
      if (!this.snap.error) this.fail(e instanceof Error ? e.message : String(e), undefined, 'ERROR');
    } finally {
      this.set({ busy: false });
    }
  }

  async stop(): Promise<void> {
    this.writeFlag(false);
    await this.sup?.stop().catch(() => undefined);
    this.set({ needsRestart: false, level: 0, partial: '', state: this.snap.state === 'ERROR' ? 'ERROR' : 'STOPPED' });
    this.emitServer();
  }

  /** The room is over for this tab (another tab took over / room closed). */
  async halt(reason: 'replaced' | 'closed'): Promise<void> {
    if (this.snap.halted === reason) return;
    this.writeFlag(false);
    await this.sup?.stop().catch(() => undefined);
    this.set({ halted: reason, needsRestart: false, level: 0, partial: '', state: 'STOPPED' });
    this.emitServer();
  }

  /** After a reconnect the server may have lost our state. */
  resendState(): void {
    this.lastSent = undefined;
    this.emitServer();
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
    this.subs.clear();
  }

  // ---------- internals ----------
  private makeEngine(stt: Stt) {
    switch (this.snap.engine) {
      case 'fake':
        return new stt.FakeEngine({ exposeGlobal: true });
      case 'web-speech':
        return new stt.WebSpeechEngine();
      default:
        return new stt.SherpaOnnxEngine({ model: stt.MODEL_KO_72M });
    }
  }

  private teardown() {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.sup) {
      const s = this.sup.stats;
      this.baseMs += s.activeListeningMs;
      this.baseRecoveries += s.recoveries;
      void this.sup.stop().catch(() => undefined);
      this.sup.dispose();
      this.sup = undefined;
    }
  }

  private wire(sup: Supervisor) {
    this.offs.push(
      sup.on('supervisorState', (st) => {
        this.set({ state: st });
        this.emitServer();
      }),
      sup.on('partial', (p) => {
        this.set({ partial: p.text });
        this.o.sink.onPartial(p.text);
      }),
      sup.on('final', (f) => {
        this.set({ partial: '', lastFinal: { text: f.text, at: this.now() } });
        this.o.sink.onFinal(f.text, { endedAt: f.endedAt });
      }),
      sup.on('level', (l) => this.set({ level: l })),
      sup.on('recovery', (r) => this.set({ recoveries: this.baseRecoveries + r.count })),
      sup.on('error', (e) => {
        if (e.fatal) this.fail(e.message, classifyError(e.message, e.code), 'ERROR');
      }),
    );
  }

  private fail(message: string, kind: ErrorKind | undefined, state: UiSttState) {
    this.writeFlag(false);
    this.set({ error: message, errorKind: kind ?? classifyError(message), state });
    this.emitServer();
  }

  private emitServer() {
    const next = toServerState(this.snap.state);
    if (next === this.lastSent) return;
    this.lastSent = next;
    this.o.onServerState(next);
  }

  private writeFlag(on: boolean) {
    try {
      if (on) this.session?.setItem(this.flagKey, '1');
      else this.session?.removeItem(this.flagKey);
    } catch {
      /* ignore */
    }
  }
}
