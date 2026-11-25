# 브라우저 STT 통합 조사 노트

조사일: 2026-11-26 · 관련 문서: [F02 연속 음성인식](../features/F02-continuous-stt.md), [한국어 STT 모델 조사](korean-stt-models.md)

목적: F02의 엔진 인터페이스 뒤에 구현체 3개를 붙이는 데 필요한 사실을 확인한다.

1. sherpa-onnx WebAssembly 스트리밍 Zipformer
2. Chrome 온디바이스 Web Speech API (`processLocally`)
3. 테스트용 가짜 엔진

> 표기: **[확인]**은 파일·API·소스 코드로 직접 확인한 사실이다. **[추정]**은 근거는 있으나 실행으로 확인하지 않은 내용이다. **[PoC]**는 실측이 필요한 항목이다.

## 결론

| 항목 | 결론 |
|---|---|
| 모델 | **kangkyu 72M chunk-16 int8**을 쓴다. Apache-2.0이고, sherpa-onnx용 int8 파일이 있고, 다운로드는 약 73MB다 |
| WASM 엔진 | **pub.dev `sherpa_onnx_web` 2.0.3 패키지의 브라우저용 빌드**를 쓴다. k2-fsa가 공식으로 빌드한 파일이다. 모델을 내장하지 않고, `FS`를 내보내고, 스레드를 쓰지 않는다 |
| 런타임 모델 로딩 | 가능하다. `Module.FS.writeFile()`로 모델 바이트를 쓰고 그 경로로 인식기를 만든다 **[확인: 소스·빌드 설정]**. 실제 실행은 아직 하지 않았다 **[PoC]** |
| COOP/COEP | 필요 없다. 현재 WASM 빌드는 pthread를 끈다 |
| Web Speech 온디바이스 | Chrome/Edge 139부터 API가 있다. 한국어 팩은 Edge 문서에 명시되어 있다. Chrome은 대상 PC에서 `available()`로 확인해야 한다 |
| 핫워드 | WASM에서 쓸 수 있다. `modified_beam_search` + `hotwordsBuf` 문자열로 넣는다. 72M 모델은 `modelingUnit: 'cjkchar'`를 반드시 지정한다 |

## 1. 모델 선택

### 1.1 kangkyu/icefall-asr-ko-streaming-zipformer-72m (추천)

| 항목 | 값 |
|---|---|
| 라이선스 | **Apache-2.0** (모델 카드 메타데이터 `license: apache-2.0`, README "License: Apache 2.0") |
| 고정 리비전 | `db24b58d22736349eaeb34cc181ad0f3debf9903` (2026-05-08) |
| 구조 | Zipformer2 causal transducer, 71.4M 파라미터 |
| 어휘 | 한국어 음절 2,460개 + `▁`(띄어쓰기) 토큰. BPE 아님 |
| 학습 데이터 | KsponSpeech 약 1,000시간 (AIHub 123번 데이터) |
| 보고된 CER | KsponSpeech eval, sherpa-onnx int8: chunk-16 8.64%, chunk-32 8.39%, chunk-64 8.25% |
| ONNX 메타데이터 | 인코더에 `model_type=zipformer2`, `decode_chunk_len=32`, `left_context_len=128,64,32,16,32,64`가 있다 **[확인: 파일 끝부분을 Range 요청으로 읽음]**. sherpa-onnx `OnlineRecognizer`가 모델 종류를 자동으로 판별한다 |

**파일 (chunk-16 기준, 바이트)**

| 파일 | 크기 | SHA-256 |
|---|---:|---|
| `encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 70,133,869 | `5f2b6e5e92834849cfdbda3aaa355e6f39ff993f067794e4ab9d5cb993b15311` |
| `decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 1,544,210 | `40c3c57ad27b45b59e27bec8bfc02f04d27c060aeb8e964ae2f87bd9f356bf7d` |
| `joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx` | 1,270,777 | `7d3bd9c1e9cf60efa5d5fed728fbd52d0f08139775f9e9002fd088b4d78f3e73` |
| `tokens.txt` | 20,844 | `435dfb9e0a2b6a79124f1a4d8f0f33a951b25384726e2e0d854f081533e6ec9d` |
| **합계** | **72,969,700 (약 69.6 MiB)** | 출처: 저장소의 `SHA256SUMS` |

- chunk-32·64 인코더도 있다 (70,131,794 / 70,121,444 바이트). 디코더·조이너는 세 chunk가 같은 파일이다 (해시 동일).
- fp32 ONNX는 없다. 필요하면 `epoch-99.pt`(285,871,088 바이트)에서 다시 내보내야 한다.
- 다운로드 URL 형식: `https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m/resolve/db24b58d22736349eaeb34cc181ad0f3debf9903/<파일명>`. `main` 대신 커밋 해시를 쓰면 파일이 바뀌지 않는다.

