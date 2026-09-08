# 범용 콘티 도구 — G1~G7 저장·출력 Hardening 검증 보고서

## 1. 판정

전체 권장 수정 반영은 완료다. G1 Request 원자성, G2 Legacy 격리, G3 Atomic Lock, G4 Git unknown, G5 Integrity/cache, G6 Bundle Claim, G7 Audio Stress 모두 완료다. 병합 판정은 **조건부 GO**이며 현재는 검증된 로컬 환경의 운영 Pilot을 권장한다. Ubuntu의 현재 HEAD 검증은 아직 없다. 생성 완료와 Final Ready는 독립이며 미확정 Text는 Draft에서만 허용한다. 실제 Playhead의 Source·Gate·Coverage와 현재 파일을 검사하고 생성 Asset의 실제 Build·감사 연결을 보존한다.

Push·Merge를 하지 않는 작업이다. 이번 변경의 GitHub Actions Run은 없다. **로컬 검증만 완료**했으며 이전 Commit의 CI 성공을 근거로 재사용하지 않는다.

## 2. Repository 기준

- Branch: `codex/storyboard-final-readiness-hardening`.
- 시작 HEAD: `afcc21d8254b5a7f058c4907d85d91190739d02e`.
- Base·Merge Base: `codex/storyboard-final-readiness`, `10ca4e1a776e56a5d934e5f61fd0cfbe72148463`.
- 구현 Commit: `637e8cd`까지. 최종 문서 Commit과 추적 파일·미추적 보존 상태는 완료 응답의 정확한 SHA와 로컬 `repository-final.json`으로 확인한다.
- Project Schema 1.9.0 / Build Provenance 3 / Request Journal 1·Lock 1 / Storage Journal 3·Lock 3·Process Registry 1 / Output Claim 1.
- 로컬 Node 24.6.0·npm 11.5.1·Chromium 140.0.7339.16. 일반 Vitest Worker 2와 Playwright Worker 1, 기본 Timeout·Retry 0을 유지한다.

## 3. 구현 사항

세부 필드·fsync·복구 순서는 [Design](../02-design/features/storyboard-generator.design.md)의 Request 전이·Lock 게시·Bundle 출력 소유권 절을 기준으로 한다.

| 목표 | 문제와 설계 | 핵심 코드·보존 계약 | 오류·Migration·회귀 |
|---|---|---|---|
| G1 | Process 간 Pending 중복·Supersede/Terminal 경쟁을 Build 제외 논리 Key Lock, 원시 SHA-256 CAS, Journal로 직렬화 | requests.ts·request-lock.ts; 동일 Build 동일 ID, Terminal 불변, Request 감사 이력 보존, 복구 재Crash는 자식 Claim 선출 | Lock/Journal 1; CODEX_REQUEST_STORE_BUSY·CODEX_REQUEST_SETTLED·CODEX_REQUEST_STATE_CONFLICT 409, CODEX_REQUEST_RECOVERY_REQUIRED 423/operator, CODEX_REQUEST_STORE_UNAVAILABLE 503; Legacy read bytes 불변; 19개 새 회귀 |
| G2 | 다른 Legacy Shot 오류가 수리를 막던 문제를 변경 전후 6필드 Issue 비교로 격리 | edit.ts·mapping.ts·App.tsx; Preview/Save 공통, Local·새/악화 Segment 오류 차단, 기존·축소 오류 표시, Approval·Final 차단 유지 | 새 Schema 없음; 기존 정책 코드 유지; 11개 새 회귀 |
| G3 | 최종 Lock의 빈/부분 JSON 노출을 temp fsync·no-replace hard link·parent fsync로 제거 | safe-filesystem.ts·store.ts; 기존 identity·Registry 검증, Project/Create/Request 공통 Primitive, 본인 임시 파일만 정리 | Store Lock/Journal 3 유지; PROJECT_BUSY, Recovery Required; 11개 새 회귀 |
| G4 | Git 조회 실패를 clean으로 기록하던 문제를 availability와 nullable dirty로 표현 | build-inputs.ts·build-schema.ts·build-provenance.ts·io/project.ts; 확인된 HEAD만 보존, audit 필드는 생성 동일성과 분리 | Project 1.8→1.9, Provenance 2→3; 과거 availability=null·dirty 원값 유지; 12개 새 회귀 |
| G5 | 검사 중 파일 변경 뒤 verified 반환과 revision별 전체 cache 무효화를 수정 | store.ts; 최대 2회 stable snapshot, 불변 Asset·identity 기반 LRU 1,024, Final/Safe는 실제 파일 강제 검사 | STORED_ASSET_CHANGED_DURING_CHECK, Asset 423 정책; 18개 새 회귀 |
| G6 | 같은 출력의 Bundle Writer 경쟁을 Output Parent의 원자 Claim으로 제어 | review-output.ts·review-bundle.ts; 한 Writer만 게시, source 불변·Quiescence·External redaction·placeholder 유지 | Claim 1; REVIEW_BUNDLE_EXISTS 409, REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED 423/operator, REVIEW_BUNDLE_WRITE_FAILED 503; 13개 새 회귀 |
| G7 | 이전 Linux 실제 Audio 실패의 장기 관측과 종료 증거 보강 | audio-stress.yml·reporter·native E2E 관찰자; PR 3회 유지, 독립 50/75/100회, 첫 실패 보존, 실제 HTMLAudioElement·200/206 | 제품 Schema 변경 없음; 11개 새 회귀/검증, 실패 Trace·console·lifecycle·summary Artifact |

