import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { MemoryTuningLog } from '../pipeline/tuningLog';
import { Console } from './Console';
import { ConsoleController, type ConsoleStore } from './ConsoleController';
import { ConsoleControllerProvider } from './ConsoleProvider';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

let sent: Array<{ id: string; input: any }>;
let resent: string[];
let controller: ConsoleController;

const cmd = (id: string, seq: number, partyIds: string[], action: Command['action'] = 'ATTACK'): Command => ({
  id, seq, target: { kind: 'PARTIES', partyIds }, action, status: 'ACTIVE', source: 'MANUAL', issuedAt: Date.now() - 5000, repeatCount: 0,
});

function mount(mode: 'commander' | 'operator' = 'commander', openInvite = false, extra: { roleLabel?: string; subCommanderToken?: string } = {}) {
  return render(
    <MantineProvider forceColorScheme="dark">
      <ConsoleControllerProvider controller={controller}>
        <Console mode={mode} code="K7M2QX" operatorToken="optok" openInvite={openInvite} {...extra} />
      </ConsoleControllerProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  sent = [];
  resent = [];
  useRoomStore.getState().reset();
  useRoomStore.setState({
    hasSnapshot: true,
    connection: 'CONNECTED',
    parties: makeDefaultParties(3),
    slots: { p1: ['A'], p2: [], p3: ['B'] },
    commands: { A: cmd('A', 1, ['p1']), B: cmd('B', 2, ['p3'], 'DEFEND') },
    presence: { total: 7, byParty: { p1: 3 }, unassigned: 0, commanderOnline: true, operatorsOnline: 0, sttState: 'OFF' },
  });
  controller = new ConsoleController({
    client: {
      request: (input) => {
        const id = `r${sent.length + 1}`;
        sent.push({ id, input });
        return id;
      },
      send: () => true,
      resend: (item) => {
        resent.push(item.clientCmdId);
        return item.clientCmdId;
      },
    },
    store: useRoomStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
  });
});
afterEach(() => {
  cleanup();
  controller.dispose();
});

const tid = (id: string) => screen.getByTestId(id);

