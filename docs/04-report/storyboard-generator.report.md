# 범용 콘티 도구 — Historical Generation Audit와 Recovery Scope 완료 보고서

## 1. 작업 기준

- Branch: `codex/storyboard-generator`
- 시작 HEAD: `f36d924687a5fab697068d21809770b0be9b72ae`
- 구현 HEAD: `b367f2c9c05720821c87c4e73d6b8d7706293201`
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- Storage Journal: version 3, legacy version 2 보수적 처리
- Store Lock: version 3, legacy version 2 보수적 처리
- Process Instance Registry: version 1
- 기존 자동 검사: 28개 파일, 666개 테스트
- 최종 로컬 자동 검사: 29개 파일, 792개 테스트
- 신규 테스트: 126개. 요구된 정확한 계약 이름은 기존 18개를 포함해 144개이며 누락·중복이 없다.
- 사용자 작성 untracked 파일 `README 2.md`는 읽거나 변경하거나 commit하지 않았다.
- 생성은 Codex App과 내장 `image_gen`, macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 API fallback을 사용하지 않는다.

## 2. 재현한 결함

| 실패 계약군 | 기존 동작과 잘못된 상태 | 수정 | 결과 |
|---|---|---|---|
| Historical Generation Target | 기존 Record의 Shot이 Merge·Re-proposal·Source Update로 사라지면 현재 외래 키 검사에서 Project가 무효가 됐다 | 구조 검증과 revision 전이 검증을 분리하고 기존 `shotIds`를 도입 revision의 Historical Reference로 유지했다 | 기존 Record는 현재 Shot이 없어도 유효하며 새 ID로 remap·삭제·비우기를 거부한다 |
| Historical Audit | 현재 Project만으로 Record 도입 시점과 당시 Target 존재를 증명할 수 없었다 | `versions/*.json`을 revision 순서로 읽어 최초 등장 snapshot을 검사하는 파생 감사를 추가했다 | `current`, `historical`, `unresolved`를 구분하고 손상 snapshot은 `STORE_RECOVERY_REQUIRED`다 |
| Generation Normalization | Record 내부 배열과 non-null Request ID 중복 계약이 없었다 | 신규 Record는 내부 중복과 기존·신규 Request ID 충돌을 오류로 처리하고 legacy 중복은 warning으로 남겼다 | 실패는 journal과 recovery block 없이 lock을 해제한다 |
| Recovery Scope | Project 복구 423과 Stored Asset 손상 423이 같은 전역 mutation 차단으로 표시됐다 | 오류 응답에 scope·projectId·resourceId·mutationBlocked를 추가하고 UI 상태를 분리했다 | Project recovery만 해당 Project를 막고 Asset 오류는 해당 출력 수리 알림으로 제한된다 |
| Unrelated Journal | Root Create 복구가 관련 없는 손상 journal까지 탐색해 정상 Project를 막을 수 있었다 | Root lock의 transaction ID와 같은 journal 경로만 직접 읽고 나머지는 known Project 또는 `unknown:<transactionId>`로 격리했다 | 정상 Project 목록·읽기·변경과 새 Create가 계속된다 |
| Live Update와 PID 재사용 | Live Create만 Project별 상태였고 PID 생존만으로 이전 process owner를 오인할 수 있었다 | Active Update와 Lock version 3의 Process Instance ID·시작 시각·registry heartbeat를 추가했다 | 해당 Project만 Busy이며 reused PID, stale·missing registry, 다른 Host를 자동 제거하지 않는다 |
| Timecode | Web 일부가 고정 30fps 계산을 사용했다 | Project timebase numerator·denominator와 start timecode를 BigInt 정수 산술로 계산하는 공통 formatter를 연결했다 | Web·CSV·PDF가 같은 값을 쓰고 PRJ-007 500ms는 24fps `00:00:12`다 |
| Proposal Timing | Source Link가 제안 Shot 전체에만 놓여 실제 공개 시점을 표현하지 못했다 | Optional permille anchor를 Shot offset으로 변환하고 Gate·순서·Frame Context에 적용했다 | 후반 anchor는 Gate 뒤면 허용되고 미래 Source는 앞 Frame Context에서 제외된다 |

