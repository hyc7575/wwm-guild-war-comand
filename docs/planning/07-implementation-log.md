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
| `presence.total` | 메인오더를 뺀 접속 수(동맹원 + 서브오더 + 운영자) |
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

## 오케스트레이터 인계 (2026-11-26)

사용자 지시로 오케스트레이터를 Sonnet 세션으로 바꾼다. 이 절만 읽고 이어받을 수 있게 쓴다.
원래 지시(작업 방식, 멈춤 조건, Git 규칙)는 이슈 #1과 처음 오케스트레이터 프롬프트를 따른다. 요약: 구현은 sonnet 서브에이전트, 조사·검수는 opus 서브에이전트. 사용자에게 묻지 않는다. 유료·로그인 작업(wrangler login/deploy)과 main 강제 푸시만 멈춤 조건이다.

### 1. 현재 상태 (브랜치 `feat/winds-command-impl`, 드래프트 PR #2)

인계 시점에 모든 변경이 커밋되어 있고, 아래 검증을 직접 실행해 통과를 확인했다.

| 검증 | 명령 | 결과 |
|---|---|---|
| 타입 검사 | `pnpm typecheck` | 통과 |
| protocol | `pnpm --filter @winds/protocol test` | 51 통과 |
| room-core | `pnpm --filter @winds/room-core test` | 43 통과 |
| parser | `pnpm --filter @winds/parser test` | 262 통과, 의도된 실패 3 (`knownFailure`) |
| parser 골든 지표 | `pnpm --filter @winds/parser golden` | 211건, 재현율·정밀도 100%, 오발행 0% (낙관적 값, §2.4) |
| stt | `pnpm --filter @winds/stt test` | 46 통과 |
| web | `pnpm --filter @winds/web test` | 157 통과 |
| server 단위 | `pnpm --filter @winds/server test` | 15 통과 |
| server 통합 (실제 wrangler dev) | `WINDS_TEST_PORT=8791 pnpm --filter @winds/server test:integration` | 55개 확인 통과 |
| E2E (Playwright, 다중 브라우저 컨텍스트) | `pnpm --filter @winds/e2e test` | 9 통과 (약 33초) |
| 부하 P-7 (로컬 루프백) | `pnpm --filter @winds/loadtest run load -- --spawn` | 동맹원 60명, 중계 p95 7.5ms, 스냅샷 13.9KB (S4 에이전트가 실행) |
| 실모델 STT 스모크 (헤드리스 Chromium, 가짜 마이크에 TTS 음성) | `pnpm fetch:stt-wasm && pnpm smoke:stt` | 72M 모델 로딩·인식 동작, 지연 0.6~1초, RTF 약 0.14 (STT 에이전트가 실행) |

### 2. 완료한 것

| 범위 | 내용 | 위치 |
|---|---|---|
| S1 | pnpm 모노레포, Zod 프로토콜, Durable Object 방 서버(Hibernation, 자동 ping 응답, alarm 수명 관리), 웹 기반·재연결 클라이언트(F10) | `packages/protocol`, `apps/server`, `apps/web/src/net`, `apps/web/src/state` |
| S2 | room-core 슬롯 규칙(도메인 §3 전부 테스트), 동맹원 HUD(F05·F06), 명령 상태(F07) | `packages/room-core`, `apps/web/src/member/hud` |
| S3 | 파서(F03)+골든 러너, 메인오더 콘솔(F08: 버튼·단축키·글자 명령·후보·직전 취소·파티 편집·방 설정·초대), STT 패키지(sherpa-onnx WASM·Chrome 온디바이스·가짜 엔진, 자동 복구 감시), 콘솔 STT 패널(F02), 모델 비교 벤치 `/bench` | `packages/parser`, `apps/web/src/commander`, `packages/stt`, `apps/web/src/bench` |
| S4 | 세션 요약(1분 임시 저장, 최근 20건, JSON 내보내기), P-7 부하 테스트, 동맹원 안내 `/guide`와 디스코드 공지 초안, 배포 설정(`wrangler.deploy.jsonc`, dry-run 통과), `docs/deploy.md` | `apps/web/src/commander/summary`, `apps/loadtest`, `apps/web/src/guide`, `docs/guides`, `docs/deploy.md` |
| 보조 운영자 (PRD Q5) | `/o/:code#token`. 명령 발행·정정·취소, 인식 원문·후보 중계(`stt.feed`) 보기 | `apps/web/src/operator` |
| 검수 1회차 | opus 검수(S1~S2 범위)에서 major 5·minor 11건 지적 → 전부 반영 (커밋 `dd7c1bb`, `e8d0ba3`). 아래 §5의 "미반영"만 남음 | — |
| E2E | 시나리오 1~8 (방 생성·참여, 수동 명령·반복·정정·취소, 음성 파이프라인, 파티 실시간 변경, 재연결, 운영자, 메인오더 끊김, 방 종료) | `apps/e2e` |

