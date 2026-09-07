# 범용 콘티 도구 — 1.6.0 통합 구현 보고서

## 1. 작업 기준

- Branch: `codex/storyboard-generator`
- 시작 HEAD: `8d7bd743a29cec0591cf1b9d14bd044a1345e67e`
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.6.0`
- Storage Journal 3, Store Lock 3, Process Instance Registry 1 유지
- 생성 실행 환경: Codex App 현재 모델, 내장 `image_gen`, macOS 가이드 음성
- `OPENAI_API_KEY`, OpenAI SDK, 외부 제공자 fallback을 사용하지 않음
- 사용자 서버와 미추적 `README 2.md`를 변경하지 않음

## 2. 최초 재현 결함

| 계약군 | 최초 상태 | 구현 결과 |
|---|---|---|
| Proposal Frame | 모델의 시작 Frame 하나만 저장해 후반 Source Anchor의 시각 전환을 표현하지 못함 | 선택적 Frame Plan과 Anchor 시작 기반 Key Frame을 생성함 |
| Visual Mode | Source가 없는 Shot을 암묵적으로 처리해 검은 화면과 직전 화면 유지의 의도를 구분하지 못함 | `sourced`, `black`, `hold-previous`를 영속 계약과 출력 판정에 추가함 |
| Visual Coverage | Direct Visual Source가 Shot 일부만 덮어도 전체 시각 근거처럼 처리할 수 있음 | confirmed 반열린 범위의 합집합에서 시작·중간·끝 Gap을 검사함 |
| Heartbeat | Registry 갱신이 transaction 경계에 의존해 긴 작업 중 live owner를 stale로 오인할 수 있음 | root와 process instance별 공유 주기 timer를 추가함 |
| Historical Audit | current에 남은 Record 중심이라 과거에 제거·변경·재등장한 ID를 빠뜨릴 수 있음 | 모든 version의 Record ID 합집합과 일관된 snapshot을 감사함 |
| Recovery Marker | 손상된 marker 하나가 초기화 전체를 실패시킬 수 있음 | 항목별 격리와 known·unknown recovery block을 구현함 |
| Stored Asset Path | 저장 후 symlink·경로 변조가 일반 검증 오류로 분류될 수 있음 | `STORED_ASSET_PATH_UNSAFE` asset scope 423으로 분류함 |
| Open-ended Text | Placement 종료가 null이면 현재 시각의 활성 여부를 일관되게 판정하지 못함 | 명시 Cue 종료, canonical 종료, 검토 필요 순서의 유효 범위를 공유함 |
| Timecode | 시작 timecode를 Duration에도 더하거나 화면별 formatter가 달랐음 | Absolute와 Duration formatter를 분리하고 BigInt 정수 산술을 공유함 |
| Program Monitor | `requestAnimationFrame`의 소수 millisecond가 정수 시간 계약을 위반함 | 재생 위치를 정수 millisecond로 정규화함 |

## 3. Proposal Frame·Visual Mode

- Proposal은 기존 `frameDescription`과 함께 선택적 `visualMode`, `frames[]`를 받는다.
- `start=0‰`, `key=1..999‰`, `end=1000‰`와 위치 중복 금지를 검사한다.
- 직접 시각 Anchor의 서로 다른 시작점마다 Key Frame을 파생하고 같은 millisecond의 명시 Frame과 결정적으로 합친다.
- `sourced`는 confirmed direct anchor가 Shot 전체 `[startMs, endMs)`를 덮어야 한다. unresolved와 mapping-required는 Coverage 근거가 아니다.
- 기존·수동 Project의 Gap은 데이터를 바꾸지 않고 `SHOT_VISUAL_COVERAGE_GAP` 검토 이슈로 남기며 Proposal Apply의 Gap은 `PROPOSAL_VISUAL_COVERAGE_GAP`으로 거부한다.
- `black`은 별도 Asset 없이 결정적 검은 PNG를 출력하고 이미지 생성 요청을 거부한다.
- `hold-previous`는 시간상 인접한 직전 Shot의 안전 Frame을 재사용하며 없으면 식별 가능한 이슈를 낸다.

## 4. Process Heartbeat

- 같은 canonical data root와 process instance의 Store들은 registry와 timer 하나를 공유한다.
- initialize 뒤 heartbeat를 시작하며 긴 transaction 중에도 주기적으로 갱신한다.
- timer는 `unref()` 상태이고 마지막 Store close에서 멈추며 registry 파일을 제거한다.
- 갱신 실패는 숨기지 않고 `/api/status.processHeartbeat`의 code와 message로 보고한다.
- `/api/status`는 active create/update owner를 다시 확인해 끝난 작업을 응답에서 제거한다.

## 5. Historical Generation Audit

- `versions/*.json` 전체의 Generation Record ID 합집합을 감사해 current 전에 제거된 Record도 보고한다.
- 최초 도입 revision의 Shot·Asset과 current target을 비교해 `current`, `historical`, `unresolved`를 구분한다.
- 중간 metadata 변경, 제거 뒤 재등장, 혼합 current/historical Shot과 historical Asset target을 보고한다.
- 감사 시작의 current revision·SHA-256과 version 목록을 끝에서 다시 확인한다. 한 번 재시도해도 바뀌면 `AUDIT_SNAPSHOT_CHANGED` 409다.
- 감사 과정은 current와 version 파일을 수정하지 않는다.

## 6. Recovery·Asset Integrity

- marker 파일명·JSON·Schema·identity를 항목별로 검사하고 잘못된 항목은 `.recovery-blocks/.invalid`에 격리한다.
- 격리 항목은 증명 가능한 Project 또는 `unknown:<file>`의 hash key block으로 보고하며 다른 Project의 list·read·update·create를 유지한다.
- 유효한 Project marker는 자기 Project mutation만 423으로 차단한다. 실제 lock이나 transaction 증거가 있는 재시작 복구가 성공한 경우에만 지운다.
- 저장 Asset의 path traversal과 symlink는 `STORED_ASSET_PATH_UNSAFE`, scope `asset`, HTTP 423이며 Project mutation은 차단하지 않는다.
- `/api/projects/:id/asset-integrity`는 현재 Frame·Audio·Reference·Prop·Continuity 출력 참조만 검사한다. 사용하지 않는 historical Asset 손상은 현재 UI banner에 남기지 않는다.
- 웹은 Project load, refresh, revision 변경과 오류 뒤 integrity 결과를 다시 조정해 수리된 알림을 제거한다.

## 7. Text Placement·Timecode

- Open-ended Placement는 같은 Placement의 명시적 Text Cue end, 유일한 confirmed Mapping의 canonical end 순서로 종료를 정한다.
- 종료 근거가 없거나 모호하면 `TEXT_PLACEMENT_END_REVIEW_REQUIRED`를 내고 Frame Context와 안전 출력을 차단한다.
- 만료된 Placement와 Text Mapping은 이후 Frame Context에 포함하지 않는다.
- `formatAbsoluteTimecode`는 start timecode를 한 번 적용하고 `formatDurationTimecode`는 0에서 시작한다.
- 24·25·30fps와 검증된 29.97·59.94 drop-frame 분 경계, 10분 경계와 24시간 wrap을 정수 프레임으로 계산한다.
- Web·CSV·PDF는 같은 formatter를 사용한다.

## 8. Browser E2E

- Playwright `1.55.0`, Chromium `140.0.7339.16`을 고정했다.
- Late Anchor Key Frame DOM, Project별 recovery 차단, Asset notice 재조정, 24fps Absolute·Duration 구분을 검사한다.
- 실제 안전 WAV HTTP 응답과 Audio seek·cue end·monitor cleanup을 검사한다.
- 409·503이 영속 recovery banner를 만들지 않는지 확인한다.
- black의 결정적 화면·생성 버튼 비활성화, hold-previous의 직전 안전 Frame과 source 부재 placeholder를 확인한다.

## 9. PRJ-007

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, Text Placement 25, 전체 Timeline 1,500,000ms를 유지한다.
- 원문 변경과 영상 Gap·Overlap은 0이다.
- `UNIT-045`는 849,000–851,000ms J-cut, PCM16 mono 48,000Hz, 2,000ms와 Safe Audio RIFF를 유지한다.
- Import 뒤 Late Anchor Proposal, Key Frame과 시점별 Image Context, Generation Record, Shot Merge, 같은 Segment 재제안, Source Update와 Historical Audit을 한 저장 이력에서 검사한다.
- Black·Hold Mode가 Information Gate를 앞당기지 않으며 JSON round-trip, CSV, PDF가 성공한다.

## 10. 테스트 결과

| 명령 | 결과 | Test File | Test Count | 비고 |
|---|---|---:|---:|---|
| `npm run schemas:write` | 성공 | - | - | 1.6.0 JSON Schema 갱신 |
| `npm run typecheck` | 성공 | - | - | Domain·Server·Script·Test |
| `npm run typecheck:web` | 성공 | - | - | React Web |
| `npm test` | 성공 | 32 | 860 | 단위·통합 |
| `npm run schemas:check` | 성공 | - | - | Zod와 생성 Schema 일치 |
| `npm run build:web` | 성공 | - | - | Vite production build |
| `npm run test:e2e` | 성공 | 1 | 7 | Chromium 실제 DOM·Audio |
| `npm run check` | 성공 | 32 | 860 | 이름 검사와 build 포함 |
| `git diff --check` | 성공 | - | - | 공백 오류 없음 |

필수 테스트 이름: 누락 0, 중복 0, skip 0, only 0, 전체 75개.

## 11. Runtime Smoke

- 사용자 서버와 다른 동적 포트 `57985`, `57989`, `57994`, `57998`을 사용했다.
- `/`, status, import, project read, Late Anchor Apply, Key Frame과 생성 context, Black·Hold, Generation Audit, Asset Integrity, Safe Frame·Audio, Source Update, JSON·CSV·PDF가 성공했다.
- 실제 HTTP로 revision 409, Asset 423, Project 423, service 503을 확인했다.
- malformed marker quarantine, periodic heartbeat health, active update 표시와 완료 뒤 refresh를 확인했다.
- 임시 App, Worker, timer, listener, process registry와 data/request root를 모두 정리했다.
- 샌드박스 안의 최초 실행은 macOS local listen 권한 `EPERM`으로 막혔고 동일 명령을 격리 환경 그대로 실행해 통과했다.

## 12. CI

- Workflow `CI`는 Ubuntu, Node.js 24에서 `check`와 `e2e`를 별도 Job으로 실행한다.
- `check`는 `npm ci`와 `npm run check`, `e2e`는 check 성공 뒤 Chromium을 설치하고 `npm run check:e2e`를 실행한다.
- 최종 Head의 Run ID, URL, SHA와 conclusion은 PR 검사를 기준으로 확인한다.

## 13. GitHub·PR·Branch Protection

- Remote: `origin`, repository `zzocojoa/storyboard-generator`
- PR: [#1](https://github.com/zzocojoa/storyboard-generator/pull/1), base `master`, head `codex/storyboard-generator`, Open 상태 유지
- 구현과 문서는 별도 commit으로 push한다.
- `master` 보호는 사용자 승인에 따라 PR 필수, strict required check `check`·`e2e`, admin 포함, force push·delete 금지로 적용하고 API로 다시 읽어 확인한다.
- `master`는 병합하지 않는다.

## 14. 변경 파일

- 신규: `src/domain/text-placement.ts`, `playwright.config.ts`, `scripts/check-required-tests.ts`, `scripts/runtime-smoke.ts`, `tests/e2e/v15-workbench.spec.ts`, 15차 회귀 테스트 3개.
- 수정: Domain schema·migration·proposal·validation·output·audit·time, Store·HTTP, JSON Schema, Web API·정책·화면, CSV·PDF, 기존 회귀 fixture, package·CI 설정.
- 문서: `README.md`, `AGENTS.md`, storyboard-workbench skill, Design, 이 구현 보고서.
- 삭제 파일은 없다.
- 사용자 미추적 duplicate 파일은 읽거나 stage하거나 commit하지 않는다.

## 15. 남은 위험

- Bitmap의 간접적인 반전 암시는 구조 ID와 시간 검사만으로 판정할 수 없다.
- 전체 Segment의 연출 품질, 자막 가독성, 음성 호흡과 실제 제작 가능성은 사람이 최종 검토해야 한다.
- Process lock은 macOS·Ubuntu 로컬 파일 시스템의 협력 writer를 대상으로 하며 SMB·NFS 분산 writer를 보장하지 않는다.