## 3. Historical Generation Model

- Structural Validation은 Record ID와 내부 정규성만 검사하며 기존 Shot의 현재 존재를 요구하지 않는다.
- Transition Validation은 기존 Record prefix의 순서와 전체 metadata를 불변으로 유지하고 신규 Record만 Next Shot·Asset에 연결한다.
- Historical Audit는 각 Record가 최초 등장한 Version Snapshot에서 Shot·Asset을 검사한다. 결과는 Project에 저장하지 않는다.
- 기존 Record의 Shot이 현재 없으면 `historical`, 현재도 있으면 `current`, 도입을 증명할 수 없으면 `unresolved`다.
- Project 영속 필드를 추가하지 않았으므로 Schema는 `1.5.0`을 유지하고 migration은 없다.

### Generation Record Acceptance Matrix

| 상태 | Shot 현재 존재 | 처리 |
|---|---:|---|
| 기존 Record, Shot 유지 | 예 | current historical target |
| 기존 Record, Shot 제거 | 아니오 | 허용, historical |
| 신규 Record, Shot 존재 | 예 | 허용 |
| 신규 Record, Shot 없음 | 아니오 | `GENERATION_RECORD_SHOT_NOT_FOUND` |
| 기존 Record Metadata 변경 | 무관 | 거부 |
| 기존 Record 삭제 | 무관 | 거부 |
| 신규 Record 뒤에 Append | 예 | 허용 |

## 4. Shot Topology Integration

- Merge는 제거된 두 번째 Shot의 Generation Record를 원래 ID 그대로 보존한다.
- 같은 Segment Re-proposal은 기존 Record를 보존하고 신규 Proposal Record를 배열 끝에 추가한다.
- Source Update는 영향 Segment의 Shot을 새 ID로 만들되 기존 Record를 remap하지 않는다.
- Split과 Reorder도 기존 Record metadata와 순서를 유지한다.
- PRJ-007 결합 테스트는 split으로 merge 대상을 만든 뒤 실제 Store revision 전이를 모두 거친다.

## 5. Generation Normalization

- 신규 `shotIds`, `resultAssetIds`, `referenceHashes` 내부 중복은 명시적인 오류다.
- 신규 non-null `requestId`는 기존과 같은 revision의 신규 Record 전체에서 유일해야 한다. null은 반복할 수 있다.
- Legacy 내부 중복과 Request ID 중복은 원본을 변경하지 않고 구조 감사 warning으로 보고한다.
- 신규 Shot·Asset과 Record를 같은 revision에 추가할 수 있다.

## 6. HTTP Semantics

응답은 `code`, `message`, `issues`, `category`, `scope`, `projectId`, `resourceId`, `retryable`, `operatorActionRequired`, `mutationBlocked`를 제공한다. 404는 명시된 Not Found 코드에만 적용하며 이름 suffix가 같은 알 수 없는 오류는 500이다.

### HTTP Acceptance Matrix

| Error | HTTP | Scope | Mutation Block |
|---|---:|---|---:|
| `GENERATION_RECORD_SHOT_NOT_FOUND` | 400 | request | 아니오 |
| `PROJECT_NOT_FOUND` | 404 | project | 아니오 |
| `PROJECT_BUSY` | 409 | project | 아니오 |
| `STORE_RECOVERY_BLOCKED` | 423 | project | 예 |
| `STORED_ASSET_HASH_MISMATCH` | 423 | asset | 아니오 |
| `STORE_LOCK_ACQUISITION_FAILED` | 503 | service/project | 아니오 |
| Unknown Error | 500 | service | 아니오 |

## 7. Recovery Scope

