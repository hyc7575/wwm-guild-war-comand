import { CreateRoomResponse, normalizeRoomCode, type CreateRoomRequest, type Party } from '@winds/protocol';
import { apiUrl } from '../config';

export interface RoomInfo {
  code: string;
  status: 'OPEN' | 'CLOSED';
  parties: Party[];
  expiresAt: number;
}

export type GetRoomResult =
  | { kind: 'ok'; room: RoomInfo }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** GET /api/rooms/:code. A CLOSED room counts as not found for joiners. */
export async function getRoom(code: string, signal?: AbortSignal): Promise<GetRoomResult> {
  try {
    const res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}`), { signal });
    if (res.status === 404) return { kind: 'not-found' };
    if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
    const room = (await res.json()) as RoomInfo;
    if (room.status === 'CLOSED') return { kind: 'not-found' };
    return { kind: 'ok', room };
  } catch (e) {
    if (signal?.aborted) return { kind: 'error', message: 'aborted' };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** POST /api/rooms. Throws Error with a user-facing message on failure. */
export async function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/rooms'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('서버에 연결할 수 없습니다');
  }
  if (!res.ok) throw new Error(`방을 만들지 못했습니다 (HTTP ${res.status})`);
  const parsed = CreateRoomResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('서버 응답이 올바르지 않습니다');
  return parsed.data;
}
