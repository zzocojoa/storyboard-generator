# 범용 콘티 도구 — 저장 Asset 계약 완료 보고서

## 1. 작업 기준

- 시작 Branch: `codex/storyboard-generator`
- 시작 HEAD: `ecabc9403cdc3344968a40a7db7656138b98f8be`
- 구현 검증 HEAD: `1fb4e00b90326a0dcac037b16834a5b0afb820ae`
- 문서 포함 종료 HEAD: 이 보고서 commit 뒤 최종 보고에서 확정한다.
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- Storage Journal: version 3, legacy version 2 보수적 읽기·복구 유지
- Store Lock: version 2
- 기존 자동 검사: 26개 파일, 491개 테스트
- 최종 로컬 자동 검사: 27개 파일, 569개 테스트
- 생성 환경은 Codex App 현재 모델, 내장 `image_gen`, macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 API fallback을 추가하지 않았다.
- 기존 127.0.0.1:4317 사용자 서버는 종료하거나 재시작하지 않았다. Runtime 검증은 별도 임시 `dataRoot`와 Fastify inject로 수행했다.

## 2. 재현한 결함

| 실패 Test | 기존 상태 | 기존 잘못된 동작 | 수정 | 수정 후 결과 |
|---|---|---|---|---|
| `initial_create_rejects_dangling_prop_asset_reference`, `update_rejects_unknown_prop_asset_reference` | `shots[].propIds[]`가 Initial Create collector와 Store Update closure에서 빠져 있었다 | Asset catalog에 없는 Prop ID를 초기 또는 후속 revision에 저장할 수 있었다 | 현재 Schema의 6개 Asset FK를 `asset-references.ts`의 한 정책으로 수집하고 Create·Update·Validation에서 사용했다 | Create는 disk 접근 전 거부하고 Update는 lock 안에서 journal 전 `ASSET_REFERENCE_NOT_FOUND`로 거부한다 |
| `update_rejects_wrong_kind_prop_asset_reference`, `update_rejects_frame_reference_to_audio_asset`, `update_rejects_audio_asset_subject_mismatch` | Update가 Asset metadata 전이만 검사해 FK의 종류·대상 결합을 완전히 확인하지 않았다 | Prop→Image, Frame→Audio, Audio→다른 Cue 같은 관계가 임의 transform을 통해 저장될 수 있었다 | Next catalog 전체에 대해 존재·허용 kind·frame/cue subject를 중앙 검사했다 | `ASSET_REFERENCE_KIND_MISMATCH`와 `ASSET_REFERENCE_SUBJECT_MISMATCH`로 저장 전에 거부한다 |
| `eexist_then_lock_vanishes_still_returns_busy`, `lock_directory_sync_failure_removes_owned_lock` | Lock 실패를 사후 경로 존재 여부로 해석하고 생성 호출의 소유권과 inode를 함께 추적하지 않았다 | 실제 `EEXIST`가 raw 오류가 되거나 작성 뒤 sync 실패한 자기 lock이 남을 수 있었다 | 실제 `O_EXCL` 오류 코드, `createdByThisCall`, metadata, `dev/ino`를 추적하고 같은 파일만 정리했다 | 경쟁은 lock이 곧 사라져도 `PROJECT_BUSY`; 자기 lock 정리 실패는 Recovery Block으로 보호한다 |
| `update_is_busy_after_create_publish_before_cleanup`, `initialization_busy_during_live_create_is_transient` | Final directory 공개와 Create 검증·journal 정리 사이에 Create-owned lock이 없었고 초기화의 Busy promise가 남을 수 있었다 | Update가 revision 0에 진입하거나 같은 Store가 Create 완료 뒤에도 Busy를 재반환할 수 있었다 | staging에 lock을 만들고 디렉터리와 함께 게시해 journal 정리 뒤 마지막에 제거하며, transient Busy의 초기화 promise를 해제했다 | 생성 중 Update는 transform 0회·version/transaction/block 0건으로 409, 완료 뒤 같은 Store 재시도는 200이다 |

