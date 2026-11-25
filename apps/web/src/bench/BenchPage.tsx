import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  listMicrophones,
  rememberMic,
  resolveRememberedMic,
  type MicrophoneInfo,
} from '@winds/stt';
import { Bench, ENGINE_LABELS, type EngineKey } from './controller';
import { parseCasesJsonl } from './metrics';

let singleton: Bench | undefined;
const getBench = () => (singleton ??= new Bench());

const box: React.CSSProperties = {
  border: '1px solid #333b4a',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
const mb = (n: number | undefined) => (n === undefined ? '-' : `${n.toFixed(0)}MB`);

export function BenchPage() {
  const bench = getBench();
  const s = useSyncExternalStore(bench.subscribe, () => bench.state);
  const [mics, setMics] = useState<MicrophoneInfo[]>([]);
  const [fakeText, setFakeText] = useState('삼파티 거점 앞으로 이동');
  const [cases, setCases] = useState<ReturnType<typeof parseCasesJsonl>>([]);
  const [audio, setAudio] = useState<File[]>([]);
  const [evalErr, setEvalErr] = useState('');

  useEffect(() => {
    void (async () => {
      const id = await resolveRememberedMic();
      bench.deviceId = id;
      setMics(await listMicrophones());
    })();
  }, [bench]);

  const pct =
    s.progress && s.progress.total
      ? Math.min(100, (100 * s.progress.loaded) / s.progress.total)
      : 0;
  const rtf = s.audioMs ? s.decodeMs / s.audioMs : undefined;
  const lat = s.rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : undefined;
  const isSherpa = s.engineKey.startsWith('sherpa');

  return (
    <div
      style={{ maxWidth: 960, margin: '0 auto', padding: 16, fontSize: 14, lineHeight: 1.5 }}
      data-testid="bench"
    >
      <h1 style={{ fontSize: 20 }}>STT 벤치 (P-2 모델 비교)</h1>
      <p style={{ opacity: 0.7 }}>
        음성은 이 브라우저 밖으로 나가지 않습니다. 모델 파일만 Hugging Face에서 받습니다.
      </p>

      <section style={box}>
        <label>
          엔진{' '}
          <select
            data-testid="engine"
            value={s.engineKey}
            onChange={(e) => void bench.setEngine(e.target.value as EngineKey)}
          >
            {(Object.keys(ENGINE_LABELS) as EngineKey[]).map((k) => (
              <option key={k} value={k}>
                {ENGINE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          마이크{' '}
          <select
            data-testid="mic"
            value={bench.deviceId ?? ''}
            onChange={(e) => {
              bench.deviceId = e.target.value || undefined;
              rememberMic(bench.deviceId);
              setMics([...mics]);
            }}
          >
            <option value="">시스템 기본</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button data-testid="check" onClick={() => void bench.checkSupport()}>
            지원 확인
          </button>
          <button data-testid="prepare" onClick={() => void bench.prepare()}>
            준비 (다운로드/초기화)
          </button>
          <button
            data-testid="start"
            onClick={() => void bench.start().then(async () => setMics(await listMicrophones()))}
          >
            시작
          </button>
          <button data-testid="stop" onClick={() => void bench.stop()}>
            정지
          </button>
        </div>
        <p data-testid="support">
          지원: {s.support ? (s.support.ok ? 'OK' : 'NO') : '-'} {s.support?.reason ?? ''}
        </p>
        <p>
          상태: <b data-testid="status">{s.statusText}</b> ({s.status}) · 복구 {s.recoveries}회 ·
          듣는 시간 {(s.activeListeningMs / 1000).toFixed(0)}s
        </p>
        <div
          style={{ background: '#222', height: 10, borderRadius: 5, overflow: 'hidden' }}
          aria-label="진행률"
        >
          <div
            data-testid="progress"
            style={{ width: `${pct}%`, height: '100%', background: '#4c8dff' }}
          />
        </div>
        <small>
          {s.progress
            ? `${s.progress.phase} ${s.progress.file ?? ''} ${mb(s.progress.loaded / 1048576)} / ${mb(s.progress.total / 1048576)}`
            : '대기'}
        </small>
        <div
          style={{ background: '#222', height: 6, borderRadius: 3, marginTop: 8 }}
          aria-label="음량"
        >
          <div
            style={{
              width: `${Math.round(s.level * 100)}%`,
              height: '100%',
              background: '#4caf50',
            }}
          />
        </div>
        {s.error && (
          <p style={{ color: '#ff6b6b' }} data-testid="error">
            오류: {s.error}
          </p>
        )}
      </section>

      {s.engineKey === 'fake' && (
        <section style={box}>
          <input
            data-testid="fake-text"
            value={fakeText}
            onChange={(e) => setFakeText(e.target.value)}
            style={{ width: '60%' }}
          />{' '}
          <button data-testid="fake-inject" onClick={() => void bench.injectFake(fakeText)}>
            발화 주입
          </button>
        </section>
      )}

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>실시간 결과</h2>
        <p data-testid="partial" style={{ minHeight: 24, opacity: 0.7 }}>
          {s.partial || '…'}
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>시각</th>
              <th>확정 텍스트</th>
              <th>지연</th>
              <th>파서</th>
            </tr>
          </thead>
          <tbody data-testid="rows">
            {s.rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #333b4a', verticalAlign: 'top' }}>
                <td>{new Date(r.at).toLocaleTimeString()}</td>
                <td>{r.text}</td>
                <td>{r.latencyMs}ms</td>
                <td>
                  {r.parse.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          지연 = 확정 수신 시각 - 말이 끝난 시각 추정(마지막 텍스트 변화). 중앙값 {p50 ?? '-'}ms (
          {lat.length}건)
        </p>
      </section>

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>성능</h2>
        {isSherpa ? (
          <p data-testid="perf">
            청크 {s.chunks}개 · 오디오 {(s.audioMs / 1000).toFixed(1)}s · 디코딩{' '}
            {(s.decodeMs / 1000).toFixed(2)}s · RTF {rtf?.toFixed(3) ?? '-'}
          </p>
        ) : (
          <p>RTF는 sherpa-onnx 엔진에서만 측정합니다.</p>
        )}
        <p>
          메모리(1분마다):{' '}
          {s.mem.slice(-5).map((m, i) => (
            <span key={i}>
              [{new Date(m.at).toLocaleTimeString()} JS {mb(m.usedMB)}/{mb(m.totalMB)}
              {m.wasmHeapMB !== undefined ? ` WASM ${mb(m.wasmHeapMB)}` : ''}]{' '}
            </span>
          ))}
          {s.mem.every((m) => m.usedMB === undefined) &&
            ' (performance.memory 없음: Chromium 계열에서만 제공)'}
        </p>
        <small>JS 힙은 메인 스레드만이다. WASM 힙은 워커 쪽 값이며 준비 직후 크기다.</small>
      </section>

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>파일로 평가</h2>
        <p style={{ opacity: 0.7 }}>
          케이스 JSONL: 한 줄에 {'{'}id?, text?, audioUrl?, expect{'}'}. 음성 케이스는 audioUrl의
          파일명과 같은 WAV를 아래에서 고릅니다(text는 기준 전사로 CER 계산). 음성이 없으면 text를
          그대로 파서에 넣습니다. 결과 JSONL은{' '}
          <code>pnpm --filter @winds/parser golden -- 파일.jsonl</code> 로 채점합니다.
        </p>
        <div>
          <label>
            케이스 JSONL{' '}
            <input
              data-testid="cases-file"
              type="file"
              accept=".jsonl,.json,.txt"
              onChange={async (e) => {
                try {
                  const f = e.target.files?.[0];
                  if (f) setCases(parseCasesJsonl(await f.text()));
                  setEvalErr('');
                } catch (err) {
                  setEvalErr((err as Error).message);
                }
              }}
            />
          </label>
        </div>
        <div>
          <label>
            오디오(WAV){' '}
            <input
              data-testid="audio-files"
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => setAudio([...(e.target.files ?? [])])}
            />
          </label>
        </div>
        <button
          data-testid="eval-run"
          disabled={!cases.length || !!s.evalRunning}
          onClick={() => {
            setEvalErr('');
            bench.evaluate(cases, audio).catch((e: Error) => setEvalErr(e.message));
          }}
        >
          평가 실행 ({cases.length}건, 오디오 {audio.length}개)
        </button>{' '}
        {s.evalOut && (
          <button
            data-testid="eval-download"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([s.evalOut ?? ''], { type: 'application/x-ndjson' }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = `stt-eval-${s.engineKey}-${Date.now()}.jsonl`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            결과 JSONL 내려받기
          </button>
        )}
        {s.evalRunning && <p>진행: {s.evalRunning}</p>}
        {evalErr && <p style={{ color: '#ff6b6b' }}>{evalErr}</p>}
        {s.evalOut && (
          <pre
            data-testid="eval-out"
            style={{ maxHeight: 200, overflow: 'auto', background: '#161a22', padding: 8 }}
          >
            {s.evalOut}
          </pre>
        )}
      </section>

      <section style={box}>
        <h2 style={{ fontSize: 16 }}>로그</h2>
        <pre
          data-testid="logs"
          style={{
            maxHeight: 220,
            overflow: 'auto',
            background: '#161a22',
            padding: 8,
            fontSize: 12,
          }}
        >
          {s.logs.join('\n')}
        </pre>
      </section>
    </div>
  );
}
