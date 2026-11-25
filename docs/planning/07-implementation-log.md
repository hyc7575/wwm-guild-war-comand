# 07 구현 로그

구현 중 내린 결정, 기획과 다르게 한 부분, 남은 문제를 날짜순으로 적는다.
규칙의 기준 문서는 [02-domain-and-protocol.md](02-domain-and-protocol.md)이다. 이 로그는 그 문서가 비워 둔 부분을 채우거나, 바꾼 이유를 남긴다.

## 1. 구현 설계 결정 (2026-11-26, S1 착수 전)

### 1.1 저장소·도구

| 항목 | 결정 | 이유 |
|---|---|---|
| 패키지 이름 | `@winds/protocol`, `@winds/room-core`, `@winds/parser`, `@winds/stt`, `@winds/web`, `@winds/server` | 로드맵 §3 저장소 구조를 그대로 따른다 |
| 내부 패키지 배포 방식 | 빌드 없이 `src/index.ts`를 바로 export 한다 | Vite·wrangler(esbuild)·vitest가 모두 TS를 바로 읽는다. 빌드 단계가 없으면 패키지 사이 변경이 즉시 반영된다. 비용: 외부 배포용 패키지로는 못 쓴다 (계획 없음) |
| 테스트 | 패키지마다 vitest. 루트 `pnpm test`, `pnpm typecheck` | 지시사항 |

### 1.2 프로토콜 보완 (도메인 문서 §6에 없던 것)

| 항목 | 결정 | 이유 |
|---|---|---|
| 방 생성 | HTTP `POST /api/rooms` → `{ code, commanderToken, operatorToken }`. WebSocket은 `GET /api/rooms/:code/ws` | 도메인 문서는 WebSocket 메시지만 정의했다. 방 코드는 서버가 만들어야 중복을 막을 수 있다 |
| 방 존재 확인 | `GET /api/rooms/:code` → 200 / 404 | 참여 화면에서 "방을 찾을 수 없습니다"를 WebSocket 연결 전에 보여 주기 위해 |
| 보조 운영자 역할 (PRD Q5) | **MVP에 포함**. 역할 `OPERATOR`. 방 생성 때 `operatorToken`을 함께 발급하고 메인오더 화면에서 운영자 링크를 공유한다. 권한: 명령 발행·정정·취소. 파티 구성·방 설정·방 종료는 못 한다 | 프리모템 "결정 필요" 권장안. T1(오발행 방치)·E1·E3를 줄인다 |
| 인식 원문·후보 공유 | C→S `stt.feed` (`entries`: 최종 문장, 파서 결과 요약, 후보). 서버는 순번 없이 COMMANDER·OPERATOR 연결에만 중계한다 | 보조 운영자가 원문과 후보를 보고 오발행을 취소하려면 필요하다. 순번 대상이 아닌 일시 정보다 |
| 음성인식 상태 | C→S `stt.status` (`OFF`/`STARTING`/`LISTENING`/`ERROR`). 서버는 `presence`에 `sttState`, `commanderOnline`을 담아 보낸다 | FR-F02-10, FR-F10-6 |
| ping | 앱 ping은 고정 문자열 `{"v":1,"type":"ping"}`, 응답 `{"v":1,"type":"pong"}`. `t` 필드를 뺀다. 지연은 클라이언트가 보낸 시각으로 잰다 | `setWebSocketAutoResponse`는 정확히 같은 문자열에만 응답한다. 이렇게 해야 ping이 Durable Object를 깨우지 않는다 (06 D-3 주의 사항) |
| 취소 사유 | `command.cancel`의 `reason`은 선택 필드. 서버(room-core)가 FR-F07-6 규칙으로 정한다 (음성 명령 30초 안 취소 = `MISRECOGNIZED`, 그 외 `CHANGED`) | F07은 "메인오더가 고르지 않는다"고 했고 도메인 문서는 `reason`을 필수로 적었다. F07을 따른다 |
| 메인오더 중복 탭 | 같은 `commanderToken`으로 새 연결이 오면 이전 COMMANDER 연결에 `session.replaced`를 보내고 닫는다 | F01 예외 상황 "나중에 연 탭이 권한을 가진다" |
| 대상 없는 명령 (Q1) | 기본은 후보(중간 확신도). 방 설정 `targetlessAsAll`(기본 false)을 켜면 전체 대상 높음으로 본다 | 사용자 지시. F03 열린 질문의 권장안 |
| 정정 대상이 이미 덮였거나 취소됨 | 새 명령으로 발행하고 `ack`에 `note: 'CORRECTION_AS_NEW'`를 담는다 | F07 예외 상황 |

### 1.3 저장

| 항목 | 결정 |
|---|---|
| Durable Object 저장소 | SQLite 기반 DO (`new_sqlite_classes`). 상태 변경마다 KV API로 방 상태 전체를 쓴다. 방 상태가 작아(스냅샷 32KB 이하) 통째로 써도 된다 |
| 방 만료·메인오더 미접속 | DO alarm으로 처리 (최대 4시간, 메인오더 미접속 30분) |

## 2. S1 결과와 추가 결정 (2026-11-26)

### 2.1 room-core 규칙 해석

도메인 문서 §3이 정하지 않은 경계를 아래처럼 정했다. 모두 `packages/room-core/test`에 테스트가 있다.