- Project recovery marker는 해당 Project mutation만 차단한다.
- Stored Asset 무결성 오류는 `resourceId`를 포함하고 해당 Frame·Audio 출력만 차단한다.
- Root Create와 일반 Update의 live owner는 각각 `activeCreates`, `activeUpdates`로 `/api/status`에 표시된다.
- Lock version 3 owner는 PID, host, process instance ID, 시작 시각과 registry heartbeat가 모두 일치해야 live다.
- Legacy Lock 2와 Journal 2·3은 보수적으로 읽고, 마지막 Store close에서 현재 Process Instance Registry를 정리한다.

### Recovery Scope Matrix

| 상태 | 같은 Project | 다른 Project | 전역 Store |
|---|---|---|---|
| Live Create | Busy | 정상 | 정상 |
| Live Update | Busy | 정상 | 정상 |
| Project Recovery Block | Mutation 차단 | 정상 | 정상 |
| Asset Integrity Error | 해당 Asset 출력 차단 | 정상 | 정상 |
| Unknown unrelated Journal | 해당 Transaction 격리 | 정상 | 정상 |

## 8. Web UI

- `blockedProjectIds`는 상태 응답과 조정되며 선택한 Project에만 mutation disable을 적용한다.
- Asset scope 423은 Asset repair notice를 표시하고 Project recovery 배너를 만들지 않는다.
- Project recovery 상태에서도 Import와 다른 Project 전환·편집이 가능하다.
- 423은 자동 재시도하지 않고, 503은 일시 장애로 표시하며, 409는 영속 block을 만들지 않는다.
## 9. Timecode

- Project의 `fpsNumerator`, `fpsDenominator`, `dropFrame`, `startTimecode`를 사용한다.
- Rational rate는 부동소수점 누적 없이 정수 frame 수로 변환한다.
- Non-drop 24·25·30fps와 검증된 drop-frame rate 범위를 지원한다. 모든 SMPTE rate를 지원한다고 간주하지 않는다.
- Project 목록, Segment 목록, Shot 카드, Timeline, Program Monitor, Inspector, CSV, PDF를 공통 formatter로 바꿨다.

## 10. Proposal Anchor

- Source Link 입력은 선택적 `{ startPermille, endPermille }`를 받는다.
- Anchor를 생략하면 기존 full-shot 동작을 유지한다.
- 시작 offset은 내림, 끝 offset은 올림하고 최소 1ms를 보장한다.
- Information Gate와 Source order는 실제 anchor 시작 시각으로 검사한다.
- Frame Context는 평가 시각에 아직 시작하지 않은 Source Unit과 Information을 제외한다.

### Proposal Anchor Acceptance Matrix

| Anchor | Reveal | 결과 |
|---|---:|---|
| 없음 | Shot 전체 | 기존 호환 |
| 0–1000 | Shot 전체 | 허용 |
| 700–1000 | 후반 공개 | Gate 이후면 허용 |
| 0–300 | 전반 공개 | Gate 이전이면 거부 |
| start ≥ end | 없음 | Validation 오류 |
| 범위 밖 | 없음 | Validation 오류 |

## 11. PRJ-007

- 실제 복제 Project에서 `Import → Generation Record 추가 → Shot Merge → 같은 SEG-002 Re-proposal → UNIT-007 Source Update → Generation Audit → UNIT-045 Safe Audio → JSON·CSV·PDF`를 한 저장 이력으로 실행했다.
- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, Text Placement 25와 1,500,000ms Timeline을 유지했다.
- `UNIT-007`의 의도한 변경 외 원본 연결과 Information Rule을 보존했다.
- 두 Generation Record는 각각 revision 1과 3에서 도입됐고 Source Update 뒤 `historical`로 감사됐다.
- `UNIT-045`는 실제 48,000Hz mono PCM16 WAV 2,000ms를 849,000–851,000ms J-cut으로 저장했고 Safe Audio RIFF를 확인했다.
- JSON 재열기, CSV 생성, PDF `%PDF-` 출력을 확인했다.

## 12. 테스트 결과

