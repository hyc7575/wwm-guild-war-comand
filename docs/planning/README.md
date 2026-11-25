# Winds Command 상세 기획 문서

[서비스 초기 기획서](../service-plan.md)를 개발 가능한 수준으로 구체화한 문서 모음이다.
작성일: 2026-11-26 · 상태: 초안(Draft)

## 문서 지도

| 문서 | 내용 | 주로 읽는 시점 |
|---|---|---|
| [01-PRD.md](01-PRD.md) | 목표, 대상, 가치 제안, 성공 지표, 범위 | 가장 먼저 |
| [02-domain-and-protocol.md](02-domain-and-protocol.md) | 도메인 모델, 명령 상태 머신, WebSocket 메시지 규격 | 구현 시작 전 |
| [features/](features/) | 기능별 아이디어·전략·요구사항·사용자 스토리·인수 조건 | 기능 구현 시 |
| [03-assumptions.md](03-assumptions.md) | 8개 범주 가정과 검증 방법 | Phase 0 계획 시 |
| [04-pre-mortem.md](04-pre-mortem.md) | 실패 시나리오와 대응 (Tigers / Paper Tigers / Elephants) | 단계 전환 전 |
| [05-roadmap-and-poc.md](05-roadmap-and-poc.md) | 단계별 범위, 종료 조건, PoC 측정 계획 | 일정 계획 시 |
| [06-tech-decisions.md](06-tech-decisions.md) | 기술 후보별 문제·대안·가능해지는 것·비용 | 기술 확정 시 |
| [research/korean-stt-models.md](research/korean-stt-models.md) | 한국어 음성인식 모델 조사와 PoC 비교 계획 | STT PoC 시작 전 |

## 기능 명세 목록

| ID | 기능 | 단계 | 우선순위 |
|---|---|---|---|
| [F01](features/F01-room-and-party.md) | 오더방 생성·참여 및 파티 구성 | MVP | Must |
| [F02](features/F02-continuous-stt.md) | 연속 음성인식 | PoC → MVP | Must |
| [F03](features/F03-command-extraction.md) | 전술 명령 추출 | PoC → MVP | Must |
| [F04](features/F04-realtime-delivery.md) | 실시간 명령 전달 | MVP | Must |
| [F05](features/F05-tactical-hud.md) | 전술 HUD | MVP | Must |
| [F06](features/F06-party-view.md) | 파티별 명령 표시 | MVP | Must |
| [F07](features/F07-command-state.md) | 명령 상태 관리 | MVP | Must |
| [F08](features/F08-manual-command.md) | 수동 명령 | MVP | Must |
| [F09](features/F09-command-dictionary.md) | 명령어 사전 | Phase 2 (기본값은 MVP) | Should |
| [F10](features/F10-connection.md) | 연결 상태 관리 | MVP | Must |

## 이번 상세화에서 확정한 사항

| 항목 | 결정 | 출처 |
|---|---|---|
| 파티 구성 | 방 생성 시 파티 수·이름을 설정하고, 방 운영 중에도 변경할 수 있다. 변경은 수 초 안에 모든 참가자에게 반영되면 된다. | 사용자 답변 (2026-11-26) |
| 1차 성공 기준 | 우리 동맹의 실제 동맹전에 정착하는 것 | 사용자 답변 (2026-11-26) |
| 문제 근거 | 기획자가 동맹원으로서 명령을 놓친 경험. 지휘관 입장의 문제는 아직 검증 전 | 사용자 답변 (2026-11-26) |

## 표기 규칙

- `FR-Fxx-n`: 기능 요구사항, `NFR-n`: 비기능 요구사항, `A-n`: 가정, `R-n`: 리스크
- **[가정]**: 근거가 아직 없는 내용이다. [03-assumptions.md](03-assumptions.md)에서 검증 방법을 관리한다.
- **[제안]**: 작성자가 제안한 값이다. 결정권자가 확정해야 한다.
- 수치 목표는 PoC 결과에 따라 조정한다.
