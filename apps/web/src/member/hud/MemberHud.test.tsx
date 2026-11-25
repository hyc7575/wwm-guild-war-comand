import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDefaultParties, type Command, type ServerMessage, type Slots } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { DEFAULT_HUD_SETTINGS, useHudSettings } from './settings';
import { MemberHud } from './MemberHud';
import { playBeep } from './beeper';

vi.mock('./beeper', () => ({
  playBeep: vi.fn(() => true),
  isAudioBlocked: vi.fn(() => false),
  onAudioStateChange: vi.fn(() => () => undefined),
  unlockAudio: vi.fn(async () => true),
}));

const NOW = 1_700_000_000_000;
let seq = 100;

const cmd = (id: string, over: Partial<Command> = {}): Command => ({
  id,
  seq: ++seq,
  target: { kind: 'ALL' },
  action: 'ATTACK',
  status: 'ACTIVE',
  source: 'MANUAL',
  issuedAt: NOW,
  repeatCount: 0,
  ...over,
});
const toParties = (...ids: string[]) => ({ kind: 'PARTIES' as const, partyIds: ids });
const loc = (id: string, label: string) => ({ id, label });

const empty = (): Slots => ({ p1: [], p2: [], p3: [], p4: [] });

function receive(msg: ServerMessage) {
  act(() => useRoomStore.getState().receive(msg));
}
function welcome(commands: Command[] = [], slots: Slots = empty(), presence: Partial<ServerMessage & object> = {}) {
  receive({
    v: 1,
    type: 'welcome',
    role: 'MEMBER',
    memberId: 'm',
    snapshot: {
      seq: 50,
      roomCode: 'ABC234',
      status: 'OPEN',
      settings: { maxMembers: 60, shareTranscript: false, targetlessAsAll: false },
      parties: makeDefaultParties(4),
      partyConfigVersion: 1,
      slots,
      commands,
      presence: { total: 7, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'LISTENING', ...presence },
      expiresAt: NOW + 1e7,
    },
  });
}
const issued = (command: Command, slots: Slots) =>
  receive({ v: 1, type: 'event', seq: ++seq, kind: 'command.issued', payload: { command, slots } });

function setup(myParty: string | null = 'p3') {
  useRoomStore.getState().attach('ABC234', 'MEMBER', myParty);
}

