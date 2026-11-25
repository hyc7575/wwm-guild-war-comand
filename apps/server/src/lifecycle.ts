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
