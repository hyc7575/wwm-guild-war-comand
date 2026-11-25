import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDefaultParties, type Command, type Party, type Slots } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { DEFAULT_HUD_SETTINGS, useHudSettings } from './settings';
import { MemberHud } from './MemberHud';

vi.mock('./beeper', () => ({
  playBeep: vi.fn(() => true),
  isAudioBlocked: vi.fn(() => false),
  onAudioStateChange: vi.fn(() => () => undefined),
  unlockAudio: vi.fn(async () => true),
}));

const NOW = 1_700_000_000_000;
const LONG = '아주아주아주아주아주아주긴파티이름입니다';

function welcome(n: number, active: number[]) {
  const parties: Party[] = makeDefaultParties(n).map((p) => (p.number === 5 ? { ...p, name: LONG.slice(0, 20) } : p));
  const slots: Slots = {};
  const commands: Command[] = [];
  for (const p of parties) slots[p.id] = [];
  for (const num of active) {
    const id = `c${num}`;
    commands.push({ id, seq: 100 + num, target: { kind: 'PARTIES', partyIds: [`p${num}`] }, action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL', issuedAt: NOW, repeatCount: 0 });
    slots[`p${num}`] = [id];
  }
  act(() =>
    useRoomStore.getState().receive({
      v: 1,
      type: 'welcome',
      role: 'MEMBER',
      memberId: 'm',
      snapshot: {
        seq: 50,
        roomCode: 'ABC234',
        status: 'OPEN',
        settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false },
        parties,
        partyConfigVersion: 1,
        slots,
        commands,
        presence: { total: 7, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'LISTENING' },
        expiresAt: NOW + 1e7,
      },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  useHudSettings.setState({ settings: DEFAULT_HUD_SETTINGS });
  useRoomStore.getState().reset();
  useRoomStore.getState().attach('ABC234', 'MEMBER', 'p2');
});
afterEach(cleanup);

const cellNumbers = () =>
  within(screen.getByLabelText('파티별 명령'))
    .getAllByRole('button')
    .map((b) => Number(b.getAttribute('data-testid')!.replace('party-cell-', '')));

describe('12 party grid', () => {
  it('default: party-number order, equal cells, 2 columns on a phone, my party only in the card', () => {
    welcome(12, [9, 11]);
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(cellNumbers()).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const grid = screen.getByLabelText('파티별 명령');
    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(screen.getByTestId('party-cell-1')).not.toHaveAttribute('data-compact');
    expect(screen.getByTestId('my-party-card')).toBeInTheDocument();
  });

  it('"active first" option: commands first, idle cells compact (8+ parties); toggle lives in the drawer', () => {
    welcome(12, [9, 11]);
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('open-settings'));
    fireEvent.click(screen.getByTestId('opt-active-first'));
    expect(useHudSettings.getState().settings.activeFirst).toBe(true);
    expect(cellNumbers()).toEqual([9, 11, 1, 3, 4, 5, 6, 7, 8, 10, 12]);
    expect(screen.getByTestId('party-cell-1')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByTestId('party-cell-9')).not.toHaveAttribute('data-compact');
  });

  it('under 8 parties the option reorders but never shrinks', () => {
    useHudSettings.setState({ settings: { ...DEFAULT_HUD_SETTINGS, activeFirst: true } });
    welcome(6, [4]);
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(cellNumbers()).toEqual([4, 1, 3, 5, 6]);
    expect(screen.getByTestId('party-cell-1')).not.toHaveAttribute('data-compact');
  });

  it('no party chosen: option is ignored (FR-F06-6 equal cells, number order)', () => {
    useRoomStore.getState().reset();
    useRoomStore.getState().attach('ABC234', 'MEMBER', null);
    useHudSettings.setState({ settings: { ...DEFAULT_HUD_SETTINGS, activeFirst: true } });
    welcome(12, [9]);
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(cellNumbers()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(screen.getByTestId('party-cell-2')).not.toHaveAttribute('data-compact');
  });

  it('no party chosen on a wide screen: no inline columns, so the large-cell CSS (minmax 170px) applies', () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 900px') || q.includes('min-width: 600px'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    try {
      useRoomStore.getState().reset();
      useRoomStore.getState().attach('ABC234', 'MEMBER', null);
      welcome(12, []);
      render(<MemberHud onChangeParty={() => undefined} />);
      expect(screen.getByLabelText('파티별 명령').style.gridTemplateColumns).toBe('');
    } finally {
      window.matchMedia = mm;
    }
  });
});
