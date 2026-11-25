# 배포 가이드 (Cloudflare, 사람이 직접 실행)

웹(정적 파일)과 방 서버(Worker + Durable Object)를 **한 Worker**로 배포한다. 같은 주소에서 웹, `/api/*`, WebSocket이 모두 나간다. CORS 설정이 필요 없다 (D-10).

## 구성

- 설정 파일: `apps/server/wrangler.deploy.jsonc`. `apps/server/wrangler.jsonc`(개발·테스트용)와 분리했다. 웹을 빌드하지 않은 상태에서도 `wrangler dev`와 통합 테스트가 돌게 하려는 것이다. wrangler는 `assets.directory`가 없으면 시작하지 않는다.
- `assets`: `../web/dist`를 정적 자산으로 올린다. `run_worker_first: ["/api/*"]`라서 `/api/*`만 Worker가 먼저 받는다. 나머지는 자산에서 바로 나가고, 없는 경로(`/r/ABC123`, `/guide`)는 `index.html`로 되돌린다(SPA).
- 정적 자산 요청은 무료이고 한도가 없다. Worker 호출로 세는 것은 `/api/*`뿐이다.
- 자산 한도(공식 문서 확인): 파일 1개 25 MiB, 파일 수 20,000개(Free). sherpa WASM 15.7MB는 통과한다.
- **음성 인식 모델(약 70MB)은 배포하지 않는다.** 메인오더 브라우저가 Hugging Face에서 받아 IndexedDB에 저장한다. 저장소와 Worker에는 모델이 없다.

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
