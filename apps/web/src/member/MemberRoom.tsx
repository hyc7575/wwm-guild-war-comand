import { useState } from 'react';
import type { Party } from '@winds/protocol';
import { useRoomSession } from '../net/RoomSession';
import { loadPartyChoice } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { RoomOverview } from '../shared/RoomOverview';
import { StatusBar } from '../shared/StatusBar';
import { partyById, partyLabel } from '../shared/labels';
import { useRoomStore } from '../state/roomStore';
import { RoomMessage } from '../pages/NotFoundRoom';
import { PartyPicker } from './PartyPicker';
import styles from './MemberRoom.module.css';

/**
 * Member screen. For now: party picker + placeholder overview.
 * The F05/F06 HUD replaces <RoomOverview /> here.
 */
export function MemberRoom({ code, fallbackParties }: { code: string; fallbackParties: Party[] }) {
  const { chooseParty } = useRoomSession();
  const connection = useRoomStore((s) => s.connection);
  const closeReason = useRoomStore((s) => s.closeReason);
  const hasSnapshot = useRoomStore((s) => s.hasSnapshot);
  const parties = useRoomStore((s) => s.parties);
  const presence = useRoomStore((s) => s.presence);
  const myPartyId = useRoomStore((s) => s.myPartyId);
  const needsPartyPick = useRoomStore((s) => s.needsPartyPick);
  const dismissPartyPick = useRoomStore((s) => s.dismissPartyPick);

  // Has the user ever picked in this room (incl. "아직 모름")? Otherwise show the picker right away.
  const [picked, setPicked] = useState(() => loadPartyChoice(code) !== undefined);
  const [changing, setChanging] = useState(false);

  if (closeReason === 'ROOM_NOT_FOUND') return <RoomMessage title="방을 찾을 수 없습니다" />;
  if (closeReason === 'ROOM_FULL') return <RoomMessage title="방이 가득 찼습니다" />;

  const showPicker = connection !== 'CLOSED' && (!picked || changing || needsPartyPick);
  const list = hasSnapshot ? parties : fallbackParties;

  if (showPicker) {
    return (
      <>
        <StatusBar />
        <PartyPicker
          parties={list}
          counts={presence.byParty}
          hasCounts={hasSnapshot}
          selected={needsPartyPick ? undefined : myPartyId}
          onPick={(id) => {
            chooseParty(id);
            setPicked(true);
            setChanging(false);
          }}
          onCancel={picked && !needsPartyPick ? () => setChanging(false) : needsPartyPick ? dismissPartyPick : undefined}
        />
        <NoticeToast />
      </>
    );
  }

  const mine = myPartyId ? partyById(list, myPartyId) : undefined;
  return (
    <>
      <StatusBar />
      {connection === 'CLOSED' && <p className={styles.closed}>오더방이 종료되었습니다</p>}
      <div className={styles.mine}>
        <span>내 파티: {mine ? partyLabel(mine) : '아직 모름'}</span>
        <button type="button" className={styles.change} onClick={() => setChanging(true)}>
          변경
        </button>
      </div>
      <RoomOverview />
      <NoticeToast />
    </>
  );
}
