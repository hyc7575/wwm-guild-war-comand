import { get, set } from 'idb-keyval';

export interface PartyDraft {
  name: string;
  aliases: string[];
}

const KEY = 'winds.lastPartyConfig';

/** F01 FR-F01-11: last party composition, kept in IndexedDB on the commander's browser. */
export async function loadLastConfig(): Promise<PartyDraft[] | null> {
  try {
    const v = await get<PartyDraft[]>(KEY);
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function saveLastConfig(parties: PartyDraft[]): Promise<void> {
  try {
    await set(KEY, parties);
  } catch {
    /* IndexedDB unavailable (private mode): the feature just does nothing */
  }
}
