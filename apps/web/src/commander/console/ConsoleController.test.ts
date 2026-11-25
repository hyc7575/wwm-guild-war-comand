import { describe, expect, it } from 'vitest';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { create } from 'zustand';
import { initialRoomData, applyServerMessage, type RoomData } from '../../state/roomReducer';
import { MemoryTuningLog } from '../pipeline/tuningLog';
import { SessionMetrics } from '../metrics';
import { ConsoleController, type ConsoleStore } from './ConsoleController';
import { findCurrentAllCommand, findLastActive } from './selectors';

const cmd = (id: string, seq: number, partyIds: string[] | 'ALL', extra: Partial<Command> = {}): Command => ({
  id,
  seq,
  target: partyIds === 'ALL' ? { kind: 'ALL' } : { kind: 'PARTIES', partyIds },
  action: 'ATTACK',
  status: 'ACTIVE',
  source: 'MANUAL',
  issuedAt: 1,
  repeatCount: 0,
  ...extra,
});

function harness(now?: () => number) {
  const useStore = create<RoomData & { dismissUnsent(id: string): void }>(() => ({
    ...initialRoomData(),
    parties: makeDefaultParties(3),
    dismissUnsent() {},
  }));
  const sent: Array<{ id: string; input: any }> = [];
  const resent: string[] = [];
  const client = {
    request: (input: any) => {
      const id = `r${sent.length + 1}`;
      sent.push({ id, input });
      return id;
    },
    send: () => true,
    resend: (item: any) => {
      resent.push(item.clientCmdId);
      return item.clientCmdId as string;
    },
  };
  const metrics = new SessionMetrics();
  const c = new ConsoleController({
    client,
    store: useStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
    metrics,
    ...(now ? { now } : {}),
  });
  const apply = (msg: any) => useStore.setState((s) => applyServerMessage(s, msg));
  return { c, sent, resent, useStore, apply, metrics };
}

describe('selectors', () => {
  it('current commands come from slots; last active = highest seq; ALL line', () => {
    const state = {
      slots: { p1: ['A', 'B'], p2: ['A'], p3: [] },
      commands: { A: cmd('A', 1, 'ALL'), B: cmd('B', 2, ['p1']), C: cmd('C', 3, ['p3'], { status: 'CANCELLED' }) },
    };
    expect(findLastActive(state)?.id).toBe('B');
    expect(findLastActive(state, new Set(['B']))?.id).toBe('A');
    expect(findCurrentAllCommand(state)?.id).toBe('A');
  });
});

