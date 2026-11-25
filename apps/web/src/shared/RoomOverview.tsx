import { useShallow } from 'zustand/react/shallow';
import { selectCurrentCommand, useRoomStore } from '../state/roomStore';
import { ACTION_LABEL, CANCEL_REASON_LABEL, partyLabel, targetLabel } from './labels';
import { partyColorStyle } from './partyColor';
import styles from './RoomOverview.module.css';

/**
 * Placeholder room view: parties, current command per party, presence.
 * The real HUD (F05/F06) lives in src/member and replaces this for members.
 */
export function RoomOverview() {
  const { parties, presence, connection, hasSnapshot } = useRoomStore(
    useShallow((s) => ({ parties: s.parties, presence: s.presence, connection: s.connection, hasSnapshot: s.hasSnapshot })),
  );
  const slots = useRoomStore((s) => s.slots);
  const commands = useRoomStore((s) => s.commands);
  const stale = connection !== 'CONNECTED';

  if (!hasSnapshot) return <p className={styles.empty}>방 정보를 불러오는 중…</p>;

  return (
    <section aria-label="파티 현황">
      <p className={styles.presence}>
        접속 {presence.total}명 · 미지정 {presence.unassigned}명
      </p>
      <ul className={`${styles.list} ${stale ? styles.stale : ''}`}>
        {parties.map((p) => {
          const cmd = selectCurrentCommand({ slots, commands }, p.id);
          return (
            <li key={p.id} className={styles.row} style={partyColorStyle(p)}>
              <div className={styles.head}>
                <strong>{partyLabel(p)}</strong>
                <span className={styles.count}>{presence.byParty[p.id] ?? 0}명</span>
              </div>
              {cmd ? (
                <div className={styles.cmd}>
                  <span className={styles.action}>{ACTION_LABEL[cmd.action]}</span>
                  <span>{targetLabel(cmd.target, parties)}</span>
                  {cmd.location && <span>{cmd.location.label}</span>}
                  {cmd.repeatCount > 0 && <span className={styles.badge}>x{cmd.repeatCount + 1}</span>}
                  {cmd.cancelReason && <span className={styles.badge}>{CANCEL_REASON_LABEL[cmd.cancelReason]}</span>}
                </div>
              ) : (
                <div className={styles.none}>명령 없음</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