이슈 #1 체크리스트는 아직 체크하지 않았다. S1~S4 항목은 위 근거로 체크해도 된다. 단 S4의 "실전 시범 2회"는 사람이 해야 한다.

### 3. 검수 1회차 뒤 추가 결정 (아직 이 로그 §2에 없던 것)

| 항목 | 결정 |
|---|---|
| 반복 판정 | 일치하는 명령이 대상 파티 **모두의** 맨 위일 때만 재강조. 아니면 새 명령 |
| 요청 오류 | FORBIDDEN·RATE_LIMITED·INVALID_MESSAGE도 `clientCmdId`가 있으면 `ack.error`로 돌려준다 |
| 빈도 제한 | 위반 횟수는 60초 무위반이면 초기화. `stt.feed`·`stt.status`는 명령과 별도 버킷(초당 5) |
| 메인오더 반쯤 끊긴 연결 | 메인오더가 붙어 있는 동안 10초 alarm으로 자동 응답 시각을 확인, 25초 넘게 조용하면 끊김 처리(종료 코드 4009). 비용: 메인오더 접속 중에는 DO가 잠들지 못한다. 4시간 방 최악 약 1,800 GB-s |
| hello 시간 제한 | 10초 안에 hello가 없으면 소켓을 닫는다. 없는·닫힌 방 WebSocket은 HTTP 404 |
| 같은 브라우저 탭 | 같은 clientId·같은 역할만 교체(`session.replaced`). 운영자 탭과 동맹원 탭은 공존 |
| 스냅샷 원문 | 최근 6건만 원문 포함 (검수 2회차 후 10→6. 서브오더 issuer 포함 최악 조건 실측 약 31.9KB, 한도 32KB) |
| 세션 요약 | `PARTY_REMOVED` 취소는 취소 지표에서 뺀다. 새로고침 뒤 같은 방의 임시 저장본에 이어서 센다 |
| 배포 설정 분리 | 정적 자산 설정은 `apps/server/wrangler.deploy.jsonc`에만 둔다. `wrangler.jsonc`에 넣으면 `web/dist`가 없을 때 wrangler dev·통합·E2E 테스트가 시작되지 않는다 |
| STT Worker | Worker·Worklet은 문자열 소스로 만든 Blob URL. 엄격한 CSP를 쓰면 `worker-src blob:`, `wasm-unsafe-eval`이 필요하다 |
| k2-fsa 예비 모델 | `bpe.vocab`이 없어 `modelingUnit: 'cjkchar'`로 돌린다. 이 모델은 핫워드 비활성 |

### 4. 아직 시작하지 않은 사용자 요청 2건 (2026-11-26 추가)

둘 다 코드·문서 모두 손대지 않았다. 다음 오케스트레이터가 가장 먼저 한다. 두 작업은 서로 파일이 겹치므로(서버 `index.ts`, 웹 설정) 순서대로 하거나 담당 파일을 나눠 맡긴다.

#### 4.1 서브오더(부지휘관) 구조 — 사용자 결정

