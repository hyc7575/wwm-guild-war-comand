import type { Location } from '@winds/protocol';
import { locationCell } from './model';
import styles from './LocationBar.module.css';

const CELLS = [
  ['LEFT', '좌'],
  ['CENTER', '중'],
  ['RIGHT', '우'],
] as const;

/** 3-cell bar lighting the matching cell. Renders nothing for free-form location ids (label only). */
export function LocationBar({ location, changed }: { location: Location | undefined; changed?: boolean }) {
  const lit = locationCell(location);
  if (!lit) return null;
  return (
    <div className={styles.bar} data-testid="location-bar" data-lit={lit} data-changed={changed ? 'true' : undefined} aria-hidden="true">
      {CELLS.map(([key, label]) => (
        <span key={key} className={styles.cell} data-on={key === lit ? 'true' : 'false'}>
          {label}
        </span>
      ))}
    </div>
  );
}
