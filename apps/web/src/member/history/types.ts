import type { Action, CancelReason, CommandSource, CommandStatus } from '@winds/protocol';

/**
 * One command as seen by this browser. No clientId/token/memberId: the server never sends them in a Command,
 * and we copy only the fields below. Target and support parties are stored as party NUMBERS so a past room
 * can be rendered without its party list.
 */
export interface HistoryEntry {
  id: string;
  seq: number;
  issuedAt: number;
  target: 'ALL' | number[];
  action: Action;
  location?: string;
  support?: number[];
  status: CommandStatus;
  source: CommandSource;
  issuerRole?: 'COMMANDER' | 'SUB_COMMANDER' | 'OPERATOR';
  repeatCount: number;
  cancelReason?: CancelReason;
  /** Only when the user turned on "인식 원문 저장" and the server sent it. */
  transcript?: string;
}

export interface RoomHistory {
  roomCode: string;
  /** last room event seq applied (duplicate / stale event guard) */
  lastSeq: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closed: boolean;
  entries: HistoryEntry[];
}

/** Retention (F07): newest N entries per room, nothing older than 7 days, newest few rooms. */
export const HISTORY_MAX_ENTRIES = 200;
export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_ROOMS = 20;
