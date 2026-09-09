# PR #6 병합 후 CI 재현성 조사

## 판정과 조사 경계

조사 기준 사건은 `781d9f1478f5fbb830d7f84f3df403505520f1a2`의 CI Run `34311587985`다. 최초 timeout 원인과 원본 ENOTEMPTY의 Writer는 미확정이다. 실제 Vitest timeout 뒤 진행 중인 Project update와 Fixture 정리가 겹치는 결함, Child `stop()`이 stdio `close` 전에 반환하는 결함은 별도 통제 시험으로 확인하고 Test 코드에서 수정했다. 제품 Runtime·Schema·Apply Coordinator는 변경하지 않았다. 로컬 조사와 후속 코드 검토의 근거는 아래에 구분한다. Hosted 검증 결과는 이 변경 PR의 실제 checkout·Run·check/e2e 결과로 확인하며, 성공만으로 원본 사건의 원인이 해결됐다고 판정하지 않는다.

이번 조사에서 확인된 추가 제품 로직 결함: 없다.

최초 CI timeout의 근본 원인: 미확정.

병합 전후 기능 검증 성공, 최초 실패 재현, 정리 결함 재현·수정, Hosted CI 재검증은 서로 다른 상태다. 재실행 성공을 원인 해결로 해석하지 않는다.

## Git 및 원본 증거

- 사건 Commit·수정 Base·시작 HEAD: `781d9f1478f5fbb830d7f84f3df403505520f1a2`.
- 작업 Branch: `codex/storyboard-ci-reproducibility`. 시작 시 fetch 후 origin/master와 같은 Commit에서 생성했다.
- 초기 조사 실행 코드 검증 HEAD: `6684b308778baa9fc826a45279d2c4baade7c2b4`. 조사 문서 Commit `fc4637d` 이후 후속 검토의 코드 수정은 `8ab2942`다. RED `41c8e5f` → 정리 수정 `b5e19f7` → CI 진단 `4c2296e` → 의도적 timeout 시작 고정 `6684b30`을 Commit으로 보존했다.
- Feature HEAD: `0008a8db1f64bad77606c159d476c8cb7d933d74`. 이전 Base: `2ecb5038e3444bfeb1beeb29530492e0920f914f`.
- PR CI 실제 Checkout: `a83935eee31fb7d0dbaf47a14549849043d7090c`. 병합본과 Tree `e68f61dd766cce41410830b284d7d1acc5009922`가 같고 부모도 같다.
- 사용자 미추적 `test-results 2/`는 열거나 변경·Stage하지 않았다. 운영 데이터·Request·서버는 변경하지 않았다.
- 초기 로컬 조사에서는 GitHub 조회와 fetch만 수행했다. 이후 후속 검토·Push·PR·CI 검증을 별도로 승인받았다. PR #6 병합과 Attempt 2 재실행은 초기 조사 이전에 완료된 별도 승인 작업이다. 이번 후속 PR의 실제 병합은 포함하지 않는다.