**chunk 선택**: chunk-16을 기본으로 한다. 모델 카드의 지연은 chunk-16이 320ms, chunk-32가 640ms다. F02 목표(발화 종료 후 300ms 이내 최종 결과)에 가장 가깝다. 정확도 차이는 0.25%p 정도다.

**CORS** **[확인: `curl -H "Origin: http://localhost:5173"`]**

- `huggingface.co/.../resolve/...` → 302 응답. `access-control-allow-origin`에 요청 Origin을 그대로 돌려준다.
- 리다이렉트 대상 `us.aws.cdn.hf.co/xet-bridge-us/...` → 200, `access-control-allow-origin: *`, `content-length` 있음.
- 작은 파일(`tokens.txt`)은 307로 `/api/resolve-cache/...`에 보낸다. 같은 CORS 헤더가 붙는다.
- `Range` 헤더 프리플라이트도 허용된다 (`access-control-allow-headers: range`). 이어받기를 구현할 수 있다.
- 결론: 브라우저 `fetch()`로 바로 받을 수 있다. 진행률은 `content-length`와 `ReadableStream`으로 계산한다.

### 1.2 k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16 (비교 기준)

| 항목 | 값 |
|---|---|
| 라이선스 | **Apache-2.0** (README 메타데이터) |
| 출처 | `johnBamma/icefall-asr-ksponspeech-pruned-transducer-stateless7-streaming-2024-06-12`를 변환. 학습 방법은 icefall PR #1651 |
| 구조 | Zipformer **v1** (`model_type=zipformer`), `encoder_dims=384,...` |
| 어휘 | BPE 5,000개 (`bpe.model` 포함). `▁`로 시작하는 조각이 2,352개 |
| int8 파일 | `encoder-epoch-99-avg-1.int8.onnx` 126,968,852 · `decoder-epoch-99-avg-1.int8.onnx` 2,844,692 · `joiner-epoch-99-avg-1.int8.onnx` 2,581,421 · `tokens.txt` 60,246 |
| **합계** | **132,455,211 바이트 (약 126.3 MiB)**. 72M의 약 1.8배 |

**이슈 #2886 "빈 결과"** (2025-12-10 등록, 아직 열림)

- 증상: 모델은 오류 없이 로드된다. `isReady()`도 참이다. 그러나 `getResult()`가 항상 빈 문자열이다.
- 추가 실험 결과: 모델 폴더의 `test_wavs`를 직접 넣으면 80~85% 정도 맞힌다. **같은 파일을 스피커로 틀고 마이크로 녹음하면 0%다.** 엔드포인트를 끄거나, 음량을 10배 올리거나, `isReady()`를 우회해도 같다. 같은 경로에서 SenseVoice는 잘 된다.
- 메인테이너 답변: "학습·평가 데이터에서만 동작한다면 학습 데이터 문제일 수 있다." 수정은 없다.
- 그 밖에: HF 보안 스캔이 인코더에 `PAIT-ONNX-200` 경고를 붙였다.
- 우리에게 주는 뜻: 실제 마이크 입력이 서비스의 전부다. 이 모델은 기준선으로만 쓴다.

### 1.3 추천과 이유

**kangkyu 72M chunk-16 int8을 주력으로 한다.**

1. 라이선스가 Apache-2.0으로 명시되어 있다.
2. sherpa-onnx용 int8 파일이 바로 있다. 변환 작업이 필요 없다.
3. 다운로드가 73MB로, 공식 모델(132MB)보다 작다.
4. 스트리밍 int8 CER이 공개되어 있다.
5. 음절 어휘라 핫워드 등록이 단순하다 (1.4절, 4절).
6. 공식 모델은 마이크 입력에서 빈 결과가 나온다는 미해결 이슈가 있다.

**위험**: 72M도 KsponSpeech만으로 학습했다. #2886과 같은 문제(실제 마이크 음성에서 실패)가 있을 수 있다. **PoC 첫날에 실제 마이크로 확인한다.** 실패하면 형제 모델 174M(KsponSpeech + AIHub 6,500시간, Apache-2.0, chunk-16 인코더 156,840,518 바이트)을 시험한다.

**남은 확인**: KsponSpeech(AIHub) 데이터 이용 약관이 학습된 모델의 배포에 조건을 두는지는 이번에 확인하지 않았다.

## 2. 브라우저에서 sherpa-onnx 스트리밍 ASR 실행

### 2.1 WASM을 얻는 방법 비교

최신 릴리스: **sherpa-onnx v2.0.3** (2026-11-22).

