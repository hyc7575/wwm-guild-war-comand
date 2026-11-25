import type { Command, Party } from '@winds/protocol';
import { ACTION_LABEL, CANCEL_REASON_SHORT } from '../../shared/labels';
import { correctedTo, formatClock, targetText, type HistoryFilter } from './model';
import styles from './HistoryList.module.css';

export interface HistoryListProps {
  parties: Party[];
  /** Newest first, already filtered and capped. */
  rows: Command[];
  /** every known command, to resolve "정정 → ..." */
  commands: Record<string, Command>;
  filter: HistoryFilter;
  onFilter(f: HistoryFilter): void;
  /** hide the "내 파티 관련만" option (no party chosen) */
  canFilterMine?: boolean;
  /** room setting shareTranscript */
  showTranscript?: boolean;
}

function summary(c: Command, parties: Party[]): string {
  return `${targetText(c.target, parties)} ${ACTION_LABEL[c.action]}${c.location ? ` ${c.location.label}` : ''}`;
}

/** FR-F06-7/8. Presentational. */
export function HistoryList({ parties, rows, commands, filter, onFilter, canFilterMine = true, showTranscript = false }: HistoryListProps) {
  return (
    <div className={styles.wrap}>
      {canFilterMine && (
        <div className={styles.filters} role="group" aria-label="이력 필터">
          <button type="button" aria-pressed={filter === 'mine'} onClick={() => onFilter('mine')} data-testid="history-filter-mine">
            내 파티 관련만
          </button>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => onFilter('all')} data-testid="history-filter-all">
            전체
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className={styles.empty}>이력이 없습니다</p>
      ) : (
        <ol className={styles.list}>
          {rows.map((c) => {
            const fixed = c.status === 'CORRECTED' ? correctedTo(commands, c.id) : undefined;
            return (
              <li key={c.id} className={styles.row} data-testid="history-row" data-status={c.status}>
                <span className={styles.time}>{formatClock(c.issuedAt)}</span>
                <span className={styles.body} data-struck={c.status === 'CANCELLED' ? 'true' : undefined}>
                  {summary(c, parties)}
                </span>
                {showTranscript && c.transcript && (
                  <span className={styles.transcript} data-testid="history-transcript">
                    “{c.transcript}”
                  </span>
                )}
                {c.repeatCount > 0 && <span className={styles.tag}>반복 {c.repeatCount}회</span>}
                {c.status === 'CORRECTED' && (
                  <span className={styles.tag} data-kind="corrected">
                    정정{fixed ? ` → ${summary(fixed, parties)}` : ''}
                  </span>
                )}
                {c.status === 'CANCELLED' && (
                  <span className={styles.tag} data-kind="cancelled">
                    취소{c.cancelReason ? `: ${CANCEL_REASON_SHORT[c.cancelReason]}` : ''}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
