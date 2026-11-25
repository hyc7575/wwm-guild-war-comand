# 한국어 음성인식 모델 조사

조사일: 2026-11-26 · 목적: [D-1 음성인식](../06-tech-decisions.md) 후보를 다시 검토하고 대안을 찾는다.

## 결론

1. **한 모델로 바로 정하지 않는다.** 공개된 정확도 수치는 데이터셋과 채점 방식이 모두 달라 서로 비교할 수 없다. 우리에게 중요한 것은 "메인오더 실전 발화에서 파티·행동·위치 단어를 맞히는가"다. 이것은 PoC 데이터셋으로만 잴 수 있다.
2. **PoC에서 4개 후보를 같은 데이터로 비교한다.**
   - 주력: KsponSpeech로 학습한 72M 스트리밍 Zipformer
   - 기준선: k2-fsa 공식 스트리밍 Zipformer
   - 대안 1: SenseVoice Small + VAD
   - 대안 2: Moonshine Tiny Korean + VAD
3. **Chrome 온디바이스 Web Speech는 5분짜리 확인을 먼저 한다.** 한국어 언어 팩이 있으면 모델 다운로드 없이 쓸 수 있다.
4. **큰 모델은 브라우저용이 아니라 라벨링 도구로 쓴다.** BuzzASR Korean, Qwen3-ASR처럼 정확하지만 무거운 모델은 녹음을 받아쓸 때 초안 작성용으로 쓴다.

## 우리 상황에서 중요한 기준

| 기준 | 이유 |
|---|---|
| 짧은 명령 발화의 핵심 단어 정확도 | 문장 전체 정확도보다 "3파티", "오른쪽", "지켜"가 맞는지가 중요하다 |
| 구어체·즉흥 발화 대응 | 메인오더는 원고를 읽지 않는다. 낭독 데이터(FLEURS) 점수보다 대화체 데이터(KsponSpeech) 점수가 더 참고가 된다 |
| 발화 종료 후 지연 | 목표는 발화가 끝나고 1초 안에 화면 표시 ([F04 지연 예산](../features/F04-realtime-delivery.md)) |
| 게임과 함께 도는 CPU 부하 | 게임 FPS 감소 5% 이하 |
| 모델 다운로드 크기 | 메인오더가 처음 한 번 받는다 |
| 침묵·잡음에서 헛소리를 만들지 않음 | 없는 말을 만들어 내면 오발행으로 이어진다 |
| 라이선스 | 비영리 무료 서비스에서 쓸 수 있어야 한다 |

## 처리 방식 두 가지

| 방식 | 동작 | 장점 | 단점 |
|---|---|---|---|
| A. 진짜 스트리밍 (Transducer) | 말하는 동안 조금씩 인식하고 중간 결과를 낸다 | 지연이 가장 짧고 자막이 실시간으로 나온다 | 같은 크기에서 정확도가 조금 낮다 |
| B. VAD + 구간 인식 | 음성 구간(VAD)이 끝나면 그 구간을 한 번에 인식한다 | 정확도가 높은 오프라인 모델을 쓸 수 있다 | 발화가 끝난 뒤에 인식을 시작한다. 중간 자막이 없다 |

명령은 대부분 1~3초짜리 짧은 발화다. 그래서 B 방식도 구간 인식 시간이 짧다면 지연 목표를 맞출 수 있다. 원래 기획은 A만 검토했으나 B도 후보에 넣는다.

## 후보 비교

> 정확도 수치는 각 모델 카드의 자체 보고값이다. **데이터셋이 서로 달라 직접 비교하면 안 된다.** 한국어는 문자 오류율(CER)로 잰다. 낮을수록 좋다.

### A. 진짜 스트리밍

