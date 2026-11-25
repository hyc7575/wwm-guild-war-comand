import {
  DEFAULT_ROOM_SETTINGS,
  LIMITS,
  makeDefaultParties,
  type Action,
  type CancelReason,
  type Command,
  type CommandIssuer,
  type CommandSource,
  type CreateRoomRequest,
  type ErrorCode,
  type EventMsg,
  type Location,
  type Party,
  type Presence,
  type Role,
  type RoomSettings,
  type RoomSettingsPatch,
  type Slots,
  type Snapshot,
  type Target,
} from '@winds/protocol';

export const MAX_RECENT_CLIENT_CMDS = 200;

export type AckNote = 'CORRECTION_AS_NEW' | 'REPEATED' | 'ALREADY_CANCELLED';
export interface AckInfo {
  commandId?: string;
  note?: AckNote;
}
export interface ClientCmdRecord extends AckInfo {
  clientCmdId: string;
  error?: ErrorCode;
}

export interface RoomState {
  code: string;
  status: 'OPEN' | 'CLOSED';
  createdAt: number;
  expiresAt: number;
  commanderTokenHash: string;
  operatorTokenHash: string;
  /** Absent on rooms created before SUB_COMMANDER existed: nobody can authenticate as one. */
  subCommanderTokenHash?: string;
  settings: RoomSettings;
  parties: Party[];
  partyConfigVersion: number;
  slots: Slots;
  commands: Command[];
  seq: number;
  recentClientCmds: ClientCmdRecord[];
  lastCommanderSeenAt: number;
}

export type Ok = { ok: true; state: RoomState; events: EventMsg[]; ack: AckInfo };
export type Err = { ok: false; error: ErrorCode; state?: RoomState };
export type Result = Ok | Err;

export interface Ctx {
  now: number;
  newId: () => string;
  /** Authenticated role of the requester. Required: a missing role is refused, never allowed. */
  role: Role;
  /** Recorded on commands/cancel events. Filled by the server from the connection, never from client payloads. */
  issuer?: CommandIssuer;
}

/** May issue, correct and cancel commands. */
export const canCommand = (role: Role): boolean =>
  role === 'COMMANDER' || role === 'SUB_COMMANDER' || role === 'OPERATOR';
/** May change parties/settings or close the room. */
export const canAdmin = (role: Role): boolean => role === 'COMMANDER';

/** Fails closed: no ctx or no role means forbidden. */
const forbidden = (ctx: Ctx | undefined, check: (r: Role) => boolean): boolean =>
  !ctx?.role || !check(ctx.role);

export interface IssueInput {
  target: Target;
  action: Action;
  location?: Location;
  supportPartyIds?: string[];
  source: CommandSource;
  transcript?: string;
  confidence?: number;
}
export interface CorrectInput {
  correctsId: string;
  target?: Target;
  action?: Action;
  location?: Location | null;
  supportPartyIds?: string[];
  source: CommandSource;
  transcript?: string;
  confidence?: number;
}
export interface CancelInput {
  commandId: string;
  reason?: CancelReason;
}
export interface PartiesInput {
  baseVersion: number;
  parties: Party[];
}

// ---------------------------------------------------------------- helpers

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createRoomState(args: {
  code: string;
  now: number;
  parties: CreateRoomRequest['parties'];
  settings?: RoomSettingsPatch;
  commanderTokenHash: string;
  operatorTokenHash: string;
  subCommanderTokenHash: string;
}): RoomState {
  const base = makeDefaultParties(args.parties.length);
  const parties: Party[] = base.map((p, i) => {
    const src = args.parties[i];
    const out: Party = { ...p, aliases: src?.aliases ?? [] };
    if (src?.name) out.name = src.name;
    return out;
  });
  const slots: Slots = {};
  for (const p of parties) slots[p.id] = [];
  return {
    code: args.code,
    status: 'OPEN',
    createdAt: args.now,
    expiresAt: args.now + LIMITS.roomMaxLifetimeMs,
    commanderTokenHash: args.commanderTokenHash,
    operatorTokenHash: args.operatorTokenHash,
    subCommanderTokenHash: args.subCommanderTokenHash,
    settings: { ...DEFAULT_ROOM_SETTINGS, ...args.settings },
    parties,
    partyConfigVersion: 1,
    slots,
    commands: [],
    seq: 0,
    recentClientCmds: [],
    lastCommanderSeenAt: args.now,
  };
}

