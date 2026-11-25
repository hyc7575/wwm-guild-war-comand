import type { Kv } from './HistoryStore';
import type { RoomHistory } from './types';

export function memoryKv(): Kv & { data: Map<string, RoomHistory> } {
  const data = new Map<string, RoomHistory>();
  return {
    data,
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    del: async (k) => void data.delete(k),
    keys: async () => [...data.keys()],
  };
}