사용자 결정: (1) 서브오더도 전체 파티에 명령할 수 있다. (2) 메인·서브 명령이 겹치면 지금 슬롯 규칙 그대로 최신 명령이 우선한다. (3) 이번에는 구조만 반영한다. 서브오더 전용 UI와 서브오더 각자의 음성인식은 나중에 한다.

계획:

| 단계 | 할 일 | 파일 |
|---|---|---|
| a. protocol | `Role`에 `SUB_COMMANDER` 추가. `Command.issuer: { clientId, role: 'COMMANDER'\|'SUB_COMMANDER'\|'OPERATOR', label? }` 추가. `CreateRoomResponse.subCommanderToken`, hello의 `subCommanderToken`. presence에 `subCommandersOnline` | `packages/protocol` |
| a. room-core·서버 | 권한을 "명령 권한 역할 집합"(`canCommand(role)`)과 "방 관리 권한"(`canAdmin(role)` = COMMANDER만, [제안])으로 일반화. 발행·정정·취소는 세 역할 모두. 파티 구성·방 설정·방 종료는 COMMANDER만. `stt.status`는 COMMANDER만. `stt.feed` 중계 대상에 SUB_COMMANDER 포함. 방 생성 때 운영자 토큰과 같은 방식으로 `subCommanderToken`을 발급·해시 저장. `issuer`는 서버가 연결 정보로 채운다(클라이언트 값 무시). `label` 기본값 "메인오더"/"서브오더"/"운영자", 닉네임이 있으면 닉네임 | `packages/room-core/src/state.ts`, `apps/server/src/room-do.ts`, `apps/server/src/index.ts` |
| b. 음성 정정·취소 | `CommandPipeline`의 `lastVoiceCommand`와 정정 15초 창을 **같은 발행자**(내 clientId가 issuer인 명령) 기준으로. 버튼 "직전 취소"는 발행자 무관 유지 | `apps/web/src/commander/pipeline/CommandPipeline.ts` |
| c. HUD | 명령 카드와 이력 행에 발행자 라벨을 작게 표시 | `apps/web/src/member/hud/CommandCard.tsx`, `HistoryList.tsx` |
| d. 세션 요약 | 발행 수를 역할별로 센다. `issued`에 `byRole: { COMMANDER, SUB_COMMANDER, OPERATOR }` 추가. 다른 사람이 낸 명령은 `command.issued` 이벤트의 `issuer.role`로 센다 | `apps/web/src/commander/summary/*`, `apps/web/src/commander/metrics.ts` |
| 권한 부여 UI(최소) | 운영자 링크와 같은 방식. 초대 창에 서브오더 링크 `/s/:code#token` 복사 버튼. `/s/:code`는 운영자 화면(`OperatorPage`)을 역할만 바꿔 재사용(전용 UI 아님) | `apps/web/src/commander/console/TopBar.tsx`(InviteModal), `apps/web/src/operator`, 라우터 `apps/web/src/App.tsx` |
| e. 문서·테스트 | `02-domain-and-protocol.md` §1 용어(서브오더, 보조 운영자, 발행자), §2 `Issuer`·`Member.role`, §4 권한 표를 역할 4개로 다시 쓴다. 이 로그에 결정과 이유(사용자 결정)를 적는다. room-core 테스트에 다중 발행자 케이스(메인 발행 → 서브가 같은 파티에 발행하면 서브가 현재 명령, 서브 취소 시 메인 명령 복귀, 서버가 issuer를 채움, SUB_COMMANDER의 parties.update는 FORBIDDEN) 추가. 통합 테스트·E2E에 서브오더 연결 1건 추가 | `docs/planning`, `packages/room-core/test`, `apps/server/test-integration`, `apps/e2e` |

#### 4.2 배포 설정 — 사용자 지시

웹과 방 서버 모두 Cloudflare로 유지한다(Vercel 쓰지 않음). 현재 상태와 할 일:

