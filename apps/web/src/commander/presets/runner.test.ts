import { describe, expect, it, vi } from 'vitest';
import { makeDefaultParties } from '@winds/protocol';
import type { AckInfo } from '../console/IssueTracker';
import type { ManualDraft } from '../console/ConsoleController';
import { NEWER_COMMAND_REASON, PresetRunner, partiesWithNewerForeignCommand } from './runner';
import type { Preset } from './schema';

function setup(partyCount = 3, intervalMs = 250) {
  let t = 0;
  let parties = makeDefaultParties(partyCount);
  const timers: Array<{ at: number; fn: () => void }> = [];
  const issued: Array<{ at: number; d: ManualDraft; ack: (a: AckInfo) => void }> = [];
  const cancelled: Array<{ at: number; id: string; ack: (a: AckInfo) => void }> = [];
  const current = new Map<string, { id: string; seq: number }>();
  let latest = 0;
  const runner = new PresetRunner({
    getParties: () => parties,
    issue: (d, ack) => {
      issued.push({ at: t, d, ack });
      return `r${issued.length}`;
    },
    cancel: (id, ack) => {
      cancelled.push({ at: t, id, ack });
      return 'c';
    },
    currentCommand: (pid) => current.get(pid) ?? null,
    latestSeq: () => latest,
    intervalMs,
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => void timers.splice(timers.indexOf(h as never), 1),
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { runner, issued, cancelled, advance, current, setLatest: (n: number) => (latest = n), setParties: (n: number) => (parties = makeDefaultParties(n)) };
}

const preset = (steps: Preset['steps']): Preset => ({ id: 'p', name: 'A작전', steps });
const step = (parties: number[], action: Preset['steps'][number]['action'] = 'ATTACK') => ({ all: false, parties, action });
const ok = (id: string): AckInfo => ({ at: 0, commandId: id });

describe('PresetRunner', () => {
  it('sends each step as its own issue, in order, respecting the interval (12 parties stay under 5/sec)', () => {
    const { runner, issued, advance } = setup(12);
    runner.start(preset(Array.from({ length: 12 }, (_, i) => step([i + 1]))));
    advance(0);
    expect(issued).toHaveLength(1);
    advance(5000);
    expect(issued).toHaveLength(12);
    expect(issued.map((i) => i.d.target)).toEqual(Array.from({ length: 12 }, (_, i) => ({ kind: 'PARTIES', partyIds: [`p${i + 1}`] })));
    // Any 1-second window holds at most 4 sends.
    for (let i = 0; i + 4 < issued.length; i++) expect(issued[i + 4]!.at - issued[i]!.at).toBeGreaterThanOrEqual(1000);
  });

  it('skips steps whose parties are gone and reports which', () => {
    const { runner, issued, advance } = setup(2);
    runner.start(preset([step([1]), step([3]), step([2, 4])]));
    advance(2000);
    expect(issued).toHaveLength(2);
    const steps = runner.latest()!.steps;
    expect(steps[1]).toMatchObject({ status: 'SKIPPED', reason: '3파티 없음, 건너뜀' });
    expect(steps[2]!.missing).toEqual([4]);
    expect(issued[1]!.d.target).toEqual({ kind: 'PARTIES', partyIds: ['p2'] });
  });

  it('skipped steps do not spend rate budget', () => {
    const { runner, issued, advance } = setup(1);
    runner.start(preset([step([5]), step([1])]));
    advance(0);
    advance(0);
    expect(issued).toHaveLength(1);
  });

  it('reports failed steps and retries only them', () => {
    const { runner, issued, advance } = setup(3);
    const run = runner.start(preset([step([1]), step([2]), step([3])]));
    advance(1000);
    issued[0]!.ack(ok('c1'));
    issued[1]!.ack({ at: 0, error: 'RATE_LIMITED' });
    issued[2]!.ack({ at: 0, error: 'UNKNOWN_PARTY' });
    expect(runner.latest()!.steps.map((s) => s.status)).toEqual(['OK', 'FAILED', 'FAILED']);
    expect(runner.latest()!.steps[1]!.reason).toBe('RATE_LIMITED');
    runner.retryFailed(run.id);
    advance(1000);
    expect(issued).toHaveLength(5);
    expect(issued[3]!.d.target).toEqual({ kind: 'PARTIES', partyIds: ['p2'] });
    issued[3]!.ack(ok('c2'));
    expect(runner.latest()!.steps[1]!.status).toBe('OK');
  });

  it('cancelRun drops unsent steps and cancels the commands already issued', () => {
    const { runner, issued, cancelled, advance } = setup(3);
    const run = runner.start(preset([step([1]), step([2]), step([3])]));
    advance(0);
    issued[0]!.ack(ok('c1'));
    runner.cancelRun(run.id);
    advance(2000);
    expect(issued).toHaveLength(1);
    expect(cancelled.map((c) => c.id)).toEqual(['c1']);
    // Unsent steps are dropped at once; the issued one waits for the cancel ack.
    expect(runner.latest()!.steps.map((s) => s.status)).toEqual(['CANCELLING', 'CANCELLED', 'CANCELLED']);
    cancelled[0]!.ack({ at: 0 });
    expect(runner.latest()!.steps[0]!.status).toBe('CANCELLED');
  });

  it('a failed cancel ack shows CANCEL_FAILED and can be retried', () => {
    const { runner, issued, cancelled, advance } = setup(1);
    const run = runner.start(preset([step([1])]));
    advance(0);
    issued[0]!.ack(ok('c1'));
    runner.cancelRun(run.id);
    advance(300);
    cancelled[0]!.ack({ at: 0, error: 'RATE_LIMITED' });
    expect(runner.latest()!.steps[0]).toMatchObject({ status: 'CANCEL_FAILED', reason: 'RATE_LIMITED' });
    runner.retryCancel(run.id);
    advance(300);
    expect(cancelled).toHaveLength(2);
    cancelled[1]!.ack({ at: 0 });
    expect(runner.latest()!.steps[0]!.status).toBe('CANCELLED');
  });

  it('skips a late step when another issuer gave the party a newer command, but not for its own commands', () => {
    const { runner, issued, advance, current, setLatest } = setup(2);
    setLatest(5);
    runner.start(preset([step([1]), step([2]), step([1], 'DEFEND')]));
    advance(0);
    issued[0]!.ack(ok('own1'));
    current.set('p1', { id: 'own1', seq: 6 });
    // Someone issues a new command to party 2 while the preset is running.
    current.set('p2', { id: 'other', seq: 7 });
    advance(1000);
    const st = runner.latest()!.steps;
    expect(st[1]).toMatchObject({ status: 'SKIPPED', reason: NEWER_COMMAND_REASON });
    expect(st[2]!.status).toBe('SENT');
    expect(issued).toHaveLength(2);
  });

  it('partiesWithNewerForeignCommand ignores old and own commands', () => {
    const cur = (id: string) => ({ p1: { id: 'a', seq: 3 }, p2: { id: 'b', seq: 9 }, p3: { id: 'mine', seq: 10 } })[id as 'p1'] ?? null;
    expect(partiesWithNewerForeignCommand(['p1', 'p2', 'p3', 'p4'], cur, new Set(['mine']), 5)).toEqual(['p2']);
  });

  it('cancels a step whose ack arrives after the run was cancelled', () => {
    const { runner, issued, cancelled, advance } = setup(1);
    const run = runner.start(preset([step([1])]));
    advance(0);
    runner.cancelRun(run.id);
    issued[0]!.ack(ok('late'));
    advance(300);
    expect(cancelled.map((c) => c.id)).toEqual(['late']);
  });

  it('keeps support targets by number and sends ALL steps', () => {
    const { runner, issued, advance } = setup(3);
    runner.start(preset([{ all: false, parties: [1], action: 'SUPPORT', supportParties: [2, 9] }, { all: true, parties: [], action: 'RETREAT' }]));
    advance(1000);
    expect(issued[0]!.d).toMatchObject({ action: 'SUPPORT', supportPartyIds: ['p2'] });
    expect(issued[1]!.d.target).toEqual({ kind: 'ALL' });
  });

  it('dispose stops pending sends', () => {
    const { runner, issued, advance } = setup(3);
    runner.start(preset([step([1]), step([2])]));
    advance(0);
    runner.dispose();
    advance(2000);
    expect(issued).toHaveLength(1);
    void vi;
  });
});
