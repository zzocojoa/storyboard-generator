# 생성 결과 적용 정합성 검증 보고서

## 판정과 기준

Request와 Project 결과 적용의 경쟁 및 실제 resultRevision 유실을 수정했다. 결과 적용 일관성과 실제 Revision 보존 구현은 완료이며 로컬 단위·통합·종합·반복·브라우저·Smoke 검증은 모두 성공했다. 사용 판단은 로컬 협력 Worker에 GO, 원격 CI·병합에는 CONDITIONAL GO다. 이번 목표는 로컬 구현·검증·문서·Feature Branch Commit이며 새 원격 작업은 실행하지 않는다. 생성 완료와 Final Ready는 여전히 별개다.

아래 구현 검증은 병합 전 기준이다. 이후 PR #6은 `781d9f1`로 병합됐고 첫 CI Attempt의 timeout 5건·추가 ENOTEMPTY 뒤 Attempt 2는 성공했다. 최초 원인은 미확정이며, 별도로 재현한 Test 정리 결함과 최신 검증 상태는 [CI 재현성 조사](../03-analysis/ci-reproducibility-34311587985.md)에 기록한다.

시작 시 fetch와 GitHub 조회로 확인한 master·실제 Base·작업 시작 HEAD는 `2ecb5038e3444bfeb1beeb29530492e0920f914f`다. 새 Branch는 `codex/storyboard-apply-consistency`다. 이전 PR #5와 #4는 이미 병합됐고 master의 CI Run 34299571463은 성공이었다. 이 과거 결과를 이번 최종 HEAD의 CI로 사용하지 않는다. Project 1.9.0·Build Provenance 3·Project Journal/Lock/Registry 3/3/1을 유지한다. Request Schema 2·Apply Intent 1·Request Journal 2·Request Lock 1을 별도로 관리한다.

## 최초 실패 재현

실제 ProjectStore·CodexRequestStore와 Barrier를 사용했다. RED Commit은 `c22f5c3ea0f566503d04e8ecffdc16805219c788`이며 원본 로그는 `/private/tmp/storyboard-apply-red.log`다.

| 결함 | 기존 결과 | 실제 회귀 | 수정 후 |
|---|---|---|---|
| Pending 확인 뒤 Fail/Supersede 종결 | Terminal은 failed/superseded인데 Project Record·Asset 각 1개 저장 | superseded_request_cannot_commit_generated_asset / failed_request_cannot_commit_generated_asset | 적용 거부, Project revision 0·Record 0·Asset 0 |
| Project Commit 뒤 완료 기록 중단, 후속 편집 | 최초 적용 1·현재 2에서 resultRevision을 2로 오기록 | recovered_request_keeps_original_result_revision | 현재 2 유지, resultRevision 1, 중복 없음 |

## 구현 경계

`CodexRequestStore.applyResult`와 `apply-evidence.ts`가 세 생성 종류의 소유권·Intent·Commit·정산·재시도를 공유한다. Request Key → Project Lock 순서이며 외부 생성은 등록 전에 수행한다. 영속 Applying Intent를 먼저 게시하고 기존 ProjectStore의 Current 게시를 Commit 지점으로 사용한다. 별도 Receipt 파일 대신 Current/전체 Version과 기존 Historical Generation Audit으로 유일한 최초 도입 Revision·Record·Request·Asset·Build·Basis·Hash를 검증한다. 검증한 Revision으로 Request만 완료하며 후속 Project를 되돌리지 않는다.

Legacy Pending+Record는 명시적인 reconcile로 실제 도입 Revision을 정산한다. Failed/Superseded+Record, Completed의 다른 Revision, 불명·다른 Host·상충 Intent는 자동 덮어쓰지 않는다. Commit이 입증되면 입력 파일이 없어도 정산한다. Legacy Proposal/Speech의 입력 동일성 Hash가 없으면 파일 재등록으로 추정하지 않고 입력 없는 reconcile을 요구한다. 완료 Intent는 재등록 동일성 감사용으로 보존한다.

CLI·HTTP·상태·오류·스키마·복구 세부 계약은 [Design](../02-design/features/storyboard-generator.design.md)의 Request·Project 결과 적용 절, 사용 절차는 [README](../../README.md)의 결과 적용 상태와 복구 절을 기준으로 한다. 읽기 전용 Review는 Apply 정산을 실행하지 않는다. Applying은 일반 생성 Pending/실패 지표에서 제외한다.

## 실제 결속 증거

