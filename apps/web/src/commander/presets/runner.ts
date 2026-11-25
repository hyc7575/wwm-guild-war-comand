import type { Party } from '@winds/protocol';
import { LIMITS } from '@winds/protocol';
import type { ManualDraft } from '../console/ConsoleController';
import type { AckInfo } from '../console/IssueTracker';
import { describeDraft } from '../labels';
import type { Preset, PresetStep } from './schema';

export type StepStatus = 'WAITING' | 'SENT' | 'OK' | 'FAILED' | 'SKIPPED' | 'CANCELLED';

export interface StepResult {
  index: number;
  status: StepStatus;
  /** What was (or will be) issued, e.g. "3파티 방어 우측". */
  label: string;
  /** Skip reason or ack error code. */
  reason?: string;
  /** Parties of the step that do not exist now (part of the step still went out). */
  missing?: number[];
  commandId?: string;
}

export interface PresetRun {
  id: number;
  presetName: string;
  steps: StepResult[];
  cancelled: boolean;
}

export interface RunnerDeps {
  getParties(): Party[];
  issue(d: ManualDraft, onAck: (ack: AckInfo) => void): string;
  cancel(commandId: string): string;
  /** True when the command is still live (not already cancelled), so a preset cancel skips dead ones. */
  isCancellable?(commandId: string): boolean;
  /** Gap between two sends. The server allows commanderRatePerSec; the default stays under it with margin. */
  intervalMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  now?: () => number;
}

/** 5/sec limit -> 250ms keeps 4/sec, so 12 parties take ~2.75s and other manual commands still fit in the bucket. */
export const DEFAULT_STEP_INTERVAL_MS = Math.ceil(1000 / (LIMITS.commanderRatePerSec - 1));
const MAX_RUNS = 5;

type Task = { run: PresetRun; index: number; kind: 'issue'; step: PresetStep } | { run: PresetRun; index: number; kind: 'cancel'; commandId: string };

/**
 * Sends the steps of a preset one by one as ordinary command.issue (no protocol change), spaced out so
 * a 12-party preset does not trip RATE_LIMITED. Party numbers are resolved at send time.
 */
export class PresetRunner {
  private runs: PresetRun[] = [];
  private queue: Task[] = [];
  private timer: unknown = null;
  private lastSendAt = -Infinity;
  private nextRunId = 1;
  private listeners = new Set<() => void>();
  private version = 0;
  private readonly interval: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly now: () => number;
  /** Steps of each run, by run id (kept to retry). */
  private readonly stepsOf = new Map<number, PresetStep[]>();

  constructor(private readonly d: RunnerDeps) {
    this.interval = d.intervalMs ?? DEFAULT_STEP_INTERVAL_MS;
    this.setT = d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = d.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = d.now ?? (() => Date.now());
  }

  start(preset: Preset): PresetRun {
    const parties = this.d.getParties();
    const run: PresetRun = {
      id: this.nextRunId++,
      presetName: preset.name || '이름 없음',
      cancelled: false,
      steps: preset.steps.map((s, index) => ({ index, status: 'WAITING', label: previewLabel(s, parties) })),
    };
    this.runs = [...this.runs, run].slice(-MAX_RUNS);
    this.stepsOf.set(run.id, preset.steps);
    for (const key of [...this.stepsOf.keys()]) if (!this.runs.some((r) => r.id === key)) this.stepsOf.delete(key);
    preset.steps.forEach((step, index) => this.queue.push({ run, index, kind: 'issue', step }));
    this.changed();
    this.pump();
    return run;
  }

  latest(): PresetRun | undefined {
    return this.runs[this.runs.length - 1];
  }

  getRuns(): PresetRun[] {
    return this.runs;
  }

  /** Re-sends the steps of a run that failed (ack error). Skipped steps are not retried: their parties are still missing. */
  retryFailed(runId: number): void {
    const run = this.runs.find((r) => r.id === runId);
    const steps = this.stepsOf.get(runId);
    if (!run || !steps || run.cancelled) return;
    let any = false;
    for (const r of run.steps) {
      if (r.status !== 'FAILED') continue;
      this.setStep(run, r.index, { status: 'WAITING', reason: undefined, commandId: undefined });
      this.queue.push({ run, index: r.index, kind: 'issue', step: steps[r.index]! });
      any = true;
    }
    if (any) {
      this.changed();
      this.pump();
    }
  }