describe('ConsoleController', () => {
  it('resend reuses the original clientCmdId instead of issuing a new request', () => {
    const { c, sent, resent } = harness();
    const msg = { type: 'command.issue', target: { kind: 'ALL' }, action: 'HOLD', source: 'MANUAL' } as const;
    c.resend({ clientCmdId: 'u1', createdAt: 0, reason: 'STALE', msg } as any);
    expect(resent).toEqual(['u1']);
    expect(sent).toHaveLength(0);
    expect(c.tracker.get('u1')).toBeDefined();
  });

  it('manual issue sends source MANUAL and counts it', () => {
    const { c, sent, metrics } = harness();
    c.issueManual({ target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND', location: { id: 'RIGHT', label: '우측' } });
    expect(sent[0]!.input).toMatchObject({ type: 'command.issue', source: 'MANUAL', action: 'DEFEND' });
    expect(metrics.snapshot().issuedManual).toBe(1);
  });

  it('manual SUPPORT sends supportPartyIds; describeDraft shows the target', () => {
    const { c, sent } = harness();
    c.issueManual({ target: { kind: 'PARTIES', partyIds: ['p2'] }, action: 'SUPPORT', supportPartyIds: ['p3'] });
    expect(sent[0]!.input).toMatchObject({ type: 'command.issue', action: 'SUPPORT', supportPartyIds: ['p3'] });
    expect(c.tracker.get(sent[0]!.id)?.label).toBe('2파티 지원 →3파티');
  });

  it('manual issue with correctsId sends command.correct', () => {
    const { c, sent } = harness();
    c.issueManual({ target: { kind: 'ALL' }, action: 'MOVE', correctsId: 'C1' });
    expect(sent[0]!.input).toMatchObject({ type: 'command.correct', correctsId: 'C1', source: 'MANUAL' });
  });

  it('text "2파티 3파티 지원" previews and issues with the support target', () => {
    const { c, sent } = harness();
    const prev = c.previewText('2파티 3파티 지원');
    expect(prev.labels).toEqual(['2파티 지원 →3파티']);
    c.issueText('2파티 3파티 지원');
    expect(sent[0]!.input).toMatchObject({ supportPartyIds: ['p3'] });
  });

  it('cancelLast walks back through commands even before cancel events arrive', () => {
    const { c, sent, useStore } = harness();
    useStore.setState({
      slots: { p1: ['A', 'B'], p2: ['A', 'C'], p3: ['A'] },
      commands: { A: cmd('A', 1, 'ALL'), B: cmd('B', 2, ['p1']), C: cmd('C', 3, ['p2'], { source: 'VOICE' }) },
    });
    c.cancelLast();
    c.cancelLast();
    c.cancelLast();
    expect(sent.map((s) => s.input.commandId)).toEqual(['C', 'B', 'A']);
    expect(c.cancelLast()).toBeUndefined();
  });

  it('preset cancels are counted apart from manual cancels, and only when the server accepts', () => {
    const { c, sent, apply, metrics } = harness();
    const acks: any[] = [];
    c.cancelCommand('B', { origin: 'PRESET', onAck: (a) => acks.push(a) });
    c.cancelCommand('C', { origin: 'PRESET', onAck: (a) => acks.push(a) });
    apply({ v: 1, type: 'ack', clientCmdId: sent[0]!.id, error: 'RATE_LIMITED' });
    apply({ v: 1, type: 'ack', clientCmdId: sent[1]!.id, commandId: 'C' });
    expect(acks.map((a) => !!a.error)).toEqual([true, false]);
    expect(metrics.snapshot()).toMatchObject({ cancelledPreset: 1, cancelledManual: 0 });
    c.cancelCommand('D');
    expect(metrics.snapshot().cancelledManual).toBe(1);
  });

  it('a failed cancel can be retried', () => {
    const { c, sent, useStore, apply } = harness();
    useStore.setState({ slots: { p1: ['B'] }, commands: { B: cmd('B', 2, ['p1']) } });
    c.cancelLast();
    apply({ v: 1, type: 'ack', clientCmdId: 'r1', error: 'RATE_LIMITED' });
    c.cancelLast();
    expect(sent).toHaveLength(2);
  });

  it('a cancel reported unsent can be retried (not skipped forever)', () => {
    const { c, sent, useStore } = harness();
    useStore.setState({ slots: { p1: ['B'] }, commands: { B: cmd('B', 2, ['p1']) } });
    c.cancelLast();
    expect(c.cancelLast()).toBeUndefined();
    useStore.setState({ unsent: [{ clientCmdId: 'r1', createdAt: 0, reason: 'NO_ACK', msg: { type: 'command.cancel', commandId: 'B' } }] });
    c.cancelLast();
    expect(sent.map((s) => s.input.commandId)).toEqual(['B', 'B']);
  });

  it('in-flight cancels expire after 10s', () => {
    let t = 1000;
    const { c, sent, useStore } = harness(() => t);
    useStore.setState({ slots: { p1: ['B'] }, commands: { B: cmd('B', 2, ['p1']) } });
    c.cancelLast();
    t += 9000;
    expect(c.cancelLast()).toBeUndefined();
    t += 2000;
    c.cancelLast();
    expect(sent).toHaveLength(2);
  });

  it('acks in the store reach the tracker', () => {
    const { c, apply } = harness();
    const id = c.issueManual({ target: { kind: 'ALL' }, action: 'HOLD' });
    apply({ v: 1, type: 'ack', clientCmdId: id, commandId: 'X', note: 'REPEATED' });
    expect(c.tracker.get(id)?.ack).toMatchObject({ commandId: 'X', note: 'REPEATED' });
  });

  it('previewText: parses typed text, "해석할 수 없습니다" case yields no drafts', () => {
    const { c } = harness();
    expect(c.previewText('3파티 우측 방어').labels).toEqual(['3파티 방어 우측']);
    expect(c.previewText('상대 많네요').drafts).toEqual([]);
    expect(c.previewText('   ').drafts).toEqual([]);
  });

  it('issueText issues each parsed draft as MANUAL; party editor request carries baseVersion', () => {
    const { c, sent } = harness();
    expect(c.issueText('3파티 우측 방어')).toBe(1);
    expect(sent[0]!.input.source).toBe('MANUAL');
    c.updateParties(4, makeDefaultParties(2), () => {});
    expect(sent[1]!.input).toMatchObject({ type: 'parties.update', baseVersion: 4 });
  });

  it('locations() lists the F08 order first', () => {
    expect(harness().c.locations().map((l) => l.label).slice(0, 5)).toEqual(['좌측', '중앙', '우측', '앞', '뒤']);
  });
});

