import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DICTIONARY } from '@winds/parser';
import { LIMITS, makeDefaultParties, type Command } from '@winds/protocol';
import type { RequestInput, SendPayload } from '../../net/RoomClient';
import type { AckInfo } from '../console/IssueTracker';
import { SessionMetrics } from '../metrics';
import { CommandPipeline, FEED_FLUSH_MS, type PipelineState } from './CommandPipeline';
import { MemoryTuningLog } from './tuningLog';

interface Sent {
  id: string;
  input: RequestInput;
  onAck?: (a: AckInfo) => void;
}

function setup(over: Partial<PipelineState['settings']> = {}) {
  const sent: Sent[] = [];
  const feeds: SendPayload[] = [];
  const state: PipelineState = {
    parties: makeDefaultParties(5),
    settings: { targetlessAsAll: false, ...over },
    commands: {},
  };
  const metrics = new SessionMetrics();
  const tuningLog = new MemoryTuningLog();
  let n = 0;
  const p = new CommandPipeline({
    request: (input, _label, onAck) => {
      const id = `req${++n}`;
      sent.push({ id, input, onAck });
      return id;
    },
    send: (m) => {
      feeds.push(m);
      return true;
    },
    getState: () => state,
    getDictionary: () => DEFAULT_DICTIONARY,
    metrics,
    tuningLog,
  });
  const ack = (s: Sent, commandId: string, command?: Partial<Command>) => {
    if (command) state.commands[commandId] = { id: commandId, seq: 1, target: { kind: 'ALL' }, action: 'HOLD', status: 'ACTIVE', source: 'VOICE', issuedAt: Date.now(), repeatCount: 0, ...command } as Command;
    s.onAck?.({ commandId, at: Date.now() });
  };
  return { p, sent, feeds, state, metrics, tuningLog, ack };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('CommandPipeline', () => {
  it('HIGH ISSUE is issued automatically with source VOICE, transcript and confidence', () => {
    const { p, sent, metrics } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() - 300 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({
      type: 'command.issue',
      source: 'VOICE',
      action: 'DEFEND',
      target: { kind: 'PARTIES', partyIds: ['p3'] },
      location: { id: 'RIGHT', label: '우측' },
      transcript: '3파티 우측 방어',
    });
    expect(metrics.snapshot().issuedVoice).toBe(1);
    const sub = p.getSnapshot().subtitles;
    expect(sub).toHaveLength(1);
    expect(sub[0]!.chips[0]).toMatchObject({ kind: 'ISSUED', label: '3파티 방어 우측', clientCmdId: 'req1' });
  });

  it('records latency from endedAt to the ack', () => {
    const { p, sent, metrics, ack } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    vi.advanceTimersByTime(450);
    ack(sent[0]!, 'C1');
    expect(metrics.snapshot().latencies).toEqual([450]);
  });

  it('MEDIUM becomes a candidate that expires after candidateTtlMs and is never auto-issued', () => {
    const { p, sent, metrics } = setup();
    p.onFinalTranscript('중앙으로 모여', { endedAt: Date.now() });
    expect(sent).toHaveLength(0);
    const [c] = p.getSnapshot().candidates;
    expect(c).toMatchObject({ kind: 'ISSUE', label: '전체 집결 중앙', expiresAt: Date.now() + LIMITS.candidateTtlMs });
    expect(metrics.snapshot().candidateShown).toBe(1);
    vi.advanceTimersByTime(LIMITS.candidateTtlMs - 1);
    expect(p.getSnapshot().candidates).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(p.getSnapshot().candidates).toHaveLength(0);
  });

  it('publishCandidate issues once as VOICE and retags the subtitle chip', () => {
    const { p, sent, metrics } = setup();
    p.onFinalTranscript('중앙으로 모여', { endedAt: Date.now() });
    const id = p.getSnapshot().candidates[0]!.id;
    p.publishCandidate(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({ type: 'command.issue', source: 'VOICE', action: 'GATHER', target: { kind: 'ALL' } });
    expect(p.getSnapshot().candidates).toHaveLength(0);
    expect(p.getSnapshot().subtitles[0]!.chips[0]).toMatchObject({ kind: 'ISSUED', clientCmdId: 'req1' });
    expect(metrics.snapshot().candidatePublished).toBe(1);
    p.publishCandidate(id); // already gone: no second send
    expect(sent).toHaveLength(1);
  });

  it('editCandidate removes it and returns the draft for the button panel', () => {
    const { p, sent } = setup();
    p.onFinalTranscript('중앙으로 모여', { endedAt: Date.now() });
    const draft = p.editCandidate(p.getSnapshot().candidates[0]!.id);
    expect(draft).toMatchObject({ action: 'GATHER', target: { kind: 'ALL' }, location: { id: 'CENTER' } });
    expect(p.getSnapshot().candidates).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('targetlessAsAll makes the same sentence a HIGH auto issue', () => {
    const { p, sent } = setup({ targetlessAsAll: true });
    p.onFinalTranscript('중앙으로 모여', { endedAt: Date.now() });
    expect(sent).toHaveLength(1);
    expect(p.getSnapshot().candidates).toHaveLength(0);
  });

  it('NONE goes to the local tuning log only', () => {
    const { p, sent, tuningLog } = setup();
    p.onFinalTranscript('상대 많네요', { endedAt: Date.now() });
    expect(sent).toHaveLength(0);
    expect(tuningLog.entries).toEqual([{ at: Date.now(), text: '상대 많네요', reason: '명령 표현 없음' }]);
    expect(p.getSnapshot().subtitles[0]!.chips).toEqual([]);
  });

  it('voice cancel sends command.cancel for the last acked voice command id', () => {
    const { p, sent, ack, metrics } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    ack(sent[0]!, 'C1', { target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND' });
    vi.advanceTimersByTime(2000);
    p.onFinalTranscript('방금 거 취소', { endedAt: Date.now() });
    expect(sent[1]!.input).toEqual({ type: 'command.cancel', commandId: 'C1' });
    expect(metrics.snapshot().cancelledVoice).toBe(1);
    // the cancelled command is no longer a correction/cancel target
    p.onFinalTranscript('방금 거 취소', { endedAt: Date.now() });
    expect(sent).toHaveLength(2);
  });

  it('a command issued by someone else (sub-commander) is never the target of a voice correction or cancel', () => {
    const { p, sent, state, ack } = setup();
    // only someone else's command exists, newer than anything we issued
    state.commands['S1'] = { id: 'S1', seq: 1, target: { kind: 'ALL' }, action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL', issuedAt: Date.now(), repeatCount: 0, issuer: { role: 'SUB_COMMANDER' } };
    p.onFinalTranscript('방금 거 취소', { endedAt: Date.now() });
    p.onFinalTranscript('아니 후퇴', { endedAt: Date.now() });
    expect(sent.some((s) => s.input.type === 'command.cancel' || s.input.type === 'command.correct')).toBe(false);
    // once we issue our own, cancel hits our own command, not S1
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    ack(sent[0]!, 'C1', { target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND' });
    state.commands['S2'] = { ...state.commands['S1']!, id: 'S2', issuedAt: Date.now() + 500 };
    vi.advanceTimersByTime(1000);
    p.onFinalTranscript('방금 거 취소', { endedAt: Date.now() });
    expect(sent[1]!.input).toEqual({ type: 'command.cancel', commandId: 'C1' });
  });

  it('cancel before the first ack is known is not sent (no command id yet)', () => {
    const { p, sent } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    p.onFinalTranscript('방금 거 취소', { endedAt: Date.now() });
    expect(sent).toHaveLength(1);
  });

  it('HIGH correction within 15s is sent as command.correct with the patch and VOICE source', () => {
    const { p, sent, ack, metrics } = setup();
    p.onFinalTranscript('1파티 중앙 집결', { endedAt: Date.now() });
    ack(sent[0]!, 'C1', { target: { kind: 'PARTIES', partyIds: ['p1'] }, action: 'GATHER', location: { id: 'CENTER', label: '중앙' } });
    vi.advanceTimersByTime(3000);
    p.onFinalTranscript('중앙 말고 우측', { endedAt: Date.now() });
    expect(sent[1]!.input).toMatchObject({
      type: 'command.correct',
      correctsId: 'C1',
      source: 'VOICE',
      location: { id: 'RIGHT', label: '우측' },
    });
    expect(metrics.snapshot().corrected).toBe(1);
    expect(p.getSnapshot().subtitles[1]!.chips[0]!.kind).toBe('CORRECTED');
  });

  it('MEDIUM correction becomes a CORRECT candidate; publishing sends command.correct', () => {
    const { p, sent, ack } = setup();
    p.onFinalTranscript('3파티 방어', { endedAt: Date.now() });
    ack(sent[0]!, 'C1', { target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND' });
    vi.advanceTimersByTime(5000);
    p.onFinalTranscript('우측 말고 중앙으로 이동', { endedAt: Date.now() });
    const cand = p.getSnapshot().candidates[0]!;
    expect(cand.kind).toBe('CORRECT');
    p.publishCandidate(cand.id);
    expect(sent[1]!.input).toMatchObject({ type: 'command.correct', correctsId: 'C1', action: 'MOVE', location: { id: 'CENTER' } });
  });

  it('after 15s a correction word is not treated as a correction', () => {
    const { p, sent, ack } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    ack(sent[0]!, 'C1', { target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND' });
    vi.advanceTimersByTime(LIMITS.correctionWindowMs + 1000);
    p.onFinalTranscript('우측 말고 중앙으로 이동', { endedAt: Date.now() });
    expect(sent.some((s) => s.input.type === 'command.correct')).toBe(false);
  });

  it('batches stt.feed entries (final text + outcome + Korean summary) and flushes after the batch window', () => {
    const { p, feeds } = setup();
    p.onFinalTranscript('3파티 우측 방어', { endedAt: Date.now() });
    p.onFinalTranscript('중앙으로 모여', { endedAt: Date.now() });
    p.onFinalTranscript('상대 많네요', { endedAt: Date.now() });
    expect(feeds).toHaveLength(0);
    vi.advanceTimersByTime(FEED_FLUSH_MS);
    expect(feeds).toHaveLength(1);
    const msg = feeds[0] as Extract<SendPayload, { type: 'stt.feed' }>;
    expect(msg.entries.map((e) => [e.text, e.outcome, e.summary])).toEqual([
      ['3파티 우측 방어', 'ISSUED', '3파티 방어 우측'],
      ['중앙으로 모여', 'CANDIDATE', '후보 · 전체 집결 중앙'],
      ['상대 많네요', 'DISCARDED', '명령 표현 없음'],
    ]);
  });

  it('onPartialTranscript sets and the final clears the interim line; subtitles keep the last 5', () => {
    const { p } = setup();
    p.onPartialTranscript('삼 파티');
    expect(p.getSnapshot().partial).toBe('삼 파티');
    for (let i = 0; i < 7; i++) p.onFinalTranscript(`상대 많네요 ${i}`, { endedAt: Date.now() });
    expect(p.getSnapshot().partial).toBe('');
    expect(p.getSnapshot().subtitles).toHaveLength(5);
    expect(p.getSnapshot().subtitles[4]!.text).toBe('상대 많네요 6');
  });

  it('subscribers are notified on change', () => {
    const { p } = setup();
    const fn = vi.fn();
    p.subscribe(fn);
    p.onFinalTranscript('상대 많네요', { endedAt: Date.now() });
    expect(fn).toHaveBeenCalled();
  });
});