  /**
   * 프리셋 취소: drops steps not yet sent and cancels the commands the run already issued.
   * Steps whose ack has not arrived yet are cancelled when it does (see onAck).
   */
  cancelRun(runId: number): void {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.cancelled) return;
    run.cancelled = true;
    this.queue = this.queue.filter((t) => {
      if (t.run !== run || t.kind !== 'issue') return true;
      this.setStep(run, t.index, { status: 'CANCELLED' });
      return false;
    });
    for (const r of run.steps) {
      if (r.status === 'OK' && r.commandId) this.enqueueCancel(run, r);
    }
    this.changed();
    this.pump();
  }

  private enqueueCancel(run: PresetRun, r: StepResult): void {
    if (this.d.isCancellable && !this.d.isCancellable(r.commandId!)) {
      this.setStep(run, r.index, { status: 'CANCELLED' });
      return;
    }
    this.queue.push({ run, index: r.index, kind: 'cancel', commandId: r.commandId! });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Snapshot identity changes on every update (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  dispose(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    this.queue = [];
    this.listeners.clear();
  }

  // ---------- internals ----------

  private changed(): void {
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }

  private setStep(run: PresetRun, index: number, patch: Partial<StepResult>): void {
    run.steps = run.steps.map((s) => (s.index === index ? { ...s, ...patch } : s));
  }

  private pump(): void {
    if (this.timer !== null || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastSendAt + this.interval - this.now());
    this.timer = this.setT(() => {
      this.timer = null;
      this.sendNext();
    }, wait);
  }

  private sendNext(): void {
    const task = this.queue.shift();
    if (!task) return;
    if (task.kind === 'cancel') {
      this.lastSendAt = this.now();
      this.d.cancel(task.commandId);
      this.setStep(task.run, task.index, { status: 'CANCELLED' });
    } else {
      const sent = this.sendStep(task.run, task.index, task.step);
      if (sent) this.lastSendAt = this.now();
    }
    this.changed();
    this.pump();
  }

  /** Returns true when a request actually left (skipped steps cost no rate budget). */
  private sendStep(run: PresetRun, index: number, step: PresetStep): boolean {
    const parties = this.d.getParties();
    const byNumber = new Map(parties.map((p) => [p.number, p]));
    let target: ManualDraft['target'];
    let missing: number[] = [];
    if (step.all) target = { kind: 'ALL' };
    else {
      const found = step.parties.flatMap((n) => (byNumber.has(n) ? [byNumber.get(n)!.id] : []));
      missing = step.parties.filter((n) => !byNumber.has(n));
      if (found.length === 0) {
        const reason = step.parties.length === 0 ? '대상 없음, 건너뜀' : `${missing.join('·')}파티 없음, 건너뜀`;
        this.setStep(run, index, { status: 'SKIPPED', reason });
        return false;
      }
      target = { kind: 'PARTIES', partyIds: found };
    }
    const support = (step.supportParties ?? []).flatMap((n) => (byNumber.has(n) ? [byNumber.get(n)!.id] : []));
    const draft: ManualDraft = {
      target,
      action: step.action,
      ...(step.location ? { location: step.location } : {}),
      ...(step.action === 'SUPPORT' && support.length ? { supportPartyIds: support } : {}),
    };
    this.setStep(run, index, { status: 'SENT', label: describeDraft(draft, parties), missing: missing.length ? missing : undefined });
    this.d.issue(draft, (ack) => this.onAck(run, index, ack));
    return true;
  }

  private onAck(run: PresetRun, index: number, ack: AckInfo): void {
    if (ack.error) this.setStep(run, index, { status: run.cancelled ? 'CANCELLED' : 'FAILED', reason: ack.error });
    else {
      this.setStep(run, index, { status: 'OK', commandId: ack.commandId });
      // The run was cancelled while this step was in flight: take it back.
      if (run.cancelled && ack.commandId) this.enqueueCancel(run, run.steps.find((s) => s.index === index)!);
    }
    this.changed();
    this.pump();
  }
}

function previewLabel(step: PresetStep, parties: Party[]): string {
  const head = step.all ? '전체' : step.parties.length ? `${step.parties.join('·')}파티` : '대상 없음';
  const draft = { target: { kind: 'ALL' as const }, action: step.action, location: step.location, supportPartyIds: [] as string[] };
  const tail = describeDraft(draft, parties).replace(/^전체 /, '');
  const sup = step.action === 'SUPPORT' && step.supportParties?.length ? `→${step.supportParties.join('·')}파티` : '';
  return `${head} ${tail}${sup}`.trim();
}
