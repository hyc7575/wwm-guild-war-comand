import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { makeDefaultParties } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { MemoryTuningLog } from '../pipeline/tuningLog';
import { ConsoleController, type ConsoleStore } from './ConsoleController';
import { ConsoleControllerProvider } from './ConsoleProvider';
import { SttSlot } from './SttSlot';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

let sentMsgs: any[];
let controller: ConsoleController;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  sentMsgs = [];
  delete (window as any).__windsFakeStt;
  useRoomStore.getState().reset();
  useRoomStore.setState({ hasSnapshot: true, roomCode: 'K7M2QX', connection: 'CONNECTED', parties: makeDefaultParties(3) });
  controller = new ConsoleController({
    client: { request: () => 'r1', send: (m) => (sentMsgs.push(m), true) },
    store: useRoomStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
  });
});
afterEach(() => {
  cleanup();
  controller.dispose();
  document.title = 'Winds Command';
});

function mount() {
  return render(
    <MantineProvider forceColorScheme="dark">
      <ConsoleControllerProvider controller={controller}>
        <SttSlot />
      </ConsoleControllerProvider>
    </MantineProvider>,
  );
}

const sttStates = () => sentMsgs.filter((m) => m.type === 'stt.status').map((m) => m.state);

describe('SttSlot with the fake engine', () => {
  it('start -> LISTENING -> inject -> pipeline.onFinal, and reports stt.status', async () => {
    const onFinal = vi.spyOn(controller.pipeline, 'onFinalTranscript').mockImplementation(() => {});
    mount();
    expect(screen.getByTestId('stt-privacy')).toHaveTextContent('음성은 이 브라우저 안에서만 처리되고 저장하지 않습니다');
    fireEvent.change(screen.getByTestId('stt-engine-select'), { target: { value: 'fake' } });
    fireEvent.click(screen.getByTestId('stt-start'));
    await waitFor(() => expect(screen.getByTestId('stt-status')).toHaveTextContent('듣는 중'));
    expect(document.title).toBe('● 듣는 중 - Winds Command');
    expect(screen.getByTestId('stt-stop')).toBeInTheDocument();

    await act(async () => {
      await window.__windsFakeStt!.inject('1파티 모여');
    });
    expect(onFinal).toHaveBeenCalledWith('1파티 모여', expect.objectContaining({ endedAt: expect.any(Number) }));
    expect(screen.getByTestId('stt-last-final')).toHaveTextContent('1파티 모여');
    expect(sttStates()).toContain('STARTING');
    expect(sttStates().at(-1)).toBe('LISTENING');
    expect(sessionStorage.getItem('winds.stt.running.K7M2QX')).toBe('1');

    fireEvent.click(screen.getByTestId('stt-stop'));
    await waitFor(() => expect(screen.getByTestId('stt-status')).toHaveTextContent('멈춤'));
    expect(sttStates().at(-1)).toBe('OFF');
    expect(sessionStorage.getItem('winds.stt.running.K7M2QX')).toBeNull();
  });

  it('shows the big restart button after a reload while STT was running', () => {
    sessionStorage.setItem('winds.stt.running.K7M2QX', '1');
    mount();
    expect(screen.getByTestId('stt-restart-big')).toHaveTextContent('음성인식 다시 시작');
  });

  it('stops listening when another tab took over', async () => {
    mount();
    fireEvent.change(screen.getByTestId('stt-engine-select'), { target: { value: 'fake' } });
    fireEvent.click(screen.getByTestId('stt-start'));
    await waitFor(() => expect(screen.getByTestId('stt-status')).toHaveTextContent('듣는 중'));
    act(() => useRoomStore.setState({ connection: 'REPLACED' }));
    await waitFor(() => expect(screen.getByTestId('stt-halted')).toHaveTextContent('다른 탭에서 열렸습니다'));
    expect(screen.getByTestId('stt-status')).toHaveTextContent('멈춤');
  });
});
