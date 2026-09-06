# 범용 콘티 도구 — 동시 생성·생성 이력·HTTP 계약 완료 보고서

## 1. 작업 기준

- Branch: `codex/storyboard-generator`
- 시작 HEAD: `618492ee2a9eca34cdad4eeb62b22dd260e35d43`
- 구현·상태 문서 검증 HEAD: `b692ae17a18d0b60e75f107d0d8aa4ebdfa9c1ba`
- 보고서 포함 종료 HEAD: 이 보고서 commit 뒤 최종 응답에서 확정한다.
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- Storage Journal: version 3, legacy version 2 보수적 읽기·복구 유지
- Store Lock: version 2
- 기존 자동 검사: 27개 파일, 569개 테스트
- 최종 로컬 자동 검사: 28개 파일, 666개 테스트
- 지정된 계약 이름: 기존 12개와 신규 97개, 총 109개가 각각 한 번 존재
- 생성 환경은 Codex App 현재 모델, 내장 `image_gen`, macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 API fallback을 추가하지 않았다.
- 기존 `127.0.0.1:4317` 사용자 서버 PID 44386은 종료하거나 재시작하지 않았다. Runtime 검증은 별도 임시 포트 44317과 격리된 data/request root에서 수행하고 모두 정리했다.

## 2. 재현한 결함

| 실패 Test 또는 계약군 | 기존 경쟁·오류 상태 | 기존 Disk 상태 | 수정 | 수정 후 결과 |
|---|---|---|---|---|
| `root_create_lock_is_acquired_before_target_check`, `concurrent_create_commits_exactly_once`, `concurrent_create_does_not_return_raw_eexist`, `concurrent_create_does_not_return_raw_enotempty` | 같은 Project의 Initial Create 둘이 target check 뒤 각자 staging에 진입할 수 있었다 | loser staging과 파일시스템 원본 오류가 남거나 final 게시 승자를 코드 계약으로 판별하기 어려웠다 | Project ID SHA-256 경로의 Root Create Lock을 target 재검사·staging·journal보다 먼저 `O_EXCL`로 획득했다 | 한 Create만 revision 0을 게시하고 경쟁자는 `PROJECT_BUSY`, 완료 후 재시도는 `PROJECT_ALREADY_EXISTS`다 |
| `crash_after_root_lock_before_journal_is_recovered`, `dead_root_lock_with_matching_journal_is_recovered`, `root_lock_journal_transaction_mismatch_is_blocked`, `create_recovery_is_idempotent` | staging journal만으로는 journal 전 crash와 root 수준 소유권을 설명할 수 없었다 | journal 없는 고아 상태 또는 root/final/journal 관계가 불명확한 상태를 안전하게 분류할 수 없었다 | root lock·journal·final lock의 Project·transaction·host·PID와 file identity를 교차 검증하는 startup recovery를 추가했다 | dead pre-journal lock과 증명 가능한 commit/rollback은 정리되고, 손상·다른 Host·불일치는 Project별 recovery block과 함께 보존된다 |
| `live_create_does_not_block_unrelated_project_read`, `live_create_does_not_block_unrelated_project_update`, `live_create_does_not_block_unrelated_project_create` 및 기존 `startup_does_not_remove_live_create_lock` | 살아 있는 Initial Create를 본 initialize가 Store 전체를 `PROJECT_BUSY`로 끝냈다 | 관련 없는 Project에도 전역 Busy가 전파됐다 | 같은 Host live owner를 Project별 Active Create로 기록하고 대상 mutation 때만 다시 확인한다 | 해당 Project Create·Update만 Busy이며 다른 Project read·update·create는 계속된다 |
| `existing_generation_record_removal_is_rejected`, `existing_generation_record_reordering_is_rejected`, provider/model/prompt/result/shot/createdAt 변경 계약 | Asset append-only와 달리 Generation Record의 revision 전이가 중앙에서 강제되지 않았다 | 과거 생성 근거가 삭제·재배열·수정된 next Project가 journal에 들어갈 수 있었다 | Asset 전이 뒤, Asset closure 전에 Generation Record의 prefix 순서와 전체 metadata를 검사한다 | 기존 Record는 byte-equivalent metadata와 순서를 유지하고 신규 Record만 끝에 추가된다. 실패는 journal·block을 만들지 않고 lock을 해제한다 |
| `recovery_blocked_returns_423`, `lock_acquisition_failed_returns_503`, `existing_error_code_message_and_issues_are_preserved` 및 Web UI 계약 | 복구가 필요한 저장 오류도 포괄적인 400으로 응답했고 UI가 입력 오류와 구분하지 못했다 | Disk는 보존됐지만 사용자가 재시도 여부와 운영자 조치 필요성을 판단할 구조가 없었다 | 기존 오류 필드에 category·retryable·operatorActionRequired를 추가하고 상태별 HTTP 정책과 UI를 연결했다 | 복구 잠금은 423과 영속 배너·mutation 차단, 일시 lock 획득 실패는 503, 기존 code·message·issues는 유지된다 |
| 첫 전체 회귀의 `startup_does_not_remove_live_create_lock`, `blocked_project_rejects_asset_upload`, `blocked_project_rejects_source_update` 계열 기대값 | 새 Project 범위 초기화와 423 계약이 이전 전역 Busy·400 기대와 충돌했다 | 구현 결함이 아니라 기존 테스트가 이전 API 의미를 고정했다 | 기존 저장 안전 검사는 유지하면서 Project별 Active Create와 구조화 423을 직접 검증하도록 기대값을 갱신했다 | 관련 파일 213개 테스트와 전체 666개 테스트가 통과했다 |

