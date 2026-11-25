import type { PartyId } from '@winds/protocol';

/** localStorage helpers. Every access is guarded: storage can be blocked or throw. */

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

const CLIENT_ID_KEY = 'winds.clientId';

/** Persisted random id identifying this browser across reconnects. */
export function getClientId(): string {
  let id = get(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    set(CLIENT_ID_KEY, id);
  }
  return id;
}

const code = (c: string) => c.toUpperCase();

export interface RoomTokens {
  commanderToken?: string;
  operatorToken?: string;
  expiresAt?: number;
}

export function saveRoomTokens(roomCode: string, tokens: RoomTokens): void {
  const prev = loadRoomTokens(roomCode);
  set(`winds.tokens.${code(roomCode)}`, JSON.stringify({ ...prev, ...tokens }));
}

export function loadRoomTokens(roomCode: string): RoomTokens {
  const raw = get(`winds.tokens.${code(roomCode)}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RoomTokens;
  } catch {
    return {};
  }
}

/** Last party choice per room. `undefined` = never chosen, `null` = "아직 모름". */
export function loadPartyChoice(roomCode: string): PartyId | null | undefined {
  const raw = get(`winds.party.${code(roomCode)}`);
  if (raw === null) return undefined;
  return raw === '' ? null : raw;
}

export function savePartyChoice(roomCode: string, partyId: PartyId | null): void {
  set(`winds.party.${code(roomCode)}`, partyId ?? '');
}

export function clearPartyChoice(roomCode: string): void {
  del(`winds.party.${code(roomCode)}`);
}

const NICK_KEY = 'winds.nickname';
export const loadNickname = (): string => get(NICK_KEY) ?? '';
export const saveNickname = (n: string): void => set(NICK_KEY, n);
