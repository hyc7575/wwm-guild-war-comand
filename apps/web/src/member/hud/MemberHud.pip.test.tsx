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


function installFakePip() {
  const doc = document.implementation.createHTMLDocument('pip');
  let pagehide: (() => void) | undefined;
  const win = {
    document: doc,
    close: vi.fn(() => pagehide?.()),
    addEventListener: (n: string, f: () => void) => {
      if (n === 'pagehide') pagehide = f;
    },
  };
  const requestWindow = vi.fn(async () => win);
  (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = { requestWindow };
  return { doc, win, requestWindow, userClose: () => pagehide?.() };
}
afterEach(() => {
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
});

describe('PiP small window', () => {
  it('hides the PiP button when the API is missing', () => {
    setup();
    welcome();
    render(<MemberHud onChangeParty={() => undefined} />);
    expect(screen.queryByTestId('open-pip')).toBeNull();
  });

  it('opens: card moves into the PiP document; closing returns to the main HUD', async () => {
    const pip = installFakePip();
    setup();
    const mine = cmd('m', { target: toParties('p3'), action: 'DEFEND', location: loc('right', '우측') });
    welcome([mine], { p1: [], p2: [], p3: ['m'], p4: [] });
    render(<MemberHud onChangeParty={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-pip'));
    });
    expect(pip.requestWindow).toHaveBeenCalledWith({ width: 320, height: 200 });
    expect(screen.getByTestId('pip-active')).toBeInTheDocument();
    expect(screen.queryByTestId('my-party-card')).toBeNull();
    expect(within(pip.doc.body).getByTestId('pip-card-action').textContent).toContain('방어');

    // a new command updates the PiP card and still beeps from the main document context
    const next = cmd('n', { target: toParties('p3'), action: 'ATTACK', location: loc('left', '좌측') });
    issued(next, { p1: [], p2: [], p3: ['m', 'n'], p4: [] });
    expect(within(pip.doc.body).getByTestId('pip-card-action').textContent).toContain('공격');
    expect(playBeep).toHaveBeenCalledTimes(1);

    // reconnecting banner shows in the PiP too
    act(() => useRoomStore.getState().setConnection('RECONNECTING', null));
    expect(within(pip.doc.body).getByTestId('pip-banner-reconnecting')).toBeTruthy();

    act(() => pip.userClose());
    expect(screen.queryByTestId('pip-active')).toBeNull();
    expect(screen.getByTestId('my-party-card')).toBeInTheDocument();
  });

  it('font step is reflected in the PiP card', async () => {
    const pip = installFakePip();
    setup();
    welcome();
    useHudSettings.setState({ settings: { ...DEFAULT_HUD_SETTINGS, fontStep: 2 } });
    render(<MemberHud onChangeParty={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-pip'));
    });
    expect((within(pip.doc.body).getByTestId('pip-hud') as HTMLElement).style.getPropertyValue('--hud-fs')).toBe('1.3');
  });
});