| 방법 | 쓸 수 있나 | 이유 |
|---|---|---|
| npm `sherpa-onnx` 2.0.3 | **아니요** | Node.js 전용 빌드다. `-sNODERAWFS=1`, `-sWASM_ASYNC_COMPILATION=0`으로 빌드한다 (`wasm/nodejs/CMakeLists.txt`) |
| GitHub 릴리스 `sherpa-onnx-wasm-simd-<ver>-*-asr-*.tar.bz2` | **아니요** | v1.13.7(2026-09-01)이 마지막이다. v1.13.8 이후 ASR 묶음이 없다. 영어·중국어 모델을 `--preload-file`로 `.data`에 넣는다 (약 175MB). `EXPORTED_RUNTIME_METHODS`에 `FS`가 없다. 한국어 모델로 바꾸려면 다시 빌드해야 한다 |
| HF Space `k2-fsa/web-assembly-asr-sherpa-onnx-*` | **아니요** | 2026-11-26 기준 API가 401을 돌려준다. 위와 같은 preload 빌드다 |
| **pub.dev `sherpa_onnx_web` 2.0.3** | **예 (추천)** | `build-wasm-simd-web.sh`로 만든 **브라우저용 공용 빌드**다. 아래 참고 |
| 직접 빌드 `./build-wasm-simd-web.sh` | 예 (예비) | emsdk 4.0.23 필요. 내보낼 함수를 줄이거나 추가할 때 쓴다 |

### 2.2 추천: `sherpa_onnx_web` 2.0.3의 브라우저용 빌드

- 아카이브: `https://pub.dev/api/archives/sherpa_onnx_web-2.0.3.tar.gz` (SHA-256 `07b395676417b7a35d14fc90ff1b20a1bbca4d9198933493af3f08e7539c9c41`, 2026-11-22 게시, Apache-2.0)
- Flutter 패키지지만 안의 `assets/`는 일반 JS·WASM 파일이다. Dart는 필요 없다.

| 필요한 파일 | 크기 (바이트) | SHA-256 |
|---|---:|---|
| `assets/sherpa-onnx-wasm-web.wasm` | 15,660,910 (gzip -9 시 4,386,675) | `324a7da57770f9cbbcfb6135fb78e205f149f74afe7c774f6142f9094dee90ee` |
| `assets/sherpa-onnx-wasm-web.js` (Emscripten glue) | 94,185 | `aa267dbd0482fd92739ae5a3669faf2d96c3379169548ce92c2512d64e25cd09` |
| `assets/sherpa-onnx-asr.js` (JS API 래퍼) | 55,576 | `ce92ee9f1548dbb1f0d41044f8ae91566610cbde1c01e954e975502068df54b7` |

빌드 설정 (`wasm/wasm-common.cmake`, `wasm/web/CMakeLists.txt`) **[확인]**

- `-sMODULARIZE=1`, `EXPORT_NAME="SherpaOnnx"` → 전역 팩토리 `SherpaOnnx(moduleArg)`가 Promise로 Module을 돌려준다.
- `EXPORTED_RUNTIME_METHODS`에 `FS`, `HEAPF32`, `stringToUTF8`, `UTF8ToString`, `lengthBytesUTF8` 등이 있다.
- `--preload-file`이 **없다.** 모델이 들어 있지 않다.
- `-sFORCE_FILESYSTEM=1`, `-sINITIAL_MEMORY=512MB`, `-sALLOW_MEMORY_GROWTH=1`.
- 스트리밍 ASR C API(`SherpaOnnxCreateOnlineRecognizer` 등)를 모두 내보낸다. TTS·VAD·KWS도 들어 있어 파일이 크다.
- glue는 `ENVIRONMENT_IS_WORKER`를 처리한다. `SharedArrayBuffer`를 쓰지 않는다.

**런타임 FS 로딩이 되는 근거**

1. 빌드에 모델이 없고 `FS`를 내보낸다. 모델을 넣는 방법은 FS에 쓰는 것뿐이다.
2. sherpa-onnx C++는 설정의 경로로 파일을 연다 (`Ort::Session(env, path, ...)`, `tokens.txt`는 `FileExists`로 확인). Emscripten MEMFS에 쓴 파일도 같은 방식으로 열린다.
3. 공식 Flutter 웹 플러그인이 이 빌드를 `wasmBinary`로 초기화하고 `Module`을 전역에 둔다.

이번 조사에서 **Node로 실제 실행하는 스모크 테스트는 권한 문제로 하지 못했다.** PoC 첫 작업으로 확인한다 (2.6절).

**대안 경로**: `tokensBuf`/`tokensBufSize` 설정으로 `tokens.txt`는 FS 없이 문자열로 넣을 수 있다. 모델 파일(encoder/decoder/joiner)은 경로만 받는다.

### 2.3 JS API (`sherpa-onnx-asr.js`, v2.0.3)

브라우저에서는 `module.exports`를 쓰지 않는다. 스크립트를 읽으면 `createOnlineRecognizer`, `OnlineRecognizer`, `OnlineStream`이 전역에 생긴다.

