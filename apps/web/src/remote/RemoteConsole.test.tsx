// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { makeDefaultParties, type Command } from '@winds/protocol';
import { useRoomStore } from '../state/roomStore';
import { MemoryTuningLog } from '../commander/pipeline/tuningLog';
import { ConsoleController, type ConsoleStore } from '../commander/console/ConsoleController';
import { ConsoleControllerProvider } from '../commander/console/ConsoleProvider';
import { RemoteConsole } from './RemoteConsole';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

let sent: Array<{ id: string; input: any }>;
let controller: ConsoleController;

const cmd = (id: string, seq: number, partyIds: string[], action: Command['action'] = 'ATTACK'): Command => ({
  id, seq, target: { kind: 'PARTIES', partyIds }, action, status: 'ACTIVE', source: 'MANUAL', issuedAt: Date.now() - 5000, repeatCount: 0,
});

beforeEach(() => {
  sent = [];
  useRoomStore.getState().reset();
  useRoomStore.setState({
    hasSnapshot: true,
    connection: 'CONNECTED',
    parties: makeDefaultParties(3),
    slots: { p1: ['A'], p2: [], p3: [] },
    commands: { A: cmd('A', 1, ['p1']) },
  });
  controller = new ConsoleController({
    client: {
      request: (input) => {
        sent.push({ id: `r${sent.length + 1}`, input });
        return `r${sent.length}`;
      },
      send: () => true,
      resend: (item) => item.clientCmdId,
    },
    store: useRoomStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
  });
  render(
    <MantineProvider forceColorScheme="dark">
      <ConsoleControllerProvider controller={controller}>
        <RemoteConsole code="K7M2QX" />
      </ConsoleControllerProvider>
    </MantineProvider>,
  );
});
afterEach(() => {
  cleanup();
  controller.dispose();
});

const tid = (id: string) => screen.getByTestId(id);

describe('RemoteConsole', () => {
  it('shows the current command per party (read-only summary)', () => {
    expect(tid('remote-row-1')).toHaveTextContent('공격');
    expect(tid('remote-row-2')).toHaveTextContent('—');
  });

  it('target -> action -> location -> publish sends command.issue and vibrates', () => {
    const vib = vi.fn();
    (navigator as any).vibrate = vib;
    expect(tid('remote-publish')).toBeDisabled();
    fireEvent.click(tid('remote-target-3'));
    fireEvent.click(tid('remote-action-DEFEND'));
    fireEvent.click(tid('remote-location-RIGHT'));
    fireEvent.click(tid('remote-publish'));
    expect(sent[0]!.input).toMatchObject({
      type: 'command.issue',
      target: { kind: 'PARTIES', partyIds: ['p3'] },
      action: 'DEFEND',
      location: { id: 'RIGHT' },
      source: 'MANUAL',
    });
    expect(vib).toHaveBeenCalled();
    expect(tid('remote-publish')).toBeDisabled(); // panel reset
  });

  it('"직전 취소" cancels the newest active command', () => {
    fireEvent.click(tid('remote-cancel-last'));
    expect(sent[0]!.input).toMatchObject({ type: 'command.cancel', commandId: 'A' });
  });

  it('disables every button and shows the banner while reconnecting', () => {
    fireEvent.click(tid('remote-target-1'));
    fireEvent.click(tid('remote-action-ATTACK'));
    expect(tid('remote-publish')).toBeEnabled();
    useRoomStore.setState({ connection: 'RECONNECTING' });
    return Promise.resolve().then(() => {
      expect(tid('remote-status')).toHaveTextContent('다시 연결 중');
      for (const id of ['remote-publish', 'remote-cancel-last', 'remote-target-1', 'remote-action-GATHER']) expect(tid(id)).toBeDisabled();
      fireEvent.click(tid('remote-cancel-last'));
      expect(sent).toHaveLength(0);
    });
  });
});
