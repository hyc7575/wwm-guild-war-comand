import type { Action, Location, PartyId, Target } from '@winds/protocol';

export interface PanelState {
  all: boolean;
  partyIds: PartyId[];
  action: Action | null;
  location: Location | null;
  /** SUPPORT only: the parties being supported. */
  supportPartyIds: PartyId[];
  /** Set when the panel was filled from a CORRECT candidate: publishing sends command.correct. */
  correctsId?: string;
}

export const EMPTY_PANEL: PanelState = { all: false, partyIds: [], action: null, location: null, supportPartyIds: [] };

export type PanelEvent =
  | { type: 'toggleAll' }
  | { type: 'toggleParty'; id: PartyId }
  | { type: 'setAction'; action: Action }
  | { type: 'setLocation'; location: Location | null }
  | { type: 'toggleSupport'; id: PartyId }
  | { type: 'prefill'; target?: Target; action?: Action; location?: Location | null; supportPartyIds?: PartyId[]; correctsId?: string }
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
    case 'toggleSupport':
      return {
        ...s,
        supportPartyIds: s.supportPartyIds.includes(e.id) ? s.supportPartyIds.filter((x) => x !== e.id) : [...s.supportPartyIds, e.id],
      };
    case 'prefill':
      return {
        all: e.target ? e.target.kind === 'ALL' : s.all,
        partyIds: e.target ? (e.target.kind === 'PARTIES' ? [...e.target.partyIds] : []) : s.partyIds,
        action: e.action ?? s.action,
        location: e.location === undefined ? s.location : e.location,
        supportPartyIds: e.supportPartyIds ? [...e.supportPartyIds] : e.target || e.action ? [] : s.supportPartyIds,
        ...(e.correctsId ? { correctsId: e.correctsId } : {}),
      };
    case 'prune': {
      const ids = s.partyIds.filter((id) => e.validPartyIds.includes(id));
      const sup = s.supportPartyIds.filter((id) => e.validPartyIds.includes(id));
      return ids.length === s.partyIds.length && sup.length === s.supportPartyIds.length ? s : { ...s, partyIds: ids, supportPartyIds: sup };
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
export function panelDraft(
  s: PanelState,
): { target: Target; action: Action; location?: Location; supportPartyIds?: PartyId[]; correctsId?: string } | null {
  const target = panelTarget(s);
  if (!target || !s.action) return null;
  return {
    target,
    action: s.action,
    ...(s.location ? { location: s.location } : {}),
    ...(s.action === 'SUPPORT' && s.supportPartyIds.length ? { supportPartyIds: s.supportPartyIds } : {}),
    ...(s.correctsId ? { correctsId: s.correctsId } : {}),
  };
}