```ts
// 인식기 생성
const recognizer = createOnlineRecognizer(Module, config); // new OnlineRecognizer(config, Module)와 같음

// config 형태
{
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: '/m/encoder.onnx', decoder: '/m/decoder.onnx', joiner: '/m/joiner.onnx' },
    tokens: '/m/tokens.txt',
    numThreads: 1,          // 스레드 없는 빌드이므로 1
    provider: 'cpu',
    debug: 0,               // 기본값이 1(로그 출력)이다
    modelType: '',          // 비우면 ONNX 메타데이터로 판별
    modelingUnit: 'cjkchar',// 핫워드를 쓸 때 필수 (4절)
    bpeVocab: '',
    // tokensBuf: '...', tokensBufSize: n  (선택)
  },
  decodingMethod: 'greedy_search' | 'modified_beam_search',
  maxActivePaths: 4,
  enableEndpoint: 1,               // 직접 config를 넘기면 기본값이 0이다. 반드시 1로 둔다
  rule1MinTrailingSilence: 2.4,    // 아무것도 인식하지 못했을 때의 무음 길이(초)
  rule2MinTrailingSilence: 0.8,    // 무언가 인식한 뒤의 무음 길이(초). F02 목표 0.5~0.8
  rule3MinUtteranceLength: 20,     // 발화 최대 길이(초)
  hotwordsFile: '',
  hotwordsBuf: '', hotwordsBufSize: 0, // 핫워드 문자열과 UTF-8 바이트 길이
  hotwordsScore: 1.5,
  blankPenalty: 0,
  ruleFsts: '', ruleFars: '',
}

// 스트림
const stream = recognizer.createStream();
stream.acceptWaveform(sampleRate, float32Samples); // 값 범위 [-1, 1]
stream.inputFinished();
stream.free();

// 인식기
recognizer.isReady(stream): boolean
recognizer.decode(stream): void
recognizer.getResult(stream): { text: string, tokens: string[], timestamps: number[], ... } // JSON 파싱 결과
recognizer.isEndpoint(stream): boolean
recognizer.reset(stream): void
recognizer.free(): void
```

**래퍼의 함정** **[확인: 소스]**

- 숫자 필드는 `값 || 기본값` 형태다. `0`을 넣으면 기본값으로 바뀐다. `enableEndpoint`만 기본값이 0이다.
- `decodingMethod`를 빼면 `greedy_search`다.
- 엔드포인트 규칙 정의(`endpoint.h`): rule1 = 인식 결과 없이 무음 2.4초, rule2 = 인식 결과가 있고 무음 1.2초, rule3 = 발화 길이 20초. 하나라도 맞으면 엔드포인트다.
- `acceptWaveform`에 16kHz가 아닌 샘플레이트를 넘기면 sherpa-onnx가 내부에서 리샘플링한다. 그래도 AudioContext를 16kHz로 만드는 쪽이 계산이 적다.

### 2.4 COOP/COEP

- v2.0.x 변경 기록에 "Disable pthread support in WebAssembly (#3836)"가 있다. glue에 `SharedArrayBuffer`가 없다.
- 따라서 `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` 헤더가 **필요 없다.** `numThreads`는 1이다.
- 나중에 COEP를 켜더라도 HF 파일은 CORS로 받으므로 문제가 없다 **[추정]**.

### 2.5 Web Worker 통합 계획

**파일 배치**

```
scripts/fetch-sherpa-wasm.mjs        # pub.dev 아카이브를 받아 SHA-256을 확인하고 3개 파일을 복사
public/vendor/sherpa-onnx/2.0.3/     # .gitignore 대상. wasm 15.7MB를 저장소에 넣지 않는다
  sherpa-onnx-wasm-web.js
  sherpa-onnx-wasm-web.wasm
  sherpa-onnx-asr.js
public/stt/sherpa-worker.js          # 클래식 워커 (importScripts 사용)
src/stt/engine.ts                    # SttEngine 인터페이스, 메시지 타입
src/stt/sherpa-engine.ts             # 워커를 감싸는 구현
src/stt/model-cache.ts               # 모델 다운로드·캐시·해시 확인
public/stt/pcm-worklet.js            # AudioWorklet
```

- glue는 UMD/전역 스크립트라 ES 모듈로 `import`할 수 없다. **클래식 워커에서 `importScripts()`로 읽는 방식이 가장 단순하다.** Vite 개발 서버에서 TS 모듈 워커가 필요하면, glue 텍스트를 `fetch`해 `new Function`으로 평가하는 방법도 있다. 이 경우 CSP에 `unsafe-eval`이 필요하다.
- WASM 자체도 CSP에 `wasm-unsafe-eval`이 필요하다 (CSP를 쓸 때).

**모델 캐시**