| 명령 또는 검사 | 결과 | 범위 |
|---|---|---|
| `npm run schemas:write` | 성공 | Proposal Result JSON Schema 갱신 |
| `npm run typecheck` | 성공 | Domain·Server·Test TypeScript |
| `npm run typecheck:web` | 성공 | Web TypeScript |
| `npm test` | 성공 | 29개 파일, 792개 테스트 |
| 정확한 계약 이름 실행 결과 대조 | 성공 | 144개, 누락 0, 중복 0 |
| `npm run schemas:check` | 성공 | Zod와 생성 JSON Schema 일치 |
| `npm run build:web` | 성공 | Web production build |
| `npm run check` | 성공 | 두 typecheck, 792 tests, schema check, web build |
| `git diff --check` | 성공 | 공백 오류 없음 |

계약군은 Historical Generation 40개, HTTP 26개, Recovery·UI·Process Identity 38개, Timecode·Proposal 21개, 기존 Storage 9개, PRJ-007 10개다. 신규 파일은 126개를 추가했고 기존 suite의 정확한 이름 18개를 재사용해 전체 144개가 한 번씩 실행됐다. 기존 666개와 신규 126개가 모두 통과했다.

Runtime smoke는 격리된 임시 data/request root와 동적 포트 55714·55718을 사용했다. 실제 HTTP에서 `/`·`/api/status`, PRJ-007 Import, Generation Audit, Safe Audio, JSON·CSV·PDF, Generation Missing Shot 400, Project Not Found 404, Project recovery 423, Stored Asset hash mismatch 423, Store unavailable 503을 확인했다. 차단 Project가 있는 동안 다른 Project 편집과 새 Import도 성공했다. 임시 App close 뒤 data root와 listener를 정리했다.

사용자용 최신 서버는 `127.0.0.1:4318`, PID 2286으로 다시 실행했고 `/`와 `/api/status`가 200이다. 기존 `127.0.0.1:4317`, PID 89219는 변경하지 않았다.

## 13. CI

- Push HEAD: `b367f2c9c05720821c87c4e73d6b8d7706293201`
- Workflow: `CI`
- Run ID: [`34047287973`](https://github.com/zzocojoa/storyboard-generator/actions/runs/34047287973)
- Run Head SHA: `b367f2c9c05720821c87c4e73d6b8d7706293201`
- Conclusion: `success`
- Job: `check`, Ubuntu 24.04, Node.js 24, `npm ci`, `npm run check`
- CI 검사량: 29개 Test File, 792개 Test

## 14. Pull Request

- PR: [#1 Historical Generation Audit와 Recovery Scope 보정](https://github.com/zzocojoa/storyboard-generator/pull/1)
- Base/Head: `master` ← `codex/storyboard-generator`
- 상태: Open, `master` 미병합
- Branch Protection 적용 시도: 자동 승인 검토에서 거절돼 원격 설정은 변경되지 않았다.
- 거절된 설정: `master`에 PR 필수, required status check `check`, force push 금지, admin 포함 보호.
- 정확한 거절 사유: 원격 저장소의 `master`에 지속적인 보호를 적용하는 조직 수준 변경이며, 대상 브랜치의 정확한 설정 변경에 대한 명시적 승인 근거가 없다고 판정됐다. 우회하지 않았다.

## 15. 남은 위험

- Lock 의미는 macOS·Ubuntu 로컬 파일 시스템에서 협력하는 `ProjectStore` writer를 대상으로 한다. SMB·NFS 분산 writer와 lock을 무시하는 외부 writer는 보장하지 않는다.
- 다른 Host lock, 살아 있는 PID의 missing·stale·불일치 Process Instance는 자동 복구하지 않고 해당 Project를 차단한다. 운영자가 실제 owner와 저장 상태를 확인해야 한다.
- Version Snapshot이 손상됐거나 누락된 과거 Record의 정확한 도입 시점은 자동 복원하지 않고 `unresolved`로 보고한다.
- Drop-frame 지원은 Timebase Validator가 허용하는 rate에 한정된다.
- Permille anchor는 제안 의도와 정보 공개 시점을 구조적으로 검사하지만 그림 속 간접 암시는 판정하지 못한다.
- 전체 32개 Segment의 연출, 자막 가독성, 음성 호흡과 실제 제작 가능성은 사람 검토가 필요하다.