HTTP Smoke의 Project ID는 `plant-care-demo`다. 다음 값은 `/private/tmp/storyboard-apply-smoke-final.log`의 applyEvidence에서 얻었다.

| 종류·상황 | Request ID | Request 상태 | resultRevision / 현재 Revision / 검증된 Commit | 결과 Asset |
|---|---|---|---|---|
| Proposal | c4df4faa-a263-4e9c-9375-c1d0f4d0cc0d | completed | 1 / 3 / 1 | 없음 |
| Image | f0ccc3bb-d67b-47e6-b435-f3053a0a3cb5 | completed | 2 / 3 / 2 | codex:f0ccc3bb-d67b-47e6-b435-f3053a0a3cb5:image |
| Speech | f9ada385-68fb-40f7-acd2-9e9c96e09cd3 | completed | 3 / 3 / 3 | codex:f9ada385-68fb-40f7-acd2-9e9c96e09cd3:audio |
| Apply 소유 후 Fail·Supersede 거부 | 1b1212eb-588d-4d67-b25b-d13d7e9bedd0 | completed | 4 / 4 / 4 | codex:1b1212eb-588d-4d67-b25b-d13d7e9bedd0:image |
| Commit 후 SIGKILL·후속 편집·입력 삭제·복구 | c24b88ee-8fa1-4e7e-9714-8089422d671c | completed | 5 / 6 / 5 | codex:c24b88ee-8fa1-4e7e-9714-8089422d671c:image |

전용 1회차의 Supersede 우선 Request `550cdc91-e9f2-426e-a420-917d4f99c5c2`와 Fail 우선 `d355e460-a58e-47a3-a2ef-a2300ba84140`는 각각 Terminal을 유지하고 Record·Asset이 0개였다. Apply 우선 `015d851d-4a28-47ee-9f8c-b9eb54f1ccb1`은 Supersede를, `e523724e-14bb-49fa-9a98-b1d3d6c9a167`은 Fail을 거부하고 Completed·revision 1·Record 1·Asset 1로 끝났다.

각 Record.id는 `codex:<해당 Request ID>`, Record.requestId는 해당 Request ID와 같다. 마지막 복구는 후속 제목 편집을 보존했고 추가 Record·Asset·Project Revision은 각각 0이었다. 적용이 먼저인 경쟁에서는 동일 Request의 Record·Asset이 각 1개다. Fail·Supersede가 먼저인 시험은 Terminal을 보존하고 결과가 각 0개임을 확인했다. 반복 실행의 개별 ID와 강제 종료 PID는 별도 반복 로그에 기록한다.

## 경쟁·중단 경계

| 실제 Barrier·Fault Point | Project 상태 | Request 상태와 정산 |
|---|---|---|
| Fail/Supersede 먼저 | 새 결과 없음 | 기존 Terminal 보존·Apply 거부 |
| Applying 먼저, Fail/Supersede/저수준 complete 경쟁 | 하나의 결과만 Commit | 경쟁 409, Completed와 원래 Commit 일치 |
| 동일 Request 동시 Apply | revision 1·Record 1·Asset 1 | 두 호출이 같은 결과 재사용 |
| before-project-commit에서 후속 편집 | 편집 revision 보존, 생성 결과 없음 | REVISION_CONFLICT, Pending으로 해제 |
| after-apply-ownership-acquired | Commit 없음 | Pending 재시도 |
| after-apply-intent-persisted, before-project-commit | Commit 없음 | Applying 확인 후 Pending 해제·재시도 |
| after-project-journal-prepared | 기존 ProjectStore가 rollback | 결과 없음 확인 후 Pending·재시도 |
| after-project-current-published, before-request-completion | 최초 Commit 유지 | Version 증거로 Completed |
| after-request-completion-journal | Commit 유지 | Request Journal 복구 후 원래 Revision 유지 |
| after-request-completed, before-apply-intent-cleanup | Commit 유지 | Completed와 Intent 보존·멱등 재등록 |
| during-apply-reconciliation, 복구 정산 Journal 재중단 | Commit 유지 | 복구자 선출 뒤 같은 Completed로 수렴 |
| 불명·상충·다른 Host Intent, Legacy Terminal 모순 | 저장된 증거 보존 | request scope 423, 무관 Project 접근·편집 가능 |
| 읽기 전용 Review | Current·Version·Asset 불변 확인 | Applying Request 원본 bytes 불변, 정산 미실행 |

## 검증 실행

