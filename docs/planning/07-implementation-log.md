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
