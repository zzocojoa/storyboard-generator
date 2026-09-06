# 범용 콘티 도구 — 저장 무결성·Worker Queue 보고서

## 1. 작업 기준

- Branch: `codex/storyboard-generator`
- 시작 HEAD: `cc812fe24277f394d7b0a21f32eb5dc8c053101a`
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- Storage Journal: version 3, 기존 version 2 읽기 호환
- Store Lock: version 2
- 기준 검사: 23개 파일, 321개 테스트
- 현재 검사: 25개 파일, 413개 테스트
- 생성 환경: Codex App 현재 모델, 내장 `image_gen`, 설정된 macOS 음성. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 API fallback은 사용하지 않는다.

## 2. 재현한 결함

| 실패 조건 | 기존 disk 상태와 동작 | 수정 후 상태 |
|---|---|---|
| 다음 revision 경로가 이미 존재 | 신규 Asset을 먼저 게시한 뒤 충돌할 수 있었다 | journal과 final Asset을 만들기 전에 `PROJECT_VERSION_EXISTS`로 끝나며 기존 version의 hash와 inode를 유지한다 |
| 신규 Asset 경로가 이미 존재 | staging 이후에 충돌을 확인할 수 있었다 | metadata·write·hash·parent와 함께 preflight에서 검사하고 journal을 만들지 않는다 |
| 같은 hash의 다른 파일 | hash만으로 transaction 게시물로 오인할 수 있었다 | staged와 final의 `dev`·`ino`가 다르면 삭제하지 않고 recovery block을 남긴다 |
| 과거 version 또는 다른 transaction의 Asset 참조 | current만으로 삭제 가능성을 판단했다 | 모든 version과 다른 transaction previous·next까지 검사하고 하나라도 참조하면 삭제를 중단한다 |
| 불완전한 Initial Create final | current 일부만으로 create journal을 정리할 수 있었다 | current·version 0·전체 version·Asset·관리 디렉터리 완전성을 증명하지 못하면 final과 journal을 보존한다 |
| Project 하위 symlink | 문자열상 root 안의 경로가 외부를 가리킬 수 있었다 | canonical root, component `lstat`·`realpath`, regular-file 검사와 `O_NOFOLLOW`로 read·write·link·delete를 거부한다 |
| 복구 실패 뒤 다음 mutation | 초기화가 끝난 instance가 불확실한 상태 위에 revision을 쌓을 수 있었다 | 프로젝트별 marker를 영속하고 모든 mutation을 `STORE_RECOVERY_BLOCKED`로 거부한다 |
| Audio Worker 대기열 | 대기 job과 Buffer가 제한 없이 쌓일 수 있었다 | job 수·입력 byte·queue timeout을 제한하고 모든 종료 경로에서 예약량을 반환한다 |
| Source Update 복수 Cue | 첫 후보를 고르지 않아도 원인과 후보가 보이지 않았다 | missing·ambiguous Issue에 Shot, Unit, Cue, Mapping Decision과 해결 방향을 넣는다 |

## 3. Update Preflight

`ProjectStore.update()`는 current revision과 current snapshot을 확인한 뒤 transform 결과를 검증한다. 다음 revision final 경로, 모든 신규 Asset final 경로, Asset ID·경로 중복, AssetWrite와 metadata 1:1, SHA-256, 실제 미디어 구조, final parent가 symlink가 아닌 실제 디렉터리인지 확인한다. recovery marker, lock, 미해결 transaction도 mutation 전에 차단한다.

검사를 모두 통과한 뒤에만 lock, transaction staging과 journal을 만든다. Version 또는 Asset 충돌은 current와 revision을 바꾸지 않고 final Asset, final version, journal을 만들지 않으며 기존 파일을 삭제하지 않는다.

## 4. Transaction Ownership

Journal version 3은 이전·다음 Project, revision과 각 Asset의 staged·final 상대경로, SHA-256과 게시 phase를 기록한다. Asset과 version은 덮어쓰기 없는 hard link로 게시하고 staged 파일은 commit cleanup까지 유지한다. current의 원자 교체가 commit point다. Phase는 복구 진행을 설명하지만 단독 소유권 증거로 사용하지 않는다.

Rollback은 staged와 final이 모두 regular file이고 journal hash가 일치하며 `stat.dev`·`stat.ino`가 같은 경우에만 transaction-owned로 판정한다. 먼저 소유가 증명된 next version을 제거하고, current, version 0을 포함한 모든 `versions/*.json`, 다른 `.transactions`의 previous·next Project를 파싱해 Asset ID와 경로 참조를 모은다. malformed version, Project ID·revision·파일명 불일치, symlink, 다른 inode, 다른 참조가 있으면 final을 보존하고 `STORE_RECOVERY_REQUIRED`로 차단한다.

