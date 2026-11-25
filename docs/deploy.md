# 배포 가이드 (Cloudflare, 사람이 직접 실행)

웹(정적 파일)과 방 서버(Worker + Durable Object)를 **한 Worker**로 배포한다. 같은 주소에서 웹, `/api/*`, WebSocket이 모두 나간다. CORS 설정이 필요 없다 (D-10). 그래도 `/api/*`는 `Origin`을 확인한다(아래 "허용 Origin").

## 구성

- 설정 파일: `apps/server/wrangler.deploy.jsonc`. `apps/server/wrangler.jsonc`(개발·테스트용)와 분리했다. 웹을 빌드하지 않은 상태에서도 `wrangler dev`와 통합 테스트가 돌게 하려는 것이다. wrangler는 `assets.directory`가 없으면 시작하지 않는다.
- `assets`: `../web/dist`를 정적 자산으로 올린다. `run_worker_first: ["/api/*"]`라서 `/api/*`만 Worker가 먼저 받는다. 나머지는 자산에서 바로 나가고, 없는 경로(`/r/ABC123`, `/guide`)는 `index.html`로 되돌린다(SPA).
- 정적 자산 요청은 무료이고 한도가 없다. Worker 호출로 세는 것은 `/api/*`뿐이다.
- 자산 한도(공식 문서 확인): 파일 1개 25 MiB, 파일 수 20,000개(Free). sherpa WASM 15.7MB는 통과한다.
- **음성 인식 모델(약 70MB)은 배포하지 않는다.** 메인오더 브라우저가 Hugging Face에서 받아 IndexedDB에 저장한다. 저장소와 Worker에는 모델이 없다.

## 환경 변수 (웹 빌드 시점, Vite)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `VITE_API_BASE` | 빈 값(같은 출처) | API와 WebSocket 주소. 예: `https://api.example.com`. WebSocket은 같은 값에서 `http`를 `ws`로 바꿔 쓴다(`apps/web/src/config.ts`). 끝 슬래시는 제거한다. 단일 Worker 배포에서는 비운다 |
| `VITE_STT_MODEL_BASE` | 빈 값(Hugging Face 고정 리비전) | 음성 인식 모델 다운로드 base URL. 예: `https://models.example.com/stt` (R2 공개 버킷 등). 끝 슬래시는 무시한다. 파일명은 모델별로 고정이라 이 주소 아래에 같은 이름으로 올려야 한다. 외부 호스팅은 CORS 허용이 필요하다 |

`apps/web/.env.production`에 적거나 빌드 명령 앞에 붙인다. `VITE_` 변수는 번들에 박히므로 비밀 값을 넣지 않는다.

```sh
VITE_STT_MODEL_BASE=https://models.example.com/stt pnpm --filter @winds/web build
```

## 허용 Origin과 HTTP 빈도 제한

둘 다 `apps/server/src/httpGuard.ts`, 설정은 wrangler `vars`다. `/api/*` HTTP와 WebSocket 업그레이드에 적용한다. `/api/health`와 preflight(OPTIONS)는 빈도 제한에서 뺀다.

### ALLOWED_ORIGINS

쉼표 목록(예: `https://winds.example.com,https://www.example.com`). 배포 전에 `wrangler.deploy.jsonc`의 예시 값을 실제 도메인으로 **반드시 바꾼다.** 개발용 `wrangler.jsonc`는 빈 값이다.

| 상황 | 결과 |
|---|---|
| `Origin` 헤더 없음 (curl, 서버 간 호출, 테스트) | 허용 |
| 요청 자신의 출처 (Origin의 스킴·호스트·포트가 요청 URL과 같음) | 항상 허용. 목록에 없어도 된다 |
| 목록이 비어 있음 | 위에 더해 loopback(`localhost`, `127.0.0.1`, `[::1]`)만 허용 |
| 목록이 있음 | 위에 더해 목록에 있는 출처만 허용 (대소문자·끝 슬래시 무시). 목록은 **추가** 출처용이다. loopback도 목록에 없으면 거절 |
| 거절 | 403 `FORBIDDEN_ORIGIN` |

