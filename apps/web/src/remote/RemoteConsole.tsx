import { useEffect, useMemo, useReducer, useRef } from 'react';
import { selectCurrentCommand, useRoomStore } from '../state/roomStore';
import { ACTION_LABEL, ACTION_ORDER, CONNECTION_LABEL, ISSUER_LABEL, partyLabel, partyNumbersLabel } from '../shared/labels';
import { partyColorStyle } from '../shared/partyColor';
import { useConsole } from '../commander/console/ConsoleProvider';
import { findCurrentAllCommand } from '../commander/console/selectors';
import { EMPTY_PANEL, panelDraft, panelReducer } from '../commander/console/panelState';
import { AckToasts, ErrorToast } from '../commander/console/AckPanel';
import { useWakeLock, vibrate } from './device';
import styles from './remote.module.css';

const CLOSE_LABEL: Partial<Record<string, string>> = {
  UNAUTHORIZED: '리모컨 링크가 올바르지 않거나 만료되었습니다',
  ROOM_FULL: '방이 가득 찼습니다',
  ROOM_NOT_FOUND: '방을 찾을 수 없습니다',
};
function statusText(connection: keyof typeof CONNECTION_LABEL, closeReason: string | null): string {
  return (connection === 'CLOSED' && closeReason && CLOSE_LABEL[closeReason]) || CONNECTION_LABEL[connection];
}

/** Phone remote for the main commander: one-handed target -> action -> location -> publish, plus a big "직전 취소". Reuses the console controller and panel reducer unchanged. */
export function RemoteConsole({ code }: { code: string }) {
  const c = useConsole();
  const parties = useRoomStore((s) => s.parties);
  const connection = useRoomStore((s) => s.connection);
  const closeReason = useRoomStore((s) => s.closeReason);
  const hasSnapshot = useRoomStore((s) => s.hasSnapshot);
  const slots = useRoomStore((s) => s.slots);
  const commands = useRoomStore((s) => s.commands);
  const [panel, dispatch] = useReducer(panelReducer, EMPTY_PANEL);
  const locations = useMemo(() => c.locations(), [c]);
  useWakeLock();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Reserve room under the summary for the fixed bottom panel (whose height varies with the party count).
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => rootRef.current?.style.setProperty('--panel-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const live = connection === 'CONNECTED';
  const draft = panelDraft(panel);
  const all = findCurrentAllCommand({ slots, commands });

  useEffect(() => {
    dispatch({ type: 'prune', validPartyIds: parties.map((p) => p.id) });
  }, [parties]);

  const publish = () => {
    if (!draft || !live) return;
    c.issueManual(draft);
    vibrate(40);
    dispatch({ type: 'reset' });
  };
  const cancelLast = () => {
    if (!live) return;
    c.cancelLast();
    vibrate([30, 50, 30]);
  };

  const tone = live ? '' : connection === 'CLOSED' || connection === 'REPLACED' || connection === 'OFFLINE' ? styles.bannerDanger : styles.bannerWarn;

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={`${styles.banner} ${tone}`} role="status" aria-live="polite" data-testid="remote-status">
        {statusText(connection, closeReason)}
        <div className={styles.role}>
          휴대폰 리모컨 · 서브오더 권한 · 방 <span data-testid="room-code">{code}</span>
        </div>
      </div>

      <ul className={`${styles.summary} ${live ? '' : styles.stale}`} aria-label="파티별 현재 명령" data-testid="remote-summary">
        {!hasSnapshot && <li>방 정보를 불러오는 중…</li>}
        {hasSnapshot && all && (
          <li className={styles.row} data-testid="remote-row-all">
            <strong>
              전체 {ACTION_LABEL[all.action]} {all.location?.label ?? ''}
            </strong>
            {all.issuer && <span> · {ISSUER_LABEL[all.issuer.role]}</span>}
          </li>
        )}
        {hasSnapshot &&
          parties.map((p) => {
            const cmd = selectCurrentCommand({ slots, commands }, p.id);
            return (
              <li key={p.id} className={styles.row} style={partyColorStyle(p)} data-testid={`remote-row-${p.number}`}>
                <strong>{partyLabel(p)}</strong>{' '}
                {cmd ? (
                  <>
                    {ACTION_LABEL[cmd.action]} {cmd.location?.label ?? ''}
                    {cmd.action === 'SUPPORT' && cmd.supportPartyIds?.length ? ` →${partyNumbersLabel(parties, cmd.supportPartyIds)}` : ''}
                    {cmd.issuer && <span> · {ISSUER_LABEL[cmd.issuer.role]}</span>}
                  </>
                ) : (
                  <span>—</span>
                )}
              </li>
            );
          })}
      </ul>

      <div className={styles.panel} ref={panelRef} data-testid="remote-panel">
        <div className={styles.panelScroll}>
        <div className={styles.group} role="group" aria-label="대상">
          <button type="button" className={styles.btn} aria-pressed={panel.all} disabled={!live} onClick={() => dispatch({ type: 'toggleAll' })} data-testid="remote-target-all">
            전체
          </button>
          {parties.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${styles.btn} ${styles.party}`}
              style={partyColorStyle(p)}
              aria-pressed={panel.partyIds.includes(p.id)}
              disabled={!live}
              onClick={() => dispatch({ type: 'toggleParty', id: p.id })}
              data-testid={`remote-target-${p.number}`}
            >
              {p.number}
            </button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label="행동">
          {ACTION_ORDER.map((a) => (
            <button key={a} type="button" className={styles.btn} aria-pressed={panel.action === a} disabled={!live} onClick={() => dispatch({ type: 'setAction', action: a })} data-testid={`remote-action-${a}`}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
        {panel.action === 'SUPPORT' && (
          <div className={styles.group} role="group" aria-label="지원 대상">
            {parties.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${styles.btn} ${styles.party}`}
                style={partyColorStyle(p)}
                aria-pressed={panel.supportPartyIds.includes(p.id)}
                disabled={!live}
                onClick={() => dispatch({ type: 'toggleSupport', id: p.id })}
                data-testid={`remote-support-${p.number}`}
              >
                지원 {p.number}
              </button>
            ))}
          </div>
        )}
        <div className={styles.group} role="group" aria-label="위치">
          {locations.map((l) => (
            <button key={l.id} type="button" className={styles.btn} aria-pressed={panel.location?.id === l.id} disabled={!live} onClick={() => dispatch({ type: 'setLocation', location: l })} data-testid={`remote-location-${l.id}`}>
              {l.label}
            </button>
          ))}
        </div>
        </div>
        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.publish}`} disabled={!live || !draft} onClick={publish} data-testid="remote-publish">
            발행
          </button>
          <button type="button" className={`${styles.btn} ${styles.cancel}`} disabled={!live} onClick={cancelLast} data-testid="remote-cancel-last">
            직전 취소
          </button>
        </div>
      </div>
      <AckToasts />
      <ErrorToast />
    </div>
  );
}
