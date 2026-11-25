# @winds/parser

메인오더 발화(STT 최종 문장)를 전술 명령으로 바꾸는 규칙 기반 한국어 파서. 순수 함수이고 네트워크·화면에 의존하지 않는다. 설계는 `docs/planning/features/F03-command-extraction.md`, `F09-command-dictionary.md`.

## API

```ts
import { parse, DEFAULT_DICTIONARY, mergeDictionaries, buildPartyLexicon,
         findDictionaryConflicts, DictionarySchema, normalize } from '@winds/parser';

const results = parse('1파티 2파티 중앙으로 모여', {
  parties,                 // @winds/protocol Party[]
  dictionary: DEFAULT_DICTIONARY,
  lastVoiceCommand,        // { command, issuedAt } | undefined
  now: Date.now(),
  options: { targetlessAsAll: false },   // 방 설정. true면 대상 없는 명령도 전체 대상 HIGH
}); // ParseResult[]
```

- `ParseResult`: `ISSUE`(draft, confidence) / `CORRECT`(correctsId, patch, confidence) / `CANCEL`(commandId) / `NONE`(reason). `evidence: Match[]`의 `start/end`는 `normalize(text, dictionary)` 결과 기준이다.
- 확신도: HIGH = 자동 발행, MEDIUM = 후보. NONE = 버림.
- 대상 없는 명령(Q1): 기본은 MEDIUM이고 `draft.target`은 `{kind:'ALL'}`(evidence에 target이 없으면 대상 생략). `targetlessAsAll`이면 HIGH.
- 약한 행동(`가`, `와`, `가자`, `이쪽으로`, `들어가`, `붙어`)은 항상 MEDIUM이고, 대상·위치가 모두 없으면 NONE이다. 강한 행동과 같이 나오면 무시한다.
- 한 문장에서 여러 명령이 나오면 `ISSUE`가 여러 개 나온다. 명령이 하나도 없으면 `[NONE]` 하나.
- 정정은 직전 음성 명령이 `LIMITS.correctionWindowMs`(15초) 이내일 때만 `CORRECT`. 아니면 정정어 뒤쪽을 새 명령으로 본다(정정어 앞쪽에 내용이 있으면 MEDIUM으로 제한).
- 취소 표현은 `CANCEL`(직전 명령이 없으면 `NONE`, reason `no previous command`).

## 사전 (F09)

`DictionarySchema`(Zod)로 검증한다. 필드: `version: 1`, `name`, `actions`(행동별 표현), `targetAll`, `locations[{id,label,aliases}]`, `numberWords`, `partySuffixes`, `correctionMarkers`, `cancelPhrases`, 선택 `disabled`(기본 사전에서 끌 표현). 빠진 목록은 빈 배열로 채워지므로 동맹 사전은 바꿀 부분만 적으면 된다.

- `mergeDictionaries(base, override)`: override가 이긴다. override가 행동 X에 둔 표현은 base의 다른 행동에서 빠지고, `disabled`는 base에서 빠진다.
- `findDictionaryConflicts(dict)`: 같은 표현이 두 행동에 있는 곳(편집기 경고용). 공백 차이는 같은 표현으로 본다.
- `buildPartyLexicon(parties)`: 번호(`1파티/1팟/1파`)·이름·별칭 → partyId.

## 매칭 휴리스틱

공백을 모두 뺀 문자열에서 사전 표현을 찾고(STT가 띄어쓰기를 틀려도 동작), 긴 매칭 우선으로 겹침을 푼다.
- 길이 3 이상: 어디서든 매칭. 길이 2: 뒤가 조사·어미(`으로`, `주세요`, `해` …)만 이어지다 어절이 끝나야 한다(`공격력`, `지원군`, `전체적으로` 제외). 띄어쓰기 없이 다른 매칭이 바로 붙는 경우는 허용.
- 길이 1(`다 가 좌 우 와 빼 쳐`): 어절 시작이거나 직전 매칭+조사 뒤에서 시작하고 뒤가 조사·어미여야 한다(`우리`, `가끔`, `다음` 제외).
- 파티 이름과 행동 표현이 같으면(`수비`) 이름 우선, 뒤에 `해/하`가 오면 행동 우선.
- 정규화에서 지원하는 숫자 표현은 `src/normalize.ts` 머리말 참고.

## 골든 테스트

`test/golden/*.jsonl`(한 줄에 케이스 하나, `//` 또는 `#` 줄은 주석) 또는 `.json`(배열).

```jsonc
{"text":"3파티 오른쪽 지켜주세요",
 "expect":[{"kind":"ISSUE","confidence":"HIGH","target":[3],"action":"DEFEND","location":"RIGHT"}]}
```

| 필드 | 설명 |
|---|---|
| `text` | 인식된 문장 |
| `expect` | 결과 배열(순서대로 비교). `ISSUE`: `confidence`, `target`(`"ALL"` 또는 파티 번호 배열), `action`, `location?`(id), `support?`(번호 배열). `CORRECT`: `confidence`, `patch:{target?,action?,location?,support?}`. `CANCEL`. `NONE` |
| `partyCount?` | 기본 6 (id `p1..`) |
| `parties?` | `[{number,name?,aliases?}]` 직접 지정 (id는 `p{번호}`) |
| `last?` | 직전 음성 명령 `{target,action,location?,ageMs?}` (ageMs 기본 3000) |
| `options?` | `{targetlessAsAll?}` |
| `knownFailure?`, `reason?` | 지금은 못 맞히는 케이스. 통과하면 vitest가 알려 준다 |
| `note?` | 메모 |

실제 녹음 전사(사람이 정답을 단 것)는 같은 형식의 JSONL로 만들어 `golden`에 경로로 넘기면 된다. 명령이 아닌 발화는 `"expect":[{"kind":"NONE"}]`.

## 실행

```sh
pnpm --filter @winds/parser typecheck
pnpm --filter @winds/parser test                       # 단위 + 골든
pnpm --filter @winds/parser golden                     # test/golden 전체, 케이스별 PASS/FAIL + 지표
pnpm --filter @winds/parser golden -- path/to/real.jsonl [--quiet] [--strict]
```

지표(F03 품질 목표): 재현율(명령 케이스 중 ISSUE/CORRECT/CANCEL이 나온 비율, 목표 95%+), 자동 발행 정밀도(HIGH 결과 중 슬롯이 모두 맞은 비율, 99%+), 오발행률(명령 아닌 케이스 중 HIGH가 나온 비율, 1% 미만). `--strict`일 때만 목표 미달이 종료 코드 1이다.
