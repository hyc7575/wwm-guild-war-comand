import type { Presence } from '@winds/protocol';
import type { ConnectionStatus } from '../../net/RoomClient';
import { HUD_CONNECTION_LABEL } from '../../shared/labels';
import styles from './HudStatusBar.module.css';

const TONE: Record<ConnectionStatus, 'ok' | 'warn' | 'danger'> = {
  CONNECTING: 'warn',
  CONNECTED: 'ok',
  RECONNECTING: 'warn',
  OFFLINE: 'danger',
  CLOSED: 'danger',
  REPLACED: 'danger',
};

export interface HudStatusBarProps {
  connection: ConnectionStatus;
  hasSnapshot: boolean;
  presence: Presence;
  /** "3파티" or undefined when no party chosen */
  myPartyText?: string;
  onChangeParty(): void;
  onOpenSettings(): void;
  /** Document PiP small window; omit to hide the button (unsupported browsers) */
  onOpenPip?(): void;
}

/** Main-commander / voice status line (FR-F05-11, FR-F10-6). Shared by the status bar and the PiP window; null while not live. */
export function commanderStatus(connection: ConnectionStatus, hasSnapshot: boolean, presence: Presence): { text: string; tone: 'ok' | 'warn' | 'dim' } | null {
  if (connection !== 'CONNECTED' || !hasSnapshot) return null;
  if (!presence.commanderOnline) return { text: '메인오더 연결 끊김', tone: 'warn' };
  if (presence.sttState === 'LISTENING') return { text: '듣는 중', tone: 'ok' };
  if (presence.sttState === 'STARTING') return { text: '음성인식 켜는 중', tone: 'dim' };
  return { text: '음성인식 꺼짐', tone: 'dim' };
}

/** FR-F05-11 / F10 / FR-F02-10. Presentational. */
export function HudStatusBar({ connection, hasSnapshot, presence, myPartyText, onChangeParty, onOpenSettings, onOpenPip }: HudStatusBarProps) {
  const live = connection === 'CONNECTED' && hasSnapshot;
  const commander = commanderStatus(connection, hasSnapshot, presence);
  return (
    <header className={styles.bar}>
      <span className={styles.conn} data-tone={TONE[connection]} data-testid="status-connection" role="status">
        <span className={styles.dot} aria-hidden="true" />
        {HUD_CONNECTION_LABEL[connection]}
      </span>
      <button type="button" className={styles.party} onClick={onChangeParty} data-testid="my-party-selector">
        내 파티: {myPartyText ?? '아직 모름'} ▼
      </button>
      {commander && (
        <span className={styles.cmdr} data-tone={commander.tone} data-testid="status-commander">
          {commander.text}
        </span>
      )}
      {live && <span className={styles.count}>{presence.total}명</span>}
      {onOpenPip && (
        <button type="button" className={styles.gear} onClick={onOpenPip} aria-label="작은 창으로 띄우기" title="작은 창으로 띄우기 (항상 위)" data-testid="open-pip">
          ⧉
        </button>
      )}
      <button type="button" className={styles.gear} onClick={onOpenSettings} aria-label="설정" data-testid="open-settings">
        ⚙
      </button>
    </header>
  );
}
