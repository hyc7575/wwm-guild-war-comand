import {
  CreateRoomRequest,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  type CreateRoomResponse,
} from '@winds/protocol';
import { randomRng, randomToken, sha256Hex } from './crypto';
import type { Env } from './env';
import {
  HttpRateLimiter,
  corsHeaders,
  isOriginAllowed,
  parseAllowedOrigins,
  parseHttpLimit,
  type LimitKind,
} from './httpGuard';

export { RoomDO } from './room-do';

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

const limiter = new HttpRateLimiter();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const origin = request.headers.get('origin');
    if (!isOriginAllowed(origin, url.origin, parseAllowedOrigins(env.ALLOWED_ORIGINS))) {
      return json({ error: 'FORBIDDEN_ORIGIN' }, 403, { vary: 'Origin' });
    }
    const cors = corsHeaders(origin);
    const res = await route(request, env, url, cors);
    if (res.status === 101) return res;
    try {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch {
      // Responses passed through from the Durable Object stub have immutable headers: copy them.
      const copy = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) copy.headers.set(k, v);
      return copy;
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (path === '/api/health' && request.method === 'GET') return json({ ok: true });

    const limits = parseHttpLimit(env.HTTP_RATE_LIMIT);
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const limited = (kind: LimitKind): Response | null => {
      const retry = limiter.check(ip, kind, limits[kind], Date.now());
      return retry === 0 ? null : json({ error: 'RATE_LIMITED' }, 429, { 'retry-after': String(retry) });
    };

    if (path === '/api/rooms' && request.method === 'POST') return limited('create') ?? createRoom(request, env);

    const m = /^\/api\/rooms\/([^/]+)(\/ws)?$/.exec(path);
    if (m && request.method === 'GET') {
      const rl = limited('read');
      if (rl) return rl;
      // A Durable Object cannot be probed for existence without instantiating it, so lookups of
      // rooms that turn out not to exist are counted in their own bucket; once it is spent we
      // refuse before touching a DO.
      const wait = limiter.blocked(ip, 'miss', limits.miss, Date.now());
      if (wait) return json({ error: 'RATE_LIMITED' }, 429, { 'retry-after': String(wait) });
      const notFound = (): Response => limited('miss') ?? json({ error: 'ROOM_NOT_FOUND' }, 404);
      let raw: string;
      try {
        raw = decodeURIComponent(m[1]!);
      } catch {
        return notFound();
      }
      const code = normalizeRoomCode(raw);
      if (!isValidRoomCode(code)) return notFound();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      if (m[2]) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }
        const wsRes = await stub.fetch(new Request('https://room/ws', request));
        return wsRes.status === 404 ? notFound() : wsRes;
      }
      const res = await stub.fetch('https://room/info');
      if (res.status === 404) return notFound();
      return json(await res.json());
    }
    return json({ error: 'NOT_FOUND' }, 404);
}

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
