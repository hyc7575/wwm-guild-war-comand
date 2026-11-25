import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { makeDefaultParties } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { MemoryTuningLog } from '../pipeline/tuningLog';
import { Console } from '../console/Console';
import { ConsoleController, type ConsoleStore } from '../console/ConsoleController';
import { ConsoleControllerProvider } from '../console/ConsoleProvider';
import { getPresetStore } from './store';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

let sent: Array<{ id: string; input: any }>;
let controller: ConsoleController;
const tid = (id: string) => screen.getByTestId(id);

function mount(mode: 'commander' | 'operator' = 'commander') {
  return render(
    <MantineProvider forceColorScheme="dark">
      <ConsoleControllerProvider controller={controller}>
        <Console mode={mode} code="K7M2QX" operatorToken="optok" />
      </ConsoleControllerProvider>
    </MantineProvider>,
  );
}

const A = {
  id: 'pa',
  name: 'A작전',
  shortcut: 'F1',
  steps: [
    { all: false, parties: [1], action: 'ATTACK' as const, location: { id: 'CENTER', label: '중앙' } },
    { all: false, parties: [3], action: 'DEFEND' as const },
    { all: false, parties: [7], action: 'HOLD' as const },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  sent = [];
  getPresetStore().set([A, { id: 'pb', name: 'B작전', shortcut: 'Shift+2', steps: [{ all: true, parties: [], action: 'RETREAT' }] }]);
  useRoomStore.getState().reset();
  useRoomStore.setState({ hasSnapshot: true, connection: 'CONNECTED', parties: makeDefaultParties(3), slots: {}, commands: {} });
  controller = new ConsoleController({
    client: {
      request: (input) => {
        const id = `r${sent.length + 1}`;
        sent.push({ id, input });
        return id;
      },
      send: () => true,
      resend: () => null,
    },
    store: useRoomStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
  });
});
afterEach(() => {
  cleanup();
  controller.dispose();
  getPresetStore().set([]);
  vi.useRealTimers();
});

const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

describe('Console presets', () => {
  it('shows a button per preset with its shortcut and issues steps one by one on click', () => {
    mount();
    expect(tid('preset-run-pa')).toHaveTextContent('A작전');
    expect(tid('preset-run-pa')).toHaveTextContent('F1');
    fireEvent.click(tid('preset-run-pa'));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent.map((s) => s.input.action)).toEqual(['ATTACK', 'DEFEND']);
    expect(sent.every((s) => s.input.type === 'command.issue' && s.input.source === 'MANUAL')).toBe(true);
    expect(tid('preset-skipped')).toHaveTextContent('7파티 없음, 건너뜀');
  });

  it('F1 runs the preset, no confirmation, and ignores key repeat', () => {
    mount();
    key({ key: 'F1', code: 'F1' });
    key({ key: 'F1', code: 'F1', repeat: true });
    act(() => void vi.advanceTimersByTime(2000));
    expect(sent).toHaveLength(2);
  });

  it('Shift+2 runs the preset instead of toggling party 2', () => {
    mount();
    key({ key: '@', code: 'Digit2', shiftKey: true });
    act(() => void vi.advanceTimersByTime(500));
    expect(sent[0]!.input).toMatchObject({ action: 'RETREAT', target: { kind: 'ALL' } });
    expect(tid('console-target-2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('plain digits still select parties; unassigned F-keys do nothing', () => {
    mount();
    key({ key: '2', code: 'Digit2' });
    expect(tid('console-target-2')).toHaveAttribute('aria-pressed', 'true');
    key({ key: 'F3', code: 'F3' });
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(0);
  });

  it('does not fire while typing in an input', () => {
    mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'F1', code: 'F1' });
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(0);
    input.remove();
  });

  it('shows failed steps with a retry button, and 프리셋 취소 cancels the issued commands', () => {
    mount();
    fireEvent.click(tid('preset-run-pa'));
    act(() => void vi.advanceTimersByTime(1000));
    const ack = (n: number, a: object) => useRoomStore.setState((s) => ({ ackLog: [...s.ackLog, { n, clientCmdId: sent[n - 1]!.id, ...a }] as never, ackCounter: n }));
    act(() => ack(1, { commandId: 'c1' }));
    act(() => ack(2, { error: 'RATE_LIMITED' }));
    expect(tid('preset-step-1')).toHaveTextContent('실패');
    expect(tid('preset-step-1')).toHaveTextContent('요청이 너무 많음');
    fireEvent.click(tid('preset-retry'));
    act(() => void vi.advanceTimersByTime(500));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.input).toMatchObject({ action: 'DEFEND' });
    // c1 is live: cancelling the preset cancels it.
    useRoomStore.setState({ commands: { c1: { id: 'c1', seq: 1, target: { kind: 'PARTIES', partyIds: ['p1'] }, action: 'ATTACK', status: 'ACTIVE', source: 'MANUAL', issuedAt: Date.now(), repeatCount: 0 } as never } });
    fireEvent.click(tid('preset-cancel'));
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent.some((s) => s.input.type === 'command.cancel' && s.input.commandId === 'c1')).toBe(true);
  });

  it('operators do not get the preset bar or keys', () => {
    mount('operator');
    expect(screen.queryByTestId('preset-bar')).toBeNull();
    key({ key: 'F1', code: 'F1' });
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent).toHaveLength(0);
  });
});