## 3. Asset Reference Policy

현재 Project Schema에 명시된 Asset Foreign Key를 다음 수용 표로 관리한다.

| Reference Field | Expected Kind | Subject Rule | Create | Update |
|---|---|---|---|---|
| Frame imageAssetId | image | frame ID | 거부 | Closure 검사 |
| AudioCue assetId | audio | cue ID | 거부 | Closure 검사 |
| Shot propIds | prop | 기존 Prop 계약 | 거부 | Closure 검사 |
| Continuity before | character/location/prop | 기존 계약 | 거부 | Closure 검사 |
| Continuity after | character/location/prop | 기존 계약 | 거부 | Closure 검사 |
| Generation resultAssetIds | 현재 생성 계약 | 기존 계약 | 거부 | Closure 검사 |

Generation Result는 기존 정상 데이터에 Prop 결과가 있으므로 현재 Asset kind 다섯 가지(`image`, `audio`, `character`, `location`, `prop`)의 존재를 허용한다. Frame과 Audio만으로 범위를 좁히지 않았다. 모든 참조는 entity ID, 실제 field 경로, Asset ID, 허용 kind와 필요한 subject를 보존한다. 오류는 `ASSET_REFERENCE_NOT_FOUND`, `ASSET_REFERENCE_KIND_MISMATCH`, `ASSET_REFERENCE_SUBJECT_MISMATCH`이며 메시지에 Project·Entity·Field·Asset·Expected/Actual Kind·Expected/Actual Subject를 담는다.

## 4. Initial Create Closure

`ProjectSchema.parse → Asset metadata·6개 FK 수집 → Asset-free assertion → parseProject → Store initialize·disk` 순서로 처리한다. `propIds`, Frame, Audio, Generation Result, Continuity Before/After 가운데 하나라도 참조하거나 Asset metadata가 하나라도 있으면 `UNSUPPORTED_INITIAL_PROJECT_ASSETS`로 거부한다.

거부 시 `dataRoot`, final Project directory, Create journal·staging, version 0, Asset, lock, Recovery Block이 생기지 않는다. 정상 create staging은 asset·transaction 디렉터리가 비어 있고 Current와 Version 0이 같은 Asset-free revision 0인지 Create-owned lock 아래에서 확인한다.

## 5. Update Closure

Update는 lock 내부에서 `Current 검증 → Transform → ProjectSchema shape → Asset catalog transition → Asset reference closure → parseProject → AssetWrite preflight → journal` 순서로 진행한다. Closure 기준은 기존 Asset과 같은 revision에서 추가한 신규 Asset을 합친 Next catalog다.

- 기존 Asset 참조와 신규 Asset metadata·write·참조의 같은 revision 등록을 허용한다.
- Missing Asset, Wrong Kind, Frame/Audio Subject 불일치는 journal 전에 거부한다.
- 임의 Store transform도 중앙 closure를 건너뛸 수 없다.
- 실패 시 Current·version·Asset을 바꾸지 않고 transaction·Recovery Block을 만들지 않으며, 정상 소유 lock을 해제한다.
- 기존 Asset catalog append-only, 동일 ID의 전체 metadata 불변, 신규 metadata와 실제 write 1:1 계약을 유지한다.

## 6. Lock Acquisition

Lock은 `O_CREAT | O_EXCL | O_NOFOLLOW`로 만들고 열린 handle에서 `dev/ino`를 얻는다. 실제 exclusive write가 `EEXIST`를 반환한 경우 이후 경로가 사라져도 `PROJECT_BUSY`이며 HTTP는 409다. 이 경로에서 경쟁 lock을 삭제하지 않는다.

