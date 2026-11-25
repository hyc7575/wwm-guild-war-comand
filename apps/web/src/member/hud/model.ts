import type { Command, Location, Party, PartyId, Slots, Target } from '@winds/protocol';
import { LIMITS } from '@winds/protocol';
import { partyNumbersLabel } from '../../shared/labels';

/** Pure derivations for the HUD. Slot rules are NEVER recomputed here: the top of a server slot stack is the current command. */

export const HISTORY_MAX = 50;

export function currentOf(slots: Slots, commands: Record<string, Command>, partyId: PartyId): Command | null {
  const stack = slots[partyId];
  const id = stack?.[stack.length - 1];
  return (id !== undefined ? commands[id] : undefined) ?? null;
}

export function isForParty(cmd: Command, partyId: PartyId | null): boolean {
  if (cmd.target.kind === 'ALL') return true;
  return partyId !== null && cmd.target.partyIds.includes(partyId);
}

/** F06: the most recent ALL command (still valid: not cancelled / corrected away). */
export function latestAllCommand(commands: Record<string, Command>): Command | null {
  let best: Command | null = null;
  for (const c of Object.values(commands)) {
    if (c.target.kind !== 'ALL') continue;
    if (c.status === 'CANCELLED' || c.status === 'CORRECTED') continue;
    if (!best || c.seq > best.seq) best = c;
  }
  return best;
}

/** F06 FR-F06-4: parties whose CURRENT command is SUPPORT naming my party. */
export function supportersOf(
  myPartyId: PartyId,
  parties: Party[],
  slots: Slots,
  commands: Record<string, Command>,
): Party[] {
  return parties.filter((p) => {
    if (p.id === myPartyId) return false;
    const c = currentOf(slots, commands, p.id);
    return !!c && c.action === 'SUPPORT' && !!c.supportPartyIds?.includes(myPartyId);
  });
}

export interface Changed {
  action: boolean;
  location: boolean;
  target: boolean;
}

export function sameTarget(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ALL' || b.kind === 'ALL') return true;
  const x = [...a.partyIds].sort().join(',');
  const y = [...b.partyIds].sort().join(',');
  return x === y;
}

/** FR-F05-3: which parts of a correction differ from the original. */
export function diffCommands(orig: Command, now: Command): Changed {
  return {
    action: orig.action !== now.action,
    location: (orig.location?.id ?? '') !== (now.location?.id ?? '') || (orig.location?.label ?? '') !== (now.location?.label ?? ''),
    target:
      !sameTarget(orig.target, now.target) ||
      [...(orig.supportPartyIds ?? [])].sort().join(',') !== [...(now.supportPartyIds ?? [])].sort().join(','),
  };
}

export function locationCell(loc: Location | undefined): 'LEFT' | 'CENTER' | 'RIGHT' | null {
  const id = loc?.id.toLowerCase();
  if (id === 'left') return 'LEFT';
  if (id === 'center') return 'CENTER';
  if (id === 'right') return 'RIGHT';
  return null;
}

/** The moment that counts for age: a repeat refreshes the command. */
export function touchedAt(c: Command): number {
  return c.repeatedAt ?? c.issuedAt;
}

export function isStale(c: Command, now: number): boolean {
  return now - touchedAt(c) > LIMITS.staleCommandMs;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function targetText(target: Target, parties: Party[]): string {
  return target.kind === 'ALL' ? '전체' : partyNumbersLabel(parties, target.partyIds);
}

export type HistoryFilter = 'mine' | 'all';

/** FR-F06-7: newest first, max 50. "mine" = targets my party or ALL. */
export function historyOf(
  commands: Record<string, Command>,
  filter: HistoryFilter,
  myPartyId: PartyId | null,
  limit = HISTORY_MAX,
): Command[] {
  const all = Object.values(commands).sort((a, b) => b.seq - a.seq || b.issuedAt - a.issuedAt);
  const list = filter === 'mine' ? all.filter((c) => isForParty(c, myPartyId)) : all;
  return list.slice(0, limit);
}

/** The command that replaced a CORRECTED one. */
export function correctedTo(commands: Record<string, Command>, id: string): Command | undefined {
  return Object.values(commands).find((c) => c.correctsId === id);
}