- Cache Storage를 쓴다. 키는 고정 리비전 URL이다. CORS 응답이라 그대로 저장할 수 있다.
- 받은 뒤 `crypto.subtle.digest('SHA-256', bytes)`를 위 표의 해시와 비교한다. 다르면 지운다.
- 진행률: `response.body.getReader()`로 읽은 바이트 / `content-length`.
- 워커 안에서 `caches`를 쓸 수 있다. 다운로드·해시·FS 쓰기를 모두 워커에서 하면 메인 스레드가 멈추지 않는다.

**메시지 프로토콜 (초안)**

```ts
// main → worker
type ToWorker =
  | { type: 'init'; wasmBase: string; model: ModelSpec; hotwords?: string; endpoint: { rule2: number } }
  | { type: 'audio-port'; port: MessagePort }   // AudioWorklet과 직접 연결
  | { type: 'flush' }                           // 강제 종료 시 마지막 결과 내보내기
  | { type: 'dispose' };

// worker → main
type FromWorker =
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'ready'; initMs: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; endedAt: number }
  | { type: 'heartbeat'; samples: number }      // 3초 감시용 (FR-F02-7)
  | { type: 'error'; message: string };
```

**워커 스케치 (`public/stt/sherpa-worker.js`)**

```js
let Module, recognizer, stream, lastText = '';

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    importScripts(`${data.wasmBase}/sherpa-onnx-wasm-web.js`, `${data.wasmBase}/sherpa-onnx-asr.js`);
    const wasmBinary = await (await fetch(`${data.wasmBase}/sherpa-onnx-wasm-web.wasm`)).arrayBuffer();
    Module = await SherpaOnnx({ wasmBinary, print: () => {}, printErr: (s) => console.warn(s) });

    const files = await loadModelFromCache(data.model, postProgress); // { 'encoder.onnx': Uint8Array, ... }
    Module.FS.mkdir('/m');
    for (const [name, bytes] of Object.entries(files)) Module.FS.writeFile(`/m/${name}`, bytes);

    recognizer = createOnlineRecognizer(Module, {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: '/m/encoder.onnx', decoder: '/m/decoder.onnx', joiner: '/m/joiner.onnx' },
        tokens: '/m/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelingUnit: 'cjkchar',
      },
      decodingMethod: data.hotwords ? 'modified_beam_search' : 'greedy_search',
      maxActivePaths: 4,
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: data.endpoint.rule2, rule3MinUtteranceLength: 20,
      hotwordsBuf: data.hotwords ?? '', hotwordsBufSize: data.hotwords ? Module.lengthBytesUTF8(data.hotwords) : 0,
      hotwordsScore: 1.5,
    });
    // 세션 생성 뒤 MEMFS 사본을 지워 메모리를 줄인다 [PoC: 안전성과 효과 확인]
    for (const name of Object.keys(files)) Module.FS.unlink(`/m/${name}`);
    stream = recognizer.createStream();
    self.postMessage({ type: 'ready' });
  } else if (data.type === 'audio-port') {
    data.port.onmessage = ({ data: chunk }) => onAudio(chunk); // Float32Array, 16kHz
  }
};

function onAudio(samples) {
  stream.acceptWaveform(16000, samples);
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text;
  if (text !== lastText) { lastText = text; self.postMessage({ type: 'partial', text }); }
  if (recognizer.isEndpoint(stream)) {
    if (text) self.postMessage({ type: 'final', text, endedAt: Date.now() });
    recognizer.reset(stream); // 발화마다 스트림 상태 초기화
    lastText = '';
  }
}
```

**오디오 경로**

