import type { Command, Party } from '@winds/protocol';
import { ACTION_LABEL, ISSUER_LABEL, partyLabel, partyNumbersLabel } from '../../shared/labels';
import { partyColorStyle } from '../../shared/partyColor';
import { ActionIcon, actionColor } from './ActionIcon';
import { LocationBar } from './LocationBar';
import { diffCommands, formatElapsed, isStale, targetText, touchedAt, type Changed } from './model';
import styles from './CommandCard.module.css';

export type RestoreKind = 'RESTORED' | 'EMPTY';

export interface CommandCardProps {
  command: Command | null;
  parties: Party[];
  /** Party this card belongs to (color + label). */
  owner?: Party;
  /** The command this one corrects, if known (highlights changed parts). */
  original?: Command | null;
  /** Parties whose current SUPPORT command points at this card's party. */
  supportFrom?: Party[];
  now: number;
  /** Connection is not live: command may be out of date (FR-F10-4). */
  dimmed?: boolean;
  /** Transient change animations (driven by the caller, see useCardEffects). */
  flashing?: boolean;
  pulsing?: boolean;
  struck?: boolean;
  restore?: RestoreKind | null;
  /** Recognised text shown small under the card (only when the room shares transcripts). */
  transcript?: string | null;
  /** data-testid of the card root. */
  testId?: string;
  /** Prefix of inner data-testids (`${p}-action`, ...). */
  idPrefix?: string;
}

const NO_CHANGE: Changed = { action: false, location: false, target: false };

/** F05 large card. Presentational: no store access. */
export function CommandCard({
  command,
  parties,
  owner,
  original,
  supportFrom = [],
  now,
  dimmed,
  flashing,
  pulsing,
  struck,
  restore,
  transcript,
  testId = 'my-party-card',
  idPrefix = 'my-card',
}: CommandCardProps) {
  const stale = !!command && isStale(command, now);
  const changed = command && original ? diffCommands(original, command) : NO_CHANGE;
  const isAll = command?.target.kind === 'ALL';
  const together =
    command && command.target.kind === 'PARTIES' && command.target.partyIds.length > 1
      ? partyNumbersLabel(parties, command.target.partyIds)
      : null;
  const supportTarget =
    command?.action === 'SUPPORT' && command.supportPartyIds?.length ? partyNumbersLabel(parties, command.supportPartyIds) : null;

  return (
    <section
      className={styles.card}
      style={{
        ...(owner ? partyColorStyle(owner) : {}),
        ['--card-accent' as string]: command ? actionColor(command.action) : 'var(--border)',
      }}
      data-testid={testId}
      data-empty={command ? undefined : 'true'}
      data-flash={flashing ? 'true' : undefined}
      data-pulse={pulsing ? 'true' : undefined}
      data-struck={struck ? 'true' : undefined}
      data-stale={stale ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      aria-label={owner ? `${partyLabel(owner)} 현재 명령` : '현재 명령'}
    >
      {restore && (
        <p className={styles.restore} data-testid="restore-notice" role="status">
          {restore === 'RESTORED' ? '이전 명령으로 복귀' : '명령 없음'}
        </p>
      )}
      {supportFrom.length > 0 && (
        <div className={styles.badges}>
          <span className={`${styles.badge} ${styles.support}`} data-testid={`${idPrefix}-badge-support`}>
            {partyNumbersLabel(parties, supportFrom.map((p) => p.id))} 지원 옴
          </span>
        </div>
      )}
      {command ? (
        <>
          <div className={styles.badges}>
            {isAll && (
              <span className={styles.badge} data-testid={`${idPrefix}-badge-all`}>
                전체
              </span>
            )}
            {together && <span className={styles.badge}>함께: {together}</span>}
            {command.correctsId && (
              <span className={`${styles.badge} ${styles.fix}`} data-testid={`${idPrefix}-badge-corrected`}>
                정정
              </span>
            )}
            {command.repeatCount > 0 && (
              <span className={styles.badge} data-testid={`${idPrefix}-repeat`}>
                반복 {command.repeatCount}회
              </span>
            )}
          </div>
          <div className={styles.main}>
            <ActionIcon action={command.action} size={96} />
            <div className={styles.action} data-testid={`${idPrefix}-action`} data-changed={changed.action ? 'true' : undefined}>
              {ACTION_LABEL[command.action]}
            </div>
            {supportTarget && (
              <div className={styles.arrow} data-changed={changed.target ? 'true' : undefined}>
                →{supportTarget}
              </div>
            )}
            {command.location && (
              <div className={styles.location} data-testid={`${idPrefix}-location`} data-changed={changed.location ? 'true' : undefined}>
                {command.location.label}
              </div>
            )}
            <LocationBar location={command.location} changed={changed.location} />
          </div>
          <div className={styles.foot}>
            {command.issuer && (
              <>
                <span className={styles.issuer} data-testid={`${idPrefix}-issuer`}>
                  {ISSUER_LABEL[command.issuer.role]}
                </span>
                <span aria-hidden="true"> · </span>
              </>
            )}
            <span>{formatElapsed(now - touchedAt(command))}</span>
            <span aria-hidden="true"> · </span>
            <span data-changed={changed.target ? 'true' : undefined}>{targetText(command.target, parties)}</span>
          </div>
          {transcript && (
            <p className={styles.transcript} data-testid={`${idPrefix}-transcript`}>
              “{transcript}”
            </p>
          )}
        </>
      ) : (
        <p className={styles.none}>대기 중인 명령 없음</p>
      )}
    </section>
  );
}
