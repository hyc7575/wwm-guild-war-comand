import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './HistoryStore';
import { HistorySettingsSection } from './HistorySettingsSection';
import { PastHistory } from './PastHistory';
import { useHistorySettings } from './settings';
import { memoryKv } from './testUtil';
import type { HistoryEntry } from './types';

const e = (id: string, seq: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, seq, issuedAt: Date.now(), target: [1, 2], action: 'GATHER', location: '중앙', status: 'ACTIVE', source: 'VOICE', issuerRole: 'SUB_COMMANDER', repeatCount: 0, ...over,
});
afterEach(cleanup);

describe('PastHistory', () => {
  it('shows earlier visits of this room and other rooms, read-only', async () => {
    const history = new HistoryStore(memoryKv());
    await history.record('ABC234', [e('old', 1), e('now', 2)]);
    await history.record('ZZZ999', [e('z', 1, { target: 'ALL', status: 'CANCELLED', cancelReason: 'CHANGED' })], { closed: true });
    render(<PastHistory roomCode="ABC234" currentIds={new Set(['now'])} history={history} />);
    expect(screen.queryByTestId('past-body')).toBeNull();
    fireEvent.click(screen.getByTestId('past-toggle'));
    await waitFor(() => expect(screen.getByTestId('past-body')).toBeTruthy());
    const rows = screen.getAllByTestId('past-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('1·2파티 집결 중앙');
    expect(rows[0]?.textContent).toContain('서브오더');
    expect(screen.getByTestId('past-room').textContent).toContain('종료됨');
    expect(rows[1]?.textContent).toContain('취소: 작전 변경');
  });

  it('shows an empty state when storage has nothing', async () => {
    render(<PastHistory roomCode="ABC234" currentIds={new Set()} history={new HistoryStore(memoryKv())} />);
    fireEvent.click(screen.getByTestId('past-toggle'));
    await waitFor(() => expect(screen.getAllByText('없음')).toHaveLength(2));
  });
});

describe('HistorySettingsSection', () => {
  it('toggles transcript saving (default off); turning it off deletes stored transcripts', async () => {
    localStorage.clear();
    useHistorySettings.getState().reload();
    const history = new HistoryStore(memoryKv());
    await history.record('R', [e('a', 1, { transcript: '원문' })]);
    render(<HistorySettingsSection history={history} />);
    const box = screen.getByTestId('opt-save-transcript') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(useHistorySettings.getState().saveTranscript).toBe(true);
    expect((await history.listRooms())[0]?.entries[0]?.transcript).toBe('원문');
    fireEvent.click(box);
    await waitFor(async () => expect((await history.listRooms())[0]?.entries[0]?.transcript).toBeUndefined());
    expect(useHistorySettings.getState().saveTranscript).toBe(false);
  });

  it('clearing asks first, cancel keeps data, confirm clears and refreshes an open list', async () => {
    const history = new HistoryStore(memoryKv());
    await history.record('ZZZ999', [e('z', 1)]);
    render(
      <>
        <PastHistory roomCode="ABC234" currentIds={new Set()} history={history} />
        <HistorySettingsSection history={history} />
      </>,
    );
    fireEvent.click(screen.getByTestId('past-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('past-row')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('history-clear'));
    fireEvent.click(screen.getByTestId('history-clear-cancel'));
    expect((await history.listRooms()).length).toBe(1);
    fireEvent.click(screen.getByTestId('history-clear'));
    fireEvent.click(screen.getByTestId('history-clear-confirm'));
    await waitFor(() => expect(screen.queryAllByTestId('past-row')).toHaveLength(0));
    expect(await history.listRooms()).toEqual([]);
  });
});

describe('PastHistory availability and status', () => {
  it('says saving is impossible when the store failed', async () => {
    const history = new HistoryStore({ get: async () => { throw new Error('x'); }, set: async () => undefined, del: async () => undefined, keys: async () => ['k'] });
    render(<PastHistory roomCode="ABC234" currentIds={new Set()} history={history} />);
    fireEvent.click(screen.getByTestId('past-toggle'));
    await waitFor(() => expect(screen.getByTestId('past-unavailable')).toHaveTextContent('이력 저장 불가'));
  });

  it('does not label stored ACTIVE entries as "진행"', async () => {
    const history = new HistoryStore(memoryKv());
    await history.record('ABC234', [e('old', 1)]);
    render(<PastHistory roomCode="ABC234" currentIds={new Set()} history={history} />);
    fireEvent.click(screen.getByTestId('past-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('past-row')).toHaveLength(1));
    expect(screen.getByTestId('past-row').textContent).not.toContain('진행');
  });
});