## 3. Root Create Lock

Root Create Lock 경로는 `<dataRoot>/.create-locks/<sha256(projectId)>.lock`이다. 관리 디렉터리는 Project 목록에서 제외한다. Lock version 2 metadata는 `projectId`, `transactionId`, `host`, `pid`, `createdAt`을 기록한다.

Initial Create 순서는 `ProjectSchema와 Asset-free 계약 → Store initialize → transaction ID → root lock 획득 → final target 재검사 → staging·journal → Current·Version 0 → final write.lock → final 게시 → 완전성 검증 → journal 정리 → final lock 제거 → root lock 제거`다. Final lock은 root lock과 Project·transaction·host·PID가 같다. 두 lock은 제거 직전에 metadata와 `dev`·`ino`를 다시 검사하며 root lock을 마지막에 제거한다.

Startup recovery는 다음 상태를 구분한다.

- dead owner, journal 없음, final 없음: pre-journal crash로 root lock만 제거한다.
- dead owner, matching journal: 기존 create transaction 복구를 끝낸 뒤 root lock을 제거한다.
- dead owner, 완전한 final: journal 유무와 관계없이 Current·Version 0과 final lock을 확인해 Project를 보존하고 남은 lock을 제거한다.
- live same-host owner: Active Create로 유지한다.
- 다른 Host, malformed metadata, root·journal·final transaction 불일치: 자동 삭제하지 않고 root lock과 관련 자료를 보존하며 해당 Project를 차단한다.

## 4. Concurrent Create

테스트는 두 `ProjectStore` instance와 Promise barrier/fault point로 순서를 고정한다. sleep과 기존 사용자 서버 상태에 의존하지 않는다.

| 시나리오 | Create A | Create B | Final Revision | Version 0 | Root Lock | Recovery Block |
|---|---|---|---:|---:|---:|---:|
| A Root Lock 보유 중 B | 성공 | `PROJECT_BUSY` | 0 | 1 | 0 | 0 |
| A 완료 후 B 재시도 | 기존 유지 | `PROJECT_ALREADY_EXISTS` | 0 | 1 | 0 | 0 |
| A/B 동시 시작 | 1건 성공 | Busy 또는 Already Exists | 0 | 1 | 0 | 0 |
| A Root Lock 후 Crash | Startup Recovery | 재시도 가능 | 0/없음 | 0/1 | 0 | 0 |
| A Final 게시 후 Crash | Commit Recovery | 기존 Project 확인 | 0 | 1 | 0 | 0 |
| Root Lock·Journal 불일치 | 차단 | 차단 | 기존 유지 | 기존 유지 | 보존 | 1 |
| 서로 다른 Project | 성공 | 성공 | 각각 0 | 각각 1 | 0 | 0 |

