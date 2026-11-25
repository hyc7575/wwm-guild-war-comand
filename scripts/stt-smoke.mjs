#!/usr/bin/env node
// 실제 모델 스모크: 헤드리스 Chromium에서 /bench 를 열어 sherpa-onnx 파이프라인이 도는지 확인한다.
//  1) wasm 초기화  2) 모델 FS 기록  3) 인식기 생성  4) 오디오 청크 흐름  5) partial/final  6) transcribeFile(파일 평가 경로)
// 사전 조건: pnpm fetch:stt-wasm 완료. 첫 실행은 Hugging Face에서 모델(~73MB)을 받는다(브라우저 캐시는 실행마다 새로라서 매번 받는다).
// 옵션: --engine=sherpa-72m|sherpa-k2  --listen-ms=10000  --port=5199  --url=이미 떠 있는 서버  --headed
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) =>
  process.argv
    .find((a) => a.startsWith(`--${k}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? d;
const ENGINE = arg('engine', 'sherpa-72m');
const LISTEN_MS = Number(arg('listen-ms', '10000'));
// 5173은 다른 프로젝트의 dev 서버와 겹치기 쉬워 전용 포트를 쓴다(strictPort)
const PORT = arg('port', '5199');
const BASE = arg('url', `http://localhost:${PORT}`);
const HEADED = process.argv.includes('--headed');
const PREPARE_TIMEOUT = 10 * 60_000;

const report = { engine: ENGINE, steps: {}, consoleErrors: [], pageErrors: [], failed: [] };
const mark = (k, v) => (
  (report.steps[k] = v),
  console.log(`[smoke] ${k}:`, typeof v === 'object' ? JSON.stringify(v) : v)
);

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

// ---- 테스트 음성 만들기: macOS 한국어 TTS가 있으면 그것으로, 없으면 비프음 ----
function makeWav(dir) {
  const wav = join(dir, 'utt.wav');
  const text = '삼파티 거점으로 이동해 주세요';
  try {
    execFileSync('say', ['-v', 'Yuna', '-o', join(dir, 'utt.aiff'), text]);
    execFileSync('afconvert', [
      '-f',
      'WAVE',
      '-d',
      'LEI16@16000',
      '-c',
      '1',
      join(dir, 'utt.aiff'),
      join(dir, 'raw.wav'),
    ]);
    // 발화 뒤 2.5초 무음을 붙여 엔드포인트가 나게 한다(fake 마이크는 이 파일을 반복 재생한다)
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      join(dir, 'raw.wav'),
      '-af',
      'apad=pad_dur=2.5',
      '-ar',
      '16000',
      '-ac',
      '1',
      wav,
    ]);
    return { wav, text, kind: 'macOS say(Yuna) 한국어 TTS' };
  } catch {
    // 1초 440Hz 비프 + 2.5초 무음, 16kHz mono PCM16
    const sr = 16000;
    const n = Math.round(sr * 3.5);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < sr; i++)
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 8000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(sr, 24);
    h.writeUInt32LE(sr * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    writeFileSync(wav, Buffer.concat([h, pcm]));
    return { wav, text: '', kind: '비프음(한국어 TTS 사용 불가)' };
  }
}

