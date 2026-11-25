import { LIMITS } from '@winds/protocol';

export type CloseReason = 'COMMANDER_CLOSED' | 'EXPIRED' | 'COMMANDER_ABSENT';

/** When the single room alarm should fire next. */
export function nextAlarmAt(
  s: { expiresAt: number; lastCommanderSeenAt: number },
  commanderOnline: boolean,
): number {
  return commanderOnline
    ? s.expiresAt
    : Math.min(s.expiresAt, s.lastCommanderSeenAt + LIMITS.commanderAbsentCloseMs);
}

/** Which close reason (if any) applies at `now`. */
export function dueCloseReason(
  s: { expiresAt: number; lastCommanderSeenAt: number },
  commanderOnline: boolean,
  now: number,
): CloseReason | null {
  if (now >= s.expiresAt) return 'EXPIRED';
  if (!commanderOnline && now >= s.lastCommanderSeenAt + LIMITS.commanderAbsentCloseMs) {
    return 'COMMANDER_ABSENT';
  }
  return null;
}

export interface AlarmPlanInput {
  expiresAt: number;
  lastCommanderSeenAt: number;
  /** A hello-completed commander socket exists. */
  commanderOnline: boolean;
  /** Earliest `connectedAt` among sockets that have not finished hello, or null. */
  oldestPendingHelloAt: number | null;
  now: number;
}

/**
 * Multiplexes every deadline onto the single DO alarm: room expiry, commander-absent close,
 * commander liveness tick (only while a commander socket exists) and hello timeout.
 */
export function planAlarm(i: AlarmPlanInput): number {
  let at = nextAlarmAt(i, i.commanderOnline);
  if (i.commanderOnline) at = Math.min(at, i.now + LIMITS.commanderLivenessTickMs);
  if (i.oldestPendingHelloAt !== null) at = Math.min(at, i.oldestPendingHelloAt + LIMITS.helloTimeoutMs);
  return Math.max(at, i.now + 1);
}

/**
 * Half-open detection. WebSocket pings are auto-answered without waking the DO, so the newest
 * of (last auto-response, last real message, hello time) is the proof of life.
 */
export function commanderStale(
  lastAutoResponseAt: number | null,
  lastMessageAt: number | null,
  connectedAt: number,
  now: number,
): boolean {
  const alive = Math.max(lastAutoResponseAt ?? 0, lastMessageAt ?? 0, connectedAt);
  return now - alive > LIMITS.commanderStaleMs;
}

export const helloExpired = (connectedAt: number, now: number): boolean =>
  now - connectedAt >= LIMITS.helloTimeoutMs;
