# @winds/loadtest

P-7 부하 테스트: 가짜 메인오더 1명 + 동맹원 N명이 방 하나에 붙어 명령을 중계한다.

```sh
pnpm --filter @winds/loadtest run load --spawn                 # 자체 wrangler dev(--local) 기동, 60명, 명령 100개
pnpm --filter @winds/loadtest run load --url http://localhost:8787 --members 30 --commands 50 --interval 500
```

옵션: `--url`(기본 8787), `--members`(60), `--commands`(100), `--interval`(ms, 1000), `--spawn`.
`--spawn`은 8797 포트(사용 중이면 다음 빈 포트), 임시 persist 폴더, 빈 inspector 포트, `WRANGLER_SEND_METRICS=false`로 띄운다. 계정·네트워크 필요 없음.

## 측정

- 중계 지연 = 동맹원 수신 시각 - 메인오더 전송 시각 (같은 프로세스의 `performance.now()`). p50/p95/p99/max. 목표 p95 <= 200ms (P-7, NFR-F04-1).
- ack 지연, 연결 끊김·오류 수, 모든 동맹원이 모든 이벤트를 순서대로 받았는지.
- 끝에서 `welcome` 크기(스냅샷 <= 32KB, NFR-F04-4)를 최악 조건으로 잰다. 파티 12개(이름·별칭 최대 길이), 명령 50개를 전부 VOICE + 원문 200자(한글)로 채우고, 원문이 항상 보이는 COMMANDER 역할로 접속한다. 메인오더 자리를 쓰므로 기존 메인오더 연결은 의도적으로 먼저 닫는다.
- Durable Object 요청 수 추정 (06 D-3: `ceil(들어온 메시지/20) + 연결 수`). 앱 ping은 `setWebSocketAutoResponse`라 세지 않는다. 가정(30명, 접속 3회, 시간당 명령 600개)은 코드 상단의 `EST_*`.
- JSON 리포트는 `reports/` (gitignore).

## 한계

- 로컬(loopback) 측정이라 실제 네트워크 지연은 빠져 있다. 서버 처리·팬아웃 비용만 본다. 배포 후 `--url https://...`로 다시 돌린다.
- 부하 생성기와 서버가 같은 컴퓨터를 쓴다. 클라이언트 쪽 이벤트 루프 지연도 수치에 섞인다.
- 종료 코드: 모든 검사 통과 시 0, 아니면 1.