| 후보 | 크기 | 보고된 한국어 정확도 | 학습 데이터 | 라이선스 | 판단 |
|---|---|---|---|---|---|
| **kangkyu Zipformer 72M** | 71.4M 파라미터 | KsponSpeech eval CER 8.25% (sherpa-onnx int8, 스트리밍) [1] | KsponSpeech 1,000시간 (대화체) | 모델 카드에서 확인 필요 | **주력 후보.** 대화체 데이터로 학습했고, 스트리밍 int8 수치가 공개된 후보 중 가장 좋고, 가볍다 |
| kangkyu Zipformer 174M | 155.7M 파라미터 | 공개 수치 못 찾음 | KsponSpeech + AIHub 약 6,500시간 [2] | Apache 2.0 [2] | 72M이 부족할 때 쓰는 상위 후보. 무거워진 만큼 CPU 부하를 확인해야 한다 |
| k2-fsa 공식 스트리밍 Korean (2024-06-16) | int8 인코더 약 121MB [3] | 공개 수치 못 찾음 | 확인 필요 | 확인 필요 | **기준선.** 원래 기획의 후보다. 빈 결과가 나온다는 사용자 보고가 있다 [4]. 설정 문제인지 PoC에서 확인한다 |
| NVIDIA Nemotron 3.5 ASR Streaming 0.6B | 600M 파라미터, int4 ONNX 있음 [5] | FLEURS 한국어 CER 약 7.1~8.3% (청크 크기별) [6] | 다국어 40개 지역 | 모델 카드에서 확인 | 정확도 상한을 볼 때만. 게임과 함께 돌리기에는 무겁다 |
| kairess KWS Zipformer Tiny | 아주 작음 | eval_clean CER 13.8% [7] | KsponSpeech | 확인 필요 | 키워드 감지 전용. 아래 "보완 기술" 참고 |

### B. VAD + 구간 인식

| 후보 | 크기 | 보고된 한국어 정확도 | 라이선스 | 판단 |
|---|---|---|---|---|
| **SenseVoice Small** | 약 234M 파라미터 | FLEURS 한국어 CER 8.27% (Q8 양자화) [8] | 모델 저장소에서 확인 | **대안 1.** 비자기회귀 모델이라 구간 인식이 빠르다. sherpa-onnx가 WebAssembly와 Silero VAD 연동을 지원한다 [9] |
| **Moonshine Tiny Korean** | 27M 파라미터 | FLEURS 한국어 CER 약 9% [10] | Moonshine Community License로 보임. 비상업 무료. LICENSE.txt 확인 필요 [11] | **대안 2.** 가장 가볍다. 같은 크기의 Whisper Tiny보다 크게 낫다는 보고가 있다 (CER 9.85% 대 23.92%) [11]. 한국어용 Transformers.js 변환본은 아직 없다 |
| k2-fsa 공식 오프라인 Korean (2024-06-24) | int8 디코더 2.8MB 등 | 공개 수치 못 찾음 | 확인 필요 | 예비 후보. 스트리밍판과 같은 계열이다 |
| Whisper Small 한국어 파인튜닝 | 244M 파라미터 | 기업 자체 데이터에서 CER 18.05% → 6.45% (추가 학습 후) [12] | 모델마다 다름 | 제외. 자기회귀 방식이라 느리고, 침묵·잡음에서 없는 문장을 만들어 내는 문제가 알려져 있다. 오발행 위험이 크다 |

### C. 브라우저 내장

| 후보 | 내용 | 판단 |
|---|---|---|
| **Chrome 온디바이스 Web Speech API** | Chrome 139부터 `processLocally: true`로 음성을 기기 안에서 처리할 수 있다. 언어 팩이 설치되어 있어야 한다 [13] | **먼저 확인한다.** 모델 다운로드와 WASM 작업이 모두 필요 없다. 한국어 팩 제공 여부는 문서로 확인하지 못했다. 아래 코드로 바로 확인할 수 있다. Chrome 전용이고, 인식 방식을 우리가 조정할 수 없다 |

```js
// Chrome 개발자 도구 콘솔에서 실행
await SpeechRecognition.available({ langs: ['ko-KR'], processLocally: true });
// "available" | "downloadable" | "downloading" | "unavailable"
```

### D. 브라우저에는 무겁지만 다른 용도로 유용

| 후보 | 크기 | 보고된 한국어 정확도 | 쓰임 |
|---|---|---|---|
| BuzzASR Korean | 약 2B 파라미터 (Whisper large-v3 파인튜닝) | FLEURS + Common Voice CER 4.6% [14] | PoC 녹음의 받아쓰기 초안. 영어가 섞인 한국어에 강하다는 보고가 있다 |
| Qwen3-ASR 0.6B / 1.7B | 0.6B / 1.7B | FLEURS 한국어 CER 5.82% / 4.60% [15] | 위와 같음 |

라벨링 순서: 큰 모델로 받아쓰기 초안 → 사람이 고침 → 명령 라벨 부착. 녹음 200건을 손으로 모두 받아쓰는 시간을 줄인다.

## 보완 기술

