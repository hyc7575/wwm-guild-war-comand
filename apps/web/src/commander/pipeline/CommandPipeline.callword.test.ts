import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CALLWORD_CONFIG, DEFAULT_DICTIONARY, CALLWORD_FOLLOWUP_MS, type CallwordConfig } from '@winds/parser';
import { makeDefaultParties } from '@winds/protocol';
import type { RequestInput, SendPayload } from '../../net/RoomClient';
import { SessionMetrics } from '../metrics';
import { CommandPipeline, FEED_FLUSH_MS } from './CommandPipeline';
import { MemoryTuningLog } from './tuningLog';

function setup(cfg: CallwordConfig) {
  const sent: RequestInput[] = [];
  const feeds: SendPayload[] = [];
  const tuningLog = new MemoryTuningLog();
  const p = new CommandPipeline({
    request: (input) => {
      sent.push(input);
      return `req${sent.length}`;
    },
    send: (m) => (feeds.push(m), true),
    getState: () => ({ parties: makeDefaultParties(5), settings: { targetlessAsAll: false }, commands: {} }),
    getDictionary: () => DEFAULT_DICTIONARY,
    getCallword: () => cfg,
    metrics: new SessionMetrics(),
    tuningLog,
  });
  const fin = (t: string) => p.onFinalTranscript(t, { endedAt: Date.now() });
  const feedEntries = () => {
    vi.advanceTimersByTime(FEED_FLUSH_MS);
    return feeds.flatMap((f) => (f.type === 'stt.feed' ? f.entries : []));
  };
  return { p, sent, fin, feedEntries, tuningLog };
}

const ON: CallwordConfig = { ...DEFAULT_CALLWORD_CONFIG, enabled: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('CommandPipeline call-word mode', () => {
  it('off: sentences without a call word are parsed as before', () => {
    const { sent, fin } = setup(DEFAULT_CALLWORD_CONFIG);
    fin('3파티 우측 방어');
    expect(sent).toHaveLength(1);
  });

  it('on: a sentence without the call word is dropped, feed says so, tuning log untouched', () => {
    const { sent, fin, feedEntries, p, tuningLog } = setup(ON);
    fin('3파티 우측 방어');
    expect(sent).toHaveLength(0);
    expect(p.getSnapshot().subtitles).toHaveLength(1);
    expect(feedEntries()).toEqual([expect.objectContaining({ text: '3파티 우측 방어', outcome: 'DISCARDED', summary: '호출어 없음, 무시' })]);
    expect(tuningLog.entries).toHaveLength(0);
  });

  it('on: only what follows the call word is parsed', () => {
    const { sent, fin } = setup(ON);
    fin('자 오더 3파티 우측 방어');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'DEFEND', transcript: '3파티 우측 방어' });
  });

  it('on: call word alone takes the next sentence within 5s', () => {
    const { sent, fin } = setup(ON);
    fin('오더');
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(CALLWORD_FOLLOWUP_MS - 1);
    fin('3파티 우측 방어');
    expect(sent).toHaveLength(1);
  });

  it('on: the follow-up expires after 5s', () => {
    const { sent, fin } = setup(ON);
    fin('오더');
    vi.advanceTimersByTime(CALLWORD_FOLLOWUP_MS + 1);
    fin('3파티 우측 방어');
    expect(sent).toHaveLength(0);
  });

  it('on: the follow-up is used once', () => {
    const { sent, fin } = setup(ON);
    fin('오더');
    fin('3파티 우측 방어');
    fin('1파티 중앙 방어');
    expect(sent).toHaveLength(1);
  });
});