브라우저 Status가 새 Request 버전 필드를 거부한 통합 실패도 재현했다. Web API가 서버의 BuildManifestSchema를 공유하도록 수정한 뒤 동일 Audio 18건과 전체 E2E 15건이 통과했다. 이 오류는 이전 Linux Audio 간헐 실패의 원인으로 해석하지 않는다.

## 4. 변경 파일

### 신규 파일

| 파일 | 목적 |
|---|---|
| `.github/workflows/audio-stress.yml` | Ubuntu 50~100회 실제 Audio와 실패 Artifact |
| `scripts/audio-stress-reporter.ts` | 완료/실패/미완 반복 JSON Summary |
| `src/codex/request-lock.ts` | 논리 Key Lock·복구자 선출·원자 게시 |
| `src/codex/storage-contract.ts` | Request Journal/Lock 버전 단일 정의 |
| `src/exporters/review-output.ts` | 본인 staging·Claim 소유권과 내구 게시 |
| `tests/atomic-lock-publication.test.ts` | 최종 Lock 가시성·충돌·fsync·소유권 회귀 |
| `tests/audio-diagnostics.ts` | 실제 HTTP 수명·소유 Listener/Socket 관찰 |
| `tests/audio-stress-contract.test.ts` | Stress·개인정보 제외·정리·Summary 검증 |
| `tests/build-git-availability.test.ts` | Git unknown·Migration·과거 값 보존 회귀 |
| `tests/controlled-process.ts` | IPC Barrier·SIGKILL Child Process 조율 |
| `tests/e2e/audio-observers.ts` | 실제 Store/Worker 종료 관찰 |
| `tests/integrity-snapshot-race.test.ts` | 검사 중 파일 변경·cache 유지 회귀 |
| `tests/request-store-transaction.test.ts` | Request 경쟁·CAS·Crash/재Crash 회귀 |
| `tests/request-store-worker.ts` | 독립 Request Process fault injection |
| `tests/review-output-claim.test.ts` | 두 Writer 경쟁·Claim·staging·기존 출력 보존 |
| `tests/review-output-worker.ts` | 독립 Bundle Writer와 IPC 게시 Barrier |
| `tests/visual-plan-legacy-isolation.test.ts` | 순차 수리·비차단 표시·승인/Final 차단 |

### 수정 파일