describe('Console (commander)', () => {
  it('renders room info, party rows with current commands, STT panel and shortcut legend', () => {
    mount();
    expect(tid('room-code')).toHaveTextContent('K7M2QX');
    expect(tid('member-count')).toHaveTextContent('7명');
    expect(tid('party-row-1')).toHaveTextContent('공격');
    expect(tid('party-row-2')).toHaveTextContent('—');
    expect(tid('party-row-3')).toHaveTextContent('방어');
    expect(tid('stt-slot')).toContainElement(tid('stt-start'));
    expect(tid('shortcut-legend')).toHaveTextContent('직전 취소');
  });

  it('button panel: [3] -> [방어] -> [우측] -> [발행] issues MANUAL and resets the selection', () => {
    mount();
    expect(tid('console-publish')).toBeDisabled();
    fireEvent.click(tid('console-target-3'));
    fireEvent.click(tid('console-action-DEFEND'));
    fireEvent.click(tid('console-location-RIGHT'));
    fireEvent.click(tid('console-publish'));
    expect(sent[0]!.input).toMatchObject({
      type: 'command.issue',
      source: 'MANUAL',
      action: 'DEFEND',
      target: { kind: 'PARTIES', partyIds: ['p3'] },
      location: { id: 'RIGHT', label: '우측' },
    });
    expect(tid('console-target-3')).toHaveAttribute('aria-pressed', 'false');
    expect(tid('console-publish')).toBeDisabled();
    expect(tid('ack-status')).toBeInTheDocument();
  });

  it('instant mode issues as soon as an action is pressed', () => {
    mount();
    fireEvent.click(tid('console-instant-toggle'));
    fireEvent.click(tid('console-target-all'));
    fireEvent.click(tid('console-action-RETREAT'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({ action: 'RETREAT', target: { kind: 'ALL' } });
  });

  it('keyboard: 1, Q (GATHER), S (중앙), Enter issues; Esc cancels the last command; typing in an input is ignored', () => {
    mount();
    fireEvent.keyDown(window, { key: '1', code: 'Digit1' });
    fireEvent.keyDown(window, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(sent[0]!.input).toMatchObject({ action: 'GATHER', target: { kind: 'PARTIES', partyIds: ['p1'] }, location: { id: 'CENTER' } });
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(sent[1]!.input).toEqual({ type: 'command.cancel', commandId: 'B' }); // highest seq
    const input = tid('console-text-input');
    fireEvent.keyDown(input, { key: 'q', code: 'KeyQ' });
    expect(tid('console-target-1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('party row [취소] and 직전 취소 send command.cancel; repeated presses walk back', () => {
    mount();
    fireEvent.click(tid('party-row-cancel-1'));
    expect(sent[0]!.input).toEqual({ type: 'command.cancel', commandId: 'A' });
    fireEvent.click(tid('console-cancel-last'));
    fireEvent.click(tid('console-cancel-last'));
    expect(sent.map((s) => s.input.commandId)).toEqual(['A', 'B']);
  });

  it('text command: live preview, unparsable disables send, Enter issues MANUAL', () => {
    mount();
    const input = tid('console-text-input');
    fireEvent.change(input, { target: { value: '상대 많네요' } });
    expect(tid('console-text-preview')).toHaveTextContent('해석할 수 없습니다');
    expect(tid('console-text-send')).toBeDisabled();
    fireEvent.change(input, { target: { value: '3파티 우측 방어' } });
    expect(tid('console-text-preview')).toHaveTextContent('3파티 방어 우측');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent[0]!.input).toMatchObject({ source: 'MANUAL', action: 'DEFEND' });
    expect(input).toHaveValue('');
  });

  it('fake voice input feeds the pipeline: subtitle + auto issue; MEDIUM shows a candidate with one-click publish', () => {
    mount();
    const v = tid('voice-test-input');
    fireEvent.change(v, { target: { value: '3파티 우측 방어' } });
    fireEvent.keyDown(v, { key: 'Enter' });
    expect(sent[0]!.input).toMatchObject({ source: 'VOICE', action: 'DEFEND' });
    expect(tid('subtitle-line')).toHaveTextContent('3파티 방어 우측');

    fireEvent.change(v, { target: { value: '중앙으로 모여' } });
    fireEvent.keyDown(v, { key: 'Enter' });
    expect(sent).toHaveLength(1);
    const card = tid('candidate-card');
    expect(card).toHaveTextContent('전체 집결 중앙');
    fireEvent.click(within(card).getByTestId('candidate-publish'));
    expect(sent[1]!.input).toMatchObject({ source: 'VOICE', action: 'GATHER' });
    expect(screen.queryByTestId('candidate-card')).toBeNull();
  });

  it('candidate [수정] fills the button panel', () => {
    mount();
    const v = tid('voice-test-input');
    fireEvent.change(v, { target: { value: '중앙으로 모여' } });
    fireEvent.keyDown(v, { key: 'Enter' });
    fireEvent.click(tid('candidate-edit'));
    expect(tid('console-target-all')).toHaveAttribute('aria-pressed', 'true');
    expect(tid('console-action-GATHER')).toHaveAttribute('aria-pressed', 'true');
    expect(tid('console-location-CENTER')).toHaveAttribute('aria-pressed', 'true');
  });

  it('ack UI: error shows the Korean reason; CORRECTION_AS_NEW shows a toast', () => {
    mount();
    fireEvent.click(tid('console-target-all'));
    fireEvent.click(tid('console-action-HOLD'));
    fireEvent.click(tid('console-publish'));
    act(() => {
      useRoomStore.getState().receive({ v: 1, type: 'ack', clientCmdId: 'r1', error: 'RATE_LIMITED' });
    });
    expect(tid('ack-status')).toHaveTextContent('요청이 너무 많음');
    fireEvent.click(tid('console-publish')); // disabled, no new request
    expect(sent).toHaveLength(1);

    fireEvent.click(tid('console-target-all'));
    fireEvent.click(tid('console-action-HOLD'));
    fireEvent.click(tid('console-publish'));
    act(() => {
      useRoomStore.getState().receive({ v: 1, type: 'ack', clientCmdId: 'r2', commandId: 'Z', note: 'CORRECTION_AS_NEW' });
    });
    expect(tid('ack-toast')).toHaveTextContent('정정 대상이 이미 바뀌어 새 명령으로 발행했습니다');
  });

  it('unsent commands can be re-sent or discarded', () => {
    useRoomStore.setState({
      unsent: [{ clientCmdId: 'u1', createdAt: 0, reason: 'STALE', msg: { type: 'command.issue', target: { kind: 'ALL' }, action: 'HOLD', source: 'MANUAL' } }],
    });
    mount();
    expect(tid('unsent-list')).toHaveTextContent('전체 대기');
    fireEvent.click(tid('unsent-resend'));
    expect(resent).toEqual(['u1']); // same clientCmdId, no new request
    expect(sent).toHaveLength(0);
    expect(useRoomStore.getState().unsent).toHaveLength(0);
  });

  it('settings toggles send room.settings', () => {
    mount();
    fireEvent.click(tid('settings-targetless-all'));
    expect(sent[0]!.input).toEqual({ type: 'room.settings', settings: { targetlessAsAll: true } });
    fireEvent.click(tid('settings-share-transcript'));
    expect(sent[1]!.input).toEqual({ type: 'room.settings', settings: { shareTranscript: true } });
  });

  it('Esc still cancels after clicking the instant-publish switch', () => {
    mount();
    const sw = tid('console-instant-toggle');
    fireEvent.click(sw);
    fireEvent.keyDown(sw, { key: 'Escape', code: 'Escape' });
    expect(sent.at(-1)!.input).toEqual({ type: 'command.cancel', commandId: 'B' });
  });

  it('ack panel shows Korean reasons for every error code', () => {
    mount();
    const codes: Record<string, string> = {
      FORBIDDEN: '권한 없음', RATE_LIMITED: '요청이 너무 많음', INVALID_MESSAGE: '잘못된 요청', UNAUTHORIZED: '인증 실패',
      UNKNOWN_COMMAND: '이미 사라진 명령', ROOM_NOT_FOUND: '방을 찾을 수 없음',
    };
    for (const [code, text] of Object.entries(codes)) {
      act(() => {
        const id = controller.issueManual({ target: { kind: 'ALL' }, action: 'HOLD' });
        useRoomStore.getState().receive({ v: 1, type: 'ack', clientCmdId: id, error: code } as never);
      });
      expect(tid('ack-status')).toHaveTextContent(text);
    }
  });

  it('shows store.lastError as a toast', () => {
    mount();
    act(() => useRoomStore.getState().receive({ v: 1, type: 'error', code: 'RATE_LIMITED', message: 'slow' } as never));
    expect(tid('error-toast')).toHaveTextContent('요청이 너무 많음');
  });

  it('party editor stops waiting when the request is reported unsent', () => {
    mount();
    fireEvent.click(tid('party-editor-open'));
    fireEvent.click(tid('party-editor-apply'));
    const id = sent.at(-1)!.id;
    expect(sent.at(-1)!.input.type).toBe('parties.update');
    act(() => {
      useRoomStore.setState({ unsent: [{ clientCmdId: id, createdAt: 0, reason: 'NO_ACK', msg: sent.at(-1)!.input }] });
    });
    expect(tid('party-editor-message')).toHaveTextContent('전달되지 않았습니다');
    expect(tid('party-editor-apply')).not.toBeDisabled();
  });

  it('arriving from /create opens the invite modal; the 초대 링크 button reopens it', () => {
    mount('commander', true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    cleanup();
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tid('invite-open')).toHaveTextContent('초대 링크');
  });

  it('close room needs confirmation', () => {
    mount();
    fireEvent.click(tid('room-close'));
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByTestId('room-close-confirm'));
    expect(sent[0]!.input).toEqual({ type: 'room.close' });
  });

  it('invite modal shows link and operator link', () => {
    mount();
    fireEvent.click(tid('invite-open'));
    expect((tid('invite-link') as HTMLInputElement).value).toMatch(/\/r\/K7M2QX$/);
    expect((tid('operator-link') as HTMLInputElement).value).toMatch(/\/o\/K7M2QX#optok$/);
  });

  it('invite modal copies the sub-commander link; absent token hides it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { unmount } = mount('commander', false, { subCommanderToken: 'subtok' });
    fireEvent.click(tid('invite-open'));
    expect((tid('sub-link') as HTMLInputElement).value).toMatch(/\/s\/K7M2QX#subtok$/);
    expect(screen.getByText(/전체 파티에 명령 가능, 방 설정은 못 함/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(tid('sub-link-copy'));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/s\/K7M2QX#subtok$/));
    unmount();
    mount();
    fireEvent.click(tid('invite-open'));
    expect(screen.queryByTestId('sub-link')).toBeNull();
  });

  it('party editor: rename + apply sends parties.update with baseVersion; VERSION_CONFLICT reloads', () => {
    useRoomStore.setState({ partyConfigVersion: 3 });
    mount();
    fireEvent.click(tid('party-editor-open'));
    fireEvent.change(tid('party-editor-name-0'), { target: { value: '본대' } });
    fireEvent.click(tid('party-editor-apply'));
    const req = sent.find((s) => s.input.type === 'parties.update')!;
    expect(req.input.baseVersion).toBe(3);
    expect(req.input.parties[0]).toMatchObject({ id: 'p1', name: '본대', number: 1 });
    act(() => {
      useRoomStore.setState({ parties: makeDefaultParties(3).map((p) => (p.id === 'p2' ? { ...p, name: '유격' } : p)) });
      useRoomStore.getState().receive({ v: 1, type: 'ack', clientCmdId: req.id, error: 'VERSION_CONFLICT' });
    });
    expect(tid('party-editor-message')).toHaveTextContent('다른 변경이 먼저 적용되어 최신 구성을 불러왔습니다');
    expect(tid('party-editor-name-1')).toHaveValue('유격');
    expect(tid('party-editor-name-0')).toHaveValue('');
  });

  it('deleting a party with members asks for confirmation first', () => {
    mount();
    fireEvent.click(tid('party-editor-open'));
    fireEvent.click(tid('party-editor-delete-0')); // p1 has 3 members + an active command
    fireEvent.click(tid('party-editor-apply'));
    expect(sent.some((s) => s.input.type === 'parties.update')).toBe(false);
    expect(tid('party-editor-confirm')).toHaveTextContent('접속 3명');
    fireEvent.click(tid('party-editor-confirm-apply'));
    expect(sent.some((s) => s.input.type === 'parties.update')).toBe(true);
  });
});

describe('Console (sub-commander via operator mode)', () => {
  it('shows the 서브오더 badge', () => {
    mount('operator', false, { roleLabel: '서브오더' });
    expect(screen.getByText('서브오더')).toBeInTheDocument();
    expect(screen.queryByTestId('room-close')).toBeNull();
  });
});

describe('Console (operator)', () => {
  it('has no party editor, settings, close or STT slot; shows relayed feed and can prefill from it', () => {
    useRoomStore.setState({
      sttFeed: [
        { id: 'f1', at: 1, text: '3파티 우측 방어', outcome: 'ISSUED', summary: '3파티 방어 우측' },
        { id: 'f2', at: 2, text: '중앙으로 모여', outcome: 'CANDIDATE', summary: '후보 · 전체 집결 중앙' },
      ],
    });
    mount('operator');
    expect(screen.queryByTestId('party-editor-open')).toBeNull();
    expect(screen.queryByTestId('settings-share-transcript')).toBeNull();
    expect(screen.queryByTestId('room-close')).toBeNull();
    expect(screen.queryByTestId('stt-slot')).toBeNull();
    const lines = screen.getAllByTestId('stt-feed-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent('중앙으로 모여'); // newest first
    fireEvent.click(within(lines[0]!).getByTestId('stt-feed-prefill'));
    expect(tid('console-action-GATHER')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tid('console-publish'));
    expect(sent[0]!.input).toMatchObject({ source: 'MANUAL', action: 'GATHER' });
    fireEvent.click(tid('console-cancel-last'));
    expect(sent[1]!.input.type).toBe('command.cancel');
  });
});

