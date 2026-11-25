import { describe, expect, it } from 'vitest';
import { LIMITS } from '@winds/protocol';
import { randomToken, sha256Hex, timingSafeEqual } from '../src/crypto';
import { commanderStale, dueCloseReason, helloExpired, nextAlarmAt, planAlarm } from '../src/lifecycle';
import { verifyHello } from '../src/auth';
import { computePresence } from '../src/presence';
import { TokenBucket, ViolationCounter, bucketKind, peekClientCmdId } from '../src/rateLimit';

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

describe('computePresence sub-commanders', () => {
  it('counts SUB_COMMANDER separately and in total', () => {
    const p = computePresence(
      [{ role: 'SUB_COMMANDER', partyId: null }, { role: 'OPERATOR', partyId: null }],
      ['p1'],
      'OFF',
    );
    expect(p).toMatchObject({ subCommandersOnline: 1, operatorsOnline: 1, total: 2, commanderOnline: false });
  });
});

describe('verifyHello', () => {
  const room = async (withSub: boolean) => ({
    commanderTokenHash: await sha256Hex('C'),
    operatorTokenHash: await sha256Hex('O'),
    ...(withSub ? { subCommanderTokenHash: await sha256Hex('S') } : {}),
  });
  const hello = (role: 'COMMANDER' | 'SUB_COMMANDER' | 'OPERATOR' | 'MEMBER', extra = {}) =>
    ({ v: 1, type: 'hello', roomCode: 'ABC234', clientId: 'x', role, ...extra }) as const;

  it('sub-commander needs its own token', async () => {
    const r = await room(true);
    expect(await verifyHello(hello('SUB_COMMANDER', { subCommanderToken: 'S' }), r)).toBe(true);
    expect(await verifyHello(hello('SUB_COMMANDER'), r)).toBe(false);
    expect(await verifyHello(hello('SUB_COMMANDER', { subCommanderToken: 'bad' }), r)).toBe(false);
    // other roles' tokens must not work
    expect(await verifyHello(hello('SUB_COMMANDER', { subCommanderToken: 'O' }), r)).toBe(false);
    expect(await verifyHello(hello('SUB_COMMANDER', { subCommanderToken: 'C' }), r)).toBe(false);
  });
  it('legacy room without sub hash: UNAUTHORIZED, no throw', async () => {
    const r = await room(false);
    expect(await verifyHello(hello('SUB_COMMANDER', { subCommanderToken: 'S' }), r)).toBe(false);
  });
  it('existing roles unchanged', async () => {
    const r = await room(true);
    expect(await verifyHello(hello('COMMANDER', { commanderToken: 'C' }), r)).toBe(true);
    expect(await verifyHello(hello('COMMANDER', { commanderToken: 'O' }), r)).toBe(false);
    expect(await verifyHello(hello('OPERATOR', { operatorToken: 'O' }), r)).toBe(true);
    expect(await verifyHello(hello('OPERATOR', { operatorToken: 'S' }), r)).toBe(false);
    expect(await verifyHello(hello('MEMBER'), r)).toBe(true);
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
      commanderOnline: true, operatorsOnline: 1, subCommandersOnline: 0, sttState: 'LISTENING',
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

describe('lifecycle: restart grace', () => {
  const s = { expiresAt: 4 * 3600_000, lastCommanderSeenAt: 0 }; // commander last seen ages ago
  const woke = 2 * LIMITS.commanderAbsentCloseMs; // new instance starts long after lastSeen + 30min
  const graceUntil = woke + LIMITS.restartGraceMs;
  it('woken with 0 sockets and a stale lastSeen: not closed at once', () => {
    expect(dueCloseReason(s, false, woke + 1, graceUntil)).toBeNull();
    expect(dueCloseReason(s, false, graceUntil - 1, graceUntil)).toBeNull();
    // without the floor the room would be closed immediately (the bug)
    expect(dueCloseReason(s, false, woke + 1)).toBe('COMMANDER_ABSENT');
  });
  it('the alarm is planned at the end of the grace, not 1ms from now', () => {
    const at = planAlarm({ ...s, commanderOnline: false, oldestPendingHelloAt: null, now: woke, graceUntil });
    expect(at).toBe(graceUntil);
  });
  it('after the grace it still closes; expiry still wins', () => {
    expect(dueCloseReason(s, false, graceUntil, graceUntil)).toBe('COMMANDER_ABSENT');
    expect(dueCloseReason({ ...s, expiresAt: woke }, false, woke, graceUntil)).toBe('EXPIRED');
    expect(nextAlarmAt({ ...s, expiresAt: woke + 10 }, false, graceUntil)).toBe(woke + 10);
  });
  it('a recently seen commander keeps its normal 30 min deadline', () => {
    const fresh = { expiresAt: 4 * 3600_000, lastCommanderSeenAt: woke - 5_000 };
    expect(nextAlarmAt(fresh, false, graceUntil)).toBe(fresh.lastCommanderSeenAt + LIMITS.commanderAbsentCloseMs);
  });
});

describe('review fixes: rate limiting', () => {
  it('violations decay after a quiet period', () => {
    const v = new ViolationCounter(LIMITS.violationDecayMs);
    expect(v.hit(0)).toBe(1);
    expect(v.hit(1000)).toBe(2);
    expect(v.hit(1000 + LIMITS.violationDecayMs + 1)).toBe(1); // reset
    // slow trickle (one per 61s for hours) never reaches the cap
    let n = 0;
    for (let i = 0; i < 300; i++) n = v.hit(100_000 + i * 61_000);
    expect(n).toBe(1);
  });
  it('stt.* is bucketed separately from commands', () => {
    expect(bucketKind('stt.feed')).toBe('stt');
    expect(bucketKind('stt.status')).toBe('stt');
    expect(bucketKind('command.issue')).toBe('cmd');
    expect(bucketKind(undefined)).toBe('cmd');
    const cmd = new TokenBucket(LIMITS.commanderRatePerSec, 0);
    const stt = new TokenBucket(LIMITS.sttRatePerSec, 0);
    for (let i = 0; i < 5; i++) stt.take(0);
    expect(stt.take(0)).toBe(false);
    expect(cmd.take(0)).toBe(true); // commands unaffected by stt exhaustion
  });
  it('peekClientCmdId recovers the id from an invalid frame', () => {
    expect(peekClientCmdId('{"type":"command.issue","clientCmdId":"abc"}')).toBe('abc');
    expect(peekClientCmdId('{"clientCmdId":""}')).toBeUndefined();
    expect(peekClientCmdId('{"clientCmdId":5}')).toBeUndefined();
    expect(peekClientCmdId('not json')).toBeUndefined();
  });
});

describe('review fixes: alarm multiplexing', () => {
  const base = { expiresAt: 1_000_000_000, lastCommanderSeenAt: 0, oldestPendingHelloAt: null, now: 1000 };
  it('ticks every 10s only while a commander socket exists', () => {
    expect(planAlarm({ ...base, commanderOnline: true })).toBe(1000 + LIMITS.commanderLivenessTickMs);
    // no commander: absent-close deadline, never a tick
    expect(planAlarm({ ...base, commanderOnline: false })).toBe(LIMITS.commanderAbsentCloseMs);
  });
  it('expiry and hello deadlines win when earlier', () => {
    expect(planAlarm({ ...base, commanderOnline: true, expiresAt: 3000 })).toBe(3000);
    expect(planAlarm({ ...base, commanderOnline: false, oldestPendingHelloAt: 500 })).toBe(500 + LIMITS.helloTimeoutMs);
  });
  it('commanderStale: fresh auto-response or message keeps it alive; >25s silence kills', () => {
    const now = 100_000;
    expect(commanderStale(now - 15_000, null, 0, now)).toBe(false);
    expect(commanderStale(null, now - 24_000, 0, now)).toBe(false);
    expect(commanderStale(now - 26_000, now - 40_000, now - 50_000, now)).toBe(true);
    expect(commanderStale(null, null, now - 5_000, now)).toBe(false); // just connected
    expect(commanderStale(null, null, now - 26_000, now)).toBe(true);
  });
  it('helloExpired at 10s', () => {
    expect(helloExpired(0, 9_999)).toBe(false);
    expect(helloExpired(0, 10_000)).toBe(true);
  });
});

import { HttpRateLimiter, corsHeaders, isOriginAllowed, parseAllowedOrigins, parseHttpLimit } from '../src/httpGuard';

describe('origin policy', () => {
  it('parses the list', () => {
    expect(parseAllowedOrigins(' https://A.com/ , ,https://b.com')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
  it('no Origin header is allowed', () => {
    expect(isOriginAllowed(null, 'https://x.com', [])).toBe(true);
    expect(isOriginAllowed(null, 'https://x.com', ['https://a.com'])).toBe(true);
  });
  it('empty list: same origin or loopback only', () => {
    expect(isOriginAllowed('https://x.com', 'https://x.com', [])).toBe(true);
    expect(isOriginAllowed('http://localhost:5180', 'http://localhost:8798', [])).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', 'https://x.com', [])).toBe(true);
    expect(isOriginAllowed('http://[::1]:5173', 'https://x.com', [])).toBe(true);
    expect(isOriginAllowed('https://evil.com', 'https://x.com', [])).toBe(false);
    expect(isOriginAllowed('https://x.com:8443', 'https://x.com', [])).toBe(false);
    expect(isOriginAllowed('http://x.com', 'https://x.com', [])).toBe(false); // scheme differs
    expect(isOriginAllowed('not a url', 'https://x.com', [])).toBe(false);
    expect(isOriginAllowed('null', 'https://x.com', [])).toBe(false);
  });
  it('list adds origins; the request own origin is always allowed', () => {
    const l = ['https://a.com'];
    expect(isOriginAllowed('https://a.com', 'https://x.com', l)).toBe(true);
    expect(isOriginAllowed('https://A.com', 'https://x.com', l)).toBe(true);
    expect(isOriginAllowed('https://x.com', 'https://x.com', l)).toBe(true); // same origin, not in list
    expect(isOriginAllowed('http://x.com', 'https://x.com', l)).toBe(false); // scheme compared
    expect(isOriginAllowed('https://x.com:8443', 'https://x.com', l)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', 'https://x.com', l)).toBe(false);
    expect(isOriginAllowed('https://b.com', 'https://x.com', l)).toBe(false);
  });
  it('cors headers echo the origin and vary', () => {
    expect(corsHeaders('https://a.com')['access-control-allow-origin']).toBe('https://a.com');
    expect(corsHeaders('https://a.com').vary).toBe('Origin');
    expect(corsHeaders(null)['access-control-allow-origin']).toBeUndefined();
  });
});

describe('http rate limit', () => {
  it('parses limits with fallback', () => {
    expect(parseHttpLimit('5,20')).toEqual({ create: 5, read: 20, miss: 20 });
    expect(parseHttpLimit('5,20,7')).toEqual({ create: 5, read: 20, miss: 7 });
    expect(parseHttpLimit(undefined)).toEqual({ create: 10, read: 60, miss: 20 });
    expect(parseHttpLimit('x,-1')).toEqual({ create: 10, read: 60, miss: 20 });
  });
  it('counts per ip and kind per window, with Retry-After', () => {
    const l = new HttpRateLimiter(60_000);
    expect(l.check('a', 'create', 2, 0)).toBe(0);
    expect(l.check('a', 'create', 2, 1000)).toBe(0);
    expect(l.check('a', 'create', 2, 2000)).toBe(58);
    expect(l.check('b', 'create', 2, 2000)).toBe(0);
    expect(l.check('a', 'read', 2, 2000)).toBe(0);
    expect(l.check('a', 'create', 2, 60_000)).toBe(0);
  });
  it('blocked() peeks without counting', () => {
    const l = new HttpRateLimiter(60_000);
    expect(l.blocked('a', 'miss', 2, 0)).toBe(0);
    l.check('a', 'miss', 2, 0);
    expect(l.blocked('a', 'miss', 2, 1000)).toBe(0);
    l.check('a', 'miss', 2, 1000);
    expect(l.blocked('a', 'miss', 2, 2000)).toBe(58);
    expect(l.blocked('b', 'miss', 2, 2000)).toBe(0);
    expect(l.blocked('a', 'miss', 2, 60_000)).toBe(0);
  });
});
