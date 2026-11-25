import { describe, expect, it } from 'vitest';
import { ACK_DELAY_MS, IssueTracker, ackStatus } from './IssueTracker';

describe('ackStatus', () => {
  const e = { sentAt: 1000 };
  it('pending, then "전송 지연" after 2s, acked, error', () => {
    expect(ackStatus(e, 1500)).toBe('PENDING');
    expect(ackStatus(e, 1000 + ACK_DELAY_MS)).toBe('PENDING');
    expect(ackStatus(e, 1000 + ACK_DELAY_MS + 1)).toBe('DELAYED');
    expect(ackStatus({ ...e, ack: { at: 1200 } }, 9999)).toBe('ACKED');
    expect(ackStatus({ ...e, ack: { at: 1200, error: 'FORBIDDEN' } }, 1200)).toBe('ERROR');
  });
});

describe('IssueTracker', () => {
  it('tracks requests and applies acks with notes/errors, firing callbacks once', () => {
    let t = 0;
    let n = 0;
    const tr = new IssueTracker({ client: { request: () => `id${++n}` }, now: () => t });
    const seen: unknown[] = [];
    tr.request({ type: 'room.close' }, '방 종료', (a) => seen.push(a));
    tr.request({ type: 'room.close' }, '두번째');
    t = 300;
    tr.handleAck({ clientCmdId: 'id1', commandId: 'C1', note: 'CORRECTION_AS_NEW' });
    tr.handleAck({ clientCmdId: 'id1', commandId: 'C1' });
    tr.handleAck({ clientCmdId: 'id2', error: 'RATE_LIMITED' });
    expect(seen).toHaveLength(1);
    expect(tr.get('id1')?.ack).toMatchObject({ commandId: 'C1', note: 'CORRECTION_AS_NEW', at: 300 });
    expect(ackStatus(tr.get('id2')!, 300)).toBe('ERROR');
  });
});