| 기술 | 내용 | 기대 효과 |
|---|---|---|
| 핫워드 강화 | sherpa-onnx Transducer의 modified beam search에 파티 이름·거점 이름 같은 단어 목록을 넣어 우선 인식 | 동맹 고유 용어 인식률 향상. F09 사전에서 목록을 자동으로 만든다 |
| 키워드 감지 (KWS) | 미리 정한 단어("일파티", "모여" 등)만 감지하는 작은 모델 | 오발행 감소. 일반 STT 결과와 KWS 결과가 모두 동의할 때만 자동 발행하는 방식으로 쓸 수 있다. 다만 모델을 하나 더 돌려야 한다 |
| 도메인 파인튜닝 | 메인오더 발화 데이터로 Zipformer를 추가 학습 | 효과가 가장 클 수 있다. 그러나 데이터가 수백 건이면 부족하고 GPU 학습 환경이 필요하다. Phase 2 이후 검토 |

## PoC 비교 계획 (P-2 확장)

같은 녹음(동의받은 메인오더 실전 발화 200건 이상)을 모든 후보에 넣는다.

| 측정 항목 | 방법 |
|---|---|
| 핵심 단어 정확도 | 파티·행동·위치 단어가 정확히 나온 비율. CER도 함께 기록한다 |
| 파서 통과 결과 | STT 출력을 F03 파서에 넣었을 때의 재현율·정밀도·오발행률 |
| 헛소리율 | 명령이 아닌 구간(잡담, 침묵, 게임 소리)에서 명령 단어가 나온 비율 |
| 지연 | 발화 종료 → 최종 결과 |
| CPU·메모리 | 30분 연속 실행 |
| 게임 FPS | P-4와 같은 방법 |
| 다운로드 크기 | int8 기준 실제 파일 합계 |

**우선순위 [제안]**

1. Chrome 온디바이스 Web Speech 확인 (5분)
2. kangkyu 72M 스트리밍 → 기준 통과 시 주력으로 확정
3. SenseVoice Small + VAD → 72M보다 핵심 단어 정확도가 확실히 높으면 교체
4. Moonshine Tiny Korean + VAD → 저사양 PC용 예비
5. k2-fsa 공식 스트리밍 → 비교 기준

## 남은 확인 사항

| 항목 | 확인 방법 |
|---|---|
| kangkyu 72M 모델 라이선스와 int8 파일 크기 | [모델 카드](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m) |
| KsponSpeech(AIHub) 학습 모델의 이용 조건 | AIHub 데이터 이용 약관 |
| SenseVoice Small 라이선스와 int8 파일 크기 | 모델 저장소 |
| Moonshine 한국어 모델 라이선스 | 모델 저장소의 LICENSE.txt |
| k2-fsa 공식 스트리밍 모델의 빈 결과 문제 | sherpa-onnx 이슈 #2886 본문 [4] |
| Chrome 온디바이스 한국어 팩 | 위 코드 실행 |

## 출처

1. [kangkyu/icefall-asr-ko-streaming-zipformer-72m](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-72m)
2. [kangkyu/icefall-asr-ko-streaming-zipformer-174m](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-174m)
3. [On-device streaming ASR in 2026 (DEV Community)](https://dev.to/voxrtio/on-device-streaming-asr-in-2026-five-approaches-and-when-to-pick-what-5h1n)
4. [sherpa-onnx issue #2886](https://github.com/k2-fsa/sherpa-onnx/issues/2886)
5. [onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4](https://huggingface.co/onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4)
6. [nvidia/nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
7. [kairess/ko-kws-zipformer-tiny](https://huggingface.co/kairess/ko-kws-zipformer-tiny)
8. [transcribe.cpp: SenseVoice Small](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/sensevoice-small.md)
9. [sherpa-onnx SenseVoice 문서](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)
10. [Flavors of Moonshine (arXiv 2509.02523)](https://arxiv.org/html/2509.02523v1)
11. [Moonshine available models](https://github.com/moonshine-ai/moonshine/blob/main/docs/models/available-models.md), [UsefulSensors/moonshine-tiny-ko](https://huggingface.co/UsefulSensors/moonshine-tiny-ko)
12. [Small Models, Big Heat — Korean ASR with Low-bit Whisper](https://www.edge-ai-vision.com/2025/11/small-models-big-heat-conquering-korean-asr-with-low-bit-whisper/)
13. [On-device speech recognition explainer (W3C WebAudio)](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md), [New in Chrome 139](https://developer.chrome.com/blog/new-in-chrome-139)
14. [BuzzASR (arXiv 2609.09554)](https://arxiv.org/html/2609.09554v1)
15. [hex language recommendations (Qwen3-ASR, SenseVoice 비교)](https://github.com/anomalyco/hex/blob/dev/docs/plans/language-recommendations.md)
