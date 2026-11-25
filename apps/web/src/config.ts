/** API base. Empty string = same origin (Vite proxies /api in dev). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** ws(s) URL for a room. Works for same-origin and absolute VITE_API_BASE. */
export function wsUrl(code: string, base: string = API_BASE, loc: Pick<Location, 'origin'> = location): string {
  const origin = base || loc.origin;
  return `${origin.replace(/^http/, 'ws')}/api/rooms/${encodeURIComponent(code)}/ws`;
}
