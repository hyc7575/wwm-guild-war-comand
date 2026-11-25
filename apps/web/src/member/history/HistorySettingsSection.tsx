import { useState } from 'react';
import { getHistoryStore, type HistoryStore } from './HistoryStore';
import { useHistorySettings } from './settings';

/** Settings-drawer part: transcript saving toggle (default off; turning it off deletes saved transcripts) and a confirmed clear button. */
export function HistorySettingsSection({ history }: { history?: HistoryStore }) {
  const { saveTranscript, setSaveTranscript } = useHistorySettings();
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const store = () => history ?? getHistoryStore();
  return (
    <>
      <label className="history-row" style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
        <input
          type="checkbox"
          checked={saveTranscript}
          onChange={(e) => {
            setSaveTranscript(e.target.checked);
            if (!e.target.checked) void store().stripTranscripts();
          }}
          data-testid="opt-save-transcript"
        />
        인식 원문도 이력에 저장 (원문을 받는 화면에서만 의미 있음; 끄면 저장된 원문도 삭제)
      </label>
      {confirming ? (
        <span role="group" aria-label="이력 지우기 확인" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          이 브라우저의 이력을 모두 지울까요?
          <button
            type="button"
            data-testid="history-clear-confirm"
            style={{ minHeight: 44 }}
            onClick={() =>
              void store()
                .clearAll()
                .then(() => {
                  setConfirming(false);
                  setCleared(true);
                })
            }
          >
            지우기
          </button>
          <button type="button" data-testid="history-clear-cancel" style={{ minHeight: 44 }} onClick={() => setConfirming(false)}>
            취소
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-testid="history-clear"
          style={{ minHeight: 44 }}
          onClick={() => {
            setCleared(false);
            setConfirming(true);
          }}
        >
          저장된 이력 지우기
        </button>
      )}
      {cleared && <p role="status">이 브라우저의 이력을 지웠습니다</p>}
    </>
  );
}