Current가 next인데 commit이 불완전하면 current next와 staged previous를 증명하고 current를 previous로 먼저 원자 복원한다. 그 뒤 version과 Asset을 같은 규칙으로 처리한다. version 2 journal은 final 게시물이 없는 rollback 또는 current·version·Asset이 완전한 commit만 자동 처리한다. inode 증명이 없는 v2 rollback 대상은 hash가 같아도 삭제하지 않는다.

## 5. Initial Create

Create transaction은 전용 staging에서 version 0, current, assets와 update transaction 디렉터리를 만든 뒤 Project 디렉터리를 rename으로 게시한다. 복구는 final 디렉터리 이름, regular current, current revision snapshot, version 0, 모든 version의 이름·revision·Project ID·내용, 참조 Asset의 hash·MIME·구조, 필수 관리 디렉터리와 알 수 없는 항목 부재를 확인한다.

Final이 없으면 검증한 자기 staging만 제거하고 `create-rolled-back`으로 기록한다. journal hash와 같은 완전한 final은 `create-committed`로 유지한다. hash가 달라도 같은 Project ID의 별도 완전한 create 결과이면 final을 보존하고 자기 staging만 `create-superseded`로 정리한다. 불완전한 final은 삭제하거나 journal을 정리하지 않고 `STORE_CREATE_RECOVERY_REQUIRED` marker를 남긴다. 같은 복구를 반복해도 증명된 파일 외의 상태는 바뀌지 않는다.

## 6. Symlink Safety

`SafeStoreFilesystem`은 설정된 data root를 한 번 canonical path로 해석하고 모든 관리 경로가 그 아래인지 확인한다. 기존 component와 parent는 `lstat`·`realpath`로 실제 디렉터리인지 검사하고, 파일은 regular file만 허용한다. read와 exclusive write에는 지원되는 macOS·Ubuntu에서 `O_NOFOLLOW`를 사용한다. Hard link는 source identity와 target parent를 확인하며 unlink 직전에 path, hash와 identity를 다시 확인한다.

Asset 디렉터리·파일, versions, transaction, create staging symlink는 거부된다. 복구 중 symlink가 발견되면 link target을 읽거나 삭제하지 않고 block을 남긴다. 이 계약은 macOS와 Ubuntu의 로컬 파일 시스템을 대상으로 하며 SMB·NFS의 분산 lock·rename 의미를 보장하지 않는다.

## 7. Recovery Block

소유권·참조·경로·journal·lock·current/version 완전성을 증명하지 못하면 `.recovery-blocks`에 Project ID, transaction, 오류 코드·메시지와 시각을 저장한다. unresolved transaction과 안전하지 않은 lock은 그대로 둔다. 같은 `ProjectStore`와 재시작한 다른 instance의 update, Source Update, Asset upload, Audio normalize, Codex apply와 편집 mutation은 `STORE_RECOVERY_BLOCKED`로 끝난다.

다른 Project의 mutation은 계속할 수 있다. Current를 정상 파싱하고 안전 출력 검사를 통과하는 read-only 경로도 사용할 수 있다. `/api/status.storageRecoveryBlocks`가 현재 차단을 표시한다. 프로세스 재시작에서 같은 recovery를 다시 실행해 성공한 경우에만 marker, transaction과 lock을 정리한다.

## 8. Worker Queue

기본값은 Worker 2개, 대기 job 4개, 실행·대기 입력 예약량 100MB, queue 대기 30초, Worker 실행 30초다. V8 old generation 96MB, young generation 16MB, stack 4MB도 적용한다. job 또는 byte 한도 초과는 `AUDIO_NORMALIZATION_QUEUE_FULL`, 시작 전 queue timeout은 `AUDIO_NORMALIZATION_QUEUE_TIMEOUT`, 실행 timeout은 `AUDIO_NORMALIZATION_TIMEOUT`이다.

완료, Worker 오류·exit·시작 실패, queue timeout과 close에서 예약 byte를 한 번만 반환한다. 시작 실패 뒤 다음 job을 계속 drain한다. `close()`는 queue timer를 취소하고 대기 job을 거부하며 active Worker를 종료한다. Fastify `onClose`와 Codex speech CLI의 `finally`가 이를 호출한다. 실제 약 46MB PCM24 multipart 업로드가 처리되는 동안 먼저 완료된 `/api/status` 200으로 Event Loop 진행을 검증했다.

## 9. Fault Injection

Fault injector는 constructor dependency로만 전달되며 production 기본값은 비활성이다. `SimulatedStorageCrash`는 writer catch rollback과 정상 lock cleanup을 건너뛰어 process 종료 disk 상태를 남긴다.

