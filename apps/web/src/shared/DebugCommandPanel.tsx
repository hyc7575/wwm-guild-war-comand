import { useState } from 'react';
import type { Action, PartyId, Target } from '@winds/protocol';
import { useRoomSession } from '../net/RoomSession';
import { useRoomStore } from '../state/roomStore';
import { ACTION_LABEL, ACTION_ORDER, CANCEL_REASON_LABEL, LOCATION_PRESETS, STATUS_LABEL, partyLabel, targetLabel } from './labels';
import styles from './DebugCommandPanel.module.css';

/** TEMPORARY issue/cancel panel for commander and operator. Replaced by the F08 console. */
export function DebugCommandPanel() {
  const { client } = useRoomSession();
  const parties = useRoomStore((s) => s.parties);
  const commands = useRoomStore((s) => s.commands);
  const unsent = useRoomStore((s) => s.unsent);
  const lastAck = useRoomStore((s) => s.lastAck);
  const lastError = useRoomStore((s) => s.lastError);
  const dismissUnsent = useRoomStore((s) => s.dismissUnsent);

  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<PartyId[]>([]);
  const [location, setLocation] = useState<string>('');

  const toggle = (id: PartyId) => {
    setAll(false);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const issue = (action: Action) => {
    const target: Target = all || picked.length === 0 ? { kind: 'ALL' } : { kind: 'PARTIES', partyIds: picked };
    const loc = LOCATION_PRESETS.find((l) => l.id === location);
    client.request({ type: 'command.issue', target, action, location: loc, source: 'MANUAL' });
  };

  const recent = Object.values(commands)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 8);

  return (
    <section className={styles.panel} aria-label="명령 발행 (임시)">
      <h2>명령 발행 (임시 디버그)</h2>
      <div className={styles.chips} role="group" aria-label="대상">
        <button type="button" aria-pressed={all} className={styles.chip} onClick={() => { setAll(true); setPicked([]); }}>
          전체
        </button>
        {parties.map((p) => (
          <button key={p.id} type="button" aria-pressed={!all && picked.includes(p.id)} className={styles.chip} onClick={() => toggle(p.id)}>
            {p.number}
          </button>
        ))}
      </div>
      <div className={styles.chips} role="group" aria-label="위치">
        <button type="button" aria-pressed={location === ''} className={styles.chip} onClick={() => setLocation('')}>
          위치 없음
        </button>
        {LOCATION_PRESETS.map((l) => (
          <button key={l.id} type="button" aria-pressed={location === l.id} className={styles.chip} onClick={() => setLocation(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className={styles.chips} role="group" aria-label="행동">
        {ACTION_ORDER.map((a) => (
          <button key={a} type="button" className={styles.action} onClick={() => issue(a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>

      <ul className={styles.recent}>
        {recent.map((c) => (
          <li key={c.id}>
            <span>
              {targetLabel(c.target, parties)} {ACTION_LABEL[c.action]} {c.location?.label ?? ''}
            </span>
            <span className={styles.dim}>
              {STATUS_LABEL[c.status]}
              {c.cancelReason ? ` (${CANCEL_REASON_LABEL[c.cancelReason]})` : ''}
            </span>
            {c.status === 'ACTIVE' && (
              <button type="button" className={styles.cancel} onClick={() => client.request({ type: 'command.cancel', commandId: c.id })}>
                취소
              </button>
            )}
          </li>
        ))}
      </ul>

      {unsent.length > 0 && (
        <div className={styles.unsent} role="alert">
          <strong>전송되지 않은 명령</strong>
          <ul>
            {unsent.map((u) => (
              <li key={u.clientCmdId}>
                {describe(u.msg, parties)}
                <button type="button" onClick={() => dismissUnsent(u.clientCmdId)}>
                  닫기
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lastAck?.error && <p className={styles.err}>거부됨: {lastAck.error}</p>}
      {lastError && <p className={styles.err}>오류: {lastError.code}</p>}
      <p className={styles.dim}>{parties.map(partyLabel).join(' / ')}</p>
    </section>
  );
}

function describe(msg: { type: string } & Record<string, unknown>, parties: import('@winds/protocol').Party[]): string {
  if (msg.type === 'command.issue') {
    return `${targetLabel(msg.target as Target, parties)} ${ACTION_LABEL[msg.action as Action]}`;
  }
  return msg.type;
}
