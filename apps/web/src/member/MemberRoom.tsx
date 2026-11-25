import { useState } from 'react';
import type { Party } from '@winds/protocol';
import { useRoomSession } from '../net/RoomSession';
import { loadPartyChoice } from '../net/session';
import { NoticeToast } from '../shared/NoticeToast';
import { StatusBar } from '../shared/StatusBar';
import { useRoomStore } from '../state/roomStore';
import { RoomMessage } from '../pages/NotFoundRoom';
import { MemberHud } from './hud';
import { PartyPicker } from './PartyPicker';
import styles from './MemberRoom.module.css';

/** Member screen: first-time party picker, then the F05/F06 HUD (picker reopens as an overlay). */
export function MemberRoom({ code, fallbackParties }: { code: string; fallbackParties: Party[] }) {
  const { chooseParty } = useRoomSession();
  const connection = useRoomStore((s) => s.connection);
  const closeReason = useRoomStore((s) => s.closeReason);
  const roomStatus = useRoomStore((s) => s.roomStatus);
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

  const closed = connection === 'CLOSED' || roomStatus === 'CLOSED';
  const showPicker = !closed && (!picked || changing || needsPartyPick);
  const list = hasSnapshot ? parties : fallbackParties;

  const picker = (
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
  );

  // First visit: picker alone, no HUD yet.
  if (showPicker && !picked) {
    return (
      <>
        <StatusBar />
        {picker}
        <NoticeToast />
      </>
    );
  }

  return (
    <>
      <MemberHud onChangeParty={() => setChanging(true)} />
      {showPicker && <div className={styles.overlay}>{picker}</div>}
    </>
  );
}
