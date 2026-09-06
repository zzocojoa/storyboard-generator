# 범용 콘티 도구 — 저장 동시성 계약 보고서

## 1. 작업 기준

- 시작 Branch: `codex/storyboard-generator`
- 시작 HEAD: `6a708476f0d2e6c5a61a7d90afe8efd9ef351baa`
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- Storage Journal: version 3, version 2 보수적 읽기·복구 유지
- Store Lock: version 2
- 기존 자동 검사: 25개 파일, 413개 테스트
- 현재 로컬 자동 검사: 26개 파일, 491개 테스트
- 생성 환경은 Codex App 현재 모델, 내장 `image_gen`, macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 API fallback을 사용하지 않는다.

## 2. 재현한 결함

| 결함 | 기존 호출 순서와 잘못된 상태 | 수정 | 결과 |
|---|---|---|---|
| Current를 lock 전에 읽음 | 두 writer가 같은 revision을 기준으로 transform과 preflight를 계산할 수 있었다 | lock을 먼저 획득하고 current부터 journal까지 같은 임계 구역에서 처리한다 | 한 writer만 commit하고 다른 writer는 Busy 또는 Conflict로 끝난다 |
| Initial Create가 metadata-only Asset을 허용 | create가 실제 AssetWrite를 받지 않으면서 Asset metadata나 참조를 저장할 수 있었다 | schema 형태 확인 직후 모든 Asset 참조를 모아 disk 접근 전에 거부한다 | `UNSUPPORTED_INITIAL_PROJECT_ASSETS`, disk side effect 0건 |
| 같은 Asset ID의 의미 변경 | path·hash·MIME 등 metadata 변경과 catalog 제거를 신규 write 없이 저장할 수 있었다 | current와 next Asset catalog를 전체 필드 deep equality와 append-only 규칙으로 검사한다 | 변경·제거·기존 경로 write를 명시적 Asset 오류로 거부한다 |
| Transform의 in-place mutation | previous 기준 객체가 transform 결과에 의해 오염될 수 있었다 | stored current에서 previous content·hash를 만들고 deep clone만 transform에 전달한다 | 실패와 mutation 뒤 current·previous snapshot이 유지된다 |

기존 Asset-bearing create를 사용하던 일반 테스트 픽스처는 `Asset-free create → update(metadata + write)` 경로로 바꿨다. version 2 호환, 과거 손상 상태와 복구 소유권을 검증하는 수동 disk fixture만 의도적으로 유지한다.

## 3. Lock-before-read

Update 순서는 다음과 같다.

```text
initialize
→ Project directory·recovery marker 최소 확인
→ transaction ID
→ Project lock 원자 획득과 소유권 확인
→ current·동일 revision snapshot·저장 구조 검증
→ expectedRevision
→ current deep clone transform
→ next parse
→ Asset catalog transition
→ version·Asset collision과 미디어 preflight
→ lock·current revision/SHA-256·게시 경로 재확인
→ journal staging
→ Asset → version → current 게시
→ commit 검증과 transaction cleanup
→ lock 해제
```

정상 commit, revision conflict, version collision, Asset 계약 오류와 일반 domain 오류는 lock을 정리한다. 저장 경로·snapshot·외부 current 변경처럼 무결성을 증명할 수 없는 오류는 기존 정책에 따라 recovery block과 필요한 보호 상태를 보존한다. `SimulatedStorageCrash`는 재시작 복구 검증을 위해 writer cleanup을 건너뛴다.

## 4. Concurrency Matrix

모든 경쟁은 Promise barrier와 두 `ProjectStore` instance로 순서를 고정했다.

| 시나리오 | A Barrier | B 시작 | A 결과 | B 결과 | Current Revision | Version 수 | Asset 수 | Transaction 수 | Recovery Block |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| A lock 보유 중 B | current read 직후 | A 정지 중 | commit | `PROJECT_BUSY` | 1 | 2 | 0 | 0 | 0 |
| A commit 후 B old revision | A cleanup 뒤 | expected 0 | commit | `REVISION_CONFLICT` | 1 | 2 | 0 | 0 | 0 |
| A/B 같은 변경 | current read 직후 | A 정지 중 | 1개 commit | `PROJECT_BUSY` | 1 | 2 | 0 | 0 | 0 |
| A/B 같은 Asset | Asset 게시 직후 | A 정지 중 | 1개 Asset commit | `PROJECT_BUSY` | 1 | 2 | 1 | 0 | 0 |
| A transform 실패 후 B | transform | A 오류 뒤 | Domain Error | commit | 1 | 2 | 0 | 0 | 0 |
| A preflight 실패 후 B | Asset decode | A 오류 뒤 | Asset Error | commit | 1 | 2 | 0 | 0 | 0 |

자동 대기 queue는 없다. 호출자는 `PROJECT_BUSY` 뒤 current를 다시 읽어 재시도하며, 오래된 `expectedRevision`은 `REVISION_CONFLICT`로 처리한다.

## 5. Initial Create Contract

Initial Create는 Asset metadata가 없고 모든 Asset 참조가 비어 있는 revision 0 Project만 허용한다. 수집 대상은 `frames[].imageAssetId`, `audioCues[].assetId`, `generationRecords[].resultAssetIds`, `shots[].continuityBefore[].assetId`, `shots[].continuityAfter[].assetId`다.

