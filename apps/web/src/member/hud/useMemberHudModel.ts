import { useMemo, useState } from 'react';
import type { Command, Party, PartyId, Presence } from '@winds/protocol';
import type { ConnectionStatus } from '../../net/RoomClient';
import { useRoomStore, type LastEvent } from '../../state/roomStore';
import {
  correctedTo,
  currentOf,
  historyOf,
  isForParty,
  latestAllCommand,
  supportersOf,
  type HistoryFilter,
} from './model';

export interface MemberHudModel {
  hasSnapshot: boolean;
  connection: ConnectionStatus;
  closed: boolean;
  /** RECONNECTING / OFFLINE: cards may be out of date (FR-F10-4) */
  dimmed: boolean;
  presence: Presence;
  /** sorted by party number */
  parties: Party[];
  myPartyId: PartyId | null;
  myParty: Party | undefined;
  /** server-owned current command of my party */
  myCommand: Command | null;
  /** the command my current one corrects, if still known */
  original: Command | null;
  supportFrom: Party[];
  /** most recent ALL command, hidden when it IS my current command (F06 table) */
  allLine: Command | null;
  /** parties shown in the small grid: all but mine; when no party chosen: all of them */
  gridParties: Party[];
  commandOf(partyId: PartyId): Command | null;
  commands: Record<string, Command>;
  slots: Record<string, string[]>;
  lastEvent: LastEvent | null;
  history: Command[];
  historyFilter: HistoryFilter;
  setHistoryFilter(f: HistoryFilter): void;
}

/** Derives everything the member HUD needs from the room store. Slot rules stay on the server. */
export function useMemberHudModel(): MemberHudModel {
  const hasSnapshot = useRoomStore((s) => s.hasSnapshot);
  const connection = useRoomStore((s) => s.connection);
  const roomStatus = useRoomStore((s) => s.roomStatus);
  const presence = useRoomStore((s) => s.presence);
  const rawParties = useRoomStore((s) => s.parties);
  const myPartyId = useRoomStore((s) => s.myPartyId);
  const slots = useRoomStore((s) => s.slots);
  const commands = useRoomStore((s) => s.commands);
  const lastEvent = useRoomStore((s) => s.lastEvent);
  const [userFilter, setHistoryFilter] = useState<HistoryFilter | null>(null);

  return useMemo(() => {
    const parties = [...rawParties].sort((a, b) => a.number - b.number);
    const myParty = myPartyId ? parties.find((p) => p.id === myPartyId) : undefined;
    const myCommand = myParty ? currentOf(slots, commands, myParty.id) : null;
    const all = latestAllCommand(commands);
    const historyFilter: HistoryFilter = userFilter ?? (myParty ? 'mine' : 'all');
    return {
      hasSnapshot,
      connection,
      closed: connection === 'CLOSED' || roomStatus === 'CLOSED',
      dimmed: connection === 'RECONNECTING' || connection === 'OFFLINE',
      presence,
      parties,
      myPartyId: myParty ? myParty.id : null,
      myParty,
      myCommand,
      original: myCommand?.correctsId ? commands[myCommand.correctsId] ?? null : null,
      supportFrom: myParty ? supportersOf(myParty.id, parties, slots, commands) : [],
      allLine: all && all.id !== myCommand?.id ? all : null,
      gridParties: myParty ? parties.filter((p) => p.id !== myParty.id) : parties,
      commandOf: (id: PartyId) => currentOf(slots, commands, id),
      commands,
      slots,
      lastEvent,
      history: historyOf(commands, historyFilter, myParty?.id ?? null),
      historyFilter,
      setHistoryFilter,
    };
  }, [hasSnapshot, connection, roomStatus, presence, rawParties, myPartyId, slots, commands, lastEvent, userFilter]);
}

export { correctedTo, isForParty };