로그는 운영 데이터 밖의 `/private/tmp/storyboard-apply-*`에 보존한다. `npm run check` 내부 실행과 별도 실행을 구분한다. 임의 sleep으로 경쟁을 기대하지 않고 실제 Child Process·IPC Barrier·SIGKILL을 사용했다. 기본 Vitest 5초, Worker 2, Playwright Worker 1·Retry 0과 Audio Stress Workflow는 유지했다.

| 명령 | 결과 | 파일 / 시험 | 실행 근거 |
|---|---|---|---|
| npm ci | 성공 | — | npm-ci.log |
| npm run schemas:write | 성공 | — | Request·Intent JSON Schema 생성 |
| npm run typecheck | 성공 | — | 별도 실행 |
| npm run typecheck:web | 성공 | — | 별도 실행 |
| npm test | 성공 | 56 / 1,187 | npm-test-final.log, 204.61초, 별도 실행 |
| npm run test:names | 성공 | 382 필수 이름 | 별도 실행, missing/duplicates/skip/only 0 |
| npm run schemas:check | 성공 | — | 별도 실행 |
| npm run build:web | 성공 | — | build-web-final.log, 별도 실행 |
| npm run check | 성공 | 56 / 1,187 | check-final.log, 내부 시험 198.87초·타입/이름/Schema/빌드 포함 |
| 적용 정합성 시험 3회 | 성공 | 1 / 36 × 3 | repeat-1/2/3.log, 48.84/48.11/46.02초 |
| npm run check:e2e | 성공 | 2 / 16 | check-e2e-final.log, 26.1초·별도 output 지정 |
| 실제 Audio·RAF 3회 | 성공 | 1 / 7 × 3 | audio-final.log, 42.0초·Retry 0 |
| npm run smoke | 성공 | 69 검사 | smoke-final.log, 동적 포트 7개 |
| git diff --check | 성공 | — | 공백 오류 없음 |

별도 반복은 매회 36개, 총 108개가 성공했다. 각 회차의 10개 장애 지점에서 실제 SIGKILL 21회씩, 합계 63회를 기록했고 Smoke의 1회는 별도다. 반복 로그의 exit 관찰과 IPC point를 집계한 증거는 `/private/tmp/storyboard-apply-repetition-evidence.json`이다. 이 64회는 전용 반복과 Smoke에 한정한 수치이며 전체 단위시험에 포함된 다른 강제 종료를 중복 합산하지 않는다. Required는 기존 353개와 신규 핵심 29개를 합한 382개, missing/duplicates/skip/only는 모두 0이다. 실제 Audio/RAF는 전체 E2E에 포함된 7개와 별도 21개를 구분해 집계했다. 두 실행의 Audio 진단 총 28개에서 bodyPassed/contextClosed/rootRemoved=true, 소유 Worker·queue·타이머·Listener·Socket·Request 잔여 0, serverListening=false 및 실제 HTTP 200/206을 확인했다(`/private/tmp/storyboard-apply-audio-evidence.json`). Chromium은 140.0.7339.16이다.

초기 전체 시험의 한 실패는 샌드박스의 `listen EPERM`이었다. 포트 권한을 적용한 전체 1,187건은 성공했다. 최초 Smoke는 종료한 Child의 보존 Registry를 live 자원으로 잘못 계산했고, PID 종료와 Registry 소유 증거를 별도로 검증하도록 시험을 바로잡았다. Legacy Journal 시험의 비Canonical JSON 입력은 실제 구버전 저장 형식으로 수정했다. 저장소의 Hash/identity 검증을 완화하지 않았다. 최초 4개 중단 시점을 단일 시험에 넣은 5초 timeout은 각각 독립 시험으로 분리했으며 timeout을 늘리지 않았다.

Smoke는 소유 App/Store/Audio Worker를 닫고 SIGKILL Child의 exit를 기다렸다. 정상 Registry는 비어 있고 종료 Child Registry 1개는 실제 PID·host·instance를 확인해 임시 Root 정리 전까지 보존했다. Root 정리는 cleaned=true다. 종료 후 51425·51428·51433·51437·51439·51442·51445 포트 모두 ECONNREFUSED를 확인했다(`/private/tmp/storyboard-apply-smoke-ports.json`). 프로세스 전체의 내부 handle 수가 0이라고 주장하지 않는다.

## Schema와 데이터 보존

