import type { Command, Party } from '@winds/protocol';
import { HUD_CONNECTION_LABEL } from '../../shared/labels';
import type { ConnectionStatus } from '../../net/RoomClient';
import { AllLine } from '../hud/AllLine';
import { CommandCard, type RestoreKind } from '../hud/CommandCard';
import styles from './CompactHud.module.css';

const TONE: Record<ConnectionStatus, 'ok' | 'warn' | 'danger'> = {
  CONNECTING: 'warn',
  CONNECTED: 'ok',
  RECONNECTING: 'warn',
  OFFLINE: 'danger',
  CLOSED: 'danger',
  REPLACED: 'danger',
};

export interface CompactHudProps {
  connection: ConnectionStatus;
  hasSnapshot: boolean;
  parties: Party[];
  myParty?: Party;
  command: Command | null;
  original?: Command | null;
  supportFrom?: Party[];
  allLine?: Command | null;
  now: number;
  dimmed?: boolean;
  flashing?: boolean;
  pulsing?: boolean;
  struck?: boolean;
  restore?: RestoreKind | null;
  /** HUD font scale (settings.fontStep) */
  fontScale: number;
  reducedMotion?: boolean;
  audioBlocked?: boolean;
  onUnlockAudio?(): void;
  /** close the small window and go back to the main HUD */
  onReturn(): void;
}

/** F05 small-window layout: status line + my party card (+ latest ALL line). Presentational. */
export function CompactHud(p: CompactHudProps) {
  return (
    <div
      className={styles.root}
      data-testid="pip-hud"
      data-reduced-motion={p.reducedMotion ? 'true' : 'false'}
      style={{ ['--hud-fs' as string]: String(p.fontScale) }}
    >
      <header className={styles.top}>
        <span className={styles.conn} data-tone={TONE[p.connection]}>
          <span className={styles.dot} aria-hidden="true" />
        </span>
        <span className={styles.connText} data-testid="pip-connection" role="status">
          {HUD_CONNECTION_LABEL[p.connection]}
        </span>
        {p.myParty && <span className={styles.party}>{p.myParty.number}파티</span>}
        <button type="button" className={styles.back} data-testid="pip-return" onClick={p.onReturn}>
          되돌리기
        </button>
      </header>
      {p.connection === 'RECONNECTING' && (
        <div className={styles.band} role="alert" data-testid="pip-banner-reconnecting">
          다시 연결 중… 명령이 최신이 아닐 수 있음
        </div>
      )}
      {p.connection === 'OFFLINE' && (
        <div className={styles.band} data-tone="danger" role="alert" data-testid="pip-banner-offline">
          인터넷 연결 없음
        </div>
      )}
      {p.connection === 'REPLACED' && (
        <div className={styles.band} data-tone="danger" role="alert" data-testid="pip-banner-replaced">
          다른 탭에서 열렸습니다
        </div>
      )}
      {p.audioBlocked && (
        <button type="button" className={styles.sound} data-testid="pip-enable-sound" onClick={p.onUnlockAudio}>
          소리 켜기
        </button>
      )}
      <div className={styles.body}>
        {!p.hasSnapshot ? (
          <p className={styles.hint}>방 정보를 불러오는 중…</p>
        ) : (
          <>
            {!p.myParty && (
              <p className={styles.hint} data-testid="pip-unselected-hint">
                내 파티를 고르면 내 명령이 보입니다 (본 창에서 선택)
              </p>
            )}
            {p.myParty && (
              <CommandCard
                command={p.command}
                parties={p.parties}
                owner={p.myParty}
                original={p.original}
                supportFrom={p.supportFrom}
                now={p.now}
                dimmed={p.dimmed}
                flashing={p.flashing}
                pulsing={p.pulsing}
                struck={p.struck}
                restore={p.restore}
                testId="pip-card"
                idPrefix="pip-card"
              />
            )}
            {p.allLine && <AllLine command={p.allLine} now={p.now} dimmed={p.dimmed} />}
          </>
        )}
      </div>
    </div>
  );
}