직접 조회한 [PR #6](https://github.com/zzocojoa/storyboard-generator/pull/6)은 2026-09-09 04:35:52 UTC에 병합됐다. 원본은 Git에서 제외되는 `.local/ci-investigation/34311587985/`에 보관했다. `pr-6.json`, `merge-commit.json`, `pr-checkout.json`, Attempt별 metadata·check 로그, Attempt 2 e2e 로그, `pr-ci.log`를 각각 수집했다. 최신 Run 요약으로 첫 Attempt를 대체하지 않았다.

## 원본 Attempt별 사실

| 실행 | check | 단위·통합 | 시간 | e2e / Audio·RAF |
|---|---|---|---:|---|
| [PR CI 34309755322 / 1](https://github.com/zzocojoa/storyboard-generator/actions/runs/34309755322/attempts/1) | 성공 | 56 파일·1,187 성공 | 110.54초 | 16 / 21 성공 |
| [34311587985 / 1](https://github.com/zzocojoa/storyboard-generator/actions/runs/34311587985/attempts/1) | 실패 | 53 파일 성공·3 실패, 1,182 성공·5 실패 | 293.82초 | check 의존성으로 미실행 |
| [34311587985 / 2](https://github.com/zzocojoa/storyboard-generator/actions/runs/34311587985/attempts/2) | 성공 | 56 파일·1,187 성공 | 97.67초 | 16 / 21 성공 |

PR CI와 Attempt 2의 Required는 382, missing/duplicates/skip/only는 모두 0이다. Attempt 1은 npm test에서 중단돼 뒤의 이름 검사·Schema·웹 Build를 실행하지 않았다. Attempt 2의 e2e 16개는 24.2초, 별도 Audio·RAF 7개 × 3회는 36.5초다. 같은 실행 내 하위 명령을 별도 독립 성공으로 세지 않는다.

| Test | Attempt 1 보고 시간 | Attempt 2 보고 시간 | 최초 오류 | 추가 정리 오류 |
|---|---:|---:|---|---|
| proposed_audio_is_not_counted_as_playable | 5,062ms | unknown | Test 본문 5,000ms timeout | 보고 없음 |
| request_supersession_is_crash_recoverable | 5,018ms | 1,469ms | Test 본문 5,000ms timeout | 보고 없음 |
| later_project_edit_does_not_change_request_result_revision | 5,131ms | 999ms | Test 본문 5,000ms timeout | 보고 없음 |
| legacy_applied_record_uses_introduction_revision | 5,052ms | 412ms | Test 본문 5,000ms timeout | `.transactions/<transactionId>` rmdir ENOTEMPTY |
| legacy_terminal_record_conflict_is_not_silently_rewritten | 5,391ms | 449ms | Test 본문 5,000ms timeout | 보고 없음 |

이 시간은 Reporter가 출력한 Test duration이며 개별 단계 측정치가 아니다. 빠른 성공 시험의 개별 시간을 생략하는 Reporter 때문에 첫 행의 Attempt 2 시간은 unknown이다. 5개 실패 Test에 오류가 총 6개 보고된 것이며 실패 Test가 6개인 것은 아니다. Hook·Request Lock·Audio Worker timeout 메시지로 보고된 실패는 없다.

원본의 Fixture 생성·Store 초기화·Request 생성·Barrier 도달·복구·Assertion·Close·Root 삭제 시작/종료 시간은 unknown이다. 일부 기존 로그는 다음 사실만 보여준다.

- Attempt 1에서 later-project-edit Test 문맥의 Child kill 이벤트가 04:38:45.3825833 UTC, Request lock 대기 이벤트가 04:38:45.5014529 UTC에 기록됐다. 최종 Revision 증거 이벤트는 없다.
- 같은 Test의 Attempt 2에는 kill·lock 대기 이후 `appliedRevision=1`, `currentRevision=2`, `resultRevision=1`, 추가 Record/Asset/Revision 0, 후속 편집 보존이 기록됐다.
- request-supersession Test의 lock 대기 로그는 Attempt 1에서 두 번, Attempt 2에서 세 번 보인다. 개별 대기 종료·지연 원인은 기록되지 않았다. 이 빈도만으로 5초 Lock timeout을 판정할 수 없다.
- 실패 목록 출력 시각은 모든 시험이 끝난 뒤의 요약 시각이다. 이를 Test 시작·실패·삭제의 실제 시각으로 사용하지 않았다.

## 환경 및 지문 비교

| 항목 | PR CI | Attempt 1 | Attempt 2 | 로컬 재현 |
|---|---|---|---|---|
| OS | Ubuntu 24.04.4 | Ubuntu 24.04.4 | **Ubuntu 24.04.5** | macOS / Darwin 24.6.0 arm64 |
| Runner 이미지 | 20260831.293.1 | 20260831.293.1 | **20260907.300.1** | 해당 없음 |
| Runner Agent | 2.337.0 | 2.337.0 | 2.337.0 | 해당 없음 |
| Node | 24.20.0 | 24.20.0 | 24.20.0 | 24.6.0 |
| npm | 11.19.0 | 11.19.0 | 11.19.0 | 11.5.1 |
| Vitest | 5.0.0 | 5.0.0 | 5.0.0 | 설치본·lockfile 5.0.0 |
| 일반 Worker / timeout / Retry | 2 / 5,000ms / 0 | 동일 | 동일 | 동일 |
| Host 부하·디스크 지연·fsync별 소요 시간 | unknown | unknown | unknown | 미계측 |

Attempt 2는 같은 Ubuntu 이미지 버전이 아니다. PR CI와 Attempt 1은 이미지 버전이 같아도 서로 다른 실행이다. 이미지 버전만으로 실제 Host I/O 조건이 같거나 달랐던 원인을 증명할 수 없다. 로컬 Linux Container·새 Hosted CI 재현은 수행하지 않았다. 로컬 Docker daemon은 확인했지만 관련 Node/Ubuntu 이미지가 설치돼 있지 않았고, 이번 유한 재현은 macOS에서 수행했다.

다음 SHA-256은 Git 객체의 실제 바이트를 읽어 계산했으며 세 원본 CI의 Tree 동일성으로 대조했다. 전체 값은 `environment-comparison.json`에도 보관한다.

| 대상 | PR CI·Attempt 1·2 공통 SHA-256 |
|---|---|
| `.github/workflows/ci.yml` | `2299923464960ac3d680c40017d235ce3fdaa9dd50acd9f70c60d61e6983c399` |
| `package-lock.json` | `9c91a0fca545341fa56c55e517b290115042ce14605f6341c188c182b368ac77` |
| `vitest.config.ts` | `fd84d4336f8845769f6b53d7368755e3c561c981eb8e0a9b817284196d1e50d6` |
| Source Tree | `8d4c2fdf08546b9ba43f88bba8beeb385a9fa0faaf2cfbf7d451425d4ae5b4c9` |
| Generation Contract | `ae75aa3c0654337d0e4e0e00f398f5b26e5cc5248ed6ee20a8df0da16596664f` |
| Runtime Config | `fa910c7c36f2db35cf13eb8586604fc5263ae5bcc89a7087a092878026ff52a8` |

수정 후에도 제품 Source·Generation Contract·Runtime Config 지문과 lockfile은 같다. Workflow·Vitest 설정의 진단 항목은 변경됐다. Source 지문이 같다는 사실을 Test/Workflow까지 같다는 뜻으로 사용하지 않는다.

## 가설 및 인과 판단

| 가설 | 관찰·실험 | 판단 |
|---|---|---|
| Runner I/O·fsync 경합이 최초 timeout을 만들었다 | Attempt 1에서 저장 중심 Suite가 느리지만 fsync/Host 계측이 없다. 로컬 원본 시험은 timeout 미재현 | 미확정 |
| 일반 Worker 2가 원인이다 | Worker 2의 유한 로컬 실행은 통과. Worker 1 비교는 최초 timeout이 미재현돼 수행하지 않음 | 미확정; 병렬 설정 변경 근거 없음 |
| Request Lock의 자체 5초 제한이 터졌다 | 원본은 `Test timed out`이다. 자체 실패 코드는 `CODEX_REQUEST_STORE_BUSY`이며 성공 Attempt에도 대기 로그가 있다 | 최초 오류 유형으로는 지지하지 않음; 전체 지연 기여는 unknown |
| Child 시작·IPC·종료가 최초 지연을 만들었다 | 일부 kill/대기만 기록됨. `stop()`의 close 이전 반환은 별도 결정적 시험에서 확인 | 최초 지연은 미확정; Helper 종료 계약 결함은 확인 |
| timeout 후 본문·Writer와 정리가 겹친다 | 설치 Vitest 계약과 실제 Project update Barrier를 둔 별도 Vitest Child에서 확인 | Test 정리 결함 확인·수정 |
| 그 Writer가 원본 ENOTEMPTY를 만들었다 | 원본 잔존 파일·Writer PID·삭제 중 신규 파일·원래 Promise 종료 로그가 없음 | **미확정** |
| Heartbeat가 원본 Root 삭제 후 다시 썼다 | Store.close는 공유 Timer를 제거하고 알려진 in-flight heartbeat를 기다린다. 원본의 실제 Timer 상태는 없음 | 미확정; 알려진 heartbeat 종료 경계는 회귀 확인 |
| Mock 복원·전역 배열이 다음 Test와 섞일 수 있다 | 이전 코드는 본문 정산 전 Mock 복원과 공유 배열 splice를 수행함 | Test별 소유 Scope·정산 뒤 복원으로 경계 수정; 원본 연쇄 발생 여부는 unknown |

저장 중심 Suite의 PR/Attempt 1/Attempt 2 시간(ms)은 apply `36,709 / 109,290 / 30,457`, request transaction `9,954 / 27,445 / 11,246`, media workflow `8,350 / 32,573 / 8,510`, storage safety `14,592 / 59,037 / 12,406`이다. 모든 시험이 같은 비율로 느려졌다고 주장하지 않는다. 낮은 계산 비용의 Suite까지 포함한 전체 시간 비율은 I/O 지연의 직접 계측이 아니다.

## 설치 코드 계약과 통제된 재현

설치된 Vitest 5의 `dist/chunks/run.CQOUYP-x.js`에서 `withTimeout`, `abortIfTimeout`, `runTest`, `afterEach` 호출을 읽었다. 5초 제한은 `dist/chunks/index.B89dZ0-N.js`의 기본값이다. Timeout은 Wrapper를 reject하고 Test Context의 AbortSignal을 발생시킨다. 원래 비동기 함수 Promise의 종료를 기다리지 않은 채 Hook으로 진행한다.

ProjectStore.close는 공유 Heartbeat 참조·Timer·알려진 in-flight heartbeat와 Process registry를 정리한다. 이미 시작한 create/update Promise의 정산 API는 아니다. 기존 테스트는 그 차이를 처리하지 않았다. 제품 서버의 종료 순서와 Test Hook을 같은 것으로 취급하지 않았으며 Store.close 제품 계약을 변경하지 않았다.

Node 설치본의 recursive rm 구현은 디렉터리 항목을 읽고 하위 삭제를 끝낸 뒤 rmdir한다. 그 사이 작성이 생기면 ENOTEMPTY가 가능하지만, 원본 CI의 신규 파일이나 작성자는 증명되지 않았다. 이 가능성만으로 원인을 확정하지 않았다.

RED `41c8e5f`의 부모 회귀는 별도 Vitest Child에서 의도적 250ms timeout을 실행하고 Writer settle가 Store close보다 먼저인지 검사한다. 기존 순서에서는 `7 < 4` Assertion이 실패했다. 별도 원본 이벤트 확보 실행의 순서는 다음과 같다. 값은 해당 Child Process 내부 monotonic elapsed(ms)이며 다른 Process와 직접 비교하지 않는다.

| 단계 | 기존 정리 | 동일 Fixture·Barrier의 수정 후 |
|---|---:|---:|
| Test 시작 | 280.881 | 454.762 |
| Journal 준비·Writer Barrier | 387.085 | 581.012 |
| Vitest timeout 신호 | 536.317 | 709.985 |
| Store close 시작 / 끝 | 537.379 / 546.981 | 903.199 / 908.706 |
| Root 삭제 시작 | 547.248 | 908.991 |
| update Promise settle | **555.755, 삭제 시작 뒤** | **902.687, Close·삭제 전** |
| Writer 또는 삭제 rejection 관찰 | 556.333 | 없음 |
| 최종 Root 삭제 종료 | 556.515 | 911.651 |

기존 관찰용 Child는 모든 결과를 정산한 뒤 전용 Root를 정리했다. 로그의 rejection 구분은 Writer/삭제를 합친 관찰값이므로 이를 ENOTEMPTY 재현으로 보고하지 않는다. 원본 실패를 해소하는 코드로 rm 재시도나 sleep을 추가한 것은 아니다.

현재 회귀는 Fixture 준비 지연이 의도적 timeout으로 오인되지 않도록 Journal Barrier에 도달한 뒤 Test 본문을 시작한다. Barrier 자체와 250ms timeout, 부모의 순서·실패 종류 검사는 유지했다. 일반 Test glob에서 제외한 `writer.fixture.ts`만 Child 설정으로 실행한다. 부모는 Exit 1, 실패 Test 1개, 오류 메시지 **정확히 1개인 의도적 timeout**, Unhandled/Uncaught 오류 부재와 정리 순서를 검사한다. Child가 다른 이유로 실패하면 부모도 실패한다. Child Process 전체 제한은 4초이며 Thread Pool을 사용해 부모의 제한 종료가 별도 Test Process를 남기지 않게 한다.

별도 `controlled_process_stop_waits_for_stdio_close` 회귀는 기존 helper의 stop 직후 `close=false`로 실패했다. 수정 후 stop은 실제 `close`와 남은 stdio 종료를 기다리며, 확인하지 못하면 제한된 시간 안에 오류를 반환한다.

## 실제 수정

- `tests/owned-test-scope.ts`, `tests/owned-test.ts`: Test별 Root·본문·상위 및 중첩 비동기 작업·Child·App·Worker owner·Store를 추적한다. 새 Test 호출은 종료 뒤 거부한다. 이미 시작한 Apply/HTTP/Transaction 내부 호출은 완료하도록 두고 각 작업의 실제 settle를 기다린다. 종료된 Operation의 비동기 문맥은 새 호출 권한을 유지하지 않는다.
- `apply-consistency`, `request-store-transaction`, `media-workflow-regression`: 공유 배열과 조기 afterEach 삭제를 소유 Scope로 교체했다. 기존 Test 본문 판단·Assertion·장애 지점은 유지했다. 직접 Fixture 파일 작업도 Scope를 사용한다. 설정된 로컬 Audio Normalizer는 소유 자원으로 닫는다.
- 정리는 Barrier 해제 → 소유 Child close → 본문·진행 작업 정산 → App/Worker/Store 종료 → Root 삭제 순서다. App 종료 Hook의 Store 종료 같은 소유 의존 호출은 허용한다. Mock은 정산 뒤 복원한다.
- 정산 제한은 일반 Scope 4초다. 미종료 Writer가 있으면 Store·Root를 보존하고 오류를 보고한다. 같은 Worker Process의 다음 Fixture는 시작하지 않는다. 각 독립 종료 실패를 모으며 최초 Vitest 오류를 성공으로 바꾸지 않는다. 삭제 retry·timeout 상향·Worker 감소·자동 Test retry를 넣지 않았다.
- `tests/controlled-process.ts`: exit 이후 stdio close까지 기다린다. Child close 제한은 2초이며 소유 Child에만 SIGKILL을 사용한다.
- 초기 7개와 후속 검토 2개, 총 9개 핵심 회귀를 Required에 등록했다. 성공 횟수를 고유 검증 수로 과장하지 않는다. 152개 기존 Test를 분할하거나 Assertion을 줄이지 않았다.
- 제품 `src/`, package.json, lockfile, Schema, 제작 Skill, AGENTS와 Audio Stress Workflow는 변경하지 않았다.

## 재현 횟수와 검증 기록

원본 기본 전체 실행은 최대 3회 중 2회, 원본 3개 파일은 최대 5회 중 2회로 끝냈다. 실행 성공까지 무한 반복하지 않았다. Worker 1/2 비교는 실행하지 않았다. 최초 timeout이 재현되지 않은 macOS에서 Worker 수 비교만 추가해도 원래 Ubuntu Host 지연과의 인과를 구분할 수 없기 때문이다. 결정적 정리 결함은 별도 Barrier로 검증했다.

| 조건 | 코드 기준 | 반복 | 결과 | 시간·근거 |
|---|---|---:|---|---|
| 원본 전체, 잘못된 TMPDIR 조건 | 781d9f1 | 1 | 1,183 성공·4 실패, timeout 없음 | 224.72초; baseline-full-1.log |
| 원본 전체, 저장소 밖 TMPDIR | 781d9f1 | 1 | 1,187 성공 | 191.25초; baseline-full-2.log |
| 원본 3개 파일 | 사건 당시 파일 그대로 | 2 | 매회 152 성공 | 52.73 / 54.54초; baseline-targeted-1/2.log |
| 수정 3개 파일, 진단 OFF | b5e19f7에 포함한 변경 | 1 | 152 성공 | 53.43초; fixed-targeted-1.log |
| 원래 Writer 순서 회귀 | 41c8e5f | 1 | 예상 RED | controlled-red.log |
| 원래 순서 이벤트 보관 | 동일 관찰 Fixture | 1 | 예상 Child timeout·정리 겹침 | controlled-red-events.jsonl |
| Scope·Child close 회귀 최초 | 수정 Scope·기존 Child helper | 1 | 5 성공·1 RED | scope-regression-first.log |
| 수정 정리 회귀 | 최종 수정 과정 | 3 | 매회 7 성공 | green-1/2/3; 1.67 / 1.82 / 1.69초 |
| Journal 도달 뒤 timeout 시작 | 6684b30 | 1 | 1 성공 | controlled-barrier-final.log; 2.02초 |
| npm run typecheck | 수정 코드 | 1 | 성공 | final-typecheck.log |
| npm run typecheck:web | 수정 코드 | 1 | 성공 | final-typecheck-web.log |
| npm run test:names | 수정 코드 | 1 | Required 389, 네 오류 수 0 | final-test-names.log |
| npm run schemas:check | 수정 코드 | 1 | 성공 | final-schemas-check.log |
| npm run build:web | 4c2296e + Probe 준비 보강 | 1 | 성공 | final-build-web.log |
| npm test, 진단 OFF | fd26727; 이후 Workflow 환경 항목·Probe 시작 시점만 보강 | 1 | 58 파일·1,194 성공 | 194.55초; final-npm-test.log |
| npm run check, 진단 ON | 6684b30 | 1 | 58 파일·1,194 성공, Required 389·네 오류 수 0 | 210.62초; final-check.log |
| npm run check:e2e | 6684b30 | 1 | 16 성공 | 27.0초; final-check-e2e.log |
| 실제 Audio·RAF 3회 | 6684b30 | 3 | 고유 7개, 실행 21개 성공 | 40.9초; final-audio-raf.log |
| npm run smoke | 6684b30 | 1 | 69 검사 성공·동적 포트 7개 | final-smoke.log; cleaned=true |
| git diff --check | 최종 문서 포함 | 1 | 성공 | 공백 오류 없음 |

첫 전체 실행의 임시 Root를 저장소 아래로 지정해 Git 부재 Fixture가 상위 저장소를 발견했다. 그 4건은 조사 실행 조건 오류이며 원본 CI timeout과 다르다. 코드나 기대값을 바꾸지 않고 다음 실행부터 저장소 밖 독립 Root를 사용했다. Raw 로그와 실패 결과는 보존했다. 별도 관찰 Child를 로그 경로 없이 호출한 1건도 설정 오류로 남겼고 재현 성공·실패 통계에 넣지 않았다. 컴파일 중간 확인은 최종 검증 반복 수로 세지 않았다.

## 재발 시 진단 경로

### 후속 코드 검토의 확인 사항

`fc4637d`에서 16개 변경 파일과 실제 호출 경계를 검토했다. 다음 두 경계는 실제 파일 쓰기 회귀를 먼저 실패시킨 뒤 `8ab2942`에서 수정했다.

| 경계 | 수정 전 실패 | 수정 후 계약 |
|---|---|---|
| 부모보다 오래 실행되는 중첩 Writer | `store-close`가 `writer-settled`보다 먼저 발생 | 중첩 Promise도 개별 추적하고 모두 정산한 뒤 Store 종료 |
| 이미 끝난 Operation의 비동기 문맥 | Root 정리 뒤 새 쓰기가 성공하고 디렉터리를 다시 생성 | Operation의 실행 상태를 확인해 `OWNED_TEST_STOPPED`로 거부 |

timeout Probe의 Assertion·JSON 검사가 실패하기 전에 Child의 `process-result.json`(stderr 포함), `events.jsonl`, `result.json`을 삭제 Root 밖에 복사한다. 별도 복제 Probe에서 오류 개수 Assertion을 의도적으로 실패시켰으며 원본 Child Exit 1·250ms timeout·9개 이벤트·JSON 보고서가 남는 것을 확인했다. 이 실패는 제품 회귀나 원본 사건 재현으로 세지 않는다.

`actions/upload-artifact@v4`는 기본적으로 숨김 경로를 제외하므로 지정된 `.build/build-manifest.json`을 포함하도록 `include-hidden-files: true`를 명시한다. 업로드 경로는 전용 진단 디렉터리와 이 manifest 파일로 한정한다. [Action의 숨김 파일 계약](https://github.com/actions/upload-artifact/tree/v4#uploading-hidden-files)을 대조하고 YAML 파싱·옵션·check → e2e 의존성을 확인했다. 실제 실패 업로드는 실패한 Hosted Run의 Artifact가 있어야 검증 완료로 판단한다.

후속 로컬 증거는 Git에서 제외된 조사 디렉터리의 `review/`에 보관한다.

| 검증 | 결과 |
|---|---|
| 두 신규 회귀의 수정 전 실행 | 2개 예상 실패 (`nested-red.log`) |
| Scope·timeout 회귀 | 9개 성공, 1.76초 |
| 세 기존 Suite와 회귀, 진단 ON | 5개 파일·161개 성공, 59.82초 |
| `npm run check`, 코드 `8ab2942`, 진단 ON | 58개 파일 중 57개 성공·1개 실패, Test 1,195개 성공·1개 실패, 209.78초 |
| 위 단일 실패 원인 | `audio_diagnostics_do_not_log_media_bytes`의 로컬 listen EPERM; 샌드박스 포트 권한 제한 |
| 허용된 실행 환경에서 해당 파일 재검증 | 12개 모두 성공, 0.717초; 코드 변경 없음 |
| TypeScript·Web TypeScript | 성공; 위 check가 npm test 전에 실행 |
| 중단된 후속 검사 | Required 391·missing/duplicates/skip/only 0, Schema 일치, Web Build 성공 |

전체 check 명령이 로컬에서 성공했다고 합쳐 보고하지 않는다. 같은 코드의 GitHub check는 별도 결과다. 후속 대상 152개 Scope의 진단은 3,520개 이벤트이며 Root 82개가 진행 작업·등록 자원 0에서 삭제됐다. 해당 Scope의 취소·정리 실패·Root 보존 이벤트는 없다. 원본 사건의 timeout 원인과 ENOTEMPTY Writer는 여전히 미확정이다.

### 실행 및 수집 계약

일반 로컬 실행의 계측은 꺼져 있다. 선택한 실행에만 `STORYBOARD_TEST_RUN_ID`, 삭제 Root 밖 절대경로인 `STORYBOARD_TEST_DIAGNOSTICS_DIR`을 지정한다. Vitest JSON에는 빠른 성공을 포함한 시험별 duration과 실패 메시지가 남는다. 세 대상 파일의 lifecycle JSONL은 Test·Fixture·Operation·PID·Worker ID·단계·monotonic 시간·오류 코드를 기록한다. `resourceCount`는 등록된 소유 핸들 수이며 살아 있는 OS Process/Thread 수를 뜻하지 않는다. 측정하지 않은 Timer 수는 null이다. 실제 제작 원문·Prompt·미디어 bytes·전체 환경변수는 추가하지 않았다.

```sh
STORYBOARD_TEST_RUN_ID=local-storage-investigation \
STORYBOARD_TEST_DIAGNOSTICS_DIR="$PWD/.local/ci-investigation/manual-run-1" \
npm test -- tests/apply-consistency.test.ts tests/request-store-transaction.test.ts tests/media-workflow-regression.test.ts
```

새 실행마다 별도 진단 디렉터리를 지정하고 Git에서 제외되는지 확인한다. TMPDIR을 바꾼다면 저장소 밖에 별도로 만든 전용 Root를 사용한다. 같은 출력 디렉터리의 JSON 보고서를 덮어쓰며 성공 횟수를 누적하지 않는다. 계측 ON의 파일 I/O 비용과 관찰 영향을 OFF 결과와 구분한다.

CI는 기존 check 명령·실패 Exit·check → e2e 의존성을 유지한다. 선택적 계측을 check에 켜고 실패 시 Run ID·Attempt·SHA가 포함된 Artifact에 JSON·lifecycle·Checkout·설정 Hash·Node/npm·Runner 이미지·Build 지문을 수집한다. 업로드는 별도 Step이며 수집 실패가 Test 성공으로 바뀌지 않는다. continue-on-error, 자동 rerun, schedule, Audio Stress 변경은 없다. Hosted 성공 경로와 실패 Artifact 업로드의 검증 여부는 구분한다.

## 자원 및 잔여 사항

운영 서버 PID 89219는 변경하지 않았다. 별도 시험은 포트 0 또는 HTTP inject를 사용한다. 종료된 조사 실행에 대해 관련 apply/request/Vitest Child가 남아 있지 않은 것을 Process snapshot으로 확인했다. 검사하지 않은 사용자 Process·OS 전체 Timer·Host I/O 상태를 0으로 보고하지 않는다.

진단 ON의 최종 check에서는 대상 Test Scope 152개·이벤트 3,098개를 확인했다. 등록 Child 핸들 58개, App 18개, Worker owner 39개, Store 79개가 Close를 마쳤고 Root 82개는 진행 Operation 및 등록 자원 수가 0인 상태에서 삭제됐다. 이 세 파일의 진단에는 timeout·cleanup-failed·root-preserved 이벤트가 없다. 다른 Suite나 OS 전체의 미계측 자원 수로 확대하지 않는다. Smoke는 실제 중단 Child 1개의 종료(ESRCH), 남은 registry의 소유자, 전체 Root 정리를 검증했다.

각 독립 TMPDIR의 잔존 이름과 종료 상태는 `experiment-results.json`에 보관한다. 원본 전체 시험에는 export-io의 정리 Hook 없는 두 임시 Root와 Node/tsx/Vite 캐시가 남는다. 첫 잘못된 TMPDIR 실행에는 추가 디렉터리가 남았으며 정확한 재생성 주체는 unknown이다. 이는 원본 Ubuntu 사건의 Writer 증거가 아니다. 해당 실행 Process 종료와 경로를 확인한 뒤 조사 소유 Root만 정리했다. `root-cleanup.json`의 독립 상위 Root 10개는 모두 삭제 후 부재까지 확인했다. 안전한 종료를 확인하지 못해 최종 보존한 Test Root는 없다. 원본 로그·진단 JSON 등 감사 자료는 조사 디렉터리에 유지했다. 제한 실패 회귀가 의도적으로 보존한 Root는 Barrier를 풀고 본문 종료를 확인한 뒤 부모 시험에서 정리한다.

이번 범위에서 재현한 Writer 정리 순서 및 Child close 결함의 미수정 항목은 없다. 대상 밖 export-io의 두 임시 Root 자체 정리 부재는 제품 결함이나 최초 timeout의 원인으로 분류하지 않고, 조사 실행 종료 후 상위 Root에서 정리했다. 잔여 판단은 최초 I/O·Process·Lock 지연의 원인, 원본 ENOTEMPTY 당시 잔존 파일과 Writer 소유자, Hosted 환경에서의 수정 검증이다. 재발 시 첫 `test-aborted` 이벤트의 진행 Operation과 `cleanup-start`/`operation-settled`/`root-remove-start` 순서를 먼저 대조한다. 그 증거에서 지연 위치가 좁혀진 경우에만 해당 경계의 fsync·IPC 시간을 추가 측정한다. 기능 확장이나 저장 시스템 재설계는 이 조사 결과에서 제안하지 않는다.

## PR #7 후속 timeout 단계 조사

이 절은 위 원본 사건과 별개인 [PR #7](https://github.com/zzocojoa/storyboard-generator/pull/7)의 후속 조사다. 작업 시작 Branch는 `codex/storyboard-ci-reproducibility`, 로컬·원격 Head는 `a853449f6118a93cbd46f15171242d2744270416`, PR Base는 `781d9f1478f5fbb830d7f84f3df403505520f1a2`였다. PR은 OPEN·미병합이었다. 이번 실행 코드 Commit은 `71de79f9353873004e20404e79338c91f38e23fe`다. 이후 문서 변경은 실행 코드와 구분한다.

timeout 이후 진행 중 작업과 임시 Root 삭제가 경합하지 않도록 정리 계약을 보강했다. 원본 ENOTEMPTY의 실제 Writer와 최초 timeout 원인은 미확정이다.

### 사건과 비교 기준

| 사건 | 실제 checkout / 최초 오류 | 결과 및 관찰 한계 |
|---|---|---|
| 원본 34311587985 / 1 | `781d9f1`, 앞 절의 5개 Test 본문 timeout | 1,182 성공·5 실패·오류 6개. ENOTEMPTY Writer와 최초 지연의 단계 시간 미확정 |
| [PR #7 34319353256 / 1](https://github.com/zzocojoa/storyboard-generator/actions/runs/34319353256/attempts/1) | `2b684eaa4f56e8cd0b9031aa465a9dbfe5adc102`, 아래 두 Test 본문 5,000ms timeout | 1,194 성공·2 실패·오류 3개, 260.41초. E2E·Audio 미실행 |
| [PR #7 34319353256 / 2](https://github.com/zzocojoa/storyboard-generator/actions/runs/34319353256/attempts/2) | 같은 checkout, 최초 오류 없음 | 1,196 성공, 111.58초. E2E 16개 24.4초, 별도 Audio/RAF 7개 × 3회 21개 38.8초. 성공 lifecycle은 당시 업로드하지 않음 |

실패 대상은 원본 check 로그와 Artifact의 Vitest JSON에서 직접 확인한 `apply_recovery_lock_order_does_not_deadlock`, `apply_claim_is_shared_by_proposal_image_and_speech`다. `review_bundle_source_project_remains_unchanged_during_race`, `codex_generation_records_remain_append_only`를 이 Run의 실패로 기록한 이전 대화 내용은 잘못된 것이다.

복구 Test에는 timeout 뒤 Child `event=paused` 대기 실패가 추가로 보고됐다. Lifecycle상 timeout 취소 → 소유 Child 종료 → 대기 rejection 순서다. 이 후속 오류를 최초 Child 장애나 내부 Lock timeout으로 분류하지 않는다. 연쇄 적용 Test의 최초 오류는 본문 timeout 하나이며 Hook timeout·ENOTEMPTY는 보고되지 않았다. 최종 Reporter 요약 시각을 실제 Test 시작 시각으로 사용하지 않았다.

PR #7 두 Attempt의 checkout 부모는 위 Base와 `a853449`이며 Tree는 `674574da00c8a5941a98839405d8a853e3cb300c`다. 두 Attempt 모두 Ubuntu 24.04.4, 이미지 `20260831.293.1`, Node 24.20.0, npm 11.19.0, Vitest 5.0.0이다. 원본 사건의 Attempt 2 이미지 변경과 혼합하지 않는다. 당시 실제 Host 부하·디스크 지연·fsync 시간은 unknown이다.

[실패 Artifact 10091384713](https://github.com/zzocojoa/storyboard-generator/actions/runs/34319353256/artifacts/10091384713)을 실제 다운로드해 checkout·환경·설정 Hash·Vitest JSON·lifecycle·timeout Probe 원본·숨김 Build manifest를 확인했다. Build의 checkout·Source/Generation/Runtime 지문도 대조했다. ZIP digest는 `bf7d09cec66cab47ddbf419f57c525951c19d662e3c570b3dfda16454809da05`다. 실패 Artifact 업로드 설정의 존재와 실제 검증을 구분한다.

### 유한 실험 계획과 측정 환경

새 실행 전에 `.local/ci-investigation/pr-7-followup/experiment-plan.json`에 기존 Attempt 비교 → 현재 코드의 두 Test 기준 실행 1회 → 필요할 때만 동일 조건 비교 최대 1회 → 수정의 RED/GREEN → 관련 Suite → check → E2E → 실제 Audio 반복 순서를 기록했다. 변경 없는 추가 비교는 필요하지 않아 실행하지 않았다. 원본 Run을 다시 실행하지 않았고 자동 Retry를 추가하지 않았다.

새 로컬 환경은 macOS 15.7.3 / Darwin 24.6.0 arm64, Node 24.6.0, npm 11.5.1, Vitest 5.0.0이다. 일반 timeout 5,000ms·Worker 2·retry 0을 유지했다. 설치 Vitest의 `resolved.testTimeout ??= ... : 5e3`와 실제 설정을 대조했다. E2E의 기존 Worker 1·retry 0도 유지했다. 기준 실행은 두 Test만 선택했으므로 동시에 두 파일을 실행한 전체 check와 같은 부하 조건은 아니다.

각 실행의 `environment.json`·`result.json`에는 실제 SHA, dirty 상태, 명령, 시작·종료, OS·Node/npm/Vitest, Workflow·lockfile·Vitest 및 Test 파일 Hash, Process Group 종료와 임시 Root 정리를 기록했다. 사용자 미추적 파일 때문에 시작부터 worktreeDirty는 true이며 generationInputsDirty는 false다. 조사 Root는 저장소 밖 `/private/tmp/storyboard-pr7-followup-*`, 로그는 삭제 Root 밖 조사 디렉터리다. 원본 증거 177개 파일의 SHA-256을 별도로 보존해 변경 여부를 대조한다. Host·fsync 미계측 값을 0으로 기록하지 않는다.

### 지연 구간

아래 값은 해당 부모 Process 내부의 단조 시계 차이(ms)다. `≈`는 기존 범용 Operation 이벤트와 호출 순서로 묶은 구간이며 새 의미 단계 계측과 구분한다. 서로 다른 Process의 단조 시각을 빼지 않았다. Attempt 2의 성공 단계 기록은 없으므로 전체 Test 시간(복구 1,816ms, 연쇄 적용 1,049ms)만 비교 가능하다.

| Test / 단계 | PR #7 Attempt 1 | 로컬 기준 실행 | 수정 후 관련 Suite | 판단 |
|---|---:|---:|---:|---|
| 복구: Store.create | 1,888.37 | 272.47 | 230.02 | Fixture 준비 지연 관찰; 내부 fsync 시간 아님 |
| 복구: 초기 이미지 Request.create | 530.88 | 94.10 | 73.44 | 중단시킬 실제 Apply에 필요한 요청, 유지 |
| 복구: Apply Child start→중단 Barrier | 1,739.32 | 439.87 | 387.39 | Child 작업·IPC·Lock을 포함한 부모 관찰 시간 |
| 복구: committedCrash 전체 준비 | ≈4,413 | ≈1,202 | 1,015.48 | 첫 실패는 복구 Child 생성 전에 대부분의 예산을 사용 |
| 복구: 복구 Child ready | ≈225 | ≈278 | 280.91 | PID로 Child 이벤트와 연결 |
| 복구: reconciliation Barrier 대기 | 366.05에서 timeout; 423.15 뒤 종료 오류 | 105.58 | 104.75 | 실패 시 Barrier 미도달, deadlock 증명 아님 |
| 복구: 소유 중 Project 편집 | 미실행 | 실행됨 | 186.09 | 후속 편집 보존 Assertion 유지 |
| 복구: release→결과·exit | 미실행 | 실행됨 | 121.93 | stdio close는 별도 소유 정리에서 대기 |
| 복구: 원래 resultRevision·편집 검사 | 미실행 | 실행됨 | 25.08 | 원래 resultRevision=1, 이후 Project 일치 확인 |
| 연쇄: Store.create | 862.50 | 293.09 | 310.34 | 상위 저장 API 시간 |
| 연쇄: 사용하지 않는 초기 이미지 요청 | 406.79 | 73.32 | 제거됨 | 추가 Request가 존재하는 RED 확인 뒤 제거 |
| 연쇄: proposal 요청 / 적용 | 118.51 / 1,541.85 | 71.02 / 417.09 | 69.14 / 344.40 | 실제 저장·Revision 전이 유지 |
| 연쇄: image 요청 / 적용 | 409.05 / 1,227.98 | 95.61 / 403.38 | 65.85 / 412.75 | 같은 Project의 다음 Revision |
| 연쇄: speech 입력 / 요청 | 0.24 / 496.61 | 실행됨 / 74.25 | 0.70 / 74.80 | 첫 실패는 요청 생성 중 5초 초과 |
| 연쇄: speech 적용 | 미실행 | 437.39 | 471.16 | 실제 WAV 검사·저장 포함 |
| 연쇄: 각 Request·Receipt 검사 | 미실행 | 실행됨 | 39.74 / 39.31 / 34.44 | kind·requestId·startRevision·committedRevision 유지 |
| 연쇄: proposal / speech replay | 미실행 | 57.16 / 59.39 | 60.33 / 55.92 | 동일 Project, Record 3개·Asset 2개 유지 |

연쇄 Test의 PCM 입력은 이미 프로젝트 형식인 48kHz·PCM16이다. `inspectAudioBytes`의 실제 소스와 계측에서 `normalizer.normalize` 호출이 없음을 확인했다. 따라서 이 경로의 Worker 변환은 미실행이며 WAV 검사·복사 시간은 speech 적용 안에 포함돼 별도로 측정하지 않았다. 이를 Worker 변환 성능 검증으로 보고하지 않는다. 필요할 때 호출되는 `chain.speech-normalization.normalize` 경계는 같은 Scope에서 관찰하도록 연결했다.

첫 복구 Test의 timeout은 5,004.19ms, 본문 settle는 5,061.35ms, Child close는 5,061.45ms, 마지막 Store close는 5,112.83ms, Root 삭제 시작은 5,112.91ms다. 연쇄 Test는 5,001.03ms timeout 뒤 진행 중 Request가 5,069.23ms에 정산되고 Root 삭제는 5,071.40ms에 시작했다. 두 실패를 포함한 152개 Scope의 Root 82개 모두 진행 Operation·등록 자원 0에서 삭제됐다. 정리 안전성의 증거이며 최초 지연 원인 해결의 증거는 아니다.

| 가설 | 분류 | 결론 |
|---|---|---|
| 여러 저장·Child 단계의 누적 비용이 5초를 초과 | 관찰됨 | 실패 지점을 위 표까지 좁힘; Host/파일 시스템 내부 원인은 미확정 |
| 연쇄 Fixture의 최초 이미지 요청이 검증에 필요 | 반증됨 | 삭제 전 요청 목록이 1개여서 RED, 삭제 후 전체 연쇄·Receipt·replay 검사 통과 |
| 불필요한 요청을 만들지 않는 Fixture 계약 | 통제 실험으로 확인됨 | 새 빈 Request 목록 Assertion의 RED/GREEN. timeout 제거의 인과 실험은 아님 |
| 미등록 Audio Normalizer가 첫 두 timeout을 유발 | 미확정, 근거 없음 | 첫 실패는 speech 적용 전이며 기존 PCM 입력은 Worker 변환을 호출하지 않음 |
| Runner I/O·fsync 또는 Lock 자체 timeout이 근본 원인 | 미확정 | 상위 API 시간과 본문 timeout만으로 확정하지 않음 |
| Test 분할·추가 제품 로직 수정이 필요 | 조건 불충족으로 수정 불필요 | 같은 Project 연쇄와 복구 소유 중 편집 시나리오 유지 |

### G1–G5 처리와 변경 계약

| 항목 | 기반영 여부 | 이번 처리 | 검증·남은 사항 |
|---|---|---|---|
| G1 사건·기준 고정 | 과거 Run 원본 보존 기반영 | Run/Attempt/checkout/정확한 Test 목록·오류 순서를 분리 | 원본 로그·Vitest JSON·Build·부모 Commit 직접 대조 |
| G2 지연 구간 | Store·Request·Child 범용 계측 기반영 | 두 Test의 의미 단계 시작·종료·실패, Child PID 연결, 성공 진단 보존 | 성공 Attempt 2의 과거 단계는 복원 불가; Host·fsync 미계측 |
| G3 증거 기반 개선 | Scope 정산·close 기반영 | 불필요 요청 제거, Test 소유 Normalizer 한 개 재사용·종료 확인 | 제품 결함 증거 없어 src·Coordinator·Schema 변경 없음 |
| G4 계약 보존 | 취소·Writer·Root·stdio close·Probe 회귀 기반영 | phase 관찰이 Transaction 권한을 만들지 않음을 기존 취소·중첩 Writer 회귀에 연결 | 일반 제한·격리·Assertion·실제 저장·필수 이름 유지 |
| G5 결과와 원인 구분 | 원본 원인 미확정 명시 기반영 | 새 로컬/원격 결과와 조사 한계를 이 절·PR 본문에서 구분 | 통과를 간헐 실패 완전 해결로 표현하지 않음 |

| 파일 | 변경 이유 / 보존한 계약 | 회귀 근거 |
|---|---|---|
| `tests/apply-consistency.test.ts` | Project Fixture와 이미지 요청 Fixture 분리, 두 Test의 단계 구분, Normalizer 소유 종료. 같은 Project의 proposal→image→speech·Revision·Apply Intent·Receipt·replay·Record/Asset 검사 보존 | 두 우선 Test, 초기 요청 목록 RED/GREEN, 관련 Apply Suite |
| `tests/owned-test-scope.ts` | `phase`는 관찰만 하며 진행 작업의 ALS 권한·정산 순서를 변경하지 않음 | 취소 후 새 쓰기 차단, 중첩 Writer 정산 |
| `tests/owned-test-scope.test.ts` | 기존 결정적 회귀를 계측 Wrapper 안에서도 실행. 테스트 수·기존 Assertion 유지 | 정리 8개 + 실제 timeout Probe 1개 |
| `tests/owned-test.ts` | Child Operation 이름에 PID 연결. 종료 구현 변경 없음 | 실제 close 회귀와 Apply Child 시험 |
| `.github/workflows/ci.yml` | 기존 진단·Build를 성공과 실패 모두 보존. check stdout/stderr·Vitest 버전 추가. pipefail로 실패 Exit 유지 | YAML·조건·check→e2e 의존성 검사, 실제 원격 업로드 여부 별도 기록 |

계측은 기존 작은 JSONL 이벤트를 사용하며 원문·Prompt·미디어 bytes를 추가하지 않는다. 단계 Wrapper는 새 ALS Transaction 문맥을 만들지 않는다. Child 경과 시간은 부모의 IPC 대기 시간이며 Child 내부 clock과 직접 차분하지 않는다. `resourceCount`는 소유 핸들 수다. Normalizer의 등록 누락은 객체 소유 경계 보완이며 실행 중 Worker 누수나 최초 timeout 원인을 재현했다는 뜻이 아니다.

timeout Probe 자체 Assertion 실패 시 원본 stderr·JSON·lifecycle 보존은 앞 절의 별도 의도적 실패 증거로 확인했다. 해당 Probe·Worker 파일은 이번에 변경하지 않았고 실제 timeout 부모 회귀를 다시 실행했다. 의도적 Child 실패를 부모 회귀 실패로 집계하지 않는다.

### 새 코드의 최종 검증 상태

아래는 이번에 실제 실행한 결과다. 시간은 Test Runner가 보고한 시간이며 각 명령 전체 Wall time은 별도 `result.json`에 있다. `-t` 선택 실행의 제외 항목은 전체 검증의 skip으로 합산하지 않는다. 전체 check에서는 실행 누락 없이 통과했다.

| 명령 / 실행 | 코드 기준 | 결과 | 시간 | 로그 디렉터리 |
|---|---|---|---:|---|
| 두 우선 Test 기준 실행 | a853449, 기존 사용자 미추적 파일만 존재 | 2 성공, 선택 밖 34개 제외 | 4.93초 | `baseline/` |
| 초기 요청 목록 RED | a853449 + Assertion만 추가 | 1 예상 실패, 선택 밖 35개 제외 | 1.24초 | `unused-request-red/` |
| 두 우선 Test + 정리 회귀 | 71de79f의 코드, 이후 명시 Type import만 추가 | 11 성공, 선택 밖 34개 제외 | 6.29초 | `priority-green/` |
| 관련 5개 Suite | 71de79f에 고정한 변경 | 161 성공 | 67.15초 | `related/` |
| `npm run check` | 71de79f | 58 파일·1,196 성공. TypeScript·Web TypeScript·Schema·Web Build 성공. Required 391, missing/duplicates/skip/only 모두 0 | Vitest 216.20초, 전체 220.31초 | `final-check/` |
| `npm run check:e2e` | 71de79f | 16 성공 | 28.2초 | `final-e2e/` |
| `npm run test:e2e -- tests/e2e/real-audio.spec.ts --repeat-each=3` 최초 | 71de79f, 공유 웹 출력 | 4 성공·7 실패·1 중단·9 미실행, Exit 130 | 전체 232.98초 | `final-audio/` |
| `npm run check:e2e` 격리 비교 1회 | 같은 71de79f, `/private/tmp` 독립 worktree | 16 성공 | 25.2초 | `isolated-e2e/` |
| 실제 Audio/RAF 격리 비교 1회 | 같은 격리 Build | 고유 7개 × 3회 = 21개 성공 | 41.4초 | `isolated-audio/` |

최종 check의 복구 Test는 2,782.05ms, 연쇄 Test는 3,071.44ms였다. 복구 단계는 committedCrash 1,708.08, Child ready 278.42, Barrier 149.47, 소유 중 편집 387.65, release/result 194.07, Revision·편집 검사 32.59ms였다. 연쇄 Test의 proposal/image/speech 적용은 637.83/609.52/627.53ms였다. 관련 Suite 실행보다 느렸지만 통과했으며, 제거한 단일 요청 비용과 전체 실행 시간 차이를 같은 인과로 취급하지 않는다.

최종 check 진단은 152개 Scope·3,562개 이벤트다. Child 58·App 18·Worker owner 40·Store 79개의 소유 핸들이 close됐고 Root 82개 모두 진행 작업·등록 자원 0에서 삭제됐다. `test-aborted`, `cleanup-failed`, `root-preserved`는 0개다. 직접 계측한 소유 자원 범위이며 OS 전체 자원 수가 아니다.

### 새 로컬 Audio 검증의 환경 사건

최초 반복 실행의 네 Test가 통과한 뒤부터 `.project-tile`의 `Real Audio A`를 기다리는 초기 화면 진입이 timeout됐다. Monitor 종료·Project 전환·Audio 본문에 도달한 실패가 아니다. Trace의 `/assets/index-D1CL4pdE.js` 응답은 HTTP 200·`text/html`이었으며 브라우저는 module MIME 오류를 보고했다. 당시 공유 `dist/web/assets`는 없고 `dist/web/assets 2`가 존재했다. 출력 디렉터리 변경의 주체와 정확한 경위는 미확정이며, 이를 iCloud·특정 Process 탓으로 확정하지 않았다.

이 상태에서 같은 실행을 계속하는 것은 Audio 검증 근거가 되지 않아 소유 Playwright CLI에 SIGINT를 보냈다. 4 성공·7 실패·1 중단·9 미실행을 그대로 보존했으며 성공 실행으로 합쳐 보고하지 않는다. 종료한 12개 Test의 진단 모두 Browser Context·Heartbeat·Worker·Timer·Listener·Socket·Request 0과 Root 삭제를 확인했다. 원본 Trace·console·lifecycle·stderr는 `final-audio/playwright-artifacts/`와 `command.log`, 분류는 `failure-analysis.json`에 보존했다.

새 증거에 따른 추가 비교를 `isolated-worktree.json`에 먼저 기록했다. 같은 Commit의 독립 임시 worktree에서 기존 설치 의존성을 참조하고 웹 Build·전체 E2E·Audio 3회 반복을 각각 한 번 실행했다. 최종 check와 Test·Script·설정 107개 파일의 Hash 및 제품 Build 지문이 일치한다. 제품 코드·시간 제한·Worker·Retry·Assertion을 바꾸지 않았다. 단위 check는 이미 같은 코드에서 통과했으므로 다시 반복하지 않았다. 격리 환경의 E2E 16개와 실제 Chromium 140.0.7339.16의 Audio 21개가 통과했다. 공유 디렉터리 변경 주체까지 규명했다는 뜻은 아니다.

사용자 `test-results 2/`, 공유 `dist/web/assets 2`, 운영 데이터·Request·서버 PID 89219는 변경하지 않았다. 공유 웹 출력 복원이나 운영 배포는 수행하지 않았다. 각 실행의 Process Group 종료와 임시 Root 부재를 확인하고 격리 worktree의 필요한 증거를 복사한 뒤 소유 작업 공간만 정리한다.

### 원격 상태와 남은 판단

이 문서 작성 시 이번 코드의 원격 Push·PR 본문 갱신·새 CI는 미실행이다. `a853449`의 과거 PR CI 성공을 `71de79f`의 원격 검증으로 사용하지 않는다. 후속 원격 결과는 [PR #7의 check 및 본문](https://github.com/zzocojoa/storyboard-generator/pull/7)에서 실제 Feature Head·Base·checkout·Run/Attempt와 함께 확인해야 한다. 성공 진단 보존 설정은 로컬에서 검사했으나 새 설정의 실제 Hosted 업로드·내용 확인은 별도 검증 항목이다.

로컬 구현·회귀 검증 범위의 판단은 GO다. 최종 병합 판단은 새 Head의 원격 check/e2e와 비교 Artifact 확인을 조건으로 하는 **조건부 GO**다. 자동 병합·master 직접 Push·보호 설정 변경·운영 배포는 수행하지 않는다. 이번 범위의 추가 권장 로직 수정: 없다. 미확정 원인 조사와 공유 웹 출력 환경 문제는 별도 잔여 사항이다.

이번 후속 증거는 `.local/ci-investigation/pr-7-followup/`에 있으며 Git에서 제외한다. 계획·환경·원본 Hash는 `experiment-plan.json`, `start-environment.json`, `original-evidence-hashes.json`, 단계 비교는 `comparisons.json`, 격리 코드 대조는 `isolated-code-equivalence.json`이다. 새 실행마다 stdout/stderr·Vitest JSON·lifecycle·Build manifest·종료 상태를 별도로 보존했다. 조사 문서 Commit 이후 코드·설정 변경이 없다면 위 검증은 동일한 실행 코드에 적용된다.

구현과 실행 가능한 로컬 검증은 완료했으며, 원본 최초 timeout과 ENOTEMPTY Writer의 원인 해결은 완료하지 않았다.