| Fault point | 중단 시 상태 | 새 Store instance 결과 |
|---|---|---|
| `after-update-preflight` | current=previous, lock, journal 없음 | stale lock 제거, previous 유지 |
| `after-update-journal-prepared` | current=previous, staged journal, final 없음 | staging rollback, previous 유지 |
| `after-update-asset-linked` | current=previous, owned Asset, journal·lock | 참조와 identity를 확인해 owned Asset 제거 |
| `after-update-version-linked` | current=previous, owned Asset·version | version을 먼저 제거하고 참조 검사 후 Asset 제거 |
| `after-update-current-published` | current=next, 완전한 version·Asset | commit 보존, staging·journal·lock 정리 |
| `before-update-cleanup` | 검증된 next와 staging | commit 보존, cleanup 완료 |
| `after-create-journal-prepared` | create journal, final 없음 | 자기 staging rollback |
| `after-create-version-zero-written` | staging version 0, final 없음 | 자기 staging rollback |
| `after-create-current-written` | 완성된 staging, final 없음 | 자기 staging rollback |
| `before-create-directory-publish` | 완성된 staging, final 없음 | 자기 staging rollback |
| `after-create-directory-publish` | 완전한 final과 create journal | final 보존, journal cleanup |
| `before-create-cleanup` | 검증된 final과 create journal | final 보존, cleanup 완료 |

수동 disk fixture는 기존 v2 journal과 의도적으로 손상된 version·symlink·다른 inode를 구성하는 데 사용한다. Writer crash 검증은 실제 `ProjectStore.update()`와 `create()`를 호출한 뒤 새 instance에서 disk 결과를 확인한다.

## 10. Source Update

Text 기반 Anchor는 현재 Shot 범위 안에 같은 Source Unit을 가리키는 Cue가 정확히 하나일 때만 다시 확정한다. 후보가 없으면 `MISSING_TEXT_ANCHOR_SOURCE`, 둘 이상이면 `AMBIGUOUS_TEXT_ANCHOR_SOURCE`를 Mapping Review에 추가한다. Issue에는 Shot ID, Source Unit ID, 전체 후보 Cue ID, Mapping Decision ID, `sourceLinks.temporalAnchor`와 하나의 Cue로 확정한 뒤 재생성하라는 해결 방향이 포함된다. 복수 후보의 첫 Cue는 선택하지 않는다.

## 11. PRJ-007

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16
- 전체 시간 1,500,000ms, 원문 변경·gap·overlap 0건
- SEG-024 Gate: FACT-03 1,088,000ms, FACT-02·FACT-09 1,108,000ms, FACT-10 1,148,000ms
- UNIT-045: `SEG-019 / SOUND`, 849,000–851,000ms J-cut, 경계 850,000ms
- 실제 WAV: PCM16 mono 48,000Hz, 2,000ms
- ProjectStore 저장, safe Audio HTTP bytes, Information Gate 불변, JSON round-trip 통과

## 12. 테스트 결과

- `npm test`: 25개 파일, 413개 테스트 통과
- Storage safety: 74개 통과. 필수 A–F·H 이름 71개와 12개 fault point 전체를 위한 3개 보강 검사다.
- Worker queue: 11개 통과
- Source Update 진단: 필수 6개 통과
- PRJ-007 지정 회귀: 필수 7개와 기존 Golden 19개 통과
- 요구된 95개 테스트 이름이 모두 존재하며 `skip`·`only`는 없다.
- `npm run schemas:write`, `npm run typecheck`, `npm run typecheck:web`, `npm run schemas:check`, `npm run build:web`, 통합 `npm run check`가 모두 통과했다. 통합 검사에서도 25개 파일의 413개 테스트를 실행했다.
- 임시 data root와 Fastify inject로 `/`, `/api/status`, native-v1 Import, revision Update, 실제 WAV 등록과 Safe Audio, version 충돌 409, 영속 Recovery Block과 mutation 차단, Worker Queue 초과를 확인했다. 기존 4317 프로세스는 사용하거나 종료하지 않았다.

## 13. CI

- 구현 Push HEAD: `62b7eb7e170fd8d8ffaab6c96bcaefe3bd7cdcfa`
- Workflow Run ID: [`34030880925`](https://github.com/zzocojoa/storyboard-generator/actions/runs/34030880925)
- Run Head SHA: `62b7eb7e170fd8d8ffaab6c96bcaefe3bd7cdcfa`
- Result: `success`
- 환경과 명령: Ubuntu 24.04, Node.js 24, `npm ci`, `npm run check`
- CI 검사량: 25개 Test File, 413개 Test, Storage safety 74개, Worker queue 11개

구현 commit과 같은 SHA의 CI 결과다. feature branch에만 push했으며 master에는 병합하지 않았다.

## 14. 남은 위험

- 파일 시스템 계약은 macOS·Ubuntu 로컬 저장소를 대상으로 한다. SMB·NFS 분산 lock과 모든 외부 process race를 보장하지 않는다.
- 지원 오디오는 PCM WAV이며 MP3, AIFF, 압축 WAV와 mastering 품질 resampler는 범위 밖이다.
- 정보 ID 검사는 bitmap의 간접 암시를 자동 판단하지 못한다. 전체 32개 Segment의 연출, 자막 가독성, 음성 호흡과 제작 가능성은 사람 검토가 필요하다.
- 지원 입력은 `native-v1`, `production-v1`이다. 임의 문서 가져오기, 다중 사용자 협업, 완성 영상 렌더링은 현재 범위가 아니다.
