import { useRoomStore } from '../state/roomStore';
import { CONNECTION_LABEL } from './labels';
import styles from './StatusBar.module.css';

const TONE = {
  CONNECTING: 'warn',
  CONNECTED: 'ok',
  RECONNECTING: 'warn',
  OFFLINE: 'danger',
  CLOSED: 'danger',
  REPLACED: 'danger',
} as const;

/** FR-F10-1: always-visible connection state. Also shows commander-offline for members (FR-F10-6). */
export function StatusBar() {
  const connection = useRoomStore((s) => s.connection);
  const role = useRoomStore((s) => s.role);
  const hasSnapshot = useRoomStore((s) => s.hasSnapshot);
  const commanderOnline = useRoomStore((s) => s.presence.commanderOnline);
  const sttState = useRoomStore((s) => s.presence.sttState);
  const roomCode = useRoomStore((s) => s.roomCode);

  const showCommanderOffline = role === 'MEMBER' && connection === 'CONNECTED' && hasSnapshot && !commanderOnline;
  const showSttOff = role === 'MEMBER' && connection === 'CONNECTED' && commanderOnline && sttState !== 'LISTENING';

  return (
    <div className={styles.wrap}>
      <div className={`${styles.bar} ${styles[TONE[connection]]}`} role="status" aria-live="polite" data-testid="status-bar">
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.text}>{CONNECTION_LABEL[connection]}</span>
        {roomCode && <span className={styles.code}>{roomCode}</span>}
      </div>
      {showCommanderOffline && <div className={`${styles.sub} ${styles.warn}`}>메인오더 연결 끊김</div>}
      {showSttOff && <div className={`${styles.sub} ${styles.dim}`}>음성인식 꺼짐</div>}
    </div>
  );
}
