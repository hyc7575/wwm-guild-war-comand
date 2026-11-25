import { describe, expect, it } from 'vitest';
import { LIMITS } from '@winds/protocol';
import { randomToken, sha256Hex, timingSafeEqual } from '../src/crypto';
import { dueCloseReason, nextAlarmAt } from '../src/lifecycle';
import { computePresence } from '../src/presence';
import { TokenBucket } from '../src/rateLimit';

describe('crypto', () => {
  it('tokens are 32 random bytes base64url', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
  it('sha256Hex matches known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(timingSafeEqual('aa', 'aa')).toBe(true);
    expect(timingSafeEqual('aa', 'ab')).toBe(false);
    expect(timingSafeEqual('aa', 'aaa')).toBe(false);
  });
});

describe('TokenBucket', () => {
  it('allows burst of rate then refuses, then refills', () => {
    const b = new TokenBucket(5, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(200)).toBe(true); // 1 token / 200ms at 5/s
    expect(b.take(200)).toBe(false);
    expect(b.take(10_000)).toBe(true);
  });
  it('member rate 2/s', () => {
    const b = new TokenBucket(LIMITS.memberRatePerSec, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
  });
});

describe('computePresence', () => {
  it('counts non-commander connections by party', () => {
    const p = computePresence(
      [
        { role: 'COMMANDER', partyId: null },
        { role: 'OPERATOR', partyId: null },
        { role: 'MEMBER', partyId: 'p1' },
        { role: 'MEMBER', partyId: 'p1' },
        { role: 'MEMBER', partyId: 'gone' },
      ],
      ['p1', 'p2'],
      'LISTENING',
    );
    expect(p).toEqual({
      total: 4, byParty: { p1: 2, p2: 0 }, unassigned: 2,
      commanderOnline: true, operatorsOnline: 1, sttState: 'LISTENING',
    });
  });
  it('sttState is OFF when commander offline', () => {
    expect(computePresence([{ role: 'MEMBER', partyId: null }], ['p1'], 'LISTENING')).toMatchObject({
      commanderOnline: false, sttState: 'OFF', total: 1, unassigned: 1,
    });
  });
});

describe('lifecycle', () => {
  const s = { expiresAt: 4 * 3600_000, lastCommanderSeenAt: 1000 };
  it('alarm = expiresAt while commander online; min with absence deadline otherwise', () => {
    expect(nextAlarmAt(s, true)).toBe(s.expiresAt);
    expect(nextAlarmAt(s, false)).toBe(1000 + LIMITS.commanderAbsentCloseMs);
    expect(nextAlarmAt({ expiresAt: 5000, lastCommanderSeenAt: 1000 }, false)).toBe(5000);
  });
  it('dueCloseReason', () => {
    expect(dueCloseReason(s, true, 5000)).toBeNull();
    expect(dueCloseReason(s, false, 1000 + LIMITS.commanderAbsentCloseMs)).toBe('COMMANDER_ABSENT');
    expect(dueCloseReason(s, true, s.expiresAt)).toBe('EXPIRED');
    expect(dueCloseReason(s, false, s.expiresAt)).toBe('EXPIRED');
  });
});