| 항목 | 현재 | 할 일 |
|---|---|---|
| 웹 → 서버 주소 | `VITE_API_BASE`가 있다(`apps/web/src/config.ts`, 비면 같은 출처) | WebSocket 주소도 같은 변수로 만드는지 확인하고 문서화 |
| 서버 허용 Origin | CORS `*` (`apps/server/src/index.ts`) | wrangler `vars.ALLOWED_ORIGINS`(쉼표 목록)로 `/api` HTTP와 WebSocket 업그레이드의 `Origin`을 확인. 목록이 비면 개발용으로 모두 허용할지, 같은 출처만 허용할지 정해 기록. 통합 테스트에 거절 케이스 추가 |
| STT 모델 | 기본으로 Hugging Face 고정 리비전 주소에서 런타임에 받는다. 웹 정적 자산에 넣지 않는다 (`packages/stt/src/models.ts`) | base URL을 `VITE_STT_MODEL_BASE` 같은 환경 변수로 분리(기본값 HF 주소). 나중에 R2로 바꿀 수 있게 |
| sherpa wasm (15.7MB) | 정적 자산 `/vendor/sherpa-onnx/` (25 MiB 파일 제한 안) | 유지. 이유를 기록 |
| 기록 | — | `docs/deploy.md`와 이 로그에 위 내용 기록 |

### 4.1 결과: 서브오더 구조 (2026-11-26)

#### 사용자 결정 (3건)

1. 서브오더도 전체 파티에 명령할 수 있다.
2. 메인·서브 명령이 겹치면 지금 슬롯 규칙 그대로 최신 명령이 우선한다.
3. 이번에는 구조만 반영한다. 서브오더 전용 UI와 서브오더 각자의 음성인식은 나중에 한다.

#### 설계 검토로 확정한 결정

| 결정 | 이유 |
|---|---|
| `Command.issuer`는 `{ role }`만 담는다 (계획의 `clientId`·`label` 삭제). optional | 명령 50건이 모두 스냅샷에 실려 32KB 한도에 가까워지고, `clientId`는 재접속 식별용이라 다른 접속자에게 보이면 안 된다. 기존 방의 명령에는 없다 |
| 음성 정정·취소의 발행자 구분과 "같은 발행자 반복 판정"을 합쳤다. 파이프라인은 자기가 낸 명령(`lastVoice`)만 정정·취소 기준으로 삼는다 | 파이프라인이 이미 자기 발행 명령 ID만 추적하므로 issuer 비교를 따로 둘 필요가 없다. 다른 사람이 낸 명령은 기준이 되지 않는다(테스트로 고정) |
| `command.cancelled` payload에 `cancelledBy?: Role` 추가 | 명령에는 취소한 사람이 남지 않는다. 서브오더가 취소한 것을 메인오더의 오인식·작전 변경 지표(KR3)에 섞으면 안 된다 |
| 버튼 "직전 취소"는 발행자와 무관하게 유지 | 현장에서 누가 냈든 직전 명령을 바로 취소할 수 있어야 한다 |
| 서브오더 접속은 방 수명과 "메인오더 연결 끊김" 표시에 영향을 주지 않는다 | 메인오더가 없는 방을 서브오더가 살려 두면 4시간 규칙과 무인 방 정리가 무의미해진다 |
| 링크 하나를 여러 명이 써도 허용한다. 회수 수단은 없다 | 접속 단위 구분·폐기는 이번 범위 밖. 한계로 적는다 |
| 세션 요약 `issued.byRole`은 `command.issued` 이벤트의 `issuer.role`로만 센다 | 로컬 요청 지표(`issuedVoice/Manual`)와 같이 세면 내 명령이 이중으로 잡힌다. 취소는 `cancelledBy`가 메인오더가 아니면 `cancelled.misrecognized/changed`에서 빼고 `cancelled.byOthers`(역할별)로 센다. 이전 저장본에 필드가 없어도 `?? 0`으로 읽는다 |

#### 한계

