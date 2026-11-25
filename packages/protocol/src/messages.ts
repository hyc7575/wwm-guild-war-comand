import { z } from 'zod';
import { LIMITS } from './limits';
import {
  Action, CancelReason, Command, CommandId, CommandSource, Location, PartiesArray, Party,
  PartyId, Presence, Role, RoomSettings, RoomSettingsPatch, Slots, Snapshot, SttState, Target,
} from './domain';

export const PING_STRING = '{"v":1,"type":"ping"}';
export const PONG_STRING = '{"v":1,"type":"pong"}';

export const ErrorCode = z.enum([
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'FORBIDDEN',
  'RATE_LIMITED',
  'VERSION_CONFLICT',
  'INVALID_MESSAGE',
  'UNKNOWN_PARTY',
  // additions beyond 02 §6.4
  'UNKNOWN_COMMAND',
  'UNAUTHORIZED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const v = z.literal(1);
const clientCmdId = z.string().min(1).max(64);
const transcript = z.string().max(LIMITS.transcriptMax);
const confidence = z.number().min(0).max(1);

// ---------- Client -> Server ----------
export const HelloMsg = z.object({
  v, type: z.literal('hello'),
  roomCode: z.string().min(1).max(16),
  clientId: z.string().min(1).max(64),
  role: Role,
  commanderToken: z.string().min(1).max(128).optional(),
  operatorToken: z.string().min(1).max(128).optional(),
  lastSeq: z.number().int().nonnegative().optional(),
  nickname: z.string().max(LIMITS.nicknameMax).optional(),
});
export const PartySelectMsg = z.object({
  v, type: z.literal('party.select'), partyId: PartyId.nullable(),
});
export const PingMsg = z.object({ v, type: z.literal('ping') });
export const CommandIssueMsg = z.object({
  v, type: z.literal('command.issue'),
  clientCmdId, target: Target, action: Action,
  location: Location.optional(),
  supportPartyIds: z.array(PartyId).max(LIMITS.maxParties).optional(),
  source: CommandSource, transcript: transcript.optional(), confidence: confidence.optional(),
});
export const CommandCorrectMsg = z.object({
  v, type: z.literal('command.correct'),
  clientCmdId, correctsId: CommandId,
  target: Target.optional(), action: Action.optional(),
  location: Location.nullable().optional(),
  supportPartyIds: z.array(PartyId).max(LIMITS.maxParties).optional(),
  source: CommandSource, transcript: transcript.optional(), confidence: confidence.optional(),
});
export const CommandCancelMsg = z.object({
  v, type: z.literal('command.cancel'),
  clientCmdId, commandId: CommandId, reason: CancelReason.optional(),
});
export const PartiesUpdateMsg = z.object({
  v, type: z.literal('parties.update'),
  clientCmdId, baseVersion: z.number().int().nonnegative(), parties: PartiesArray,
});
export const RoomSettingsMsg = z.object({
  v, type: z.literal('room.settings'), clientCmdId, settings: RoomSettingsPatch,
});
export const RoomCloseMsg = z.object({ v, type: z.literal('room.close'), clientCmdId });
export const SttStatusMsg = z.object({ v, type: z.literal('stt.status'), state: SttState });

export const SttFeedOutcome = z.enum(['ISSUED', 'CANDIDATE', 'CORRECTED', 'CANCELLED', 'DISCARDED']);
export type SttFeedOutcome = z.infer<typeof SttFeedOutcome>;
export const SttFeedEntry = z.object({
  id: z.string().min(1).max(64),
  at: z.number(),
  text: z.string().max(LIMITS.transcriptMax),
  outcome: SttFeedOutcome,
  summary: z.string().max(100).optional(),
});
export type SttFeedEntry = z.infer<typeof SttFeedEntry>;
const feedEntries = z.array(SttFeedEntry).max(LIMITS.sttFeedMaxEntries);
export const SttFeedMsg = z.object({ v, type: z.literal('stt.feed'), entries: feedEntries });

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMsg, PartySelectMsg, PingMsg, CommandIssueMsg, CommandCorrectMsg, CommandCancelMsg,
  PartiesUpdateMsg, RoomSettingsMsg, RoomCloseMsg, SttStatusMsg, SttFeedMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- Server -> Client ----------
export const WelcomeMsg = z.object({
  v, type: z.literal('welcome'), role: Role, memberId: z.string(), snapshot: Snapshot,
});
export const SnapshotMsg = Snapshot.extend({ v, type: z.literal('snapshot') });

const evBase = { v, type: z.literal('event'), seq: z.number().int().nonnegative() };
export const EventMsg = z.discriminatedUnion('kind', [
  z.object({ ...evBase, kind: z.literal('command.issued'),
    payload: z.object({ command: Command, slots: Slots }) }),
  z.object({ ...evBase, kind: z.literal('command.repeated'),
    payload: z.object({ commandId: CommandId, repeatedAt: z.number(), repeatCount: z.number().int().positive() }) }),
  z.object({ ...evBase, kind: z.literal('command.corrected'),
    payload: z.object({ command: Command, correctedId: CommandId, slots: Slots }) }),
  z.object({ ...evBase, kind: z.literal('command.cancelled'),
    payload: z.object({ commandIds: z.array(CommandId).min(1), reason: CancelReason, slots: Slots }) }),
  z.object({ ...evBase, kind: z.literal('parties.updated'),
    payload: z.object({
      parties: z.array(Party), partyConfigVersion: z.number().int().nonnegative(),
      slots: Slots, cancelledCommandIds: z.array(CommandId),
    }) }),
  z.object({ ...evBase, kind: z.literal('settings.updated'),
    payload: z.object({ settings: RoomSettings }) }),
]);
export type EventMsg = z.infer<typeof EventMsg>;

export const AckMsg = z.object({
  v, type: z.literal('ack'), clientCmdId,
  commandId: CommandId.optional(),
  error: ErrorCode.optional(),
  note: z.enum(['CORRECTION_AS_NEW', 'REPEATED', 'ALREADY_CANCELLED']).optional(),
});
export const PresenceMsg = Presence.extend({ v, type: z.literal('presence') });
export const PongMsg = z.object({ v, type: z.literal('pong') });
export const ErrorMsg = z.object({
  v, type: z.literal('error'), code: ErrorCode, message: z.string(),
});
export const RoomClosedMsg = z.object({
  v, type: z.literal('room.closed'),
  reason: z.enum(['COMMANDER_CLOSED', 'EXPIRED', 'COMMANDER_ABSENT']),
});
export const SessionReplacedMsg = z.object({ v, type: z.literal('session.replaced') });
export const SttFeedRelayMsg = z.object({
  v, type: z.literal('stt.feed'), entries: feedEntries, from: Role,
});

export const ServerMessage = z.union([
  WelcomeMsg, SnapshotMsg, EventMsg, AckMsg, PresenceMsg, PongMsg, ErrorMsg, RoomClosedMsg,
  SessionReplacedMsg, SttFeedRelayMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, msg: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid message' };
}

export const parseClientMessage = (raw: string): ParseResult<ClientMessage> =>
  parseWith(ClientMessage, raw);
export const parseServerMessage = (raw: string): ParseResult<ServerMessage> =>
  parseWith(ServerMessage, raw);

// ---------- HTTP ----------
export const CreateRoomRequest = z.object({
  parties: z
    .array(z.object({
      name: z.string().max(LIMITS.partyNameMax).optional(),
      aliases: z.array(z.string().min(1).max(LIMITS.partyAliasMax)).max(LIMITS.maxAliasesPerParty).optional(),
    }))
    .min(LIMITS.minParties).max(LIMITS.maxParties),
  settings: RoomSettingsPatch.optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;
export const CreateRoomResponse = z.object({
  code: z.string(), commanderToken: z.string(), operatorToken: z.string(), expiresAt: z.number(),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;