| 파일 | 목적 |
|---|---|
| `.agents/skills/storyboard-workbench/SKILL.md` | 생성·복구·Final 운영 절차의 현재 계약 |
| `AGENTS.md` | Schema·복구·검증 지침 현재 상태 |
| `README.md` | 버전·Request·출력 Claim 사용 계약 |
| `docs/01-plan/features/storyboard-generator.plan.md` | 계획·설계·분석·실행 증거의 현재 상태 |
| `docs/02-design/features/storyboard-generator.design.md` | 계획·설계·분석·실행 증거의 현재 상태 |
| `docs/03-analysis/storyboard-generator.analysis.md` | 계획·설계·분석·실행 증거의 현재 상태 |
| `docs/04-report/storyboard-generator.report.md` | 계획·설계·분석·실행 증거의 현재 상태 |
| `schemas/storyboard_project.schema.json` | 1.9.0과 Git availability JSON Schema |
| `scripts/check-required-tests.ts` | 신규 핵심 검증 이름 등록 |
| `scripts/runtime-smoke.ts` | 최신 Project Schema 기대값 |
| `scripts/write-build-manifest.ts` | Provenance 3·Request 버전 기록 |
| `src/build-inputs.ts` | Git 확인 실패와 clean 분리 |
| `src/build-schema.ts` | 현재 Build availability·버전 계약 |
| `src/build.ts` | 영속 Build에 availability 전달 |
| `src/codex/requests.ts` | 전이 SHA CAS·다중 파일 Journal·멱등 복구 |
| `src/domain/audio-normalizer.ts` | Worker·Queue·Timer 정리 진단 |
| `src/domain/build-provenance.ts` | 과거 availability=null 메모리 이관 |
| `src/domain/edit.ts` | Visual Plan 변경 전후 오류 격리 |
| `src/domain/mapping.ts` | 승인 Segment 정책·Issue 식별 공유 |
| `src/domain/schema.ts` | Project 1.9.0·영속 Git availability |
| `src/exporters/review-bundle.ts` | 출력 Claim 게시기로 연결 |
| `src/importers/import-package.ts` | 새 Project 1.9.0 생성 |
| `src/io/project.ts` | 18→19 Migration 체인 |
| `src/server/app.ts` | Request/Claim/Asset 오류 정책·전체 종료 대기 |
| `src/server/safe-filesystem.ts` | 완성 파일의 no-replace 원자 공개 Primitive |
| `src/server/store.ts` | 원자 Lock·임시 증거 복구·stable Integrity LRU |
| `tests/build-hardening.test.ts` | 새 스키마·Request 파일/sidecar 검증 |
| `tests/e2e/real-audio.spec.ts` | Native media·200/206·실패/종료 증거 |
| `tests/helpers.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/information-interlock.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/mapping.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/migration.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/output-boundary-regression.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/readiness-audit.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `tests/v15-visual-regression.test.ts` | 기존 회귀 fixture의 최신 Schema 기대값 |
| `web/src/App.tsx` | 무관한 기존 Segment 검토 항목 표시 |
| `web/src/api.ts` | 서버와 현재 Build Status 스키마 공유 |

운영 데이터·생성 미디어·로그·Review Bundle·사용자 미추적 파일은 Commit에 포함하지 않는다. 삭제 파일은 없다. 작업 중 새로 나타난 미추적 `test-results 2/`는 원인을 추정하거나 정리하지 않고 그대로 보존한다. 최종 Worktree의 미추적 항목과 구현의 추적 변경 상태를 구분한다.

## 5. Test 결과

이번 원본 로그는 `.local/reviews/residual-hardening/`에 보존한다. 아래 `npm test` 등 개별 단계는 `npm run check`가 실제 실행한 명령이며 별도의 두 번 성공으로 세지 않는다.

| 명령·시험 | 결과 | 파일 수 | 검사 수 | 근거·특이사항 |
|---|---|---:|---:|---|
| npm ci | 성공 | — | — | npm-ci.log, lockfile 재설치 |
| npm run schemas:write | 성공 | — | — | schemas-write.log, Project 1.9.0 |
| npm run typecheck | 성공 | — | — | check.log |
| npm run typecheck:web | 성공 | — | — | check.log |
| npm test | 성공 | 55 | 1,149 | check.log, 198.95초, Worker 2 |
| npm run test:names | 성공 | — | 351 | missing/duplicates/skip/only 모두 0 |
| npm run schemas:check | 성공 | — | — | 소스·JSON Schema 일치 |
| npm run build:web | 성공 | — | — | check.log·audio-stress-build.log |
| npm run check | 성공 | 55 | 1,149 | 타입·필수 이름·Schema·빌드 포함 |
| npm run check:e2e | 성공 | 2 | 15 | check-e2e.log, 28.6초 |
| 실제 Audio 3회 반복 | 성공 | 1 | 18 | g7-audio-three-green.log, 37.4초 |
| 실제 Audio Stress 50회 | 성공 | 1 | 300 | audio-stress-50.log, 10.3분, retry 0 |
| npm run smoke | 성공 | — | 54 | smoke.log, cleaned=true·동적 포트 6개 종료 |
| 최종 Build·Legacy 회귀 | 성공 | 2 | 31 | build-final-tests.log, 5.17초·Git 실패 주입 경고는 예상 결과 |
| git diff --check | 성공 | — | — | 공백 오류 0 |

Audio Stress Summary는 성공 반복 50, 실패·미완·재시도 0, 첫 실패 번호 null이다. 300개 고유 Case의 진단 파일 모두 Native metadata/playing·실제 HTTP 200/206·서버 request/send/finish/close를 담는다. body 통과·Context 종료·Root 정리는 모두 true이고 남은 소유 Resource는 합계 0이다. 근거는 `audio-stress-evidence.json`과 `audio-stress-50-artifacts/`다. 전체 check·E2E·Stress·Smoke 로그의 예상 밖 Heartbeat 오류는 각각 0이다. Smoke의 6개 포트는 연결 검사를 통해 모두 닫혔음을 확인했다. 일반 Audio 검증 3회와 Stress 50회는 별도 실행이며 전체 E2E에도 Audio 6개가 포함된다.

Resource 수치는 이 시험이 소유한 Browser Context·HTTP Socket/Request·Listener·Heartbeat Timer·Worker/Queue/Timer다. 런타임 전체의 내부 handle 수를 0으로 주장하지 않는다. 실패 Artifact는 지정한 test-results와 .local/audio-stress만 포함하고 숨김 Console Log 포함 옵션을 명시한다. 기본 제외 동작은 [upload-artifact v4 공식 문서](https://github.com/actions/upload-artifact/blob/v4/README.md#uploading-hidden-files)로 확인했다. Media bytes와 사설 Header는 진단 로그에 기록하지 않는다. Audio Trace는 합성 fixture를 사용하고 실패 때만 보존한다.

실패 선작성 증거: G1 `g1-red.log` 2건, G2 `g2-red.log` 3건·`g2-approval-red.log` 1건, G4 `g4-red.log` 10건, G5 `g5-red-canonical.log` 8건, G6 `g6-red.log` 2건, G7 `g7-red.log` 7건, Artifact 숨김 로그 옵션 `g7-artifact-red.log` 1건이다. 후자는 `g7-artifact-green.log` 11건 통과로 확인했다. G3 `g3-red.log` 6건 중 잘못된 fixture 1건은 근거에서 제외하고 수정 fixture를 이전 코드에 적용한 `g3-root-red-valid.log`로 다시 실패를 확인했다. G5의 초기 비canonical 경로 주입 로그도 근거에서 제외했다. 신설 Primitive·Workflow 부재 실패와 기존 동작 결함을 구분한다.

## 6. 동시성·Crash Recovery 증거

| 상황 | 실제 검증·결과 |
|---|---|
| 동일 Build 동시 Request | 독립 Child Process 2개·동일 root·IPC Lock Barrier; pending 1개·동일 ID |
| 다른 Build Supersede | Build가 다른 동일 Key를 직렬화; 새 ID·기존 요청 한 번 superseded·파일 보존 |
| Complete vs Fail | 대기 Barrier로 순서를 고정; 하나만 성공·Terminal 재덮기 거부 |
| Complete vs Supersede | 동일 Key 경쟁; 확정 Terminal을 Supersede가 덮지 않음 |
| Request Journal Crash | Journal 직후·신규 게시·일부 Supersede·Terminal 게시 등에서 SIGKILL; before/after·staging inode 증명 후 복구 |
| Recovery 재실행·재Crash | 복구 중 SIGKILL·두 복구 Process 경쟁; 자식 Claim 선출·멱등 복구·외부 Terminal CAS 불일치 보존 |
| Lock Metadata 부분 노출 | Project/Create fault injection·동시 reader; 최종 경로는 완전 JSON, live 준비 중 파일로 불필요한 block 없음 |
| Bundle 동일 Output 경쟁 | A staging 완료·Claim 소유 Barrier 뒤 B 실행; 정확히 하나 성공·B는 409·Winner 내용/파일 보존 |
| 검사 중 Asset 변경 | path/inode 교체·in-place metadata 변경; 최대 2회 재검사·계속 변하면 비검증·Final/safe counts 제외 |

G1 인접 검증 4파일/55건, G2 3파일/42건, G3 4파일/175건, G4 4파일/42건, G5 2파일/28건, G6 4파일/54건, G7 초기 단위 2파일/22건이 각각 통과했다. 최종 전체 검사에는 새 회귀와 기존 안전 계약을 함께 포함한다. Lock 대기만 제한적으로 수행하며 사용자 전이 callback, CAS 실패와 테스트를 재시도해 성공으로 가리지 않는다.

## 7. Schema·Migration과 운영 원본

이전 Project 1.8.0은 `migrateProjectInput`의 `migrate18To19`와 `migrateGeneratorBuildInput`을 거쳐 1.9.0으로 메모리 이관한다. 이전 1.0~1.8 체인을 유지하며 최신 입력 재이관은 멱등이다. Source·ID·Time·Anchor·Asset·Version·Prompt와 기존 dirty 값은 보존한다. 과거 Build availability는 null이고 현재 Build 정보로 채우지 않는다. Legacy Request도 Schema preprocess로 읽으며 원시 JSON을 자동 재작성하지 않는다.

운영 저장본은 쓰기 가능한 Store로 열지 않고 SHA-256만 다시 계산했다. Current 4·Version 307·Asset 112 = 423개와 고유 Request 104개, **총 527개 변경 0**이다. 근거는 이번 `data-preservation.json`이며 기준은 보관된 `verified-a0b907e/existing-projects.json`이다. 또한 Current 4·Version 307·Request 104개를 실제 현재 Schema로 메모리 이관해 멱등성·Schema 검사 오류 0을 확인했다(`legacy-operating-validation.json`). 이는 저장 Schema 호환 검사이며 과거 영상 전체의 Final 품질 승인으로 해석하지 않는다. 자동 Confirm·Accept·Asset 교체·운영 복구를 실행하지 않았다. 기존 제작 자료의 타임라인과 회귀 fixture 차이를 보정하지 않는다.

## 8. Commit 목록

| SHA | 제목 | 범위 |
|---|---|---|
| f23f861 | fix: fail closed on changing integrity snapshots and preserve asset cache | G5 |
| 8391313 | fix: isolate legacy segment issues while preserving approval gates | G2 |
| c22b512 | fix: preserve unknown Git state in versioned build provenance | G4 |
| 6312973 | fix: publish complete lock metadata atomically and recover owned staging | G3 |
| 1b85c5d | fix: serialize Codex request transitions with recoverable journals and CAS | G1 |
| df086fc | fix: claim review bundle outputs before durable publication | G6 |
| 9184ae7 | fix: share the current build status contract with the web client | G1 Web 통합 |
| 28bba83 | ci: add native audio stress diagnostics and cleanup evidence | G7 |
| 637e8cd | fix: retain hidden audio stress console logs in failure artifacts | G7 Artifact 누락 방지 |

현재 문서 Commit은 위 구현과 이번 실제 실행 근거를 기록한다. 모든 Commit은 작업 Branch의 로컬 이력이며 Push·Merge하지 않는다.

## 9. 미반영·잔여 위험

근본 원인 확정 안 됨. Stress Workflow와 실패 Artifact 수집 경로만 구축함.

이번 변경의 Ubuntu GitHub Actions는 실행하지 않았다. 로컬 반복 성공을 이전 Linux 실패 해결로 표현하지 않는다. Request·Bundle은 로컬 협력 Process 기준이며 SMB/NFS 다중 Host, 비협력 Writer의 임의 디스크 변경을 지원한다고 주장하지 않는다. 알 수 없는 Lock·Claim·Transaction은 자동 삭제하지 않고 운영자 확인을 요구한다. Project 적용과 Request 완료 기록을 하나의 분산 Transaction으로 묶지는 않는다.

기존 제품 범위의 한계도 유지한다. 이미지의 간접 정보 노출·연출·낭독 자연스러움은 사람이 검토한다. External은 명시된 규칙의 치환과 이미지 Placeholder이며 OCR·문맥적 개인정보 완전 제거를 보장하지 않는다. Bundle 결정성은 동일 Snapshot·Build·생성 시각·Font/Renderer 조건이다.

## 10. 최종 권장 조치

**운영 Pilot만 가능.** 로컬 전체 check·E2E·50회 실제 Audio·Runtime Smoke와 원본 불변 검증은 통과했다. Push가 허용되는 다음 단계에서 현재 HEAD의 Ubuntu check·e2e와 별도 Linux Stress 결과를 확인한 뒤 병합 판정을 확정한다. 이전 Linux Audio 실패는 근본 원인을 확정하지 않았으며 실패 Artifact로 후속 관측해야 한다. 이번 작업에서는 Push·Merge하지 않았다.