beforeEach(() => {
  seq = 100;
  localStorage.clear();
  useHudSettings.setState({ settings: DEFAULT_HUD_SETTINGS });
  vi.mocked(playBeep).mockClear();
  useRoomStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = () => screen.getByTestId('my-party-card');

describe('F06 display rules', () => {
  it('row 1: my-party command is the most recent -> that command, small ALL line', () => {
    setup();
    const all = cmd('a', { action: 'GATHER', location: loc('center', '중앙') });
    const mine = cmd('m', { target: toParties('p3'), action: 'DEFEND', location: loc('right', '우측') });
    welcome([all, mine], { p1: ['a'], p2: ['a'], p3: ['a', 'm'], p4: ['a'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('방어');
    expect(screen.queryByTestId('my-card-badge-all')).toBeNull();
    expect(screen.getByTestId('all-line')).toHaveTextContent('집결');
    expect(screen.getByTestId('all-line')).toHaveTextContent('중앙');
  });

  it('row 2: ALL is most recent -> card shows it with 전체 badge, ALL line hidden', () => {
    setup();
    const all = cmd('a', { action: 'GATHER', location: loc('center', '중앙') });
    welcome([all], { p1: ['a'], p2: ['a'], p3: ['a'], p4: ['a'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('집결');
    expect(screen.getByTestId('my-card-badge-all')).toBeInTheDocument();
    expect(screen.queryByTestId('all-line')).toBeNull();
  });

  it('row 3: no command -> dim "대기 중인 명령 없음", ALL line only if there is a last ALL', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(card()).toHaveAttribute('data-empty', 'true');
    expect(card()).toHaveTextContent('대기 중인 명령 없음');
    expect(screen.queryByTestId('all-line')).toBeNull();
    cleanup();
    useRoomStore.getState().reset();
    setup();
    // an ALL command exists but my stack is empty (e.g. joined party added later)
    welcome([cmd('a', { action: 'HOLD' })], { p1: ['a'], p2: ['a'], p3: [], p4: ['a'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(card()).toHaveTextContent('대기 중인 명령 없음');
    expect(screen.getByTestId('all-line')).toHaveTextContent('대기');
  });

  it('row 4: no party chosen -> no card, equal grid of all parties, hint, ALL line on top', () => {
    setup(null);
    welcome([cmd('a', { action: 'GATHER' })], { p1: ['a'], p2: ['a'], p3: ['a'], p4: ['a'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('my-party-card')).toBeNull();
    expect(screen.getByTestId('unselected-hint')).toHaveTextContent('내 파티를 고르면 내 명령을 크게 볼 수 있습니다');
    for (const n of [1, 2, 3, 4]) expect(screen.getByTestId(`party-cell-${n}`)).toBeInTheDocument();
    expect(screen.getByTestId('all-line')).toBeInTheDocument();
    expect(screen.getByTestId('my-party-selector')).toHaveTextContent('아직 모름');
  });
});

describe('US-F06-1 sequence', () => {
  it('keeps my card on the ALL command after a later multi-party command', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);

    const c1 = cmd('c1', { target: toParties('p1'), action: 'ATTACK' });
    issued(c1, { p1: ['c1'], p2: [], p3: [], p4: [] });
    expect(card()).toHaveTextContent('대기 중인 명령 없음');
    expect(screen.getByTestId('party-cell-1')).toHaveTextContent('공격');

    const c2 = cmd('c2', { target: toParties('p3'), action: 'DEFEND', location: loc('right', '우측') });
    issued(c2, { p1: ['c1'], p2: [], p3: ['c2'], p4: [] });
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('방어');
    expect(screen.getByTestId('my-card-location')).toHaveTextContent('우측');
    expect(screen.getByTestId('location-bar')).toHaveAttribute('data-lit', 'RIGHT');
    expect(screen.getByTestId('party-cell-1')).toHaveTextContent('공격');

    const c3 = cmd('c3', { action: 'GATHER', location: loc('center', '중앙') });
    issued(c3, { p1: ['c1', 'c3'], p2: ['c3'], p3: ['c2', 'c3'], p4: ['c3'] });
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('집결');
    expect(screen.getByTestId('my-card-badge-all')).toBeInTheDocument();
    expect(screen.getByTestId('location-bar')).toHaveAttribute('data-lit', 'CENTER');
    expect(screen.queryByTestId('all-line')).toBeNull();

    const c4 = cmd('c4', { target: toParties('p1', 'p2'), action: 'ATTACK' });
    issued(c4, { p1: ['c1', 'c3', 'c4'], p2: ['c3', 'c4'], p3: ['c2', 'c3'], p4: ['c3'] });
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('집결');
    expect(screen.getByTestId('my-card-badge-all')).toBeInTheDocument();
    expect(screen.getByTestId('party-cell-1')).toHaveTextContent('공격');
    expect(screen.getByTestId('party-cell-2')).toHaveTextContent('공격');
  });
});

describe('card badges', () => {
  it('shows 함께 badge for multi-party targets and the support arrow', () => {
    setup();
    const c = cmd('s', { target: toParties('p1', 'p3'), action: 'SUPPORT', supportPartyIds: ['p2'] });
    welcome([c], { p1: ['s'], p2: [], p3: ['s'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(card()).toHaveTextContent('함께: 1·3파티');
    expect(card()).toHaveTextContent('→2파티');
  });

  it('support badge appears and disappears with the supporter current command', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('my-card-badge-support')).toBeNull();
    const s = cmd('s', { target: toParties('p2'), action: 'SUPPORT', supportPartyIds: ['p3'] });
    issued(s, { p1: [], p2: ['s'], p3: [], p4: [] });
    expect(screen.getByTestId('my-card-badge-support')).toHaveTextContent('2파티 지원 옴');
    const next = cmd('n', { target: toParties('p2'), action: 'ATTACK' });
    issued(next, { p1: [], p2: ['s', 'n'], p3: [], p4: [] });
    expect(screen.queryByTestId('my-card-badge-support')).toBeNull();
  });

  it('shows 반복 N회', () => {
    setup();
    const c = cmd('r', { target: toParties('p3'), repeatCount: 2 });
    welcome([c], { p1: [], p2: [], p3: ['r'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-repeat')).toHaveTextContent('반복 2회');
  });

  it('shows the issuer label on the card and in history; hidden when issuer is absent', () => {
    setup();
    const a = cmd('i1', { target: toParties('p3'), action: 'DEFEND', issuer: { role: 'SUB_COMMANDER' } });
    welcome([a], { p1: [], p2: [], p3: ['i1'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-issuer')).toHaveTextContent('서브오더');
    fireEvent.click(screen.getByTestId('history-toggle'));
    expect(screen.getByTestId('history-issuer')).toHaveTextContent('서브오더');
    cleanup();
    useRoomStore.getState().reset();
    setup();
    welcome([cmd('i2', { target: toParties('p3') })], { p1: [], p2: [], p3: ['i2'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('my-card-issuer')).toBeNull();
    fireEvent.click(screen.getByTestId('history-toggle'));
    expect(screen.queryByTestId('history-issuer')).toBeNull();
  });

  it('correction: 정정 badge and only changed parts highlighted', () => {
    setup();
    const orig = cmd('o', { target: toParties('p3'), action: 'ATTACK', location: loc('left', '좌측'), status: 'CORRECTED' });
    const fixed = cmd('f', { target: toParties('p3'), action: 'ATTACK', location: loc('right', '우측'), correctsId: 'o' });
    welcome([orig, fixed], { p1: [], p2: [], p3: ['f'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-badge-corrected')).toHaveTextContent('정정');
    expect(screen.getByTestId('my-card-location')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('my-card-action')).not.toHaveAttribute('data-changed');
  });

  it('free-form location ids show the label only (no 3-cell bar)', () => {
    setup();
    const c = cmd('x', { target: toParties('p3'), location: loc('front', '앞') });
    welcome([c], { p1: [], p2: [], p3: ['x'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-location')).toHaveTextContent('앞');
    expect(screen.queryByTestId('location-bar')).toBeNull();
  });
});

describe('stale / elapsed', () => {
  it('dims after 3 minutes and updates elapsed every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 12_000);
    setup();
    const c = cmd('s', { target: toParties('p3') });
    welcome([c], { p1: [], p2: [], p3: ['s'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(card()).toHaveTextContent('12초 전');
    expect(card()).not.toHaveAttribute('data-stale');
    act(() => void vi.advanceTimersByTime(3000));
    expect(card()).toHaveTextContent('15초 전');
    act(() => void vi.advanceTimersByTime(3 * 60_000));
    expect(card()).toHaveAttribute('data-stale', 'true');
  });
});

describe('cancel restore', () => {
  const cancel = (ids: string[], slots: Slots) =>
    receive({ v: 1, type: 'event', seq: ++seq, kind: 'command.cancelled', payload: { commandIds: ids, reason: 'MISRECOGNIZED', slots } });

  it('strikes the cancelled card 0.5s, then shows the restored command + notice for 3s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setup();
    const a = cmd('a', { action: 'GATHER' });
    const b = cmd('b', { target: toParties('p3'), action: 'ATTACK' });
    welcome([a, b], { p1: ['a'], p2: ['a'], p3: ['a', 'b'], p4: ['a'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('공격');

    cancel(['b'], { p1: ['a'], p2: ['a'], p3: ['a'], p4: ['a'] });
    expect(card()).toHaveAttribute('data-struck', 'true');
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('공격');

    act(() => void vi.advanceTimersByTime(500));
    expect(card()).not.toHaveAttribute('data-struck');
    expect(screen.getByTestId('my-card-action')).toHaveTextContent('집결');
    expect(screen.getByTestId('restore-notice')).toHaveTextContent('이전 명령으로 복귀');

    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId('restore-notice')).toBeNull();
  });

  it('shows 명령 없음 when the stack became empty', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setup();
    const b = cmd('b', { target: toParties('p3') });
    welcome([b], { p1: [], p2: [], p3: ['b'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    cancel(['b'], empty());
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByTestId('restore-notice')).toHaveTextContent('명령 없음');
  });

  it('cancelling someone else command does not strike my card', () => {
    setup();
    const b = cmd('b', { target: toParties('p1') });
    const m = cmd('m', { target: toParties('p3') });
    welcome([b, m], { p1: ['b'], p2: [], p3: ['m'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    cancel(['b'], { p1: [], p2: [], p3: ['m'], p4: [] });
    expect(card()).not.toHaveAttribute('data-struck');
    expect(screen.queryByTestId('restore-notice')).toBeNull();
  });
});

describe('animations', () => {
  it('new command flashes 1s; repeat pulses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    const c = cmd('n', { target: toParties('p3') });
    issued(c, { p1: [], p2: [], p3: ['n'], p4: [] });
    expect(card()).toHaveAttribute('data-flash', 'true');
    act(() => void vi.advanceTimersByTime(1000));
    expect(card()).not.toHaveAttribute('data-flash');
    receive({ v: 1, type: 'event', seq: ++seq, kind: 'command.repeated', payload: { commandId: 'n', repeatedAt: NOW + 5, repeatCount: 1 } });
    expect(card()).toHaveAttribute('data-pulse', 'true');
    expect(card()).not.toHaveAttribute('data-flash');
    expect(screen.getByTestId('my-card-repeat')).toHaveTextContent('반복 1회');
  });

  it('reduced motion override sets the root flag', () => {
    setup();
    welcome();
    const { container } = render(<MemberHud onChangeParty={() => undefined} />);
    expect(container.firstElementChild).toHaveAttribute('data-reduced-motion', 'false');
    act(() => useHudSettings.getState().update({ reduceMotion: true }));
    expect(container.firstElementChild).toHaveAttribute('data-reduced-motion', 'true');
  });
});

describe('alerts', () => {
  it('beeps for my party and ALL commands (issued + corrected), never for others or repeats', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);

    issued(cmd('o', { target: toParties('p1') }), { p1: ['o'], p2: [], p3: [], p4: [] });
    expect(playBeep).not.toHaveBeenCalled();

    issued(cmd('m', { target: toParties('p3') }), { p1: ['o'], p2: [], p3: ['m'], p4: [] });
    expect(playBeep).toHaveBeenCalledTimes(1);

    receive({ v: 1, type: 'event', seq: ++seq, kind: 'command.repeated', payload: { commandId: 'm', repeatedAt: NOW + 1, repeatCount: 1 } });
    expect(playBeep).toHaveBeenCalledTimes(1);

    issued(cmd('a', { action: 'GATHER' }), { p1: ['o', 'a'], p2: ['a'], p3: ['m', 'a'], p4: ['a'] });
    expect(playBeep).toHaveBeenCalledTimes(2);

    const fixed = cmd('f', { target: toParties('p3'), correctsId: 'm', action: 'DEFEND' });
    receive({
      v: 1, type: 'event', seq: ++seq, kind: 'command.corrected',
      payload: { command: fixed, correctedId: 'm', slots: { p1: ['o', 'a'], p2: ['a'], p3: ['f', 'a'], p4: ['a'] } },
    });
    expect(playBeep).toHaveBeenCalledTimes(3);

    const other = cmd('x', { target: toParties('p2'), action: 'HOLD' });
    issued(other, { p1: ['o', 'a'], p2: ['a', 'x'], p3: ['f', 'a'], p4: ['a'] });
    expect(playBeep).toHaveBeenCalledTimes(3);
  });

  it('does not beep when sound is off', () => {
    setup();
    welcome();
    useHudSettings.setState({ settings: { ...DEFAULT_HUD_SETTINGS, soundOn: false } });
    render(<MemberHud onChangeParty={() => undefined} />);
    issued(cmd('m', { target: toParties('p3') }), { p1: [], p2: [], p3: ['m'], p4: [] });
    expect(playBeep).not.toHaveBeenCalled();
  });

  it('does not beep for commands already in the snapshot at mount', () => {
    setup();
    welcome([cmd('m', { target: toParties('p3') })], { p1: [], p2: [], p3: ['m'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(playBeep).not.toHaveBeenCalled();
  });
});

describe('history', () => {
  function seed() {
    setup();
    const c1 = cmd('c1', { target: toParties('p1'), action: 'ATTACK', issuedAt: NOW - 3000 });
    const c2 = cmd('c2', { target: toParties('p3'), action: 'DEFEND', status: 'CANCELLED', cancelReason: 'CHANGED', issuedAt: NOW - 2000 });
    const c3 = cmd('c3', { action: 'GATHER', repeatCount: 2, issuedAt: NOW - 1000 });
    const c4 = cmd('c4', { target: toParties('p3'), action: 'MOVE', status: 'CORRECTED', issuedAt: NOW - 500 });
    const c5 = cmd('c5', { target: toParties('p3'), action: 'RETREAT', correctsId: 'c4', issuedAt: NOW });
    welcome([c1, c2, c3, c4, c5], { p1: ['c1', 'c3'], p2: ['c3'], p3: ['c5'], p4: ['c3'] });
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('history-toggle'));
  }

  it('lists newest first, filters mine / all, shows cancel reason, correction target and repeat count', () => {
    seed();
    let rows = screen.getAllByTestId('history-row');
    // default filter for a chosen party: mine (p3 + ALL) -> c5, c4, c3, c2 (c1 hidden)
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('후퇴');
    expect(rows[1]).toHaveTextContent('정정');
    expect(rows[1]).toHaveTextContent('→ 3파티 후퇴');
    expect(rows[2]).toHaveTextContent('반복 2회');
    expect(rows[3]).toHaveTextContent('작전 변경');
    expect(within(rows[3]!).getByText(/3파티 방어/)).toHaveAttribute('data-struck', 'true');

    fireEvent.click(screen.getByTestId('history-filter-all'));
    rows = screen.getAllByTestId('history-row');
    expect(rows).toHaveLength(5);
    expect(rows[4]).toHaveTextContent('1파티 공격');
  });

  it('caps at 50 rows', () => {
    setup();
    const cmds: Command[] = [];
    const slots = empty();
    for (let i = 0; i < 60; i++) cmds.push(cmd(`k${i}`, { target: toParties('p3'), issuedAt: NOW + i }));
    slots.p3 = ['k59'];
    welcome(cmds, slots);
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('history-toggle'));
    expect(screen.getAllByTestId('history-row')).toHaveLength(50);
  });
});

describe('connection and room state', () => {
  it('shows connected / commander states', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    act(() => useRoomStore.getState().setConnection('CONNECTED', null));
    expect(screen.getByTestId('status-connection')).toHaveTextContent('연결됨');
    expect(screen.getByTestId('status-commander')).toHaveTextContent('듣는 중');
    receive({ v: 1, type: 'presence', total: 3, byParty: {}, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' });
    expect(screen.getByTestId('status-commander')).toHaveTextContent('음성인식 꺼짐');
    receive({ v: 1, type: 'presence', total: 3, byParty: {}, unassigned: 0, commanderOnline: false, operatorsOnline: 0, sttState: 'OFF' });
    expect(screen.getByTestId('status-commander')).toHaveTextContent('메인오더 연결 끊김');
  });

  it('RECONNECTING: yellow band + dimmed cards; OFFLINE: red band; party selector reopens picker', () => {
    setup();
    const m = cmd('m', { target: toParties('p3') });
    welcome([m], { p1: [], p2: [], p3: ['m'], p4: [] });
    const onChange = vi.fn();
    render(<MemberHud onChangeParty={onChange} />);
    act(() => useRoomStore.getState().setConnection('RECONNECTING', null));
    expect(screen.getByTestId('banner-reconnecting')).toHaveTextContent('최신이 아닐 수 있습니다');
    expect(card()).toHaveAttribute('data-dimmed', 'true');
    act(() => useRoomStore.getState().setConnection('OFFLINE', null));
    expect(screen.getByTestId('banner-offline')).toHaveTextContent('인터넷 연결 없음');
    expect(screen.queryByTestId('banner-reconnecting')).toBeNull();
    fireEvent.click(screen.getByTestId('my-party-selector'));
    expect(onChange).toHaveBeenCalled();
  });

  it('CLOSED: full-screen room-closed', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    act(() => useRoomStore.getState().setConnection('CLOSED', null));
    expect(screen.getByTestId('room-closed')).toHaveTextContent('오더방이 종료되었습니다');
    expect(screen.queryByTestId('my-party-card')).toBeNull();
  });

  it('party structure notice renders in the HUD', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    receive({
      v: 1, type: 'event', seq: ++seq, kind: 'parties.updated',
      payload: { parties: makeDefaultParties(4), partyConfigVersion: 2, slots: empty(), cancelledCommandIds: [] },
    });
    expect(screen.getByText('파티 구성이 바뀌었습니다')).toBeInTheDocument();
  });
});

describe('focus view', () => {
  it('opens another party command large without changing my party; close returns', () => {
    setup();
    const c = cmd('c1', { target: toParties('p1'), action: 'ATTACK', location: loc('center', '중앙') });
    welcome([c], { p1: ['c1'], p2: [], p3: [], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('party-cell-1'));
    const view = screen.getByTestId('focus-view');
    expect(within(view).getByTestId('focus-card-action')).toHaveTextContent('공격');
    expect(useRoomStore.getState().myPartyId).toBe('p3');
    fireEvent.click(screen.getByTestId('focus-close'));
    expect(screen.queryByTestId('focus-view')).toBeNull();
  });

  it('grid excludes my party and is ordered by number', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('party-cell-3')).toBeNull();
    const cells = screen.getAllByTestId(/^party-cell-/).map((e) => e.getAttribute('data-testid'));
    expect(cells).toEqual(['party-cell-1', 'party-cell-2', 'party-cell-4']);
    expect(screen.getByTestId('party-cell-2')).toHaveTextContent('—');
  });
});

describe('settings', () => {
  it('persists in localStorage', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('open-settings'));
    fireEvent.click(screen.getByLabelText('알림음'));
    fireEvent.click(screen.getByRole('button', { name: '아주 크게' }));
    act(() => useHudSettings.getState().reload());
    expect(useHudSettings.getState().settings).toMatchObject({ soundOn: false, fontStep: 2 });
  });

  it('font size buttons are named after their real scale', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    fireEvent.click(screen.getByTestId('open-settings'));
    fireEvent.click(screen.getByRole('button', { name: '크게' }));
    expect(useHudSettings.getState().settings.fontStep).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '보통' }));
    expect(useHudSettings.getState().settings.fontStep).toBe(0);
    expect(screen.queryByRole('button', { name: '작게' })).toBeNull();
  });

  it('drawer: focus moves in, Esc closes, focus returns to the gear', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    const gear = screen.getByTestId('open-settings');
    gear.focus();
    fireEvent.click(gear);
    const drawer = screen.getByTestId('settings-drawer');
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('settings-drawer')).toBeNull();
    expect(document.activeElement).toBe(gear);
  });
});


describe('shareTranscript', () => {
  const withSetting = (on: boolean) => {
    useRoomStore.setState((st) => ({ settings: { ...st.settings, shareTranscript: on } }));
  };
  it('shows the transcript under the card and in history only when shared', () => {
    setup();
    const mine = cmd('m', { target: toParties('p3'), action: 'DEFEND', transcript: '3파티 오른쪽 지켜' });
    welcome([mine], { p1: [], p2: [], p3: ['m'], p4: [] });
    withSetting(true);
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.getByTestId('my-card-transcript')).toHaveTextContent('“3파티 오른쪽 지켜”');
    cleanup();
    withSetting(false);
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('my-card-transcript')).toBeNull();
  });
});