호출별로 `createdByThisCall`, lock metadata, file identity를 추적한다. 작성·fsync·close·metadata 검증·directory sync 중 실패하면 이 호출이 만든 동일 metadata와 동일 `dev/ino`의 파일만 지운다. 소유권이나 identity를 증명할 수 없거나 정리에 실패하면 lock을 임의 삭제하지 않고 `STORE_LOCK_CLEANUP_REQUIRED`와 영속 Recovery Block으로 변경을 차단한다. 일반 획득 실패는 원인 코드가 포함된 `STORE_LOCK_ACQUISITION_FAILED`로 반환한다.

## 7. Create–Update Serialization

Create는 Current와 Version 0을 staging에 쓴 뒤 staging 내부에 Create-owned lock을 만든다. staging 전체를 lock 아래 검증하고, lock을 포함한 디렉터리를 final 경로로 원자 게시한다. 게시 뒤 final Current·Version·Asset-free 상태와 lock metadata·identity를 다시 확인한다.

그 뒤 Create journal을 정리하고 lock을 마지막에 제거한 후 revision 0을 반환한다. Final 공개부터 이 시점까지 다른 Update는 `PROJECT_BUSY`이고 transform, version 1, update transaction, Recovery Block을 만들지 않는다. 완료 후 같은 요청은 revision 1로 저장된다. 초기화 중 live Create를 본 Store의 `PROJECT_BUSY` promise는 캐시에서 해제되어 같은 인스턴스가 재시도할 수 있다.

Startup Recovery는 journal v3의 dead owned final lock과 완전한 Asset-free snapshot을 증명하면 create commit을 완료하고 journal과 lock을 정리한다. 살아 있는 owner는 유지해 Busy로 처리한다. lock 없음, journal·lock 소유자 불일치, metadata·identity·snapshot 불일치는 자동 정리하지 않고 복구 필요 상태로 둔다. Legacy journal v2는 기존의 보수적 복구를 유지한다.

## 8. Concurrency Matrix

| 시나리오 | Create 상태 | Update 결과 | Final Revision | Version 수 | Recovery Block |
|---|---|---|---:|---:|---:|
| Create 게시 전 | Staging | PROJECT_NOT_FOUND 또는 BUSY | 0/없음 | 0/1 | 0 |
| Final 게시 후 검증 중 | Create Lock 보유 | PROJECT_BUSY | 0 | 1 | 0 |
| Create Journal Cleanup 중 | Create Lock 보유 | PROJECT_BUSY | 0 | 1 | 0 |
| Create 완료 후 | Lock 제거 | Update 성공 | 1 | 2 | 0 |
| Create 게시 후 Crash | Dead Create Lock | Startup Recovery | 0 | 1 | 0 |
| Lock·Journal 불일치 | Recovery Required | Update 차단 | 기존 유지 | 기존 유지 | 1 |

테스트는 두 `ProjectStore` 인스턴스와 Promise barrier/fault point로 순서를 고정했다. 시간 지연이나 기존 사용자 서버 상태에는 의존하지 않는다.

## 9. PRJ-007

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, Text Placement 25를 유지한다.
- 원문 문자열과 총 Timeline 1,500,000ms를 유지한다.
- UNIT-045의 849,000–851,000ms J-cut, `unit045-audio`, PCM16 mono 48,000Hz 2,000ms를 유지한다.
- Safe Audio HTTP 200과 RIFF bytes를 확인했다.
- 기존 Asset catalog append-only, Information Gate와 JSON round-trip을 확인했다.

PRJ-007은 회귀 기준이며 Asset 정책과 저장 직렬화는 특정 프로젝트 ID나 절대경로에 고정하지 않은 범용 계약이다.

## 10. 테스트 결과

