import { useEffect } from 'react';
import type { Command } from '@winds/protocol';
import { useRoomStore, type RoomData } from '../../state/roomStore';
import { getHistoryStore, type HistoryStore } from './HistoryStore';
import { useHistorySettings } from './settings';
import type { HistoryEntry } from './types';

export function toEntry(c: Command, parties: RoomData['parties'], withTranscript: boolean): HistoryEntry {
  const num = (id: string) => parties.find((p) => p.id === id)?.number;
  const nums = (ids: string[]) => ids.map(num).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
  return {
    id: c.id,
    seq: c.seq,
    issuedAt: c.issuedAt,
    target: c.target.kind === 'ALL' ? 'ALL' : nums(c.target.partyIds),
    action: c.action,
    ...(c.location ? { location: c.location.label } : {}),
    ...(c.supportPartyIds?.length ? { support: nums(c.supportPartyIds) } : {}),
    status: c.status,
    source: c.source,
    ...(c.issuer ? { issuerRole: c.issuer.role } : {}),
    repeatCount: c.repeatCount,
    ...(c.cancelReason ? { cancelReason: c.cancelReason } : {}),
    ...(withTranscript && c.transcript ? { transcript: c.transcript } : {}),
  };
}

function idsOf(e: NonNullable<RoomData['lastEvent']>): string[] {
  return [e.commandId, e.correctedId, ...(e.commandIds ?? [])].filter((x): x is string => !!x);
}

/**
 * Outside-the-reducer subscription that mirrors commands into the local history.
 * Events carry a seq (duplicates skipped in the store); a snapshot (welcome / reconnect) tops up
 * commands we do not have and refreshes status of the ones we do.
 */
export function startHistoryRecorder(opts: {
  history?: HistoryStore;
  subscribe?: (l: (s: RoomData, prev: RoomData) => void) => () => void;
  saveTranscript?: () => boolean;
} = {}): () => void {
  const history = opts.history ?? getHistoryStore();
  const subscribe = opts.subscribe ?? ((l) => useRoomStore.subscribe(l));
  const saveTranscript = opts.saveTranscript ?? (() => useHistorySettings.getState().saveTranscript);

  return subscribe((s, prev) => {
    if (!s.roomCode || !s.hasSnapshot) return;
    const withT = saveTranscript();
    if (s.lastEvent && s.lastEvent !== prev.lastEvent) {
      const entries = idsOf(s.lastEvent)
        .map((id) => s.commands[id])
        .filter((c): c is Command => !!c)
        .map((c) => toEntry(c, s.parties, withT));
      void history.record(s.roomCode, entries, { eventSeq: s.lastEvent.seq });
    } else if (s.commands !== prev.commands || !prev.hasSnapshot || prev.roomCode !== s.roomCode) {
      const entries = Object.values(s.commands).map((c) => toEntry(c, s.parties, withT));
      void history.record(s.roomCode, entries, { snapshotSeq: s.seq });
    }
    if (s.roomStatus === 'CLOSED' && prev.roomStatus !== 'CLOSED') void history.markClosed(s.roomCode);
  });
}

/** Mount once per room screen. */
export function useHistoryRecorder(): void {
  useEffect(() => startHistoryRecorder(), []);
}