- 요약은 collector가 본 이벤트만 센다. 스냅샷으로 재접속하는 사이 빠진 이벤트(다른 발행자의 발행·취소)는 세지 못한다. 상태 스토어의 `lastEvent`는 마지막 이벤트 하나라서 한 번에 여러 이벤트가 겹치면 앞의 것을 놓칠 수 있다.
- `issuer`가 역할만 담으므로 서브오더가 여러 명이어도 개별로 구분하지 못한다.
- `cancelledBy`를 요약이 받으려면 웹 상태의 `lastEvent`가 이 값을 넘겨야 한다(collector는 `lastEvent.cancelledBy`, `lastEvent.commandId`를 읽는다).

#### 이해 점검: ③ 가능해진 것, ④ 비용·한계

새 기술 도입이 아니라 역할 확장이라 ①②는 생략한다.

- ③ 메인오더가 다른 사람에게 명령 권한을 나눠 줄 수 있다. HUD에서 누가 낸 명령인지 보이고, 요약으로 역할별 발행 수를 비교할 수 있다.
- ④ 권한 판정이 역할 3개로 늘어 서버 분기가 늘었다. 링크 회수·개별 구분이 안 되고, 겹치는 명령은 최신 우선이라 서로 덮어쓸 수 있다.

### 5. 남은 일

#### Phase 1

