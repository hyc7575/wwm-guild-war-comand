import type { Command, Party } from '@winds/protocol';
import { ACTION_LABEL, partyNumbersLabel } from '../../shared/labels';
import { partyColorStyle } from '../../shared/partyColor';
import { ActionIcon } from './ActionIcon';
import { isStale } from './model';
import styles from './PartyGrid.module.css';

export interface PartyGridProps {
  /** Parties to show, already ordered by party number. */
  parties: Party[];
  commandOf(partyId: string): Command | null;
  now: number;
  /** equal-size big cells (no party chosen yet, FR-F06-6) */
  large?: boolean;
  dimmed?: boolean;
  onSelect?(party: Party): void;
}

/** FR-F06-5: compact cells, party-number order. Presentational. */
export function PartyGrid({ parties, commandOf, now, large, dimmed, onSelect }: PartyGridProps) {
  return (
    <ul className={styles.grid} data-large={large ? 'true' : undefined} data-dimmed={dimmed ? 'true' : undefined} aria-label="파티별 명령">
      {parties.map((p) => {
        const c = commandOf(p.id);
        const support = c?.action === 'SUPPORT' && c.supportPartyIds?.length ? `→${partyNumbersLabel(parties, c.supportPartyIds)}` : '';
        return (
          <li key={p.id}>
            <button
              type="button"
              className={styles.cell}
              style={partyColorStyle(p)}
              data-testid={`party-cell-${p.number}`}
              data-stale={c && isStale(c, now) ? 'true' : undefined}
              onClick={() => onSelect?.(p)}
            >
              <span className={styles.head}>
                <span className={styles.num}>{p.number}</span>
                <span className={styles.name}>{p.name ?? `${p.number}파티`}</span>
              </span>
              {c ? (
                <span className={styles.cmd}>
                  <ActionIcon action={c.action} size={large ? 36 : 24} />
                  <span className={styles.act}>
                    {ACTION_LABEL[c.action]}
                    {support}
                  </span>
                  {c.location && <span className={styles.loc}>{c.location.label}</span>}
                </span>
              ) : (
                <span className={styles.empty}>—</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