1. `new AudioContext({ sampleRate: 16000 })`. Chrome은 마이크 입력을 이 샘플레이트로 자동 변환한다 **[추정: PoC에서 Edge와 함께 확인]**.
2. `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
3. AudioWorklet은 128샘플 단위로 받는다. 1,600샘플(100ms)씩 모아서 보낸다. `postMessage(buf, [buf.buffer])`로 복사 없이 넘긴다.
4. `MessageChannel`을 만들어 한쪽은 워클릿 `node.port`로, 다른 쪽은 워커로 보낸다. 오디오가 메인 스레드를 거치지 않는다.

### 2.6 PoC에서 먼저 할 일

1. **런타임 FS 로딩 스모크 테스트.** Node 23에서 위 3개 파일과 72M 모델로 `test_wavs`를 인식한다. web 빌드는 Node 환경도 처리하고 MEMFS를 쓰므로 브라우저와 같은 경로를 탄다. 이번 조사에서 실행 권한이 거부되어 하지 못했다.
2. 실제 마이크 입력에서 빈 결과가 나오지 않는지 확인한다 (#2886 위험).
3. 브라우저 WASM의 RTF를 잰다. 모델 카드 값(chunk-16, 네이티브 1스레드 RTF 0.052)보다 느릴 것이다 **[추정]**.
4. 메모리: 초기 512MB 선언과 모델 사본 수를 확인한다. `FS.unlink` 뒤 실제로 줄어드는지 본다.

## 3. Chrome 온디바이스 Web Speech API

### 3.1 API 형태 (W3C 초안, MDN)

```webidl
partial interface SpeechRecognition {
  attribute boolean processLocally;                      // 기본 false. true면 기기 안에서만 처리
  attribute ObservableArray<SpeechRecognitionPhrase> phrases; // 문맥 편향
  static Promise<SpeechRecognitionAvailabilityStatus> available(SpeechRecognitionOptions options);
  static Promise<boolean> install(SpeechRecognitionOptions options);
};
dictionary SpeechRecognitionOptions {
  required sequence<DOMString> langs;
  boolean processLocally = false;
  SpeechRecognitionQuality quality = "command"; // "command" | "dictation" | "conversation"
};
enum SpeechRecognitionAvailabilityStatus { "unavailable", "downloadable", "downloading", "available" };
```

| 기능 | Chrome | Edge | 출처 |
|---|---|---|---|
| 접두사 없는 `SpeechRecognition`, `processLocally`, `available()`, `install()` | 139 | 139 | MDN BCD 8.1.10 |
| `phrases` | 142 | 142 | MDN BCD |
| `quality` 옵션 | 150 (데스크톱) | — | blink-dev Intent to Ship (2026-05-06) |
| Edge 자체 로컬 모델 | — | Canary/Dev 150.0.4076 이상, `edge://flags`에서 켬 | Microsoft Learn |

**사용 순서**

```ts
const opts = { langs: ['ko-KR'], processLocally: true, quality: 'command' };
let status = await SpeechRecognition.available(opts);
if (status === 'downloadable' || status === 'downloading') {
  // 사용자 클릭 안에서 호출해야 한다 (transient activation)
  const ok = await SpeechRecognition.install(opts);
  status = ok ? 'available' : 'unavailable';
}
const r = new SpeechRecognition();
r.lang = 'ko-KR';
r.processLocally = true;
r.continuous = true;
r.interimResults = true;
// r.phrases = [new SpeechRecognitionPhrase('삼파티', 3.0)];  // Chrome 142+. 미지원 시 'phrases-not-supported'
r.start(); // r.start(audioTrack)로 MediaStreamTrack을 넘길 수도 있다
```

**주의**

- `install()`은 다운로드를 시작할 때 사용자 활성화가 필요하다. 없으면 `NotAllowedError`다.
- 개인정보 보호 때문에, 사이트가 `install()`을 부르기 전에는 `available()`이 실제 상태 대신 `downloadable`을 돌려준다. 이미 설치되어 있으면 `install()`은 다시 받지 않는다.
- 한 블로그(2026-11)는 Chrome에서 `install()`에 `processLocally: true`가 없으면 설치가 실패했다고 보고했다. 항상 넣는다.
- Permissions-Policy 이름은 `on-device-speech-recognition`이다. 막혀 있으면 `unavailable`이다. iframe 안에서는 이 정책이 필요하다.
- 팩 없이 `processLocally = true`로 `start()`하면 `error` 이벤트(`service-not-allowed`)가 난다. 그 밖의 오류 코드: `language-not-supported`, `phrases-not-supported`, `no-speech`, `audio-capture`, `not-allowed`, `aborted`.
- Android와 ChromeOS는 온디바이스 Web Speech를 지원하지 않는다. MVP 대상(PC Chrome/Edge)과는 맞는다.
- Google 브랜드 Chrome에서만 팩이 설치되고 Chromium 빌드에서는 안 된다는 보고가 있다.

### 3.2 한국어 팩

| 근거 | 내용 |
|---|---|
| Microsoft Learn (Edge, 2026-06) | 로컬 인식 지원 언어에 **Korean (ko-KR)**을 명시한다. en-US, de-DE, it-IT, pt-PT, es-ES, ko-KR |
| 개발자 gist (Chrome Canary 142, 2025-09) | 오프라인 지원 언어 17개에 ko-KR이 있다. 작성자는 일본어만 실제로 확인했다 |
| Chrome 공식 문서 | 언어 목록을 찾지 못했다 |

결론: Chrome의 한국어 온디바이스 팩은 **있을 가능성이 높지만 공식 문서로 확인하지 못했다.** 대상 PC에서 `available({langs:['ko-KR'], processLocally:true})`를 실행해 확인한다.

### 3.3 연속 모드 자동 종료와 재시작