| 항목 | 상태 |
|---|---|
| 검수 2회차 | S3~S4 범위(파서, STT 패키지·패널, 세션 요약, 안내, 배포 설정, E2E)는 아직 opus 검수를 받지 않았다. §4 작업 뒤 S1~S4 전체를 한 번 더 검수시키는 것을 권한다 |
| 검수 1회차 미반영 | 방 생성·조회 HTTP 빈도 제한(방 코드 대입 방지, 검수 #14 HTTP 부분). `apps/server/src/index.ts`. Cloudflare 규칙 또는 IP별 제한. §4.2와 같은 파일이라 함께 하면 좋다 |
| 콘솔 미전송 재전송 | `RoomClient.resend(item)`(같은 clientCmdId 재사용)이 생겼지만 콘솔의 [다시 보내기]는 아직 `request(item.msg)`를 쓴다. `apps/web/src/commander/console/ConsoleController.ts`의 resend를 `client.resend(item)`로 바꾼다 |
| 이력 표시 | 삭제된 파티 대상 명령의 이력 행 대상이 "?"로 보인다 (`partyNumbersLabel` 대체값) |
| 이슈 #1 체크리스트·PR 본문 갱신 | 안 함 |

#### Phase 2 (로드맵 4절 순서, 전부 미착수)

1. F09 동맹 사전 편집기·사전 테스트·내보내기/가져오기 (파서에 `mergeDictionaries`, `findDictionaryConflicts`, `disabled`가 이미 있다. 콘솔 `getDictionary`는 지금 기본 사전만 돌려준다. 버린 문장 튜닝 기록은 IndexedDB `winds.tuningLog`에 쌓인다 → FR-F09-8)
2. 작은 창 모드 (Document Picture-in-Picture). HUD 컴포넌트는 props 기반이라 재사용 가능 (`apps/web/src/member/hud/index.ts`)
3. 휴대폰 리모컨 (메인오더 권한을 두 번째 기기에). §4.1 역할 구조 위에 만든다
4. 전술 프리셋
5. 복합 명령·문맥 처리 ("아까 거기로", "1파티 빼고 다" — 파서 알려진 실패 3건 포함)
6. 모바일 UI 최적화, 파티 8개 이상 격자
7. 호출어 모드 (선택)
8. 명령 이력 로컬 저장

### 6. 다음에 할 일 순서

1. §4.1 서브오더 구조 (protocol·room-core·server → web 순서. 한 sonnet 에이전트가 protocol~server, 다른 에이전트가 web을 맡되 web은 protocol 커밋 뒤에 시작)
2. §4.2 배포 설정 + 검수 #14 HTTP 빈도 제한 (서버 `index.ts`를 함께 고친다)
3. §5 Phase 1 잔여 2건(콘솔 resend, 이력 "?")
4. opus 검수 2회차 (S1~S4 전체 + §4) → 지적 반영
5. 이슈 #1 체크, PR 본문 갱신, push
6. Phase 2를 순서대로. 기능 하나마다 커밋, 스프린트마다 opus 검수·push
7. 끝나면 이 로그에 최종 요약, PR 본문 갱신, 이슈 완료 댓글, `orca worktree set --worktree active --workspace-status in-review --unread --json`

### 7. 알려진 문제·주의

| 항목 | 내용 |
|---|---|
| 루트 `pnpm test` | `apps/e2e`의 `test`도 함께 돈다. 포트 8798·5180을 쓰므로 다른 서버가 떠 있으면 실패한다. 패키지별로 돌리거나 e2e를 루트 test에서 빼는 것을 검토 |
| 남은 프로세스 | 인계 시점에 포트 8799에 이전 에이전트가 남긴 workerd(PID 54442)가 있었다. 통합 테스트는 `WINDS_TEST_PORT`로 다른 포트를 쓰면 된다. 8787의 프로세스는 이번 작업과 무관할 수 있어 건드리지 않았다 |
| 파서 지표 | 골든 211건은 개발 측이 쓴 문장이라 낙관적이다. 실전 받아쓰기로 다시 재야 한다 (P-3, 사람 작업) |
| STT 실측 | 실제 마이크·사람 목소리, Edge, Chrome 온디바이스 한국어 팩, 30분 연속 실행·메모리, 게임 FPS는 확인하지 못했다 (P-1, P-2, P-4, P-6, 사람 작업). k2-fsa 모델의 #2886 빈 결과 문제도 실제 마이크로 확인해야 한다 |
| 라이선스 | KsponSpeech(AIHub) 학습 모델의 재배포 조건 미확인 |
| WebSocket + 정적 자산 | `run_worker_first`로 `/api/*` HTTP가 Worker로 가는 것은 확인했지만, 배포 설정에서 WebSocket 업그레이드는 로컬에서 확인하지 않았다 |
| 시계 차이 | HUD 경과 시간은 클라이언트 시계와 서버 `issuedAt`의 차이를 그대로 반영한다 |
| 배포 | 하지 않았다 (멈춤 조건). 절차는 `docs/deploy.md` |

### 배포 설정 결과 (2026-11-26)

§4.2 배포 설정과 검수 #14의 HTTP 부분을 서버에서 처리했다. 코드는 `apps/server/src/httpGuard.ts`, `index.ts`. 상세 절차는 `docs/deploy.md`.

**Origin 정책** (wrangler `vars.ALLOWED_ORIGINS`, 쉼표 목록. `/api/*` HTTP와 WebSocket 업그레이드에 적용)

| 상황 | 결과 |
|---|---|
| Origin 헤더 없음 | 허용 (비브라우저, 테스트) |
| 목록 비어 있음 (개발) | 같은 출처(요청 Host == Origin host) 또는 loopback만 허용 |
| 목록 있음 (배포) | 목록의 출처만 허용 |
| 거절 | 403 `FORBIDDEN_ORIGIN` |

CORS 응답은 `*` 대신 허용된 Origin을 되돌리고 `Vary: Origin`을 붙인다. preflight도 같은 검사를 거친다. 이유: `*`는 아무 사이트의 페이지가 방 API와 WebSocket을 쓰게 둔다. 한계: Origin은 브라우저만 지키므로 접근 제어가 아니다. 방 접근 통제는 방 코드·토큰이 한다.

**HTTP 빈도 제한** (`vars.HTTP_RATE_LIMIT`=`생성,조회`, IP별 메모리 고정 1분 창, 초과 429 + Retry-After): `POST /api/rooms` 분당 10, `GET /api/rooms/:code`와 WebSocket 업그레이드는 한 몫으로 분당 300 [제안값, 처음 60에서 NAT 30명 입장을 고려해 올림]. 개발(`wrangler.jsonc`)은 100000으로 풀었다. 로컬 테스트·E2E가 loopback 한 IP에서 많이 호출하기 때문이다. 이유: 방 코드 대입(검수 #14)을 늦추려는 것이다. 한계: isolate마다 따로 세고 재시작하면 초기화된다. 완전한 방어가 아니며, 완전한 방어는 Cloudflare Rate Limiting 규칙이다. 한 NAT 뒤 30명 동시 입장은 조회 60/분에 걸려 배포 기본값을 300으로 했다. 실전 뒤 조정한다.

**검증:** 순수 함수 단위 테스트(`apps/server/test/helpers.test.ts`), 통합 테스트(기본 vars로 개발 정책, 두 번째 서버를 `--var ALLOWED_ORIGINS`, `HTTP_RATE_LIMIT:2,3`으로 띄워 목록 정책·403·429·WebSocket 403/429 확인). 배포 설정(`wrangler.deploy.jsonc`)의 `ALLOWED_ORIGINS` 예시 값은 배포 전에 실제 도메인으로 바꿔야 한다(사람 작업).

## 검수 2회차 결과 (2026-11-26)

opus 검수 2건(서버·프로토콜, 웹·파서·STT)에서 major 7·minor 약 17건 지적 → 반영 완료. 결정과 한계만 남긴다.

| 영역 | 결정 / 한계 |
|---|---|
| DO 재시작 | 메인오더 접속 중 10초 틱마다 `commanderSeenAt` 키만 저장 + 인스턴스 시작 후 60초(`restartGraceMs`)는 COMMANDER_ABSENT로 닫지 않는다. 유예 기준이 인스턴스 메모리라 hibernation 복귀마다 새 유예가 생긴다(닫는 시점이 늦어질 뿐) |
| 권한 | room-core `Ctx.role` 필수. 역할이 없거나 MEMBER면 모든 요청 FORBIDDEN (열린 실패 제거) |
| 프레임 | `maxFrameLength` 8192(`string.length`. 한글 원문 stt.feed가 정상 범위여야 해서 바이트 아님). 파싱 전 길이·빈도 검사 |
| HTTP 404 | 없는 방 조회는 별도 `miss` 버킷(IP당 분당 20). DO를 만들어 봐야 존재를 알 수 있어 404 뒤에 센다. 비용: 한도를 쓴 IP는 1분간 정상 조회도 429 |
| Origin | 요청 자신의 출처는 목록과 무관하게 항상 허용(목록은 추가 출처). 자리표시 값을 안 바꿔도 전면 장애가 나지 않는다 |
| 파서 | 부정("하지마/안 돼/중지/금지")과 "…말고"로 끝나 슬롯이 없는 발화는 NONE. 전체+파티 혼합("다들 1파티 쪽으로")·"파티한테/쪽으로"는 MEDIUM. 취소는 단독 발화이거나 대상·행동이 직전 명령과 같을 때만. 골든 229건(알려진 실패 3), 재현율·정밀도 100%·오발행 0% (여전히 낙관적). 한계: "1파티 모여 취소"처럼 사전에 없는 취소 표현은 새 명령으로 처리 |
| 닫힌 방 재접속 | WS 업그레이드 404가 이어지면(3회) `GET /api/rooms/:code`로 확인하고 404면 CLOSED(`ROOM_NOT_FOUND`). 방 확인은 `checkRoom` 콜백 주입 |
| 수동 발행 | `supportPartyIds`를 초안·후보 [수정]·미리보기에 반영, 버튼 패널에 지원 대상 선택 |
| KR3 지표 | 취소 사유(MISRECOGNIZED/CHANGED)는 취소자와 무관하게 센다. `byOthers`는 취소자 집계로 따로 둔다. `issued.voice`는 `command.issued/corrected` 이벤트의 `source===VOICE`로 센다. 요약 수집기는 메인오더 화면에서만 만든다 |
| 음성 정정 | CORRECT 후보 [수정]은 `correctsId` 유지. 한계: 한 문장에 명령이 여러 건이면 "방금 거 취소"는 마지막 명령만 취소 |
| 미반영 | 클라이언트 ping이 Chrome 백그라운드 타이머 제한(분당 1회)에 걸리면 25초 끊김 판정이 반복될 수 있다 → 실기기 확인 필요(P-2 계열, 사람 작업). ping을 Worker 타이머로 옮기는 것은 하지 않았다 |
