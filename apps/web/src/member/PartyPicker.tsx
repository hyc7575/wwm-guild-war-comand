import type { Party, PartyId } from '@winds/protocol';
import { partyColorStyle } from '../shared/partyColor';
import styles from './PartyPicker.module.css';

interface Props {
  parties: Party[];
  counts: Record<PartyId, number>;
  /** null = no count yet (not connected) */
  hasCounts: boolean;
  selected: PartyId | null | undefined;
  onPick(partyId: PartyId | null): void;
  onCancel?(): void;
}

/** F01 party selection. All buttons are >= 48px tall. */
export function PartyPicker({ parties, counts, hasCounts, selected, onPick, onCancel }: Props) {
  return (
    <section className={styles.wrap} aria-labelledby="picker-title">
      <h1 id="picker-title" className={styles.title}>
        어느 파티인가요?
      </h1>
      <div className={styles.grid}>
        {parties.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.btn}
            style={partyColorStyle(p)}
            aria-pressed={selected === p.id}
            onClick={() => onPick(p.id)}
          >
            <span className={styles.num}>{p.number}</span>
            <span className={styles.name}>{p.name ?? `${p.number}파티`}</span>
            <span className={styles.count}>{hasCounts ? `${counts[p.id] ?? 0}명` : '–'}</span>
          </button>
        ))}
        <button type="button" className={`${styles.btn} ${styles.unknown}`} aria-pressed={selected === null} onClick={() => onPick(null)}>
          아직 모름
        </button>
      </div>
      {onCancel && (
        <button type="button" className={styles.cancel} onClick={onCancel}>
          닫기
        </button>
      )}
    </section>
  );
}
