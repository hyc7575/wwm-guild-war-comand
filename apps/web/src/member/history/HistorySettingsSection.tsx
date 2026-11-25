import { useState } from 'react';
import { getHistoryStore, type HistoryStore } from './HistoryStore';
import { useHistorySettings } from './settings';

/** Settings-drawer part: transcript saving toggle (default off) and clear button. */
export function HistorySettingsSection({ history }: { history?: HistoryStore }) {
  const { saveTranscript, setSaveTranscript } = useHistorySettings();
  const [cleared, setCleared] = useState(false);
  return (
    <>
      <label className="history-row" style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
        <input type="checkbox" checked={saveTranscript} onChange={(e) => setSaveTranscript(e.target.checked)} data-testid="opt-save-transcript" />
        인식 원문도 이력에 저장 (원문을 받는 화면에서만 의미 있음)
      </label>
      <button
        type="button"
        data-testid="history-clear"
        style={{ minHeight: 44 }}
        onClick={() => void (history ?? getHistoryStore()).clearAll().then(() => setCleared(true))}
      >
        저장된 이력 지우기
      </button>
      {cleared && <p role="status">이 브라우저의 이력을 지웠습니다</p>}
    </>
  );
}
