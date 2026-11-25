import type { Command, Party, PartyId } from '@winds/protocol';

/** F06 grid layout: pure helpers so the column count and ordering can be tested without the DOM. */

/** Idle parties are shrunk only when this many parties (or more) are in the room. */
export const COMPACT_MIN_PARTIES = 8;

export type GridTier = 'phone' | 'tablet' | 'wide';

/** Viewport width -> tier. phone < 600px, tablet < 900px, wide >= 900px (FR-F05-8 breakpoint). */
export function gridTier(width: number): GridTier {
  return width >= 900 ? 'wide' : width >= 600 ? 'tablet' : 'phone';
}

/** Columns for `count` cells: phones 2, tablets 3, wide screens 3 (<=6 cells) or 4. Never more than `count`. */
export function gridColumns(count: number, tier: GridTier): number {
  if (count <= 1) return 1;
  const base = tier === 'phone' ? 2 : tier === 'tablet' ? 3 : count <= 6 ? 3 : 4;
  return Math.min(base, count);
}

/** Whether idle cells shrink: only with the "active first" option on and a big room. */
export function shouldCompactIdle(totalParties: number, activeFirst: boolean): boolean {
  return activeFirst && totalParties >= COMPACT_MIN_PARTIES;
}

/**
 * Display order. Default is party-number order (FR-F06-5/6). With `activeFirst`, parties that hold a command
 * come first; both groups keep party-number order. Input order is the party-number order; the sort is stable.
 */
export function orderParties(parties: Party[], commandOf: (id: PartyId) => Command | null, activeFirst: boolean): Party[] {
  if (!activeFirst) return parties;
  const active: Party[] = [];
  const idle: Party[] = [];
  for (const p of parties) (commandOf(p.id) ? active : idle).push(p);
  return [...active, ...idle];
}
