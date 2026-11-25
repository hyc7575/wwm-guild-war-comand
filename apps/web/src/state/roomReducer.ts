import type {
  Command,
  PartyId,
  Party,
  Presence,
  Role,
  RoomSettings,
  RoomStatus,
  ServerMessage,
  Slots,
  Snapshot,
  SttFeedEntry,
} from '@winds/protocol';
import { DEFAULT_ROOM_SETTINGS, LIMITS } from '@winds/protocol';
import type { CloseReason, ConnectionStatus, UnsentCommand } from '../net/RoomClient';

export type NoticeKind = 'PARTIES_CHANGED' | 'MY_PARTY_REMOVED';
export interface Notice {
  /** Monotonic per store so a repeated notice restarts its 3s timer. */
  id: number;
  kind: NoticeKind;
  text: string;
}

/** Last applied room event (additive; lets the HUD animate transitions without diffing). */
export interface LastEvent {
  seq: number;
  kind: Extract<ServerMessage, { type: 'event' }>['kind'];
  /** issued/corrected: the new command; repeated: the repeated command. */
  commandId?: string;
  /** corrected: the replaced command. */
  correctedId?: string;
  /** cancelled / parties.updated: cancelled command ids. */
  commandIds?: string[];
}

/** Every ack the server sent, in order. `n` is monotonic so consumers can diff without timestamps. */
export interface AckRecord {
  n: number;
  clientCmdId: string;
  commandId?: string;
  error?: string;
  note?: string;
}
export const ACK_LOG_MAX = 50;

export interface RoomData {
  roomCode: string | null;
  role: Role | null;
  memberId: string | null;
  hasSnapshot: boolean;
  roomStatus: RoomStatus;
  settings: RoomSettings;
  parties: Party[];
  partyConfigVersion: number;
  /** Per-party command stack; the LAST element is the current command (server-owned). */
  slots: Slots;
  commands: Record<string, Command>;
  presence: Presence;
  expiresAt: number;
  seq: number;
  connection: ConnectionStatus;
  closeReason: CloseReason | null;
  myPartyId: PartyId | null;
  /** True after the chosen party disappeared: UI must reopen the party picker (FR-F01-9). */
  needsPartyPick: boolean;
  unsent: UnsentCommand[];
  /** Latest stt.feed entries (commander/operator only), newest last, capped. */
  sttFeed: SttFeedEntry[];
  lastError: { code: string; message: string } | null;
  /** Last ack that carried an error/note, for the console to surface. */
  lastAck: { clientCmdId: string; commandId?: string; error?: string; note?: string } | null;
  notice: Notice | null;
  noticeCounter: number;
  lastEvent: LastEvent | null;
  /** Capped log of all acks (console ack UI / pipeline latency). */
  ackLog: AckRecord[];
  ackCounter: number;
}

export const EMPTY_PRESENCE: Presence = {
  total: 0,
  byParty: {},
  unassigned: 0,
  commanderOnline: false,
  operatorsOnline: 0,
  sttState: 'OFF',
};

export function initialRoomData(): RoomData {
  return {
    roomCode: null,
    role: null,
    memberId: null,
    hasSnapshot: false,
    roomStatus: 'OPEN',
    settings: DEFAULT_ROOM_SETTINGS,
    parties: [],
    partyConfigVersion: 0,
    slots: {},
    commands: {},
    presence: EMPTY_PRESENCE,
    expiresAt: 0,
    seq: 0,
    connection: 'CONNECTING',
    closeReason: null,
    myPartyId: null,
    needsPartyPick: false,
    unsent: [],
    sttFeed: [],
    lastError: null,
    lastAck: null,
    notice: null,
    noticeCounter: 0,
    lastEvent: null,
    ackLog: [],
    ackCounter: 0,
  };
}

function indexCommands(list: Command[]): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const c of list) out[c.id] = c;
  return out;
}

function withNotice(s: RoomData, kind: NoticeKind, text: string): RoomData {
  const id = s.noticeCounter + 1;
  return { ...s, noticeCounter: id, notice: { id, kind, text } };
}

/** If my chosen party no longer exists, drop it and ask the UI to reopen the picker. */
function reconcileMyParty(s: RoomData): RoomData {
  if (s.myPartyId && !s.parties.some((p) => p.id === s.myPartyId)) {
    return withNotice(
      { ...s, myPartyId: null, needsPartyPick: true },
      'MY_PARTY_REMOVED',
      '내 파티가 삭제되었습니다. 파티를 다시 선택하세요',
    );
  }
  return s;
}

