import { describe, expect, it } from 'vitest';
import { EMPTY_PANEL, panelDraft, panelReducer } from './panelState';

describe('panelReducer', () => {
  it('multi-select parties; selecting 전체 clears them and vice versa', () => {
    let s = panelReducer(EMPTY_PANEL, { type: 'toggleParty', id: 'p1' });
    s = panelReducer(s, { type: 'toggleParty', id: 'p3' });
    expect(s.partyIds).toEqual(['p1', 'p3']);
    s = panelReducer(s, { type: 'toggleAll' });
    expect(s).toMatchObject({ all: true, partyIds: [] });
    s = panelReducer(s, { type: 'toggleParty', id: 'p2' });
    expect(s).toMatchObject({ all: false, partyIds: ['p2'] });
  });
  it('draft needs target and action; location is optional and toggles off on second click', () => {
    let s = panelReducer(EMPTY_PANEL, { type: 'toggleParty', id: 'p3' });
    expect(panelDraft(s)).toBeNull();
    s = panelReducer(s, { type: 'setAction', action: 'DEFEND' });
    expect(panelDraft(s)).toEqual({ target: { kind: 'PARTIES', partyIds: ['p3'] }, action: 'DEFEND' });
    const right = { id: 'RIGHT', label: '우측' };
    s = panelReducer(s, { type: 'setLocation', location: right });
    expect(panelDraft(s)?.location).toEqual(right);
    s = panelReducer(s, { type: 'setLocation', location: right });
    expect(panelDraft(s)?.location).toBeUndefined();
  });
  it('prefill fills target/action/location; reset empties; prune drops deleted parties', () => {
    let s = panelReducer(EMPTY_PANEL, {
      type: 'prefill',
      target: { kind: 'PARTIES', partyIds: ['p1', 'p2'] },
      action: 'GATHER',
      location: { id: 'CENTER', label: '중앙' },
    });
    expect(s).toMatchObject({ partyIds: ['p1', 'p2'], action: 'GATHER', location: { id: 'CENTER' } });
    s = panelReducer(s, { type: 'prune', validPartyIds: ['p2'] });
    expect(s.partyIds).toEqual(['p2']);
    expect(panelReducer(s, { type: 'reset' })).toEqual(EMPTY_PANEL);
  });
});