/** The current (top-of-stack) command id for a party, if any. */
export function currentCommandId(state: RoomState, partyId: string): string | undefined {
  const st = state.slots[partyId];
  return st && st.length ? st[st.length - 1] : undefined;
}

function topIds(slots: Slots): Set<string> {
  const s = new Set<string>();
  for (const st of Object.values(slots)) if (st.length) s.add(st[st.length - 1]!);
  return s;
}

function recompute(s: RoomState): void {
  const tops = topIds(s.slots);
  for (const c of s.commands) {
    if (c.status === 'ACTIVE' || c.status === 'SUPERSEDED') {
      c.status = tops.has(c.id) ? 'ACTIVE' : 'SUPERSEDED';
    }
  }
}

function enforceCap(s: RoomState): void {
  if (s.commands.length <= LIMITS.maxCommands) return;
  const tops = topIds(s.slots);
  const dropped = new Set<string>();
  let over = s.commands.length - LIMITS.maxCommands;
  for (const c of s.commands) {
    if (over <= 0) break;
    if (!tops.has(c.id)) {
      dropped.add(c.id);
      over--;
    }
  }
  if (!dropped.size) return;
  s.commands = s.commands.filter((c) => !dropped.has(c.id));
  for (const k of Object.keys(s.slots)) s.slots[k] = s.slots[k]!.filter((id) => !dropped.has(id));
}

function emit<K extends EventMsg['kind']>(
  s: RoomState,
  kind: K,
  payload: Extract<EventMsg, { kind: K }>['payload'],
): EventMsg {
  s.seq += 1;
  return { v: 1, type: 'event', seq: s.seq, kind, payload } as EventMsg;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};
const sameTarget = (a: Target, b: Target) =>
  a.kind === 'ALL' ? b.kind === 'ALL' : b.kind === 'PARTIES' && sameSet(a.partyIds, b.partyIds);
const sameLocation = (a?: Location, b?: Location) => (a?.id ?? undefined) === (b?.id ?? undefined);

function validateRefs(s: RoomState, target: Target, support?: string[]): boolean {
  const ids = new Set(s.parties.map((p) => p.id));
  if (target.kind === 'PARTIES' && !target.partyIds.every((id) => ids.has(id))) return false;
  if (support && !support.every((id) => ids.has(id))) return false;
  return true;
}

function resolveTargetParties(s: RoomState, target: Target): string[] {
  if (target.kind === 'ALL') return s.parties.map((p) => p.id);
  return [...new Set(target.partyIds)];
}

function dedupTarget(t: Target): Target {
  return t.kind === 'ALL' ? t : { kind: 'PARTIES', partyIds: [...new Set(t.partyIds)] };
}

/**
 * A command may only be treated as a repeat while it is still the current order of every party
 * it applies to. Otherwise (e.g. "1-2 attack", "2 defend", "1-2 attack") the re-issue is a real
 * new command. Target set: listed parties that still exist; for ALL, every party stack holding it.
 */
function isTopEverywhere(s: RoomState, c: Command): boolean {
  const ids =
    c.target.kind === 'ALL'
      ? s.parties.map((p) => p.id).filter((id) => s.slots[id]?.includes(c.id))
      : [...new Set(c.target.partyIds)].filter((id) => s.slots[id]);
  if (!ids.length) return false;
  return ids.every((id) => currentCommandId(s, id) === c.id);
}

// ---------------------------------------------------------------- issue