function applySnapshot(s: RoomData, snap: Snapshot): RoomData {
  return reconcileMyParty({
    ...s,
    hasSnapshot: true,
    seq: snap.seq,
    roomCode: snap.roomCode,
    roomStatus: snap.status,
    settings: snap.settings,
    parties: snap.parties,
    partyConfigVersion: snap.partyConfigVersion,
    slots: snap.slots,
    commands: indexCommands(snap.commands),
    presence: snap.presence,
    expiresAt: snap.expiresAt,
  });
}

function markCancelled(
  commands: Record<string, Command>,
  ids: string[],
  reason: Command['cancelReason'],
): Record<string, Command> {
  const next = { ...commands };
  for (const id of ids) {
    const c = next[id];
    if (c) next[id] = { ...c, status: 'CANCELLED', cancelReason: reason };
  }
  return next;
}

/**
 * Pure reducer for server messages. Slots always come from the server payload as-is:
 * the client never recomputes slot rules (02 §4).
 */
export function applyServerMessage(s: RoomData, msg: ServerMessage): RoomData {
  switch (msg.type) {
    case 'welcome':
      return applySnapshot({ ...s, role: msg.role, memberId: msg.memberId }, msg.snapshot);
    case 'snapshot':
      return applySnapshot(s, msg);
    case 'presence': {
      const { v: _v, type: _t, ...presence } = msg;
      return { ...s, presence };
    }
    case 'room.closed':
      return { ...s, roomStatus: 'CLOSED' };
    case 'stt.feed':
      return {
        ...s,
        sttFeed: [...s.sttFeed, ...msg.entries].slice(-LIMITS.sttFeedMaxEntries),
      };
    case 'error':
      return { ...s, lastError: { code: msg.code, message: msg.message } };
    case 'ack': {
      const n = s.ackCounter + 1;
      const rec: AckRecord = {
        n,
        clientCmdId: msg.clientCmdId,
        ...(msg.commandId !== undefined ? { commandId: msg.commandId } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
        ...(msg.note !== undefined ? { note: msg.note } : {}),
      };
      // A late ack resolves an item already reported unsent.
      const unsent = s.unsent.some((u) => u.clientCmdId === msg.clientCmdId)
        ? s.unsent.filter((u) => u.clientCmdId !== msg.clientCmdId)
        : s.unsent;
      const next = { ...s, unsent, ackCounter: n, ackLog: [...s.ackLog, rec].slice(-ACK_LOG_MAX) };
      return msg.error || msg.note
        ? { ...next, lastAck: { clientCmdId: msg.clientCmdId, commandId: msg.commandId, error: msg.error, note: msg.note } }
        : next;
    }
    case 'session.replaced':
    case 'pong':
      return s;
    case 'event':
      return applyEvent(s, msg);
  }
}

function applyEvent(s: RoomData, msg: Extract<ServerMessage, { type: 'event' }>): RoomData {
  const base = { ...s, seq: msg.seq };
  switch (msg.kind) {
    case 'command.issued': {
      const { command, slots } = msg.payload;
      return { ...base, slots, commands: { ...s.commands, [command.id]: command }, lastEvent: { seq: msg.seq, kind: msg.kind, commandId: command.id } };
    }
    case 'command.repeated': {
      const { commandId, repeatedAt, repeatCount } = msg.payload;
      const c = s.commands[commandId];
      if (!c) return base;
      return {
        ...base,
        commands: { ...s.commands, [commandId]: { ...c, repeatedAt, repeatCount } },
        lastEvent: { seq: msg.seq, kind: msg.kind, commandId },
      };
    }
    case 'command.corrected': {
      const { command, correctedId, slots } = msg.payload;
      const old = s.commands[correctedId];
      const commands = { ...s.commands, [command.id]: command };
      if (old) commands[correctedId] = { ...old, status: 'CORRECTED' };
      return { ...base, slots, commands, lastEvent: { seq: msg.seq, kind: msg.kind, commandId: command.id, correctedId } };
    }
    case 'command.cancelled': {
      const { commandIds, reason, slots } = msg.payload;
      return {
        ...base,
        slots,
        commands: markCancelled(s.commands, commandIds, reason),
        lastEvent: { seq: msg.seq, kind: msg.kind, commandIds },
      };
    }
    case 'parties.updated': {
      const { parties, partyConfigVersion, slots, cancelledCommandIds } = msg.payload;
      const next = reconcileMyParty({
        ...base,
        lastEvent: { seq: msg.seq, kind: msg.kind, commandIds: cancelledCommandIds },
        parties,
        partyConfigVersion,
        slots,
        commands: markCancelled(s.commands, cancelledCommandIds, 'PARTY_REMOVED'),
      });
      return next.notice?.kind === 'MY_PARTY_REMOVED'
        ? next
        : withNotice(next, 'PARTIES_CHANGED', '파티 구성이 바뀌었습니다');
    }
    case 'settings.updated':
      return { ...base, settings: msg.payload.settings };
  }
}