HTTP 이중 Import는 정확히 한 요청이 201, 경쟁 요청이 409이고 같은 Project 디렉터리·Version 0·Source Snapshot을 하나만 남긴다. 정상 경쟁에서는 loser staging, raw `EEXIST`·`ENOTEMPTY`, recovery block이 남지 않는다.

## 5. Project-scoped Active Create

초기화가 같은 Host의 살아 있는 root lock을 발견하면 owner를 죽이거나 lock을 지우지 않고 `activeCreates()`에 기록한다. 해당 Project의 Create와 Update는 `PROJECT_BUSY`다. Root·transaction·final lock이 사라지거나 create가 끝나면 다음 대상 작업에서 상태를 새로 읽고 Active Create를 제거한다.

관련 없는 Project의 목록, 읽기, Update, Initial Create는 계속된다. 살아 있는 정상 작업 때문에 전역 recovery block을 만들지 않는다. 일반 Update의 live `write.lock`은 Initial Create root lock과 구분하며 기존의 전역 초기화 안전 계약을 유지한다.

## 6. Generation Record

`generationRecords`는 감사 가능한 생성 이력이다. Update 순서는 `Project shape → Asset transition → Generation Record transition → Asset reference closure → full Project validation → write preflight → journal`이다.

| 변경 | 허용 여부 | 오류 |
|---|---|---|
| 기존 Record 유지 | 허용 | 없음 |
| 기존 Record 삭제 | 거부 | `GENERATION_RECORD_REMOVAL_FORBIDDEN` |
| 기존 Record Metadata 변경 | 거부 | `GENERATION_RECORD_IMMUTABLE` |
| 기존 Record 순서 변경 | 거부 | `GENERATION_RECORD_ORDER_IMMUTABLE` |
| 신규 Record 뒤에 추가 | 허용 | 없음 |
| 없는 Shot 참조 | 거부 | `GENERATION_RECORD_SHOT_NOT_FOUND` |
| 없는 Asset 참조 | 거부 | `ASSET_REFERENCE_NOT_FOUND` |
| 같은 Revision 신규 Asset 참조 | 허용 | 없음 |

ID 중복과 Shot 존재는 공통 Validator에서도 검사한다. Image·Speech 결과 적용은 신규 Record를 추가하고 Proposal·Source Update·Asset replacement는 과거 Record를 그대로 보존한다. JSON round-trip과 storage recovery 뒤에도 순서와 metadata가 유지된다.

## 7. HTTP Semantics

응답은 기존 `{ error: { code, message, issues } }`를 유지하면서 `category`, `retryable`, `operatorActionRequired`를 추가한다.

| 분류 | HTTP | 주요 Code | 자동 재시도 |
|---|---:|---|---|
| Validation | 400 | `ASSET_REFERENCE_*`, `GENERATION_RECORD_*` | 아니오 |
| Not Found | 404 | `PROJECT_NOT_FOUND` 등 | 아니오 |
| Conflict | 409 | `PROJECT_BUSY`, `REVISION_CONFLICT`, `PROJECT_ALREADY_EXISTS` | 조건부 |
| Storage Locked | 423 | `STORE_RECOVERY_*`, `STORE_LOCK_CLEANUP_REQUIRED` | 아니오 |
| Unavailable | 503 | `STORE_LOCK_ACQUISITION_FAILED` | 가능 |
| Internal | 500 | Unknown Error | 아니오 |

Web은 Import 요청이 진행되는 동안 버튼을 비활성화하고 `IMPORTING`을 표시해 이중 제출을 막는다. 423에서는 **STORAGE RECOVERY REQUIRED** 배너를 유지하고 해당 Project의 mutation control을 잠그며 자동 재시도하지 않는다. 503은 **STORAGE TEMPORARILY UNAVAILABLE**로 구분한다.