function issueCore(
  state: RoomState,
  input: IssueInput,
  ctx: Ctx,
  opts: { skipRepeat?: boolean; note?: AckNote } = {},
): Result {
  if (forbidden(ctx, canCommand)) return { ok: false, error: 'FORBIDDEN' };
  if (!validateRefs(state, input.target, input.supportPartyIds)) {
    return { ok: false, error: 'UNKNOWN_PARTY' };
  }
  const s = clone(state);
  const target = dedupTarget(input.target);

  if (!opts.skipRepeat) {
    let found: Command | undefined;
    for (const c of s.commands) {
      if (c.status !== 'ACTIVE') continue;
      const last = Math.max(c.issuedAt, c.repeatedAt ?? 0);
      if (ctx.now - last > LIMITS.repeatWindowMs) continue;
      if (
        sameTarget(c.target, target) &&
        c.action === input.action &&
        sameLocation(c.location, input.location) &&
        sameSet(c.supportPartyIds ?? [], input.supportPartyIds ?? []) &&
        isTopEverywhere(s, c)
      ) {
        if (!found || last >= Math.max(found.issuedAt, found.repeatedAt ?? 0)) found = c;
      }
    }
    if (found) {
      found.repeatedAt = ctx.now;
      found.repeatCount += 1;
      const ev = emit(s, 'command.repeated', {
        commandId: found.id,
        repeatedAt: found.repeatedAt,
        repeatCount: found.repeatCount,
      });
      return { ok: true, state: s, events: [ev], ack: { commandId: found.id, note: 'REPEATED' } };
    }
  }

  const cmd: Command = {
    id: ctx.newId(),
    seq: s.seq + 1,
    target,
    action: input.action,
    status: 'ACTIVE',
    source: input.source,
    issuedAt: ctx.now,
    repeatCount: 0,
  };
  if (ctx.issuer) cmd.issuer = { role: ctx.issuer.role };
  if (input.location) cmd.location = input.location;
  if (input.supportPartyIds) cmd.supportPartyIds = [...input.supportPartyIds];
  if (input.transcript !== undefined) cmd.transcript = input.transcript;
  if (input.confidence !== undefined) cmd.confidence = input.confidence;

  s.commands.push(cmd);
  for (const pid of resolveTargetParties(s, target)) s.slots[pid]!.push(cmd.id);
  recompute(s);
  enforceCap(s);
  const ev = emit(s, 'command.issued', { command: clone(cmd), slots: clone(s.slots) });
  const ack: AckInfo = { commandId: cmd.id };
  if (opts.note) ack.note = opts.note;
  return { ok: true, state: s, events: [ev], ack };
}

export function issueCommand(state: RoomState, input: IssueInput, ctx: Ctx): Result {
  return issueCore(state, input, ctx);
}

// ---------------------------------------------------------------- correct

export function correctCommand(state: RoomState, input: CorrectInput, ctx: Ctx): Result {
  if (forbidden(ctx, canCommand)) return { ok: false, error: 'FORBIDDEN' };
  const orig = state.commands.find((c) => c.id === input.correctsId);
  if (!orig) return { ok: false, error: 'UNKNOWN_COMMAND' };

  // Party ids deleted since the original was issued are dropped from inherited fields.
  const alive = new Set(state.parties.map((p) => p.id));
  let origTarget: Target = orig.target;
  if (origTarget.kind === 'PARTIES') {
    origTarget = { kind: 'PARTIES', partyIds: origTarget.partyIds.filter((id) => alive.has(id)) };
  }
  if (!input.target && origTarget.kind === 'PARTIES' && origTarget.partyIds.length === 0) {
    return { ok: false, error: 'UNKNOWN_PARTY' };
  }
  const origSupport = orig.supportPartyIds?.filter((id) => alive.has(id));
  const target = input.target ?? origTarget;
  const location = input.location === null ? undefined : (input.location ?? orig.location);
  const support = input.supportPartyIds ?? (origSupport?.length ? origSupport : undefined);
  const merged: IssueInput = {
    target,
    action: input.action ?? orig.action,
    source: input.source,
    ...(location ? { location } : {}),
    ...(support ? { supportPartyIds: support } : {}),
    ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  };

  if (orig.status !== 'ACTIVE') {
    return issueCore(state, merged, ctx, { skipRepeat: true, note: 'CORRECTION_AS_NEW' });
  }
  if (!validateRefs(state, target, support)) return { ok: false, error: 'UNKNOWN_PARTY' };

  const s = clone(state);
  const origS = s.commands.find((c) => c.id === orig.id)!;
  const holders = s.parties.filter((p) => s.slots[p.id]!.includes(orig.id)).map((p) => p.id);
  // ALL -> ALL keeps the original's footprint: later-added parties are not given the command.
  const newParties =
    orig.target.kind === 'ALL' && target.kind === 'ALL'
      ? holders
      : resolveTargetParties(s, target);
  const newSet = new Set(newParties);

  const cmd: Command = {
    id: ctx.newId(),
    seq: s.seq + 1,
    target: dedupTarget(target),
    action: merged.action,
    status: 'ACTIVE',
    source: input.source,
    issuedAt: ctx.now,
    repeatCount: 0,
    correctsId: orig.id,
  };
  if (ctx.issuer) cmd.issuer = { role: ctx.issuer.role };
  if (location) cmd.location = location;
  if (support) cmd.supportPartyIds = [...support];
  if (input.transcript !== undefined) cmd.transcript = input.transcript;
  if (input.confidence !== undefined) cmd.confidence = input.confidence;

  const held = new Set(holders);
  for (const pid of Object.keys(s.slots)) {
    const st = s.slots[pid]!;
    const idx = st.indexOf(orig.id);
    if (idx >= 0) {
      if (newSet.has(pid)) st[idx] = cmd.id;
      else st.splice(idx, 1);
    } else if (newSet.has(pid) && !held.has(pid)) {
      st.push(cmd.id);
    }
  }
  origS.status = 'CORRECTED';
  s.commands.push(cmd);
  recompute(s);
  enforceCap(s);
  const ev = emit(s, 'command.corrected', {
    command: clone(cmd),
    correctedId: orig.id,
    slots: clone(s.slots),
  });
  return { ok: true, state: s, events: [ev], ack: { commandId: cmd.id } };
}

