import type { Party } from '@winds/protocol';
import type { CSSProperties } from 'react';

/** `style` that exposes the party's color token as --party-color. */
export function partyColorStyle(p: Pick<Party, 'color'>): CSSProperties {
  return { ['--party-color' as string]: `var(--${/^p\d{1,2}$/.test(p.color) ? p.color : 'p1'})` };
}