| 명령 또는 검사 | 결과 | 범위 |
|---|---|---|
| `npm run schemas:write` | 성공 | Zod 기준 JSON Schema 재생성, 변경 없음 |
| `npm run typecheck` | 성공 | Domain·Server·테스트 TypeScript |
| `npm run typecheck:web` | 성공 | Web TypeScript |
| `npm test` | 성공 | 27개 파일, 569개 테스트 |
| `npm run schemas:check` | 성공 | Zod와 생성 JSON Schema 일치 |
| `npm run build:web` | 성공 | Web production build |
| `npm run check` | 성공 | 두 타입 검사, 569개 테스트, schema drift, web build 통합 실행 |
| `git diff --check` | 성공 | 공백 오류 없음 |
| 임시 Fastify runtime | 성공 | `/` 200, status 200, asset-free import 201, initial Prop 거부, dangling/wrong-kind 거부, valid Prop revision 1, 실제 EEXIST 409, active Create Update 409, 완료 후 200, Recovery Block 0, Safe Audio 200 |

신규 파일의 78개 테스트와 기존에 있던 12개 테스트를 합쳐 명세의 정확한 이름 90개가 각각 한 번 존재한다. 그룹별 수는 A 8, B 10, C 15, D 4, E 13, F 10, G 10, H 4, I 7, J 9다. 기존 491개에 신규 78개를 더한 최종 수는 569개다.

완료 조건 57개는 다음 증거군으로 확인했다.

| 완료 조건 | 결과 | 증거 |
|---|---|---|
| 1–17 Asset reference·Create/Update closure | 충족 | 중앙 6필드 collector, 공통 validator, 저장 전 오류·무부작용 테스트 |
| 18–23 Lock 획득·정리·HTTP | 충족 | 실제 EEXIST, 소멸 경쟁, sync/verify 실패, identity 변경, 409 테스트 |
| 24–39 Create lock·직렬화·복구·재초기화 | 충족 | 네 barrier, two-store 경쟁, dead/live/mismatch recovery 테스트 |
| 40–46 기존 저장·PRJ-007 회귀 | 충족 | update concurrency, immutability, journal v2/v3, UNIT-045·Gate·round-trip |
| 47–55 품질 게이트·버전·운영 제약 | 충족 | 27/569, schema 1.5.0, lock 2, journal 3, schema/build, 사용자 서버 보존, SDK 미추가 |
| 56 master 미병합 | 충족 | feature branch만 사용 |
| 57 세 저장 경계 완결 | 충족 | Asset closure, owned cleanup, Create–Update serialization 모두 구현·검증 |

## 11. CI

- 구현 Push HEAD: `1fb4e00b90326a0dcac037b16834a5b0afb820ae`
- Workflow Run ID: [`34038096081`](https://github.com/zzocojoa/storyboard-generator/actions/runs/34038096081)
- Run Head SHA: `1fb4e00b90326a0dcac037b16834a5b0afb820ae`
- Result: `success`
- 환경과 명령: Ubuntu 24.04, Node.js 24, `npm ci`, `npm run check`
- CI 검사량: 27개 Test File, 569개 Test

구현과 같은 SHA의 CI 결과다. 이 보고서를 포함한 문서 commit을 push한 뒤 최신 종료 HEAD의 CI도 별도로 확인한다. 이전 Run `34035122120`의 성공은 이번 변경의 완료 근거로 사용하지 않았다.

## 12. 남은 위험

- Lock 보장은 macOS·Ubuntu 로컬 파일 시스템에서 협력하는 `ProjectStore` writer를 대상으로 한다. SMB·NFS의 분산 lock 의미와 lock을 무시하는 외부 writer까지 보장하지 않는다.
- 명시된 6개 FK를 중앙 정책으로 관리한다. 향후 Project Schema에 새 Asset FK를 추가할 때 정책·필드 목록·계약 테스트를 함께 갱신해야 한다.
- Asset-bearing Initial Create, 자동 대기 queue, Asset garbage collection은 구현하지 않았다.
- 지원 오디오는 PCM WAV다. MP3, AIFF, 압축 WAV와 mastering 품질 resampler는 지원하지 않는다.
- 정보 ID 검사는 bitmap의 간접 암시를 판정하지 못한다. 전체 32개 Segment의 연출, 자막 가독성, 음성 호흡과 제작 가능성은 사람 검토가 필요하다.