// ---------------------------------------------------------------- cancel

export function cancelCommand(state: RoomState, input: CancelInput, ctx: Ctx): Result {
  if (forbidden(ctx, canCommand)) return { ok: false, error: 'FORBIDDEN' };
  const orig = state.commands.find((c) => c.id === input.commandId);
  if (!orig) return { ok: false, error: 'UNKNOWN_COMMAND' };
  if (orig.status === 'CANCELLED' || orig.status === 'CORRECTED') {
    return { ok: true, state, events: [], ack: { commandId: orig.id, note: 'ALREADY_CANCELLED' } };
  }
  const s = clone(state);
  const c = s.commands.find((x) => x.id === orig.id)!;
  const reason: CancelReason =
    input.reason ??
    (c.source === 'VOICE' && ctx.now - c.issuedAt < LIMITS.misrecognizedWindowMs
      ? 'MISRECOGNIZED'
      : 'CHANGED');

  for (const pid of Object.keys(s.slots)) {
    const st = s.slots[pid]!;
    const idx = st.indexOf(c.id);
    if (idx < 0) continue;
    const wasTop = idx === st.length - 1;
    st.splice(idx, 1);
    if (wasTop && st.length) {
      const below = s.commands.find((x) => x.id === st[st.length - 1]);
      if (!below || ctx.now - Math.max(below.issuedAt, below.repeatedAt ?? 0) >= LIMITS.cancelRestoreMaxAgeMs) s.slots[pid] = [];
    }
  }
  c.status = 'CANCELLED';
  c.cancelReason = reason;
  c.cancelledAt = ctx.now;
  recompute(s);
  const ev = emit(s, 'command.cancelled', {
    commandIds: [c.id],
    reason,
    slots: clone(s.slots),
    ...(ctx.issuer ? { cancelledBy: ctx.issuer.role } : {}),
  });
  return { ok: true, state: s, events: [ev], ack: { commandId: c.id } };
}

// ---------------------------------------------------------------- parties

export function updateParties(state: RoomState, input: PartiesInput, ctx: Ctx): Result {
  if (forbidden(ctx, canAdmin)) return { ok: false, error: 'FORBIDDEN' };
  if (input.baseVersion !== state.partyConfigVersion) return { ok: false, error: 'VERSION_CONFLICT' };
  const n = input.parties.length;
  if (n < LIMITS.minParties || n > LIMITS.maxParties) return { ok: false, error: 'INVALID_MESSAGE' };
  const ids = new Set(input.parties.map((p) => p.id));
  if (ids.size !== n) return { ok: false, error: 'INVALID_MESSAGE' };

  const s = clone(state);
  s.parties = input.parties.map((p, i) => ({ ...clone(p), number: i + 1 }));
  const removedCommandIds = new Set<string>();
  const newSlots: Slots = {};
  for (const p of s.parties) newSlots[p.id] = s.slots[p.id] ?? [];
  for (const [pid, st] of Object.entries(s.slots)) {
    if (!ids.has(pid)) for (const cid of st) removedCommandIds.add(cid);
  }
  s.slots = newSlots;
  const remaining = new Set(Object.values(s.slots).flat());
  const cancelled: string[] = [];
  for (const c of s.commands) {
    if (
      removedCommandIds.has(c.id) &&
      !remaining.has(c.id) &&
      (c.status === 'ACTIVE' || c.status === 'SUPERSEDED')
    ) {
      c.status = 'CANCELLED';
      c.cancelReason = 'PARTY_REMOVED';
      c.cancelledAt = ctx.now;
      cancelled.push(c.id);
    }
  }
  s.partyConfigVersion += 1;
  recompute(s);
  const ev = emit(s, 'parties.updated', {
    parties: clone(s.parties),
    partyConfigVersion: s.partyConfigVersion,
    slots: clone(s.slots),
    cancelledCommandIds: cancelled,
  });
  return { ok: true, state: s, events: [ev], ack: {} };
}

