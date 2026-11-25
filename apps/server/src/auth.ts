import type { ClientMessage } from '@winds/protocol';
import type { RoomState } from '@winds/room-core';
import { sha256Hex, timingSafeEqual } from './crypto';

type Hello = Extract<ClientMessage, { type: 'hello' }>;

/**
 * Per-role token/hash table. The switch is exhaustive: adding a Role without handling it here
 * fails to compile, so no role can silently skip authentication.
 * `expected` is undefined for rooms created before SUB_COMMANDER existed (no hash stored).
 */
function credential(
  hello: Hello,
  room: Pick<RoomState, 'commanderTokenHash' | 'operatorTokenHash' | 'subCommanderTokenHash'>,
): { token: string | undefined; expected: string | undefined } | null {
  switch (hello.role) {
    case 'COMMANDER':
      return { token: hello.commanderToken, expected: room.commanderTokenHash };
    case 'SUB_COMMANDER':
      return { token: hello.subCommanderToken, expected: room.subCommanderTokenHash };
    case 'OPERATOR':
      return { token: hello.operatorToken, expected: room.operatorTokenHash };
    case 'MEMBER':
      return null;
    default: {
      const _never: never = hello.role;
      return _never;
    }
  }
}

/** True when the hello may take its claimed role. MEMBER needs no token. */
export async function verifyHello(
  hello: Hello,
  room: Pick<RoomState, 'commanderTokenHash' | 'operatorTokenHash' | 'subCommanderTokenHash'>,
): Promise<boolean> {
  const c = credential(hello, room);
  if (!c) return true;
  if (!c.token || !c.expected) return false;
  return timingSafeEqual(await sha256Hex(c.token), c.expected);
}