거부 오류에는 Project ID, metadata 수, 참조 수, 참조 필드 목록과 `Asset-free Project를 먼저 생성한 뒤 Revision Update로 등록`하라는 해결 방법이 들어간다. 거부 시 final Project directory, create transaction·journal·staging, version 0, Asset 파일과 recovery block이 생기지 않는다. 과거에 저장된 정상 Asset-bearing Project의 읽기, startup recovery, Safe Frame·Audio와 내보내기는 그대로 지원한다. Asset-bearing Initial Create 지원은 별도 목표다.

## 6. Asset Immutability

같은 Asset ID의 `kind`, `subjectId`, `path`, `mimeType`, `sha256`, `description`, `durationMs`, `version`, `audioMetadata`와 향후 Asset Schema 필드를 포함한 전체 객체가 revision 사이에서 같아야 한다. 기존 항목 누락은 `ASSET_REMOVAL_FORBIDDEN`, 필드 변경은 `ASSET_METADATA_IMMUTABLE`, 기존 경로 write는 `ASSET_WRITE_FOR_EXISTING_ASSET`로 거부한다.

교체는 신규 Asset ID·경로·version과 실제 write를 추가하고 Frame 또는 Audio Cue 참조만 새 ID로 옮긴다. 이전 metadata와 파일은 감사용으로 남긴다. 신규 metadata 경로와 `AssetWrite.relativePath` 집합은 정확히 1:1이어야 하며 중복, 누락, 미선언 write, hash·MIME·decode 불일치와 final 충돌을 journal 전에 거부한다. Asset garbage collection은 구현하지 않았다.

## 7. Transform Isolation

Lock 아래에서 읽어 검증한 current로 previous JSON과 SHA-256을 먼저 만든다. transform에는 `structuredClone` 후 `parseProject`를 통과한 별도 객체를 전달한다. transform이 입력을 직접 바꾸더라도 stored current와 이전 version snapshot은 변하지 않고, 기존 Asset baseline과 비교해 metadata 변경을 찾아낸다. transform throw와 유효하지 않은 next는 current·version·Asset·journal·recovery block을 만들지 않고 lock을 해제한다.

## 8. PRJ-007

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, Text Placement 25
- 전체 시간 1,500,000ms와 원문 문자열 보존
- UNIT-045: 849,000–851,000ms J-cut, `unit045-audio` ID 유지
- 실제 WAV: PCM16 mono 48,000Hz, 2,000ms
- Safe Audio HTTP 200과 RIFF bytes 확인
- Information Gate와 JSON round-trip 보존
- 후속 revision에서 기존 UNIT-045 Asset catalog 항목 유지

## 9. 테스트 결과

| 명령 또는 검사 | 결과 | 범위 |
|---|---|---|
| `npm run schemas:write` | 성공 | Zod 기준 JSON Schema 재생성 |
| `npm run typecheck` | 성공 | Domain·Server·테스트 TypeScript |
| `npm run typecheck:web` | 성공 | Web TypeScript |
| `npm test` | 성공 | 26개 파일, 491개 테스트 |
| `npm run schemas:check` | 성공 | Zod와 생성 JSON Schema 일치 |
| `npm run build:web` | 성공 | Web production build |
| `npm run check` | 성공 | 두 타입 검사, 491개 테스트, schema drift, web build 통합 실행 |
| 저장 계약 보강 | 성공 | 신규 78개와 기존 JSON round-trip을 합친 필수 이름 79개 |
| 임시 Fastify runtime | 성공 | `/` 200, status 200, import 201, update 200, concurrent commit 200, Busy 409, Conflict 409, Asset 변경 거부, Initial Asset 거부, Audio update 201, Safe Audio 200, revision 3, version 4개, recovery block 0개 |

실패 후 수정한 내용은 Asset 참조 금지 검사 순서를 full project validation보다 앞으로 옮긴 것, 일반 Asset 픽스처를 실제 create→update 경로로 전환한 것, 기존 Asset hash 변경에 의존하던 손상 Audio 검사를 실제 파일 손상 판정으로 바꾼 것이다. 모든 필수 품질 명령은 최종 로컬 변경 상태에서 다시 실행해 성공했다.

## 10. CI

Feature Branch push 뒤 현재 종료 HEAD와 같은 SHA의 GitHub Actions를 확인한다. Workflow는 Ubuntu 24.04, Node.js 24, `npm ci`, `npm run check`를 사용한다. 이전 기준 Run `34030959878`의 성공은 이번 변경의 완료 근거로 사용하지 않는다. Push HEAD, 새 Run ID, Run Head SHA와 conclusion은 최종 완료 보고에 기록한다.

## 11. 남은 위험

- 저장 직렬화 계약은 macOS·Ubuntu 로컬 파일 시스템에서 협력하는 `ProjectStore` writer를 대상으로 한다. SMB·NFS 분산 lock 의미와 lock을 무시하는 외부 프로세스의 변경 방지는 보장하지 않으며, 외부 변경은 journal 직전 재검사로 탐지해 차단한다.
- 자동 대기 queue, Asset-bearing Initial Create와 Asset garbage collection은 범위 밖이다.
- 지원 오디오는 PCM WAV다. MP3, AIFF, 압축 WAV와 mastering 품질 resampler는 지원하지 않는다.
- 정보 ID 검사는 bitmap의 간접 암시를 판단하지 못한다. 전체 32개 Segment의 연출, 자막 가독성, 음성 호흡과 제작 가능성은 사람 검토가 필요하다.
