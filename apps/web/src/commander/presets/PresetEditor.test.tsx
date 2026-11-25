import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { makeDefaultParties } from '@winds/protocol';
import { useRoomStore } from '../../state/roomStore';
import { MemoryTuningLog } from '../pipeline/tuningLog';
import { ConsoleController, type ConsoleStore } from '../console/ConsoleController';
import { ConsoleControllerProvider } from '../console/ConsoleProvider';
import { PresetEditor } from './PresetEditor';
import { PresetStore } from './store';
import type { Preset } from './schema';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

let controller: ConsoleController;
let store: PresetStore;
const tid = (id: string) => screen.getByTestId(id);

const base = (id: string, name: string, shortcut?: string): Preset => ({
  id,
  name,
  ...(shortcut ? { shortcut } : {}),
  steps: [{ all: false, parties: [1], action: 'ATTACK' }],
});

function mount() {
  return render(
    <MantineProvider forceColorScheme="dark">
      <ConsoleControllerProvider controller={controller}>
        <PresetEditor opened onClose={() => {}} store={store} />
      </ConsoleControllerProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  useRoomStore.getState().reset();
  useRoomStore.setState({ hasSnapshot: true, connection: 'CONNECTED', parties: makeDefaultParties(3) });
  controller = new ConsoleController({
    client: { request: () => 'r', send: () => true, resend: () => null },
    store: useRoomStore as unknown as ConsoleStore,
    tuningLog: new MemoryTuningLog(),
  });
  store = new PresetStore(undefined);
});
afterEach(() => {
  cleanup();
  controller.dispose();
});

describe('PresetEditor', () => {
  it('adds a preset, edits name and step, and saves as you type', () => {
    mount();
    fireEvent.click(tid('preset-add'));
    expect(store.get()).toHaveLength(1);
    fireEvent.change(tid('preset-name'), { target: { value: 'A작전' } });
    fireEvent.click(tid('preset-step-0-party-3'));
    fireEvent.click(tid('preset-step-add'));
    fireEvent.click(tid('preset-step-all-1'));
    const p = store.get()[0]!;
    expect(p.name).toBe('A작전');
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]!.parties).toEqual([3]);
    expect(p.steps[1]!.all).toBe(true);
  });

  it('duplicates (without the shortcut), reorders and deletes', () => {
    store.set([base('a', 'A작전', 'F1'), base('b', 'B작전')]);
    mount();
    fireEvent.click(tid('preset-duplicate'));
    expect(store.get().map((p) => p.name)).toEqual(['A작전', 'A작전 복사', 'B작전']);
    expect(store.get()[1]!.shortcut).toBeUndefined();
    expect(store.get()[1]!.id).not.toBe('a');
    fireEvent.click(tid('preset-down-1'));
    expect(store.get().map((p) => p.name)).toEqual(['A작전', 'B작전', 'A작전 복사']);
    fireEvent.click(tid('preset-delete'));
    expect(store.get()).toHaveLength(2);
  });

  it('warns when two presets share a shortcut', () => {
    store.set([base('a', 'A작전', 'F2'), base('b', 'B작전', 'F2')]);
    mount();
    expect(tid('preset-shortcut-conflict')).toHaveTextContent('"B작전"');
    fireEvent.click(tid('preset-item-1'));
    expect(tid('preset-shortcut-conflict')).toHaveTextContent('"A작전"');
  });

  it('exports JSON and imports it back (appended, shortcuts that collide are dropped)', () => {
    store.set([base('a', 'A작전', 'F1')]);
    mount();
    fireEvent.click(tid('preset-export'));
    const json = (tid('preset-json') as HTMLTextAreaElement).value;
    expect(JSON.parse(json).presets[0]).toMatchObject({ name: 'A작전', shortcut: 'F1' });
    fireEvent.click(tid('preset-import'));
    expect(store.get()).toHaveLength(2);
    expect(store.get()[1]!.shortcut).toBeUndefined();
    expect(tid('preset-import-result')).toHaveTextContent('단축키 F1');
  });

  it('rejects invalid JSON without changing the list', () => {
    store.set([base('a', 'A작전')]);
    mount();
    fireEvent.change(tid('preset-json'), { target: { value: '{"presets":[{"name":"x","steps":[{"parties":[1],"action":"NUKE"}]}]}' } });
    fireEvent.click(tid('preset-import'));
    expect(tid('preset-import-result')).toHaveTextContent('알 수 없는 행동');
    fireEvent.change(tid('preset-json'), { target: { value: 'not json' } });
    fireEvent.click(tid('preset-import'));
    expect(tid('preset-import-result')).toHaveTextContent('JSON을 읽을 수 없습니다');
    expect(store.get()).toHaveLength(1);
  });
});
