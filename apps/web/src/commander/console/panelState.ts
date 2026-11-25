import type { Action, Location, PartyId, Target } from '@winds/protocol';

export interface PanelState {
  all: boolean;
  partyIds: PartyId[];
  action: Action | null;
  location: Location | null;
}

export const EMPTY_PANEL: PanelState = { all: false, partyIds: [], action: null, location: null };

export type PanelEvent =
  | { type: 'toggleAll' }
  | { type: 'toggleParty'; id: PartyId }
  | { type: 'setAction'; action: Action }
  | { type: 'setLocation'; location: Location | null }
  | { type: 'prefill'; target?: Target; action?: Action; location?: Location | null }
  | { type: 'prune'; validPartyIds: PartyId[] }
  | { type: 'reset' };

export function panelReducer(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case 'toggleAll':
      return { ...s, all: !s.all, partyIds: [] };
    case 'toggleParty':
      return {
        ...s,
        all: false,
        partyIds: s.partyIds.includes(e.id) ? s.partyIds.filter((x) => x !== e.id) : [...s.partyIds, e.id],
      };
    case 'setAction':
      return { ...s, action: e.action };
    case 'setLocation':
      // Clicking the selected location again clears it.
      return { ...s, location: e.location && s.location?.id === e.location.id ? null : e.location };
    case 'prefill':
      return {
        all: e.target ? e.target.kind === 'ALL' : s.all,
        partyIds: e.target ? (e.target.kind === 'PARTIES' ? [...e.target.partyIds] : []) : s.partyIds,
        action: e.action ?? s.action,
        location: e.location === undefined ? s.location : e.location,
      };
    case 'prune': {
      const ids = s.partyIds.filter((id) => e.validPartyIds.includes(id));
      return ids.length === s.partyIds.length ? s : { ...s, partyIds: ids };
    }
    case 'reset':
      return EMPTY_PANEL;
  }
}

export function panelTarget(s: PanelState): Target | null {
  if (s.all) return { kind: 'ALL' };
  if (s.partyIds.length) return { kind: 'PARTIES', partyIds: s.partyIds };
  return null;
}

/** A draft ready to issue, or null while target or action is missing. */
export function panelDraft(s: PanelState): { target: Target; action: Action; location?: Location } | null {
  const target = panelTarget(s);
  if (!target || !s.action) return null;
  return { target, action: s.action, ...(s.location ? { location: s.location } : {}) };
}
