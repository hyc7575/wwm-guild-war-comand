import {
  CreateRoomRequest,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  type CreateRoomResponse,
} from '@winds/protocol';
import { randomRng, randomToken, sha256Hex } from './crypto';
import type { Env } from './env';

export { RoomDO } from './room-do';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/api/health' && request.method === 'GET') return json({ ok: true });

    if (path === '/api/rooms' && request.method === 'POST') return createRoom(request, env);

    const m = /^\/api\/rooms\/([^/]+)(\/ws)?$/.exec(path);
    if (m && request.method === 'GET') {
      const code = normalizeRoomCode(decodeURIComponent(m[1]!));
      if (!isValidRoomCode(code)) return json({ error: 'ROOM_NOT_FOUND' }, 404);
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      if (m[2]) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }
        return stub.fetch(new Request('https://room/ws', request));
      }
      const res = await stub.fetch('https://room/info');
      if (res.status === 404) return json({ error: 'ROOM_NOT_FOUND' }, 404);
      return json(await res.json());
    }
    return json({ error: 'NOT_FOUND' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_MESSAGE' }, 400);
  }
  const parsed = CreateRoomRequest.safeParse(body);
  if (!parsed.success) return json({ error: 'INVALID_MESSAGE' }, 400);

  const commanderToken = randomToken();
  const operatorToken = randomToken();
  const subCommanderToken = randomToken();
  const commanderTokenHash = await sha256Hex(commanderToken);
  const operatorTokenHash = await sha256Hex(operatorToken);
  const subCommanderTokenHash = await sha256Hex(subCommanderToken);
  const rng = randomRng();

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateRoomCode(rng);
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const res = await stub.fetch('https://room/init', {
      method: 'POST',
      body: JSON.stringify({
        code,
        parties: parsed.data.parties,
        settings: parsed.data.settings,
        commanderTokenHash,
        operatorTokenHash,
        subCommanderTokenHash,
      }),
    });
    if (res.status === 409) continue; // collision: try another code
    if (!res.ok) return json({ error: 'INTERNAL' }, 500);
    const { expiresAt } = (await res.json()) as { expiresAt: number };
    const out: CreateRoomResponse = { code, commanderToken, operatorToken, subCommanderToken, expiresAt };
    return json(out, 201);
  }
  return json({ error: 'INTERNAL' }, 503);
}