허용된 응답에는 `Access-Control-Allow-Origin: <요청 Origin>`과 `Vary: Origin`을 붙인다(`*` 아님). 한계: `Origin`은 브라우저만 지킨다. 비브라우저 클라이언트는 헤더를 위조하거나 생략할 수 있어, 이것은 다른 사이트의 웹 페이지가 내 서버를 쓰는 것을 막을 뿐 접근 제어가 아니다. 방 접근은 여전히 방 코드와 토큰이다.

### HTTP 빈도 제한 (방 코드 대입 방지)

`HTTP_RATE_LIMIT`=`<생성/분>,<조회/분>[,<없는 방 조회/분>]`. 셋째 값은 생략하면 20이다. IP(`CF-Connecting-IP`, 없으면 `local`)별 고정 1분 창이다. 초과하면 429와 `Retry-After`(초).

| 대상 | 배포 값 | 개발 값(`wrangler.jsonc`) |
|---|---|---|
| `POST /api/rooms` | 분당 10 | 100000 |
| `GET /api/rooms/:code` + WebSocket 업그레이드 (한 몫으로 합산) | 분당 300 | 100000 |

없는 방(404)을 가리키는 조회(잘못된 코드, 깨진 `%` 인코딩 포함)는 위와 별도로 IP당 분당 20건만 센다. 초과하면 429다. Durable Object는 만들어 보기 전에는 존재 여부를 알 수 없어서(이름에서 ID만 계산) 404가 난 뒤에 센다. 대신 한도를 다 쓴 IP는 DO를 건드리기 전에 429로 막아, 코드 대입으로 빈 DO를 계속 만드는 것을 막는다. 한도를 다 쓰면 그 IP의 정상 방 조회도 1분간 429다.

개발 값이 큰 이유: 로컬 테스트와 E2E는 전부 loopback 한 IP라 많은 연결이 한도에 걸린다. 한도 수치는 제안값이다. 같은 NAT(길드원이 한 공유기 뒤)에서 30명이 입장하면 조회 60/분에 걸린다. 그래서 배포 기본값을 300으로 올렸다.

**한계:** 카운터는 Worker isolate 메모리에 있다. isolate마다 따로 세고 재시작하면 초기화되므로, 방 코드 대입을 늦출 뿐 완전한 방어가 아니다. 완전한 방어는 Cloudflare Rate Limiting 규칙(대시보드 → Security → WAF → Rate limiting rules, 경로 `/api/rooms*`)을 앞단에 두는 것이다. 이 코드는 그 규칙이 없을 때의 최소 방어선이다. 방 코드는 32^6(약 10억) 경우이고 방은 4시간 만에 사라진다.

## sherpa wasm과 모델 분리

- sherpa wasm(15.7MB)은 정적 자산 `/vendor/sherpa-onnx/`에 그대로 둔다. Cloudflare 정적 자산 파일 1개 한도(25 MiB) 안이다.
- 모델(약 70MB)은 그 한도를 넘으므로 정적 자산에 넣지 못한다. R2 또는 외부 호스팅으로 분리하고 `VITE_STT_MODEL_BASE`로 가리킨다.

## 순서

1. 의존성과 WASM 받기 (WASM은 gitignore 대상이라 새로 받은 저장소에는 없다)
   ```sh
   pnpm install
   pnpm fetch:stt-wasm
   ```
2. 검증 (계정 불필요). 웹 빌드 후 `wrangler deploy --dry-run`으로 번들링만 확인한다.
   ```sh
   pnpm --filter @winds/server build:deploy
   ```
   `apps/server/.wrangler/dryrun/`에 결과가 생긴다. 이 폴더는 gitignore 대상이다.
3. (선택) 배포와 같은 구성을 로컬에서 보기
   ```sh
   pnpm --filter @winds/web build
   pnpm --filter @winds/server dev:assets   # http://localhost:8788
   ```
4. 로그인 (처음 한 번, 브라우저가 열린다)
   ```sh
   pnpm --filter @winds/server exec wrangler login
   ```
