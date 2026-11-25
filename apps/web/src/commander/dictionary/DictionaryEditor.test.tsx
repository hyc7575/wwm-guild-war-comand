import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { DictionaryEditor } from './DictionaryEditor';
import { emptyAllianceDictionary } from './editing';
import { DictionaryStore } from './store';

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
afterEach(cleanup);

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function mount(store: DictionaryStore, log: Array<{ at: number; text: string; reason: string }> = []) {
  return render(
    <MantineProvider forceColorScheme="dark">
      <DictionaryEditor opened onClose={() => {}} store={store} readTuningLog={async () => log} />
    </MantineProvider>,
  );
}
const tid = (id: string) => screen.getByTestId(id);
const type = (id: string, value: string) => fireEvent.change(tid(id), { target: { value } });
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('DictionaryEditor', () => {
  it('adding an action expression applies to the sentence test right away', () => {
    const store = new DictionaryStore(mem());
    mount(store);
    type('dict-action-input', '박아넣어');
    fireEvent.click(tid('dict-action-add'));
    expect(tid('dict-own-ATTACK-박아넣어')).toBeInTheDocument();
    expect(store.getMerged().actions.ATTACK).toContain('박아넣어');
    openTab('사전 테스트');
    type('dict-test-input', '1파티 박아넣어');
    expect(tid('dict-test-result')).toHaveTextContent('공격');
    expect(tid('dict-test-result')).toHaveTextContent('신뢰도 높음');
  });

  it('warns when the expression belongs to another action and lets the user move it', () => {
    const store = new DictionaryStore(mem());
    mount(store);
    type('dict-action-input', '후퇴');
    fireEvent.click(tid('dict-action-add')); // action select defaults to 공격; 후퇴 is RETREAT
    expect(tid('dict-action-conflict')).toHaveTextContent('후퇴');
    expect(store.getAlliance().actions.ATTACK).toEqual([]);
    fireEvent.click(tid('dict-conflict-move'));
    expect(store.getMerged().actions.ATTACK).toContain('후퇴');
    expect(store.getMerged().actions.RETREAT).not.toContain('후퇴');
  });

  it('switching off a built-in expression removes it from the merged dictionary', () => {
    const store = new DictionaryStore(mem());
    mount(store);
    fireEvent.click(tid('dict-base-HOLD-스탑'));
    expect(store.getMerged().actions.HOLD).not.toContain('스탑');
    fireEvent.click(tid('dict-base-HOLD-스탑'));
    expect(store.getMerged().actions.HOLD).toContain('스탑');
  });

  it('adds a location with an alias and the parser resolves it', () => {
    const store = new DictionaryStore(mem());
    mount(store);
    openTab('위치');
    type('dict-loc-label', '북문');
    type('dict-loc-aliases', '위쪽 문');
    fireEvent.click(tid('dict-loc-add'));
    expect(tid('dict-loc-CUSTOM_1')).toHaveTextContent('북문');
    openTab('사전 테스트');
    type('dict-test-input', '2파티 위쪽 문 공격');
    expect(tid('dict-test-result')).toHaveTextContent('북문');
  });

  it('rejects an invalid import with reasons and imports a valid one (merge)', () => {
    const store = new DictionaryStore(mem());
    mount(store);
    openTab('내보내기·가져오기');
    type('dict-import-text', '{"version":2,"name":"x"}');
    fireEvent.click(tid('dict-import-check'));
    expect(tid('dict-import-errors')).toHaveTextContent('버전');
    type('dict-import-text', 'not json');
    fireEvent.click(tid('dict-import-check'));
    expect(tid('dict-import-errors')).toHaveTextContent('JSON');
    expect(store.getAlliance().actions.ATTACK).toEqual([]);

    type('dict-import-text', JSON.stringify({ version: 1, name: '받은 사전', actions: { ATTACK: ['찍어'] } }));
    fireEvent.click(tid('dict-import-check'));
    fireEvent.click(tid('dict-import-merge'));
    expect(store.getMerged().actions.ATTACK).toContain('찍어');
  });

  it('suggests frequent discarded words and adds one to the chosen action', async () => {
    const store = new DictionaryStore(mem());
    mount(store, [
      { at: 1, text: '북쪽 찍어', reason: 'x' },
      { at: 2, text: '1파티 찍어', reason: 'x' },
    ]);
    openTab('추천');
    await waitFor(() => expect(tid('dict-suggest-찍어')).toBeInTheDocument());
    expect(tid('dict-suggest-add-찍어')).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText('찍어 행동')[0]!);
    fireEvent.click(await screen.findByRole('option', { name: '공격', hidden: true }));
    fireEvent.click(tid('dict-suggest-add-찍어'));
    expect(store.getMerged().actions.ATTACK).toContain('찍어');
  });

  it('shows id clashes in the merge review and keeps both places', () => {
    const store = new DictionaryStore(mem());
    store.set({ ...emptyAllianceDictionary('나'), locations: [{ id: 'CUSTOM_1', label: '다리', aliases: [] }] });
    mount(store);
    openTab('내보내기·가져오기');
    type('dict-import-text', JSON.stringify({ ...emptyAllianceDictionary('너'), locations: [{ id: 'CUSTOM_1', label: '성문', aliases: ['게이트'] }] }));
    fireEvent.click(tid('dict-import-check'));
    expect(tid('dict-merge-diff')).toHaveTextContent('다리');
    expect(tid('dict-merge-diff')).toHaveTextContent('CUSTOM_2');
    fireEvent.click(tid('dict-import-merge'));
    expect(store.getAlliance().locations.map((l) => l.label)).toEqual(['다리', '성문']);
  });

  it('shows an error instead of throwing when the merged dictionary exceeds the limits', () => {
    const store = new DictionaryStore(mem());
    const many = (p: string) => Array.from({ length: 300 }, (_, i) => `${p}${i}`);
    store.set({ ...emptyAllianceDictionary('나'), actions: { ...emptyAllianceDictionary().actions, ATTACK: many('가') } });
    mount(store);
    openTab('내보내기·가져오기');
    type('dict-import-text', JSON.stringify({ ...emptyAllianceDictionary('너'), actions: { ...emptyAllianceDictionary().actions, ATTACK: many('나') } }));
    fireEvent.click(tid('dict-import-check'));
    fireEvent.click(tid('dict-import-merge'));
    expect(tid('dict-import-apply-error')).toHaveTextContent('한도');
    expect(store.getAlliance().actions.ATTACK).toHaveLength(300);
  });
});
