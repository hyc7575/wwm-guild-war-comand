import { z } from 'zod';
import { LIMITS } from './limits';

export const PARTY_COLORS = [
  'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12',
] as const;

export const PartyId = z.string().min(1).max(64);
export type PartyId = z.infer<typeof PartyId>;
export const CommandId = z.string().min(1).max(64);
export type CommandId = z.infer<typeof CommandId>;

export const Role = z.enum(['COMMANDER', 'OPERATOR', 'MEMBER']);
export type Role = z.infer<typeof Role>;

export const Party = z.object({
  id: PartyId,
  number: z.number().int().min(1).max(LIMITS.maxParties),
  name: z.string().max(LIMITS.partyNameMax).optional(),
  aliases: z.array(z.string().min(1).max(LIMITS.partyAliasMax)).max(LIMITS.maxAliasesPerParty),
  color: z.string().min(1).max(16),
});
export type Party = z.infer<typeof Party>;

export const PartiesArray = z.array(Party).min(LIMITS.minParties).max(LIMITS.maxParties);

export const Action = z.enum(['GATHER', 'MOVE', 'ATTACK', 'DEFEND', 'RETREAT', 'SUPPORT', 'HOLD']);
export type Action = z.infer<typeof Action>;

export const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }),
  z.object({
    kind: z.literal('PARTIES'),
    partyIds: z.array(PartyId).min(1).max(LIMITS.maxParties),
  }),
]);
export type Target = z.infer<typeof Target>;

export const Location = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(LIMITS.locationLabelMax),
});
export type Location = z.infer<typeof Location>;

export const CommandStatus = z.enum(['ACTIVE', 'SUPERSEDED', 'CORRECTED', 'CANCELLED']);
export type CommandStatus = z.infer<typeof CommandStatus>;
export const CommandSource = z.enum(['VOICE', 'MANUAL']);
export type CommandSource = z.infer<typeof CommandSource>;
export const CancelReason = z.enum(['MISRECOGNIZED', 'CHANGED', 'PARTY_REMOVED']);
export type CancelReason = z.infer<typeof CancelReason>;

export const Command = z.object({
  id: CommandId,
  seq: z.number().int().nonnegative(),
  target: Target,
  action: Action,
  location: Location.optional(),
  supportPartyIds: z.array(PartyId).max(LIMITS.maxParties).optional(),
  status: CommandStatus,
  source: CommandSource,
  transcript: z.string().max(LIMITS.transcriptMax).optional(),
  confidence: z.number().min(0).max(1).optional(),
  issuedAt: z.number(),
  repeatedAt: z.number().optional(),
  repeatCount: z.number().int().nonnegative().default(0),
  correctsId: CommandId.optional(),
  cancelReason: CancelReason.optional(),
  cancelledAt: z.number().optional(),
});
export type Command = z.infer<typeof Command>;

export const RoomSettings = z.object({
  maxMembers: z.number().int().min(1).max(LIMITS.maxMembers),
  shareTranscript: z.boolean(),
  targetlessAsAll: z.boolean().default(false),
});
export type RoomSettings = z.infer<typeof RoomSettings>;
export const RoomSettingsPatch = RoomSettings.partial();
export type RoomSettingsPatch = z.infer<typeof RoomSettingsPatch>;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxMembers: LIMITS.maxMembers,
  shareTranscript: false,
  targetlessAsAll: false,
};

export const Slots = z.record(PartyId, z.array(CommandId));
export type Slots = z.infer<typeof Slots>;

export const RoomStatus = z.enum(['OPEN', 'CLOSED']);
export type RoomStatus = z.infer<typeof RoomStatus>;

export const SttState = z.enum(['OFF', 'STARTING', 'LISTENING', 'ERROR']);
export type SttState = z.infer<typeof SttState>;

export const Presence = z.object({
  total: z.number().int().nonnegative(),
  byParty: z.record(PartyId, z.number().int().nonnegative()),
  unassigned: z.number().int().nonnegative(),
  commanderOnline: z.boolean(),
  operatorsOnline: z.number().int().nonnegative(),
  sttState: SttState,
});
export type Presence = z.infer<typeof Presence>;

export const Snapshot = z.object({
  seq: z.number().int().nonnegative(),
  roomCode: z.string(),
  status: RoomStatus,
  settings: RoomSettings,
  parties: z.array(Party),
  partyConfigVersion: z.number().int().nonnegative(),
  slots: Slots,
  commands: z.array(Command),
  presence: Presence,
  expiresAt: z.number(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** `n` default parties: ids `p1..pn`, numbered, with palette colors. */
export function makeDefaultParties(n: number): Party[] {
  const count = Math.max(LIMITS.minParties, Math.min(LIMITS.maxParties, Math.floor(n)));
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    number: i + 1,
    aliases: [],
    color: PARTY_COLORS[i] ?? 'p1',
  }));
}
