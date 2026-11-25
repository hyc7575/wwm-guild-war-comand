import type { Command, Party } from '@winds/protocol';
import { ACTION_LABEL } from '../../shared/labels';
import { ActionIcon } from './ActionIcon';
import { formatElapsed, touchedAt } from './model';
import styles from './AllLine.module.css';

/** "전체: 집결 · 중앙 (2분 전)" (F06 전체 명령 줄). Presentational. */
export function AllLine({ command, now, dimmed }: { command: Command; parties?: Party[]; now: number; dimmed?: boolean }) {
  return (
    <p className={styles.line} data-testid="all-line" data-dimmed={dimmed ? 'true' : undefined}>
      <span className={styles.label}>전체:</span>
      <ActionIcon action={command.action} size={20} />
      <strong>{ACTION_LABEL[command.action]}</strong>
      {command.location && <span>· {command.location.label}</span>}
      <span className={styles.age}>({formatElapsed(now - touchedAt(command))})</span>
    </p>
  );
}
