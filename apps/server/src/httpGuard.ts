/** Origin policy and per-IP HTTP rate limiting for /api/* (pure functions; index.ts wires them in). */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * Policy: no Origin header (non-browser, tests) -> allowed.
 * Empty list (dev) -> same origin (Origin host == request Host) or loopback only.
 * Non-empty list -> only listed origins.
 */
export function isOriginAllowed(origin: string | null, requestHost: string, allowed: string[]): boolean {
  if (origin === null) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.length > 0) return allowed.includes(u.origin.toLowerCase());
  return u.host.toLowerCase() === requestHost.toLowerCase() || LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

/** `Access-Control-*` headers for an allowed Origin. Without Origin there is nothing to echo. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin !== null) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '86400';
  }
  return h;
}

export type LimitKind = 'create' | 'read';
export const DEFAULT_HTTP_LIMIT: Record<LimitKind, number> = { create: 10, read: 60 };

/** `HTTP_RATE_LIMIT` = "<create per minute>,<read per minute>", e.g. "10,60". Bad values fall back to defaults. */
export function parseHttpLimit(raw: string | undefined): Record<LimitKind, number> {
  const [c, r] = (raw ?? '').split(',').map((s) => Number(s.trim()));
  return {
    create: Number.isFinite(c) && c! > 0 ? Math.floor(c!) : DEFAULT_HTTP_LIMIT.create,
    read: Number.isFinite(r) && r! > 0 ? Math.floor(r!) : DEFAULT_HTTP_LIMIT.read,
  };
}

/**
 * Fixed-window counter per (ip, kind), in memory.
 * LIMITATION: state lives in one Worker isolate. Each isolate counts separately and a restart resets it,
 * so this slows room-code guessing but is not a complete defense. A complete one is a
 * Cloudflare Rate Limiting rule in front of the Worker (see docs/deploy.md).
 */
export class HttpRateLimiter {
  private windows = new Map<string, { start: number; n: number }>();
  constructor(private readonly windowMs = 60_000) {}

  /** Returns 0 when allowed, otherwise seconds until the window resets (Retry-After). */
  check(ip: string, kind: LimitKind, limit: number, now: number): number {
    if (this.windows.size > 5000) {
      for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    const key = `${kind}:${ip}`;
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, n: 0 };
      this.windows.set(key, w);
    }
    if (w.n < limit) {
      w.n++;
      return 0;
    }
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
  }
}
