import { create } from 'zustand';
import type { PartyId, Role, ServerMessage, Command } from '@winds/protocol';
import type { CloseReason, ConnectionStatus, UnsentCommand } from '../net/RoomClient';
import { applyServerMessage, initialRoomData, type RoomData } from './roomReducer';

export * from './roomReducer';

export const NOTICE_MS = 3000;

export interface RoomActions {
  /** Reset the store for a (new) room before connecting. */
  attach(roomCode: string, role: Role, myPartyId?: PartyId | null): void;
  reset(): void;
  receive(msg: ServerMessage): void;
  setConnection(status: ConnectionStatus, reason: CloseReason | null): void;
  addUnsent(item: UnsentCommand): void;
  dismissUnsent(clientCmdId: string): void;
  clearUnsent(): void;
  choosePartyLocal(partyId: PartyId | null): void;
  dismissPartyPick(): void;
  clearNotice(id?: number): void;
  clearLastAck(): void;
}

export type RoomStore = RoomData & RoomActions;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const useRoomStore = create<RoomStore>((set, get) => ({
  ...initialRoomData(),

  attach(roomCode, role, myPartyId = null) {
    set({ ...initialRoomData(), roomCode, role, myPartyId });
  },
  reset() {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ ...initialRoomData() });
  },
  receive(msg) {
    const before = get().noticeCounter;
    set((s) => applyServerMessage(s, msg));
    const after = get();
    if (after.noticeCounter !== before && after.notice) {
      const id = after.notice.id;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => get().clearNotice(id), NOTICE_MS);
    }
  },
  setConnection(connection, closeReason) {
    set({ connection, closeReason });
  },
  addUnsent(item) {
    set((s) => ({ unsent: [...s.unsent, item] }));
  },
  dismissUnsent(id) {
    set((s) => ({ unsent: s.unsent.filter((u) => u.clientCmdId !== id) }));
  },
  clearUnsent() {
    set({ unsent: [] });
  },
  choosePartyLocal(partyId) {
    set({ myPartyId: partyId, needsPartyPick: false });
  },
  dismissPartyPick() {
    set({ needsPartyPick: false });
  },
  clearNotice(id) {
    set((s) => (id === undefined || s.notice?.id === id ? { notice: null } : s));
  },
  clearLastAck() {
    set({ lastAck: null });
  },
}));

/** Current command of a party: the last id of its server-owned slot stack. */
export function selectCurrentCommand(state: Pick<RoomData, 'slots' | 'commands'>, partyId: PartyId): Command | null {
  const stack = state.slots[partyId];
  const id = stack?.[stack.length - 1];
  return (id !== undefined ? state.commands[id] : undefined) ?? null;
}
