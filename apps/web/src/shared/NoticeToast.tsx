import { useRoomStore } from '../state/roomStore';
import styles from './NoticeToast.module.css';

/** Transient notice (3s, auto-cleared by the store), e.g. "파티 구성이 바뀌었습니다". */
export function NoticeToast() {
  const notice = useRoomStore((s) => s.notice);
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {notice && <div className={styles.toast}>{notice.text}</div>}
    </div>
  );
}
