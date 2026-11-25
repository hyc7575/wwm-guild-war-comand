import type { Presence, Role, SttState } from '@winds/protocol';

export interface ConnInfo {
  role: Role;
  partyId: string | null;
}

/** `total` counts non-commander connections (members + operators + sub-commanders). */
export function computePresence(
  conns: ConnInfo[],
  partyIds: string[],
  sttState: SttState,
): Presence {
  const known = new Set(partyIds);
  const byParty: Record<string, number> = {};
  for (const id of partyIds) byParty[id] = 0;
  let total = 0;
  let unassigned = 0;
  let commanderOnline = false;
  let operatorsOnline = 0;
  let subCommandersOnline = 0;
  for (const c of conns) {
    if (c.role === 'COMMANDER') {
      commanderOnline = true;
      continue;
    }
    if (c.role === 'OPERATOR') operatorsOnline++;
    if (c.role === 'SUB_COMMANDER') subCommandersOnline++;
    total++;
    if (c.partyId && known.has(c.partyId)) byParty[c.partyId]!++;
    else unassigned++;
  }
  return {
    total,
    byParty,
    unassigned,
    commanderOnline,
    operatorsOnline,
    subCommandersOnline,
    sttState: commanderOnline ? sttState : 'OFF',
  };
}
