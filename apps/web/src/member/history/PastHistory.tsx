import { useEffect, useState } from 'react';
import { ACTION_LABEL, CANCEL_REASON_SHORT, ISSUER_LABEL } from '../../shared/labels';
import { getHistoryStore, type HistoryStore } from './HistoryStore';
import type { HistoryEntry, RoomHistory } from './types';
import styles from './PastHistory.module.css';

export function entryTarget(e: HistoryEntry): string {
  if (e.target === 'ALL') return '전체';
  return e.target.length ? `${e.target.join('·')}파티` : '(삭제된 파티)';
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_LABEL: Record<HistoryEntry['status'], string> = {
  ACTIVE: '진행',
  SUPERSEDED: '대체됨',
  CORRECTED: '정정됨',
  CANCELLED: '취소',
};

function Row({ e }: { e: HistoryEntry }) {
  return (
    <li className={styles.row} data-testid="past-row" data-status={e.status}>
      <span className={styles.time}>{stamp(e.issuedAt)}</span>
      <span>
        {entryTarget(e)} {ACTION_LABEL[e.action]}
        {e.location ? ` ${e.location}` : ''}
        {e.support?.length ? ` (지원 ${e.support.join('·')}파티)` : ''}
      </span>
      <span className={styles.tag}>
        {STATUS_LABEL[e.status]}
        {e.status === 'CANCELLED' && e.cancelReason ? `: ${CANCEL_REASON_SHORT[e.cancelReason]}` : ''}
      </span>
      {e.issuerRole && <span className={styles.tag}>{ISSUER_LABEL[e.issuerRole]}</span>}
      {e.transcript && <span className={styles.transcript}>“{e.transcript}”</span>}
    </li>
  );
}

export interface PastHistoryProps {
  /** Room being viewed now: its entries not in `currentIds` show as "이전 접속분". */
  roomCode: string;
  currentIds: ReadonlySet<string>;
  history?: HistoryStore;
}

/** F07 local history, read-only: earlier visits to this room plus other (ended) rooms from this browser. */
export function PastHistory({ roomCode, currentIds, history }: PastHistoryProps) {
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<RoomHistory[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (history ?? getHistoryStore()).listRooms().then((r) => alive && setRooms(r));
    return () => {
      alive = false;
    };
  }, [open, history]);

  const mine = rooms?.find((r) => r.roomCode === roomCode);
  const earlier = (mine?.entries ?? []).filter((e) => !currentIds.has(e.id));
  const others = (rooms ?? []).filter((r) => r.roomCode !== roomCode);

  return (
    <section className={styles.wrap}>
      <button type="button" className={styles.toggle} aria-expanded={open} data-testid="past-toggle" onClick={() => setOpen((v) => !v)}>
        지난 이력 보기 {open ? '▾' : '▸'}
      </button>
      {open && rooms && (
        <div data-testid="past-body">
          <h3 className={styles.h3}>이 방의 이전 접속분</h3>
          {earlier.length ? (
            <ol className={styles.list}>{earlier.map((e) => <Row key={e.id} e={e} />)}</ol>
          ) : (
            <p className={styles.empty}>없음</p>
          )}
          <h3 className={styles.h3}>다른 방</h3>
          {others.length ? (
            others.map((r) => (
              <details key={r.roomCode} className={styles.room} data-testid="past-room">
                <summary>
                  {r.roomCode} · {r.closed ? '종료됨' : '마지막 접속 ' + stamp(r.lastSeenAt)} · {r.entries.length}건
                </summary>
                <ol className={styles.list}>{r.entries.map((e) => <Row key={e.id} e={e} />)}</ol>
              </details>
            ))
          ) : (
            <p className={styles.empty}>없음</p>
          )}
          <p className={styles.note}>이 브라우저에만 저장된 최근 이력입니다(다른 기기와 동기화되지 않음).</p>
        </div>
      )}
    </section>
  );
}