- `continuous = true`여도 세션은 스스로 끝난다. 무음이 이어질 때 끝난다는 보고가 7~20초로 다양하다. 예전 Chromium 소스에는 연속 모드 무음 제한 15초가 있었다. 무음이 없어도 몇 분 뒤 끊긴다는 보고도 있다. Edge 문서도 "긴 무음 뒤 자동으로 멈출 수 있다"고 적는다.
- 처리 방법:
  1. `end` 이벤트에서 사용자가 멈춘 것이 아니면 다시 `start()`한다.
  2. 바로 재시작하지 않고 짧게 기다린다 (예: 250ms, 실패가 이어지면 늘림). 바로 재시작하면 반복 루프가 생긴다는 보고가 있다.
  3. `no-speech`, `aborted`는 정상 재시작으로 본다. `not-allowed`, `service-not-allowed`, `language-not-supported`, `audio-capture`는 재시작하지 않고 오류 상태로 둔다.
  4. US-F02-3 규칙(1분 안에 3번 실패하면 멈춤)을 그대로 적용한다. 단, 무음 때문에 정상으로 끝난 세션은 실패로 세지 않는다.
  5. 재시작하는 동안 앞부분 발화를 놓칠 수 있다. PoC에서 공백 시간을 잰다.
- Web Speech는 메인 스레드 이벤트로 동작한다. 오디오 프레임을 직접 볼 수 없으므로, 3초 감시(FR-F02-7)는 `audiostart`/`result`/`end` 시각으로 대신한다.

## 4. 핫워드 (문맥 편향)

**WASM에서 쓸 수 있다** **[확인: 소스]**

- web 빌드는 `modified_beam_search`와 핫워드 컨텍스트 그래프를 포함한다. JS 래퍼에 `hotwordsFile`, `hotwordsBuf`, `hotwordsBufSize`, `hotwordsScore`가 있다.
- `hotwordsBuf`에 문자열을 넣으면 파일 없이 쓸 수 있다. 크기는 UTF-8 바이트 수다 (`Module.lengthBytesUTF8`).
- 핫워드는 `decodingMethod: 'modified_beam_search'`일 때만 적용된다.
- C API에는 스트림별 핫워드(`SherpaOnnxCreateOnlineStreamWithHotwords`)가 있지만 **web 빌드는 이 함수를 내보내지 않는다.** F09 사전이 바뀌면 인식기를 다시 만들어야 한다. 이때 모델 파일이 FS에 다시 있어야 한다. 직접 빌드하면 이 함수를 추가할 수 있다.

**72M 모델 (음절 어휘)**

- `modelingUnit: 'cjkchar'`를 지정한다. 각 단어를 UTF-8 글자 단위로 나눠 토큰으로 바꾼다. 한글 음절 하나가 토큰 하나라서 바로 맞는다.
- **`modelingUnit`을 비워 두면 위험하다.** 핫워드 인코딩에서 `SHERPA_ONNX_EXIT(-1)`로 끝난다. WASM에서는 모듈 전체가 중단된다.
- 형식: 한 줄에 하나. 점수는 `:` 뒤에 쓴다.
  ```
  삼파티 :2.0
  거점 :1.5
  ```
- `▁`로 시작하고 모든 조각이 `tokens.txt`에 있는 줄은 이미 토큰화된 것으로 보고 그대로 쓴다. 예: `▁ 삼 파 티`. 단어 앞 띄어쓰기까지 맞출 때 쓴다.
- 어휘(2,460 음절)에 없는 글자가 있으면 그 핫워드는 건너뛴다 (로그만 남음). F09 사전을 만들 때 `tokens.txt`로 미리 검사한다.

**공식 2024-06-16 모델 (BPE 5,000)**

- `modelingUnit: 'bpe'`와 `bpeVocab` 파일이 필요하다. HF 저장소에는 `bpe.model`만 있다. `scripts/export_bpe_vocab.py`로 `bpe.vocab`을 만들어야 한다.
- 또는 `▁`로 시작하는 토큰열을 직접 적는다.

**우리 서비스에서의 주의**

- 핫워드는 인식률을 올리지만, 없는 명령 단어를 만들어 낼 수도 있다. "놓치는 것보다 잘못 보내는 것이 더 나쁘다"는 F02 전략과 부딪칠 수 있다.
- PoC에서 핫워드 켬/끔으로 핵심 단어 정확도와 헛소리율을 함께 잰다. 점수는 1.0~2.0에서 시작한다.
- `modified_beam_search`는 `greedy_search`보다 계산이 많다. CPU 부하를 함께 잰다.

## 5. 엔진 인터페이스에 주는 영향