## 8. PRJ-007

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, Text Placement 25를 유지한다.
- 원문 문자열과 총 Timeline 1,500,000ms를 유지한다.
- `UNIT-045`의 849,000–851,000ms J-cut, `unit045-audio`, PCM16 mono 48,000Hz 2,000ms를 유지한다.
- Safe Audio HTTP 200과 RIFF bytes를 확인했다.
- `SEG-024` Text의 1,088,000ms, 1,108,000ms, 1,148,000ms 공개 Gate를 유지한다.
- 기존 Asset catalog와 Generation Record의 append-only, JSON 재열기, recovery 뒤 이력 불변성을 확인했다.

PRJ-007은 실제 제작 회귀 기준이다. Root Create Lock, Generation Record, HTTP 정책은 Project ID·절대경로·장면 수·분량에 고정하지 않은 범용 계약이다.

## 9. 테스트 결과

| 명령 또는 검사 | 결과 | 범위 |
|---|---|---|
| 정확한 계약 이름 검사 | 성공 | 지정 109개 존재, 누락 0, 중복 0 |
| `npm run typecheck` | 성공 | Domain·Server·테스트 TypeScript |
| `npm run typecheck:web` | 성공 | Web TypeScript |
| `npm test` | 성공 | 28개 파일, 666개 테스트 |
| `npm run schemas:check` | 성공 | Zod와 생성 JSON Schema 일치 |
| `npm run build:web` | 성공 | Web production build |
| `npm run check` | 성공 | 두 타입 검사, 666개 테스트, schema drift, web build 통합 실행 |
| `git diff --check` | 성공 | 공백 오류 없음 |
| 임시 44317 Runtime | 성공 | `/` 200, `/api/status` 200, asset-free Import 201, 중복 Import 409와 구조화 Conflict body |
| 임시 Runtime 정리 | 성공 | PID 84391 종료, 임시 data/request/config/응답 파일 제거, 44317 listener 없음 |
| 기존 사용자 서버 보존 | 성공 | PID 44386, `127.0.0.1:4317` listener 유지 |

기존 569개에 신규 97개를 더한 최종 수는 666개다. 지정된 정확한 이름 109개는 기존 12개와 신규 97개로 구성되며 각각 한 번 존재한다. Root lock 획득·정리, 두 Store concurrent create, crash recovery, Active Create 범위, Generation Record 전이, HTTP/UI 의미, 기존 storage와 PRJ-007 회귀를 함께 실행한다.

## 10. CI

- 구현·상태 문서 Push HEAD: `b692ae17a18d0b60e75f107d0d8aa4ebdfa9c1ba`
- Workflow Run ID: [`34041424584`](https://github.com/zzocojoa/storyboard-generator/actions/runs/34041424584)
- Run Head SHA: `b692ae17a18d0b60e75f107d0d8aa4ebdfa9c1ba`
- Result: `success`
- 환경과 명령: Ubuntu 24.04, Node.js 24, `npm ci`, `npm run check`
- CI 검사량: 28개 Test File, 666개 Test

구현과 상태 문서가 포함된 같은 SHA의 CI 결과다. 이 보고서 commit을 push한 뒤 보고서 포함 종료 HEAD의 CI도 최종 응답에서 exact SHA·Run ID·결과로 확인한다.

## 11. 남은 위험

- Lock 보장은 macOS·Ubuntu 로컬 파일 시스템에서 협력하는 `ProjectStore` writer를 대상으로 한다. SMB·NFS의 분산 lock 의미와 lock을 무시하는 외부 writer는 보장하지 않는다.
- 다른 Host의 live 여부는 안전하게 판정하지 않으므로 자동 복구하지 않고 해당 Project를 차단한다. 사람이 owner와 저장 상태를 확인해야 한다.
- Generation Record metadata 비교는 현재 1.5.0 Schema로 parse된 정규 객체를 기준으로 한다. 향후 필드를 추가하면 Migration과 전이 계약을 함께 갱신해야 한다.
- Asset-bearing Initial Create, 자동 대기 queue, Asset garbage collection은 구현하지 않았다.
- 지원 오디오는 PCM WAV다. MP3, AIFF, 압축 WAV와 mastering 품질 resampler는 지원하지 않는다.
- 정보 ID 검사는 bitmap의 간접 암시를 판정하지 못한다. 전체 32개 Segment의 연출, 자막 가독성, 음성 호흡과 제작 가능성은 사람 검토가 필요하다.