5. 배포
   ```sh
   pnpm --filter @winds/server deploy
   ```
   출력의 `https://winds-command.<계정>.workers.dev` 가 서비스 주소다. 첫 배포 때 Durable Object 마이그레이션(`v1`, SQLite)이 함께 적용된다.
6. 배포 후 확인
   - `curl https://<주소>/api/health` 가 `{"ok":true}`
   - 휴대폰으로 `https://<주소>/guide` 열기
   - 방을 만들고 다른 기기로 입장해 명령이 오는지 본다
   - 부하 확인: `pnpm --filter @winds/loadtest run load --url https://<주소> --members 30`. 로컬 수치와 달리 실제 네트워크 지연이 들어간다. 무료 한도를 쓰므로 꼭 필요할 때만 돌린다.

`pnpm --filter @winds/server deploy`는 웹 빌드 후 곧바로 배포한다. 예전에 빌드한 `dist`를 올리지 않도록 항상 새로 빌드한다.

## 무료 한도 (06 D-3)

- Workers Free + SQLite 기반 Durable Object로 가능하다. 한도를 넘으면 요금이 아니라 요청 실패가 난다. 한도는 매일 00:00 UTC(한국 시각 오전 9시)에 초기화된다.
- 동맹전 1회(30명, 1시간) 예상: 들어온 메시지 약 1,400건 → `ceil(1400/20) + 연결 96` = **약 170건**. 앱 ping은 `setWebSocketAutoResponse`로 처리해 세지 않는다. ping까지 세는 최악의 경우도 약 530건이다. 일일 한도(10만 건)의 1% 미만이다. 부하 테스트 리포트(`apps/loadtest/reports/`)에 같은 추정이 들어 있다.
- 실행 시간(duration)이 더 빠듯할 수 있다. 연결이 있는 동안 객체가 깨어 있다. 첫 실전 뒤 대시보드로 확인한다.
- 일일 요청 한도 수치는 문서가 바뀔 수 있다. 배포 전에 [가격 문서](https://developers.cloudflare.com/durable-objects/platform/pricing)로 다시 확인한다.

## 지켜볼 것 (T8)

사전 부검 T8: 일일 요청이 무료 한도의 30%를 넘으면 신호다.

- Cloudflare 대시보드 → Workers & Pages → `winds-command` → Metrics: 요청 수, 오류율, CPU 시간.
- Durable Objects 사용량: 요청 수, 실행 시간(GB-s), 저장소 읽기·쓰기.
- 동맹전 직후 한 번, 첫 3회는 매번 본다. 30%를 넘으면 ping 간격, 접속 횟수(재연결 폭주 여부), 메시지 수를 먼저 의심한다.
- 한도를 넘으면 그날 새 요청이 실패한다. 다음 날 오전 9시(KST)에 풀린다. 동맹전 전에 미리 확인해 둔다.

## 되돌리기

- 이전 버전으로: `pnpm --filter @winds/server exec wrangler rollback -c wrangler.deploy.jsonc` (직전 버전). 버전 목록은 `wrangler deployments list`, 특정 버전은 `wrangler rollback <버전 ID>`.
- 코드 롤백은 Durable Object 저장 데이터와 마이그레이션을 되돌리지 않는다. 메시지 형식(`v: 1`)이 바뀐 배포를 되돌릴 때는 열려 있는 방이 없을 때 하는 것이 안전하다.
- 서비스를 완전히 내릴 때: 대시보드에서 Worker 삭제, 또는 `wrangler delete -c wrangler.deploy.jsonc`. 방 데이터는 방 닫기나 4시간 만료 때 이미 지워진다.
- 서비스가 죽었을 때 대비책은 메인오더 음성이다. 화면은 보조다.

## 하지 않는 것

- `wrangler deploy`를 `-c wrangler.deploy.jsonc` 없이 실행하지 않는다. 자산 없이 Worker만 올라간다.
- 모델 파일을 `apps/web/public`에 넣지 않는다. 25 MiB 한도를 넘고 저장소가 커진다.