export function updateSettings(state: RoomState, patch: RoomSettingsPatch, ctx: Ctx): Result {
  if (forbidden(ctx, canAdmin)) return { ok: false, error: 'FORBIDDEN' };
  const s = clone(state);
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (s.settings as Record<string, unknown>)[k] = v;
  }
  const ev = emit(s, 'settings.updated', { settings: clone(s.settings) });
  return { ok: true, state: s, events: [ev], ack: {} };
}

export function closeRoom(state: RoomState, ctx: Ctx): Result {
  if (forbidden(ctx, canAdmin)) return { ok: false, error: 'FORBIDDEN' };
  const s = clone(state);
  s.status = 'CLOSED';
  return { ok: true, state: s, events: [], ack: {} };
}

// ---------------------------------------------------------------- idempotency

export function withClientCmd(
  state: RoomState,
  clientCmdId: string,
  fn: (s: RoomState) => Result,
): Result {
  const prev = state.recentClientCmds.find((r) => r.clientCmdId === clientCmdId);
  if (prev) {
    if (prev.error) return { ok: false, error: prev.error };
    const ack: AckInfo = {};
    if (prev.commandId) ack.commandId = prev.commandId;
    if (prev.note) ack.note = prev.note;
    return { ok: true, state, events: [], ack };
  }
  const r = fn(state);
  const base = r.ok ? r.state : state;
  const rec: ClientCmdRecord = { clientCmdId };
  if (r.ok) {
    if (r.ack.commandId) rec.commandId = r.ack.commandId;
    if (r.ack.note) rec.note = r.ack.note;
  } else {
    rec.error = r.error;
  }
  // Never mutate the input: a no-op result (e.g. ALREADY_CANCELLED) returns `state` itself.
  const next = r.ok ? (r.state === state ? { ...state } : r.state) : clone(state);
  next.recentClientCmds = [...base.recentClientCmds, rec].slice(-MAX_RECENT_CLIENT_CMDS);
  return r.ok ? { ...r, state: next } : { ok: false, error: r.error, state: next };
}

// ---------------------------------------------------------------- views

export function stripTranscript(c: Command): Command {
  if (c.transcript === undefined) return c;
  const { transcript: _t, ...rest } = c;
  return rest;
}

const canSeeTranscript = (settings: RoomSettings, role: Role) =>
  role !== 'MEMBER' || settings.shareTranscript;

/** Snapshots keep transcripts only for the newest N commands (WebSocket frame budget). */
export const SNAPSHOT_TRANSCRIPT_COMMANDS = 6;

export function toSnapshot(state: RoomState, presence: Presence, role: Role): Snapshot {
  const see = canSeeTranscript(state.settings, role);
  const keepFrom = state.commands.length - SNAPSHOT_TRANSCRIPT_COMMANDS;
  const commands = state.commands.map((c, i) => clone(see && i >= keepFrom ? c : stripTranscript(c)));
  return {
    seq: state.seq,
    roomCode: state.code,
    status: state.status,
    settings: clone(state.settings),
    parties: clone(state.parties),
    partyConfigVersion: state.partyConfigVersion,
    slots: clone(state.slots),
    commands,
    presence,
    expiresAt: state.expiresAt,
  };
}

/** Event as seen by a role: transcripts are stripped for MEMBER unless shareTranscript. */
export function eventForRole(ev: EventMsg, settings: RoomSettings, role: Role): EventMsg {
  if (canSeeTranscript(settings, role)) return ev;
  if (ev.kind === 'command.issued' || ev.kind === 'command.corrected') {
    return { ...ev, payload: { ...ev.payload, command: stripTranscript(ev.payload.command) } } as EventMsg;
  }
  return ev;
}
