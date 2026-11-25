import type { RoomDO } from './room-do';

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
  /** Comma-separated allowed Origins for /api/* and WebSocket. Empty: same origin or loopback only. */
  ALLOWED_ORIGINS?: string;
  /** "<POST /api/rooms per minute>,<GET room + WebSocket upgrade per minute>" per IP. Default "10,60". */
  HTTP_RATE_LIMIT?: string;
}