| 항목 | sherpa-onnx | Web Speech (온디바이스) | 가짜 엔진 |
|---|---|---|---|
| 준비 | 모델 73MB + WASM 15.7MB 다운로드, 해시 확인 | `available()` → `install()` (사용자 클릭 필요) | 즉시 |
| 중간 결과 | 디코딩마다 | `interimResults` | 스크립트 |
| 최종 결과 기준 | 엔드포인트 규칙 (우리가 조정) | 브라우저가 정함 | 스크립트 |
| 자동 종료 | 없음 | 있음. 재시작 필요 | 테스트로 흉내 |
| 핫워드 | `hotwordsBuf` (인식기 재생성) | `phrases` (Chrome 142+) | 무시 |
| 오디오 감시 | 워커 heartbeat | 이벤트 시각으로 대신 | 테스트로 흉내 |

공통 인터페이스에는 `prepare(onProgress)`, `start()`, `stop()`, `setHotwords(list)`, 이벤트(`partial`, `final`, `state`, `error`)를 둔다 **[제안]**. 준비 단계에 "사용자 클릭이 필요함" 상태를 넣는다 (Web Speech `install()` 때문).

## 출처

**모델**

- [kangkyu/icefall-asr-ko-streaming-zipformer-72m](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m) · [API](https://huggingface.co/api/models/kangkyu/icefall-asr-ko-streaming-zipformer-72m) · [파일 목록 API](https://huggingface.co/api/models/kangkyu/icefall-asr-ko-streaming-zipformer-72m/tree/main) · [SHA256SUMS](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m/blob/main/SHA256SUMS)
- [kangkyu/icefall-asr-ko-streaming-zipformer-174m](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-174m)
- [k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16](https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16)
- [sherpa-onnx issue #2886](https://github.com/k2-fsa/sherpa-onnx/issues/2886) · [icefall PR #1651](https://github.com/k2-fsa/icefall/pull/1651)

**sherpa-onnx**

- [sherpa-onnx v2.0.3 릴리스](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.3) · [v1.13.7 릴리스 (마지막 ASR WASM 묶음)](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.7)
- [build-wasm-simd-web.sh](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/build-wasm-simd-web.sh) · [wasm/wasm-common.cmake](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/wasm/wasm-common.cmake) · [wasm/web/CMakeLists.txt](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/wasm/web/CMakeLists.txt) · [wasm/asr/CMakeLists.txt](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/wasm/asr/CMakeLists.txt) · [wasm/nodejs/CMakeLists.txt](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/wasm/nodejs/CMakeLists.txt)
- [wasm/asr/sherpa-onnx-asr.js](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/wasm/asr/sherpa-onnx-asr.js) · [csrc/utils.cc (EncodeHotwords)](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/sherpa-onnx/csrc/utils.cc) · [csrc/endpoint.h](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/sherpa-onnx/csrc/endpoint.h) · [c-api/c-api.cc](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/sherpa-onnx/c-api/c-api.cc)
- [CHANGELOG (#3836 pthread 비활성화)](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/CHANGELOG.md)
- [pub.dev sherpa_onnx_web](https://pub.dev/packages/sherpa_onnx_web) · [아카이브 2.0.3](https://pub.dev/api/archives/sherpa_onnx_web-2.0.3.tar.gz)
- [npm sherpa-onnx](https://www.npmjs.com/package/sherpa-onnx)

**Web Speech**

- [Web Speech API 초안](https://webaudio.github.io/web-speech-api/) · [On-device explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
- [MDN available()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static) · [MDN install()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/install_static) · [MDN processLocally](https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally) · [MDN browser-compat-data](https://github.com/mdn/browser-compat-data)
- [New in Chrome 139](https://developer.chrome.com/blog/new-in-chrome-139)
- [Intent to Ship: On-device Web Speech API](https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM) · [Intent to Ship: On-Device Recognition Quality](https://groups.google.com/a/chromium.org/g/blink-dev/c/P8P-x7AnC6I)
- [Microsoft Edge: SpeechRecognition API (로컬 모델)](https://learn.microsoft.com/en-us/microsoft-edge/web-ai/speech-recognition-api)
- [Chrome 오프라인 음성인식 메모 (gist, Canary 142)](https://gist.github.com/mujurin1/2d4382461c8d136ed22a5c6959ddfd82)
- [On-Device Speech Recognition In PWAs (Modern Web Weekly)](https://modernwebweekly.substack.com/p/on-device-speech-recognition-in-pwas)
- [glossa issue #47 (Chrome 브랜드 빌드에서만 팩 설치)](https://github.com/amngy/glossa/issues/47)
- 연속 모드 자동 종료: [web-speech-api issue #96](https://github.com/WebAudio/web-speech-api/issues/96), [chromium-html5: 60초 제한?](https://groups.google.com/a/chromium.org/g/chromium-html5/c/s2XhT-Y5qAc), [Chromium speech_recognizer_impl.cc (구버전)](https://chromium.googlesource.com/chromium/src/+/a753229/content/browser/speech/speech_recognizer_impl.cc), [public-speech-api 2015-05](https://lists.w3.org/Archives/Public/public-speech-api/2015May/0001.html)