| 항목 | 결정 |
|---|---|
| 반복 판정 | `now - max(issuedAt, repeatedAt) <= 10초`. ACTIVE 명령만 비교한다. 대상·지원 대상 집합과 위치 ID를 순서 무관하게 비교한다 |
| 취소 후 비우기 | 취소한 명령이 맨 위였던 스택만 본다. 아래 명령이 15분 **이상** 지났으면 그 스택을 비운다 |
| 자동 취소 사유 | 음성 명령을 발행 30초 **미만**에 취소하면 `MISRECOGNIZED` |
| 정정이 대상을 바꿀 때 | 남는 파티는 같은 자리에서 교체, 빠진 파티는 스택에서 뺀다(15분 규칙 미적용), 새 파티는 맨 위에 올린다 |
| 정정 대상이 ACTIVE가 아님 | 새 명령으로 발행(`CORRECTION_AS_NEW`), 반복 판정은 하지 않는다 |
| 명령 50건 상한 | 어느 스택의 맨 위도 아닌 가장 오래된 명령부터 지우고 스택에서도 뺀다 |
| 실패한 요청의 멱등성 | 실패한 `clientCmdId`도 기억해 같은 오류를 돌려준다 |

### 2.2 서버

| 항목 | 결정 / 한계 |
|---|---|
| 오류 응답 | 권한·형식 오류는 `error` 메시지, 규칙 오류(VERSION_CONFLICT, UNKNOWN_PARTY, UNKNOWN_COMMAND)는 `ack.error` |
| 오류 코드 추가 | `UNKNOWN_COMMAND`(없는 명령 ID), `UNAUTHORIZED`(토큰 불일치) |
| `presence.total` | 메인오더를 뺀 접속 수(동맹원 + 운영자) |
| 같은 clientId 재접속 | 이전 소켓을 닫아 인원 상한에 두 번 세지 않는다 |
| 한계 | 빈도 제한 버킷과 presence 타이머는 DO가 잠들면 초기화된다. presence 타이머가 변경 뒤 최대 2초 DO를 깨워 둔다. hello를 보내지 않는 소켓의 시간 제한은 아직 없다 |
| pnpm 11 | 의존성 빌드 스크립트를 기본으로 막는다. `pnpm-workspace.yaml`의 `allowBuilds`에 `esbuild`, `workerd`만 허용했다 |

### 2.3 웹

| 항목 | 결정 |
|---|---|
| 스타일 | HUD는 SCSS 대신 일반 CSS Modules. Vite 기본 지원이라 의존성이 하나 줄어든다 |
| 순번 누락 | 프로토콜에 스냅샷 요청 메시지가 없으므로, 누락을 감지하면 소켓을 닫고 즉시 `lastSeq`로 재접속해 스냅샷을 받는다 |
| 생존 판정 | `pong`뿐 아니라 모든 수신 메시지가 35초 타이머를 갱신한다 |
| 화면 복귀 | 연결 상태여도 15초 넘게 조용했으면 강제로 재접속한다. 휴대폰 화면이 꺼진 동안 타이머가 멈추기 때문이다 |
| ack 재전송 | 2초마다 최대 4회. 그 뒤는 "전송되지 않은 명령"(`NO_ACK`) |
| 의존성 고정 | react-router `^7`(라이브러리 모드), jsdom `^26`(31은 Node 23.6에서 vitest 워커가 죽는다) |

### 2.4 파서

| 항목 | 결정 |
|---|---|
| 약한 행동 | `가`, `와`, `가자`, `이쪽으로`, `들어가`, `붙어`는 항상 후보(MEDIUM). 대상·위치 없이 약한 행동만 있으면 버린다("가자 가자") |
| 한 글자 표현 | `다`, `좌`, `우` 등은 어절 시작에서 조사·어미가 붙을 때만 매칭한다 |
| 제외 표현 | `빼고`, `제외`가 있으면 모든 결과를 후보로 낮춘다. "1파티 빼고 다 모여"의 대상 해석은 아직 틀린다(알려진 실패) |
| 지표의 한계 | 골든 211건은 파서를 만든 쪽이 쓴 문장이다. 재현율 100%·정밀도 100%는 낙관적인 값이고, 실전 받아쓰기로 다시 재야 한다 (P-3) |

### 2.5 STT 모델·WASM (조사: [stt-integration-notes.md](research/stt-integration-notes.md))

| 항목 | 결정 |
|---|---|
| 주력 모델 | `kangkyu/icefall-asr-ko-streaming-zipformer-72m` chunk-16 int8, 리비전 고정. Apache-2.0, 합계 약 70MB, Hugging Face에서 CORS 허용 |
| 예비 모델 | k2-fsa 2024-06-16 (약 126MB). 마이크 입력에서 빈 결과가 나온다는 이슈 #2886이 아직 열려 있다 |
| WASM | pub.dev `sherpa_onnx_web` 2.0.3 자산을 내려받아 쓴다(저장소에 커밋하지 않음). FS가 export되어 모델을 런타임에 넣을 수 있다. 스레드를 쓰지 않아 COOP/COEP가 필요 없다 |
| 확인 못 한 것 | KsponSpeech(AIHub) 학습 모델의 재배포 조건 |
