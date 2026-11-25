import type { RoomDO } from './room-do';

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
}