Project Shape와 별도 Receipt 저장 파일을 추가하지 않았다. 새 Request JSON은 schemaVersion 2와 Applying/Intent를 사용하고 Journal 2는 Claim/정산/해제 전이를 검증한다. 과거 unversioned Request와 Journal 1은 실제 복구·반복 읽기에서 호환된다. 읽기만으로 과거 Request·Version 파일을 다시 쓰거나 과거 Build를 현재 값으로 채우지 않는다.

운영 `.local` 데이터와 사용자 미추적 `test-results 2/`는 미접근·미수정·미Stage다. 따라서 운영 파일 Hash 변경 수를 이번 검증 결과로 주장하지 않는다. 기존 서버 PID 89219가 실행 중인지만 읽기 전용 ps로 확인했고 종료·재시작하지 않았다. 합성 임시 저장소에서 후속 Project·Record·Asset metadata의 동등성과 Review 원본 불변을 검사했다. 자동 Text Confirm·Frame Accept·Shot Approval을 추가하지 않았다.

기준 master와 현재의 CI/Audio Stress Workflow, package/lockfile, domain media/schema/generation-records, 실제 Audio E2E, Vitest/Playwright 설정 총 10개 파일의 bytes와 SHA-256은 같았다(`/private/tmp/storyboard-apply-preserved-code.json`). App.tsx의 RAF 계산은 변경하지 않았으며 기존 실제 Audio 회귀로 검증한다. 일반 CI Retry/Timeout·Audio Stress 반복 정책을 바꾸지 않았다.

## 파일과 로컬 Commit

신규 파일은 `src/codex/apply-evidence.ts`, `src/codex/apply-schema.ts`, `src/codex/request-schema.ts`, Request/Intent JSON Schema 2개, `tests/apply-consistency.test.ts`, `tests/apply-store-worker.ts`, `scripts/apply-smoke.ts`다. 수정 경계는 기존 Request/Apply/Work/CLI/Metrics, Project 감사 Snapshot 공개, HTTP/Web 상태, Build/Schema 생성, 필수 이름 Registry·기존 Request/Metrics 시험·Runtime Smoke 및 요구된 문서 6개다. 삭제 파일은 없다. 생성 미디어·운영 데이터·임시 로그·사용자 파일은 Commit하지 않는다.

| Commit | 목적 |
|---|---|
| c22f5c3ea0f566503d04e8ecffdc16805219c788 | 실제 두 Store에서 최초 경쟁·Revision 결함 실패 선작성 |
| 74d797f2b29d449fb51e7d21a856595a3b632649 | 공통 적용 소유권·Version 증거·원래 Revision 복구·Schema·CLI/HTTP/Web |
| d50667f08e4706dfd211d4747c76551ee4212889 | 실제 IPC 경쟁·중단/재중단·Legacy·HTTP Smoke·필수 이름 |

문서 Commit은 위 검증과 현재 운영 계약을 기록한다. 문서 자체의 최종 SHA는 완료 응답과 `git log`로 확인한다. 변경은 신규 8개·수정 24개·삭제 0개, 총 32개 파일이며 추적 변경을 모두 로컬 Commit에 포함한다. 사용자 미추적 디렉터리는 그대로 남긴다.

## 원격 검증과 한계

이번 Branch의 Push·신규 PR·최종 HEAD GitHub CI·Merge는 미실행이다. 기존 PR #4/#5를 재사용하거나 master/기존 Feature Branch를 자동 병합하지 않았다. 최신 로컬 검증을 Ubuntu CI의 대체 증거로 사용하지 않는다.

보장은 로컬 macOS·Ubuntu 파일 시스템의 협력 Writer가 같은 Request의 저장 결과를 최대 한 번 적용하는 범위다. 이번 실제 실행 환경은 로컬 macOS이고, 변경 HEAD의 Ubuntu 실행은 아직 없다. 외부 모델 호출 자체의 최대 1회, SMB/NFS 분산 Writer, 비협력 파일 조작은 보장하지 않는다. Legacy의 불명 입력 동일성·모순 이력은 검토가 필요하며 추측으로 복구하지 않는다. Final Ready와 연출·시각·낭독 승인도 별개다.


이번 목표의 미반영 사항: 없다. 단일 Worker와 여러 협력 Worker의 결과 등록을 사용할 수 있고, 중단 뒤 검증된 Commit으로 정산할 수 있다. 감사의 resultRevision은 최초 도입 Version과 결속된다. 변경 HEAD의 Ubuntu CI와 코드 병합 검토는 별도 원격 작업 범위다.
