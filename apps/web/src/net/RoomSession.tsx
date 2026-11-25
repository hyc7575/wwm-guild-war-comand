import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PartyId, Role } from '@winds/protocol';
import { wsUrl } from '../config';
import { getRoom } from './api';
import { useRoomStore } from '../state/roomStore';
import { RoomClient } from './RoomClient';
import { getClientId, loadNickname, loadPartyChoice, savePartyChoice } from './session';

interface SessionValue {
  client: RoomClient;
  /** Member: choose a party (persists per room, tells the server, re-sent after reconnects). */
  chooseParty(partyId: PartyId | null): void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useRoomSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRoomSession must be used inside <RoomSession>');
  return v;
}

interface Props {
  code: string;
  role: Role;
  token?: string;
  children: ReactNode;
}

/** Owns one RoomClient for the lifetime of the room screen and mirrors it into the zustand store. */
export function RoomSession({ code, role, token, children }: Props) {
  const [value, setValue] = useState<SessionValue | null>(null);

  useEffect(() => {
    const store = useRoomStore.getState();
    const saved = role === 'MEMBER' ? loadPartyChoice(code) ?? null : null;
    store.attach(code, role, saved);

    const client = new RoomClient({
      url: wsUrl(code),
      roomCode: code,
      clientId: getClientId(),
      role,
      token,
      nickname: role === 'MEMBER' ? loadNickname() || undefined : undefined,
      checkRoom: async () => ((await getRoom(code)).kind === 'not-found' ? 'NOT_FOUND' : 'UNKNOWN'),
      handlers: {
        onStatus: (s, r) => useRoomStore.getState().setConnection(s, r),
        onMessage: (m) => useRoomStore.getState().receive(m),
        onUnsent: (u) => useRoomStore.getState().addUnsent(u),
        onUnsentResolved: (id) => useRoomStore.getState().dismissUnsent(id),
      },
    });
    if (saved) client.selectParty(saved);

    // If the store drops my party (deleted), forget it so reconnects do not re-send it.
    const unsub = useRoomStore.subscribe((s, prev) => {
      if (role === 'MEMBER' && prev.myPartyId && s.myPartyId === null && s.needsPartyPick) {
        savePartyChoice(code, null);
        client.selectParty(null);
      }
    });

    setValue({
      client,
      chooseParty(partyId) {
        useRoomStore.getState().choosePartyLocal(partyId);
        savePartyChoice(code, partyId);
        client.selectParty(partyId);
      },
    });
    client.start();
    return () => {
      unsub();
      client.stop();
      useRoomStore.getState().reset();
      setValue(null);
    };
  }, [code, role, token]);

  const memo = useMemo(() => value, [value]);
  if (!memo) return null;
  return <Ctx.Provider value={memo}>{children}</Ctx.Provider>;
}
