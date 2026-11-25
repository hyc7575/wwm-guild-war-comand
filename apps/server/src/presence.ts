import type { Presence, SttState } from '@winds/protocol';

export interface ConnInfo {
  role: 'COMMANDER' | 'OPERATOR' | 'MEMBER';
  partyId: string | null;
}

/** `total` counts non-commander connections (members + operators). */
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
  for (const c of conns) {
    if (c.role === 'COMMANDER') {
      commanderOnline = true;
      continue;
    }
    if (c.role === 'OPERATOR') operatorsOnline++;
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
    sttState: commanderOnline ? sttState : 'OFF',
  };
}