let server;
let exitCode = 0;
try {
  if (!existsSync(join(root, 'apps/web/public/vendor/sherpa-onnx/sherpa-onnx-wasm-web.wasm'))) {
    throw new Error('WASM 자산이 없습니다. 먼저 `pnpm fetch:stt-wasm` 을 실행하세요.');
  }
  if (!(await reachable(BASE))) {
    console.log(`[smoke] dev 서버 시작: vite --port ${PORT}`);
    server = spawn(
      'pnpm',
      ['--filter', '@winds/web', 'exec', 'vite', '--port', PORT, '--strictPort'],
      { cwd: root, stdio: 'ignore', detached: true },
    );
    for (let i = 0; i < 60 && !(await reachable(BASE)); i++)
      await new Promise((r) => setTimeout(r, 500));
    if (!(await reachable(BASE))) throw new Error('dev 서버가 뜨지 않았습니다');
  }

  const work = mkdtempSync(join(tmpdir(), 'stt-smoke-'));
  const audio = makeWav(work);
  mark('testAudio', audio.kind);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${audio.wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => report.pageErrors.push(String(e)));

  await page.goto(`${BASE}/bench`);
  await page.getByTestId('engine').selectOption(ENGINE);
  await page.getByTestId('check').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid=support]')?.textContent?.match(/OK|NO/),
  );
  mark('support', await page.getByTestId('support').textContent());

  // ---- 준비(모델 다운로드 + wasm 초기화) ----
  const t0 = Date.now();
  await page.getByTestId('prepare').click();
  await page.waitForFunction(
    () => {
      const b = window.__windsBench;
      return b && (b.state.status === 'READY' || b.state.status === 'ERROR');
    },
    undefined,
    { timeout: PREPARE_TIMEOUT, polling: 500 },
  );
  const prep = await page.evaluate(() => {
    const b = window.__windsBench;
    return {
      status: b.state.status,
      error: b.state.error,
      diagnostics: b.engine.diagnostics ?? [],
      initMs: b.engine.initMs,
      wasmHeapMB: (b.engine.heapBytes ?? 0) / 1048576,
    };
  });
  mark('prepare', { ...prep, totalMs: Date.now() - t0 });
  const d = prep.diagnostics.join('\n');
  mark('wasmInitialized', /wasm-initialized/.test(d));
  mark('modelInFS', /model-written/.test(d));
  mark('recognizerCreated', /recognizer-created/.test(d));
  mark('warmupOk', /warmup-ok/.test(d));
  if (prep.status !== 'READY') throw new Error(`prepare 실패: ${prep.error}`);

  // ---- 라이브 경로 ----
  await page.getByTestId('start').click();
  await page.waitForTimeout(LISTEN_MS);
  const live = await page.evaluate(() => {
    const b = window.__windsBench;
    return {
      status: b.state.status,
      counts: b.counts,
      audioChunks: b.engine.audioChunks,
      finals: b.state.rows.map((r) => ({ text: r.text, latencyMs: r.latencyMs, parse: r.parse })),
      partial: b.state.partial,
      audioMs: b.state.audioMs,
      decodeMs: b.state.decodeMs,
      rtf: b.state.audioMs ? b.state.decodeMs / b.state.audioMs : null,
      error: b.state.error,
      logs: b.state.logs.slice(-12),
    };
  });
  mark('live', live);
  mark('audioChunksFlowed', live.audioChunks > 0 && live.counts.metrics > 0);
  await page.getByTestId('stop').click();
  await page.waitForTimeout(500);

  // ---- transcribeFile: Float32 직접 ----
  const direct = await page.evaluate(async () => {
    const sr = 16000;
    const beep = new Float32Array(sr * 3);
    for (let i = 0; i < sr; i++) beep[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3;
    const silent = new Float32Array(sr * 2);
    const out = {};
    for (const [k, s] of [
      ['beep', beep],
      ['silence', silent],
    ]) {
      const r = await window.__windsBench.engine.transcribeFile(s, sr);
      out[k] = {
        text: r.text,
        audioMs: r.audioMs,
        decodeMs: Math.round(r.decodeMs),
        rtf: Number(r.rtf.toFixed(3)),
      };
    }
    return out;
  });
  mark('transcribeFile(beep/silence)', direct);

  // ---- 파일 평가 UI 경로(WAV 파일 선택 -> JSONL) ----
  const casesPath = join(work, 'cases.jsonl');
  writeFileSync(
    casesPath,
    [
      JSON.stringify({
        id: 'audio1',
        audioUrl: 'utt.wav',
        text: audio.text || undefined,
        expect: [{ kind: 'NONE' }],
      }),
      JSON.stringify({ id: 'text1', text: '삼파티 거점 앞으로 이동', expect: [{ kind: 'NONE' }] }),
    ].join('\n'),
  );
  await page.getByTestId('cases-file').setInputFiles(casesPath);
  await page.getByTestId('audio-files').setInputFiles(audio.wav);
  await page.getByTestId('eval-run').click();
  await page.waitForSelector('[data-testid=eval-out]', { timeout: 120_000 });
  const evalOut = (await page.getByTestId('eval-out').textContent())
    ?.trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  mark('fileEval', evalOut);
  mark('fileEvalAudioOk', Boolean(evalOut?.[0]?.stt?.audioMs > 0));

  mark('referenceText', audio.text);
  await browser.close();
} catch (e) {
  report.failed.push(String(e?.stack ?? e));
  exitCode = 1;
} finally {
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  console.log('\n===== SMOKE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}
