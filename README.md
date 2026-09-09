# 범용 콘티 제작 도구

구조화된 영상 제작 자료를 검증해 컷 단위 콘티로 만들고, 원문·시간표·생성 자산·검토 상태를 함께 편집하는 로컬 웹 도구다. 작품별 데이터는 입력 어댑터와 프로젝트 저장소로 분리하므로 특정 프로젝트 ID, 인물, 장면 수, 분량이나 영상 모드에 의존하지 않는다.

현재 첫 완성본은 다음 흐름을 지원한다.

- `native-v1` 또는 `production-v1` 입력 패키지 검증과 프로젝트별 저장
- 장면·구간 탐색, 원문 및 제작 지시 확인, 컷 분할·병합·재정렬·수정·전환·잠금·확정
- 축약 자막과 Canonical 원문의 관계 검토, Text Cue 권한 복구·삭제, Shot별 역할 기반 Source Mapping, 공통 정보 출력 Gate
- 화면비·매체·그림 스타일과 인물·장소·소품 기준 이미지 관리
- Codex App 기반 컷 제안, 기준 이미지를 포함한 프레임 생성, 로컬 가이드 음성 생성
- 시작·키·끝 프레임 편집, stale 이미지 보존과 출력 차단, 명시적 `within-segment`·`j-cut`·`l-cut` 오디오, 안전한 그림·자막·음성의 시간순 재생
- 새 원본의 변경 영향 미리보기, 잠긴 컷 충돌 방지, 영향 구간만 갱신
- 프로젝트 JSON, 제작 목록 CSV, A4 가로 그림 콘티 PDF 출력

## 설치와 실행

Node.js 24.6 이상인 24.x와 npm을 사용한다. 최초 설치는 `npm ci`, 이후 실행은 웹 빌드와 서버 시작 순서다.

```sh
npm ci
npm run build:web
npm start
```

브라우저에서 `http://127.0.0.1:4317`을 연다. 프로젝트와 생성 자산은 `.local/data` 아래에 프로젝트별로 분리되며 Git에 포함되지 않는다. 각 변경은 현재본과 별개의 revision JSON으로 저장된다. 최초 Project는 Asset metadata와 Frame 이미지, Audio Cue, Generation Result, Shot 소품, 두 Continuity 목록의 Asset 참조가 모두 없는 경우만 받는다. Asset은 최초 Project 생성 뒤 revision update에서 신규 ID·경로와 실제 파일을 함께 등록한다. 이 조건을 어기면 data root를 만들기 전에 `UNSUPPORTED_INITIAL_PROJECT_ASSETS`로 거부한다. 과거에 정상 저장된 Asset-bearing Project의 읽기·복구·출력은 계속 지원한다.

## 빠른 사용법

1. 왼쪽 **IMPORT PACKAGE**에 `storyboard_handoff.json` 경로를 입력하고 가져온다. 동작 확인용 production 예시는 `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator/tests/fixtures/production/storyboard_handoff.json`이다. 구조화 계약 파일이 없는 `09_PRODUCTION` 폴더 자체는 바로 가져올 수 없다.
2. Scene과 Segment를 선택해 Shot의 시간, 행동, 카메라, Source Link, Frame, Audio Cue와 Text Cue를 검토한다. 종료가 없는 원본 Text Placement는 시작 시각을 유지한 채 종료 시각을 편집하고 **시각 확정**으로 검토를 마친다. `sourced`는 확인된 직접 시각 Source가 컷 전체를 덮어야 하며, `black`은 검은 화면, `hold-previous`는 직전 안전 프레임을 유지한다.
3. **CODEX CUT**, **IMAGE**, **CODEX VOICE**로 생성 요청을 쌓는다. 같은 저장소를 연 Codex App 작업에서 `$storyboard-workbench 대기 중인 콘티 생성 요청을 처리해 주세요.`를 실행한다.
4. 결과가 반영되면 **REFRESH**를 누르고 **시간순 재생**으로 이미지, 음성, 자막과 공개 시점을 확인한다.
5. 생성 완료와 **FINAL READY**를 구분한다. **DRAFT PREVIEW/PDF/CSV**에서 초안을 검토하고, 모든 차단 항목이 해소되면 **FINAL PREVIEW/PDF/CSV**로 출력한다. JSON은 재편집 상태를 보존한다.

`proposed` Text Cue는 Draft에서 `DRAFT · TIMING UNCONFIRMED`로 표시한다. Final에서는 `TEXT_TIMING_CONFIRMATION_REQUIRED`로 차단한다. **시각 확정**은 해당 Cue의 시간 검토 완료이며 원문 권한·Mapping·정보 Gate·자산·다른 컷의 안전성까지 승인하는 동작은 아니다. Draft도 미해결 Mapping, 종료 시각 부재와 Gate 위반의 본문은 출력하지 않는다.

`GET /api/projects/:id/final-readiness`는 현재 Project와 실제 자산 검사에서 `generated → reviewed → text-confirmed → visual-timeline-safe → final-ready` 단계와 차단 Issue를 계산한다. 모든 컷 승인, 필요한 Frame 승인, Text 확정, 전체 시각 구간, 실제 Audio와 현재 출력 자산이 통과해야 Final Ready다. CSV·PDF의 `?maturity=final`은 조건 미달 시 파일 대신 모든 Issue를 포함한 `FINAL_OUTPUT_NOT_READY` 409를 반환한다. Query 생략은 하위 호환 Draft다.

Program Monitor와 `GET /api/projects/:id/output/visual?atMs=1000&channel=program-monitor`는 실제 정수 Playhead의 활성 Source를 검사한다. 과거 Frame이 안전했어도 현재 Source 공백에서는 표시하지 않는다. `black`은 자산 없는 검은 화면이며 `hold-previous`는 인접한 이전 컷의 `endMs - 1` 안전 출력에서 실제 원본까지 추적한다. 전환 미리보기도 실제 노출 시각의 Gate를 검사한다. 수동 Source 수정·이동은 양쪽 컷의 신규·확대 공백을 거부하고 기존 공백의 축소는 허용한다. 공백 컷과 첫 컷·비인접 Hold는 승인할 수 없다.

Visual Mode와 Source Links·Anchor는 Inspector의 **VISUAL PLAN**에서 함께 편집하고 한 번에 저장한다. `PATCH /api/projects/:id/shots/:shotId/visual-plan`에 `expectedRevision`과 `{ visualMode, sourceLinks }`를 보낸다. 성공은 revision 하나만 추가하고 Shot을 proposed, Frame을 pending으로 돌리며 기존 Asset·Record를 보존한다. 실패는 부분 변경을 남기지 않는다. 기존 Content API의 Mode 단독 변경은 `VISUAL_PLAN_ATOMIC_UPDATE_REQUIRED`다. 최초 시각 공개는 배열 순서 대신 같은 Segment의 Unit별 가장 이른 확정 Anchor 시각으로 검사한다. 동시 공개와 이후 재등장은 순서 역전이 아니다.

Transition은 `cut`·`fade`에서 Incoming을 미리 노출하지 않는다. `fade`는 fade-to-black이며 `dissolve`·`wipe`·`match-cut`은 전환 시작부터, 명시적 `after-black-midpoint`는 중간 이후 노출로 검사한다. `custom`은 명시적 정책 없이는 차단한다. Monitor·승인·제안·Final 출력은 같은 노출 시각 정책을 사용한다. 이는 안전성 계약이며 완성 영상의 Blend 렌더러를 제공한다는 뜻은 아니다.

`/api/status`는 조회마다 외부 Process가 새로 만든 Create·Update Lock을 탐색하고 손상 Entry를 Project별로 보고한다. 살아 있는 다른 Process의 Lock을 임의 삭제하지 않는다. 목록 Summary만 최대 1,024개 Asset Integrity Cache를 사용하며 revision·Asset metadata·파일 identity/size/mtime/ctime 변경 시 다시 검사한다. Final Readiness·PDF/CSV·Bundle·Safe Visual/Frame/Audio·Asset 다운로드·생성 Reference는 매번 실제 hash와 decoding을 검사한다.

서버 상태와 저장 복구 상태는 `GET /api/status`, 현재 출력 자산 검사는 `GET /api/projects/:projectId/asset-integrity`, 생성 이력은 `GET /api/projects/:projectId/generation-audit`에서 확인한다.

이후 저장은 journal version 3과 lock version 3을 사용한다. Lock에는 host·PID와 함께 한 Node.js process에서 공유하는 `processInstanceId`, process 시작 시각을 기록한다. `<dataRoot>/.process-instances`의 heartbeat가 같은 process임을 증명할 때만 live owner로 판정하며, PID가 살아 있어도 Registry가 없거나 오래됐거나 일치하지 않으면 lock을 자동 삭제하지 않는다. 협력하는 writer는 Project lock을 원자적으로 먼저 얻은 뒤 current와 같은 revision snapshot을 읽고, `expectedRevision`, transform, Asset catalog와 모든 Asset 외래 키의 존재·종류·대상을 검사한 다음 실제 파일을 검증한다. journal을 만들기 직전에 lock 소유권과 current revision·SHA-256·게시 경로를 다시 확인한다. 다른 writer가 lock을 보유하면 `PROJECT_BUSY`, 먼저 끝난 writer 때문에 revision이 바뀌었으면 `REVISION_CONFLICT`이며 둘 다 HTTP 409다. 자동 대기 queue는 두지 않는다.

Initial Create는 transaction ID를 만든 직후 `<dataRoot>/.create-locks/<sha256(projectId)>.lock`을 `O_EXCL`로 획득하고, 그 뒤에만 final 위치를 다시 확인하고 staging과 journal을 만든다. 같은 Project ID의 다른 Create는 `PROJECT_BUSY`, 먼저 완료된 Project를 다시 불러오면 `PROJECT_ALREADY_EXISTS`이며 둘 다 HTTP 409다. 서로 다른 Project ID는 각자 다른 root lock을 사용한다. staging의 final `write.lock`은 root lock과 Project ID·transaction ID·host·PID를 공유한다. Current와 Version 0 검증, create journal 정리가 끝나면 final lock을 먼저 제거하고 root lock을 마지막으로 제거한다. 정상 경쟁은 staging이나 recovery marker를 남기지 않는다.

시작 복구는 `.create-locks`도 검사한다. Root lock은 자신의 transaction ID 경로에 있는 journal만 직접 읽는다. 관련 없는 손상 journal은 Project ID를 증명할 수 있으면 그 Project에, 증명할 수 없으면 transaction ID 기반 unknown recovery entry에 격리한다. 같은 Host의 살아 있는 Initial Create와 일반 Update는 해당 Project의 `activeCreates` 또는 `activeUpdates`에만 기록하므로 다른 Project의 목록·읽기·수정·생성을 막지 않는다. 종료된 owner의 root lock은 matching create journal과 final lock을 검증해 commit 또는 rollback을 끝낸 뒤 제거한다. journal이 없는 pre-journal 중단과 완전한 final은 안전하게 정리하고, 다른 Host·손상된 lock·transaction 불일치는 lock을 보존한 채 해당 Project에 recovery marker를 남긴다. 기존 lock version 2와 journal version 2·3은 보수적으로 읽는다. 형식·파일명·내용이 잘못된 recovery marker는 `.recovery-blocks/.invalid`로 격리하고 `/api/status.invalidRecoveryMarkers`에 보고한다. 운영자는 상태 응답의 원인과 원래 파일명을 확인하고 저장본을 수리한 뒤 서버를 다시 시작해야 하며 marker를 수동 삭제해 차단을 우회하지 않는다.

Asset catalog와 Generation Record는 append-only다. 같은 Asset ID의 metadata 전체는 revision 사이에서 바꿀 수 없고 기존 Asset을 제거하거나 기존 경로에 새 write를 제출할 수 없다. 기존 Generation Record도 삭제·재정렬하거나 provider·model·prompt·result asset·shot·생성 시각을 포함한 어떤 metadata도 바꿀 수 없으며 새 Record는 배열 끝에만 추가한다. 기존 Record의 `shotIds`는 생성 당시 revision의 Historical Reference이므로 병합·재제안·원본 갱신으로 현재 Shot이 사라져도 유효하다. 신규 Record만 같은 next revision에서 Shot과 result Asset이 실제로 존재하는지 검사한다. 내부 ID 배열과 non-null request ID의 중복도 신규 Record에서 거부하며, legacy 중복은 감사 warning으로 보고한다. `/api/projects/:projectId/generation-audit`는 version snapshot을 읽어 도입 revision과 current·historical·unresolved 상태를 반환한다.

중앙 참조 정책은 Frame→image/frame ID, Audio Cue→audio/cue ID, Shot propIds→prop, Continuity→character·location·prop, Generation Result→현재 다섯 Asset 종류의 존재를 검사한다. 교체는 신규 Asset ID·경로·version·실제 write를 추가하고 참조를 새 ID로 옮기며, 이전 Asset metadata와 파일은 감사용으로 보존한다. Asset과 revision은 덮어쓰기 없는 hard link로 게시한다. staging hard link는 commit 정리까지 유지하며 rollback은 staging과 final의 `dev`·`ino`, journal SHA-256, current·모든 version·다른 transaction의 참조를 함께 확인한 뒤 자기 파일만 삭제한다. 기존 journal version 2는 완료 상태가 증명되거나 게시 파일이 없는 경우만 자동 복구한다. 소유권·참조·경로가 모호하면 파일과 lock 또는 transaction을 보존하고 프로젝트별 recovery marker를 남긴다. 복구 결과와 차단 상태는 `/api/status`의 `storageRecovery`, `storageRecoveryBlocks`와 구조화 로그에서 확인한다.

API 오류는 `code`, `message`, `issues`와 함께 `category`, `scope`, `projectId`, `resourceId`, `mutationBlocked`, `retryable`, `operatorActionRequired`를 반환한다. 신규 Generation Record의 없는 Shot과 Asset 참조는 400, 명시적으로 정의한 없는 리소스만 404, Busy·revision 충돌·이미 존재하는 Project는 409, 저장 복구가 필요한 Project와 저장된 자산 무결성 오류는 423, 일시적인 lock 획득 실패는 503, 분류되지 않은 서버 오류는 500이다. Project 복구 423만 해당 Project의 변경을 잠그고 **STORAGE RECOVERY REQUIRED**를 표시한다. Asset 423은 해당 출력만 막고 **ASSET REPAIR REQUIRED**를 표시한다. 둘 다 자동 재시도하지 않으며 503은 영속 잠금 없이 **STORAGE TEMPORARILY UNAVAILABLE**로 표시한다.

웹 화면의 Audio Cue에서 PCM WAV를 선택하면 `multipart/form-data`로 서버에 등록한다. mono/stereo, 16/24-bit PCM WAV를 최대 50MB·1시간까지 읽고, 실제 구조·MIME·길이·sample rate·채널·codec·SHA-256을 확인한 뒤 프로젝트의 `handoff.timebase.sampleRate`에 맞춘 16-bit PCM WAV로 저장한다. 입력 sample rate, WAV chunk 수, 출력 Frame·Byte·Sample 연산량을 Buffer 할당 전에 제한한다. 변환은 설정된 수의 Worker Thread에서 실행한다. 기본 설정은 동시 Worker 2개, 대기 4개, 실행·대기 입력 합계 100MB, queue 대기 30초, Worker 실행 30초다. 초과 요청은 `AUDIO_NORMALIZATION_QUEUE_FULL`, 시작하지 못한 대기 요청은 `AUDIO_NORMALIZATION_QUEUE_TIMEOUT`으로 거부한다. 완료·실패·timeout 때 예약 byte를 반환하고 서버 종료 시 대기 요청과 Worker를 정리한다. AIFF와 MP3는 현재 `UNSUPPORTED_AUDIO_CONTAINER` 또는 `UNSUPPORTED_AUDIO_CODEC`으로 거부한다. 변환이 실패하거나 시간 제한을 넘으면 프로젝트 revision과 자산 파일은 바뀌지 않는다.

Safe Audio는 전체 파일 무결성 검사 뒤 단일 Range를 제공한다. 정상 전체 요청은 200, 부분 요청은 206이다. 잘못되거나 여러 개인 Range는 416과 `Content-Range: bytes */<full-size>`, `Accept-Ranges: bytes`, `Cache-Control: no-store`를 반환한다.

이전 저장본의 WAV가 유효하지만 프로젝트 sample rate나 PCM16 형식과 다르면 손상으로 숨기지 않고 `AUDIO REPAIR`로 표시한다. Audio Cue의 **WAV 정규화 복구**는 원본 Asset과 파일을 보존하고, 실제 WAV에서 읽은 길이·형식을 적용한 새 Asset 버전을 만든다. Program Monitor 재생은 Cue 종료점에 도달하면 Audio를 멈추며 일시정지, playhead 탐색, 프로젝트 전환, revision 변경 때 이전 Audio와 늦게 끝난 재생 Promise를 정리한다.

이미지 검사는 `sharp` 0.35.4(Apache-2.0)를 사용해 PNG·JPEG·WebP 전체를 디코딩하고 크기와 픽셀 상한을 확인한다. `@fastify/multipart` 10.1.1(MIT)은 Node.js 기반 업로드 크기와 파일 수를 제한한다. 두 패키지는 macOS와 Linux용 배포 패키지를 사용하며 별도 `ffmpeg`나 `afconvert`를 오디오 가져오기 런타임으로 요구하지 않는다. 설치 또는 디코딩이 실패하면 등록을 성공으로 처리하지 않고 구체적인 자산 오류를 반환한다.

생성은 서버가 외부 API를 직접 호출하지 않는다. 화면에서 `CODEX CUT`, `IMAGE`, `CODEX VOICE`를 누르면 `.local/codex-requests`에 요청이 저장된다. 같은 저장소의 Codex App 작업에서 다음 스킬을 실행한다.

```sh
$storyboard-workbench 대기 중인 콘티 생성 요청을 처리해 주세요.
```

저장소 스킬 [storyboard-workbench](.agents/skills/storyboard-workbench/SKILL.md)이 현재 Codex 모델로 컷 JSON을 작성하고, 내장 `image_gen`으로 그림을 만들고, macOS `say`의 한국어 음성을 WAV로 변환해 프로젝트에 반영한다. `OPENAI_API_KEY`와 OpenAI SDK는 사용하지 않는다. 생성 중에도 웹 편집은 계속할 수 있으며, 결과 반영 후 화면의 `REFRESH`를 누르면 새 프로젝트 revision을 읽는다.

요청 위치, 로컬 음성, Audio Worker·queue 수, 예약 byte, queue·실행 timeout과 메모리 한도는 [`storyboard.config.json`](storyboard.config.json)에서 관리한다. 요청에는 대상 원문·컷·시각 기준의 해시가 들어간다. 요청 뒤 대상이 바뀌면 Codex 결과 적용을 거부하고 새 요청을 요구한다. 화면 상단의 Codex 상태에서 완료·대기·실패, 평균·최대 처리 시간, 같은 대상의 반복 생성 횟수와 최근 실패 원인을 확인한다. Codex App은 요청별 API 비용을 제공하지 않으므로 비용은 0으로 기록하지 않고 `N/A`로 표시한다.

## 프로젝트 불러오기

웹 화면의 `IMPORT PACKAGE`에 `storyboard_handoff.json`의 절대경로 또는 저장소 루트 기준 상대경로를 입력한다. 입력 계약은 파일 역할·상대경로·필수 여부·해시 방식·필드별 기준 원본과 제작 설정을 명시한다.

- [`storyboard_handoff.schema.json`](schemas/storyboard_handoff.schema.json): 입력 패키지 계약
- [`native_dataset.schema.json`](schemas/native_dataset.schema.json): 범용 원본 데이터 계약
- [`storyboard_project.schema.json`](schemas/storyboard_project.schema.json): 재편집 프로젝트 계약
- [검증 fixture 설명](tests/fixtures/README.md): 합성 범용 사례와 초기 실제 회귀 사례의 구분

`native-v1`은 한 개의 공통 데이터 파일을 읽는다. `production-v1`은 구조화 대본·시간표·인물·장면과 제작 문서 역할을 명시적으로 연결한다. 형식 전용 파일명과 필드는 각 어댑터 안에서만 처리한다. 구조화 원본이 없는 임의 문서는 현재 지원하지 않으며 파싱 실패 시 추론 기반 가져오기로 전환하지 않는다.

파일 경로는 패키지 루트 안으로 제한한다. `bytes-sha256`은 UTF-8 파일 바이트를 검사하고, `sorted-json-sha256`은 유니코드 코드 포인트 순으로 키를 정렬한 공백 없는 JSON을 검사한다. 필수 파일 누락, 해시 불일치, 끊어진 참조, 미지원 버전은 구체적인 오류로 끝난다. 문구나 선언의 제작상 차이는 원문을 고치지 않고 검토 항목으로 보존한다.

자막 Placement마다 `TextMappingDecision`이 생긴다. 문자열이 정확히 같으면 `exact/confirmed`, 축약 후보나 독립 요소가 감지되면 `unresolved`로 시작한다. `separate-element`와 `standalone-placement`에는 별도의 `TextPlacementInformationDecision`이 필요하다. `unresolved`는 출력을 차단하고, 사용자가 `non-informational`로 확인하거나 하나 이상의 Information ID를 가진 `informational`로 확정해야 출력할 수 있다. `separate-element`에서는 Placement Cue와 Canonical Cue가 서로 다른 화면 요소와 시각을 유지하며 Placement가 Canonical 정보 ID를 상속하지 않는다. Mapping 결정이 없거나 중복되거나 미해결이면 Placement 본문은 Program Monitor·PDF·CSV 안전 출력에서 차단된다. Migration에서 권한을 확정하지 못한 Text Cue는 Inspector에서 Placement, Mapping Decision, Source Unit 중 하나로 원문 기반 복구하거나 필수 커버리지를 해치지 않는 경우 삭제할 수 있다.

각 컷은 `sourceLinks`를 권한 원본으로 사용한다. Link는 `primary-visual`, `continued-visual`, `audio-only`, `context-only` 용도와 `confirmed`, `mapping-required` 상태, 컷 안에서 처음 유효해지는 `temporalAnchor`를 가진다. Anchor는 컷 상대 반열린 구간이나 특정 프레임으로 확정하거나 검토 필요 상태로 둘 수 있다. Anchor에 연결된 프레임 시각을 바꾸면 해당 Link와 승인을 자동으로 재검토 상태로 돌린다. 수동 분할에서 시간 근거가 없는 원문은 한쪽 후보에만 배치되고 `mapping-required`로 표시된다. Inspector의 **TEXT MAPPING REVIEW**, **SOURCE TEMPORAL MAPPING**, **INFORMATION GATE**에서 절대 공개 시각, Gate 비교 결과, 관계·용도·상태와 기준/유효 공개 시점을 검토하고 같은 구간의 앞뒤 컷으로 연결을 이동할 수 있다.

Codex 컷 제안의 선택적 `sourceLinks[].anchor`는 `startPermille`, `endPermille`로 컷 내부 상대 범위를 표현한다. 범위는 `0 ≤ start < end ≤ 1000`이고, 생략하면 기존처럼 컷 전체를 사용한다. 컷 길이를 weight로 배분한 뒤 시작은 내림, 끝은 올림해 최소 1ms의 실제 offset으로 바꾼다. Information Gate와 원문 순서는 컷 시작이 아니라 이 실제 anchor 시작 시각으로 검사하며, 앞 프레임의 이미지 문맥에는 아직 시작하지 않은 source와 정보가 들어가지 않는다. 웹·CSV·PDF의 시간 표시는 프로젝트 timebase의 정수 프레임 산술을 공유하므로 PRJ-007의 500ms는 24fps 기준 `00:00:12`다.

Source Update 뒤 Text 기반 Anchor 후보가 없으면 `MISSING_TEXT_ANCHOR_SOURCE`, 둘 이상이면 `AMBIGUOUS_TEXT_ANCHOR_SOURCE`가 Mapping Review에 표시된다. Issue에는 Shot·Source Unit, 후보 Cue와 Mapping Decision ID, 대상 필드와 해결 방향이 들어가며 복수 후보의 첫 항목을 자동 선택하지 않는다.

## CLI

브라우저 없이 가져오기·검증·JSON/CSV 출력을 확인할 수 있다.

```sh
npm run cli -- --help
npm run cli -- outline --handoff tests/fixtures/native/storyboard_handoff.json --output .local/plant-care.project.json --text-hold-ms 3000
npm run cli -- validate --project .local/plant-care.project.json
npm run cli -- export-csv --project .local/plant-care.project.json --output .local/plant-care.shots.csv
```

`outline`은 구간마다 편집 시작용 컷과 프레임을 만든다. 카메라·화면 위치·출연 인물을 임의로 확정하지 않는다. 음성 슬롯은 글자 수에 비례한 제안 시간이며 생성한 가이드 음성의 WAV 길이와 선언한 구간 관계를 검증한 뒤 `measured` 상태가 된다. `j-cut`은 바로 앞 구간부터 원본 구간 안까지, `l-cut`은 원본 구간부터 바로 다음 구간까지만 걸칠 수 있다. 두 관계는 정보 Gate를 앞당기는 증거로 사용하지 않는다. 원본에 화면 글자 종료점이 없으면 `--text-hold-ms` 값이 제안값으로 기록된다. `proposed` 글자 큐는 안전 미리보기와 초안 내보내기에 포함되며, 최종 편집 완료 전에는 Inspector에서 종료 시각을 검토하고 `confirmed`로 확정한다. 기존 출력 경로를 덮어쓰지 않는다.

현재 프로젝트 형식은 `1.9.0`이다. 이전 저장본은 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.5.0 → 1.6.0 → 1.7.0 → 1.8.0 → 1.9.0` 순서로 메모리에서 변환한다. 1.5 Shot은 `visualMode: sourced`, 이전 Generation Record는 `generatorBuild: null`로 이관한다. 원문·ID·시간·Anchor·Frame·Text·Audio·Asset과 기존 생성 metadata는 보존하며 Version 파일을 재작성하지 않는다. 기존 `frame` Anchor는 공개 시점만 증명한다. 표시 구간은 명시적 `frame-range`의 `endOffsetMs` 또는 `shot-offset`으로 확정해야 하며 1ms 구간이나 다음 Frame까지로 추측하지 않는다. 구간 미확정은 `SOURCE_VISUAL_INTERVAL_REQUIRED`와 Coverage Gap으로 차단한다.

## Build와 읽기 전용 검토 번들

`npm run build:manifest`는 `.build/build-manifest.json`에 provenanceVersion 3을 작성한다. Project Journal/Lock은 3/3, Process Registry는 1, Request Schema/Apply Intent는 2/1, Request Journal/Lock은 2/1이다. `headCommitSha`는 dirty여도 실제 HEAD를 유지한다. `worktreeDirty`는 전체 Git 상태, `generationInputsDirty`는 생성 계약 입력의 변경 여부이며 `commitSha`는 HEAD의 deprecated alias다. Git 조회가 모두 성공하면 `gitStateAvailable=true`이고 두 dirty 값은 실제 상태다. HEAD만 성공하면 HEAD를 보존하고 availability=false·dirty=null을 기록한다. Git 자체를 읽지 못하면 HEAD도 null이다. 환경의 Commit SHA로 clean을 추정하지 않는다. 런타임은 시작 시 읽은 Build를 고정한다.

Stable Fingerprint는 `sourceTreeSha256`(src·web·package 파일), `generationContractSha256`(Workbench Skill·AGENTS·Codex·Proposal·관련 Domain·Prompt·JSON Schema·lockfile), `runtimeGenerationConfigSha256`(음성·Provider·Audio 출력 설정)과 Project Schema Version이다. 경로는 상대경로 `/`로 정규화하고 정렬한 경로+NUL+bytes+NUL을 해시한다. Runtime 설정은 허용된 비밀 아닌 값만 Stable JSON으로 해시한다. builtAt·PID·Host·절대경로·Secret은 요청 동일성에 사용하지 않는다.

같은 Target·Basis·Fingerprint의 Pending 요청만 재사용한다. 이전 Build의 Pending은 파일을 보존한 `superseded`가 되고 새 ID를 만든다. UI와 Metrics는 이를 일반 실패율에서 제외한다. kind·Project·Target·Basis의 논리 Key Lock 아래에서 재사용·Supersede·Terminal 전이를 직렬화하며 Build는 Lock Key에서 제외한다. 현재 파일 SHA-256 CAS와 Request Journal 2가 중단된 다중 파일 게시를 복구한다. Terminal은 다시 덮지 않으며 알 수 없는 복구 증거는 `CODEX_REQUEST_RECOVERY_REQUIRED` 423으로 보존한다. 상세 오류·fsync·소유권 계약은 Design을 따른다. Context·Apply도 Fingerprint를 검사한다. Project Schema 1.8.0의 1.7→1.8 메모리 Migration은 기존 Build에 알 수 없는 hash·dirty 값을 null로 남기고 Transition의 기존 의미를 명시한다. 1.8→1.9는 과거 Build의 `gitStateAvailable`을 null로 추가하며 이미 저장된 dirty 값을 보존한다. Legacy Project·Request 읽기는 메모리에서 이관하며 디스크와 이전 Record·Version 파일을 현재 Build로 다시 쓰지 않는다.

```sh
npm run review-bundle -- --project-id PRJ-007 --output .local/reviews/PRJ-007-draft --maturity draft
npm run review-bundle -- --data-root /absolute/project-data --project-id PRJ-007 --output .local/reviews/PRJ-007-final --maturity final
```

새 출력 폴더에 기본 **11개 파일**을 만든다: `project.json`, `shots.csv`, `storyboard.pdf`, `final-readiness.json`, `generation-audit.json`, `asset-integrity.json`, `asset-manifest.json`, `build-manifest.json`, `storage-health.json`, `redaction-manifest.json`, `bundle-manifest.json`. 체크섬 Manifest에는 자신을 제외한 10개 파일의 SHA-256·크기를 기록한다.

`bundleBuilderBuild`는 번들을 만든 Build이고 `generationBuildSummary`는 실제 생성 Fingerprint별 Record·결과 Asset 수와 legacy/unknown/unlinked 수다. 기존 `build`는 Builder의 deprecated alias다. Asset Manifest는 실제 Generation Record·Build·감사 파일을 연결한다. Version은 숫자로 정렬하고 JSON object key는 안정적으로 직렬화하되 의미 있는 배열 순서는 유지한다. PDF 이미지는 출력용 흰 배경으로 정규화해 비동기 alpha 처리의 객체 순서 차이를 제거한다. 원본 이미지는 보존한다. `--created-at`을 고정한 동일 Snapshot·Build·Font/Renderer의 번들을 재현할 수 있다.

Review Reader는 Lock·Journal·Create Transaction·Recovery/Invalid Evidence·Future Version·Current/Version 일치를 읽기 전용으로 검사한다. Final은 `quiescent=true`도 요구한다. Non-quiescent Draft는 `DRAFT · SOURCE NOT QUIESCENT`와 Storage Health를 담는다. 검토 중 증거가 바뀌면 `REVIEW_SOURCE_NOT_QUIESCENT`로 결과 게시를 거부한다. Canonical 감사가 불가능한 Draft에는 `auditAvailable=false`와 원인을 남긴다.

Profile 기본값은 `internal`이다. 원문·Prompt·경로를 보존하고 PDF에 이미지를 포함한다. 별도 미디어 파일은 `--include-media`에서만 추가한다. `external`은 원본을 변경하지 않는 출력 Projection으로 Source Snapshot Content·Prompt·절대경로·이메일·전화번호·지정 패턴을 JSON·CSV·PDF에서 함께 치환한다. `redaction-manifest.json`은 원문 없이 category·field path·SHA-256·개수를 기록한다. 모든 Artifact Label과 논리적 Bundle 이름에 `EXTERNAL REDACTED`를 표시한다. External Project Projection은 재편집 Project 입력이 아니다.

```sh
npm run review-bundle -- --project-id PRJ-007 --output .local/reviews/internal-draft --maturity draft --profile internal
npm run review-bundle -- --project-id PRJ-007 --output '.local/reviews/EXTERNAL REDACTED' --maturity draft --profile external --redact-pattern 'VIP-[0-9]{4}'
```

External은 `--include-media`를 거부하고 PDF의 원본 이미지를 Placeholder로 바꾼다. `externalImagePolicy: placeholder`, `embeddedImageRedaction: not-performed`를 명시하며 OCR 검토 완료를 주장하지 않는다. 사용자가 추가 패턴을 지정할 수 있으나 개인정보의 문맥적 완전 제거까지 자동 보장하지 않는다.

번들 CLI는 원본에 lock·heartbeat·복구·mkdir을 실행하지 않는다. 출력 Parent에 대상 hash 기반 Claim 1을 원자 공개해 같은 출력의 협력 Writer 중 하나만 게시한다. 기존 출력·Live Claim은 `REVIEW_BUNDLE_EXISTS` 409, 알 수 없거나 중단된 Claim은 `REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED` 423과 운영자 조치를 요구한다. 본인 staging·claim만 정리하며 기존 Bundle은 덮지 않는다. 원본 Data Root 안의 출력 경로와 기존 출력 폴더를 거부하고, Project·전체 Version·자산의 변경을 검출한다. Final 불가 상태에서는 폴더를 생성하지 않는다. Draft 파일은 성숙도를 표시하며 `project.json`의 검토 Envelope도 프로젝트 읽기에서 지원한다. 기존 콘티를 재검증할 때 자동 Confirm·Frame Accept·Asset 교체를 하지 않는다. 실제 저장본별 결과와 회귀 fixture의 차이는 [검증 보고서](docs/04-report/storyboard-generator.report.md)에서 확인한다.

Program Monitor는 상태를 다시 검사하는 `/output/frame/:frameId`와 `/output/audio/:cueId`만 사용한다. 서버는 매 요청에서 파일 존재, 프로젝트 내부 경로, SHA-256, 실제 MIME·디코딩, 대상 연결과 출력 인터록을 확인하며 응답에 `Cache-Control: no-store`를 붙인다. Raw Asset 경로는 검토용이다. `proposed` 음성, 자산·길이 불일치, 권한 미확정 Text Cue, 미해결 정보 규칙, Gate보다 이른 정보는 출력하지 않고 문제 코드와 대상 ID만 표시한다. 손상된 Frame은 PDF 전체를 실패시키지 않고 Frame ID·Asset ID·Issue code가 있는 placeholder로 바뀌며 CSV에는 현재 무결성과 출력 안전 상태가 기록된다.

Codex App 생성 브리지의 현재 요청과 적용 명령은 다음과 같이 확인할 수 있다. 일반 사용에서는 저장소 스킬이 이 명령을 실행한다.

```sh
npm run codex-workbench -- pending
npm run codex-workbench -- context --request <UUID>
npm run codex-workbench -- --help
```

CSV에서 같은 오디오 이벤트가 여러 컷 행에 나타나면 하나의 이벤트 ID를 공유하는 것이며 발화를 반복 생성하지 않는다. 스프레드시트 수식으로 해석될 수 있는 셀은 작은따옴표로 보호한다. 원문 그대로의 교환과 재편집에는 프로젝트 JSON을 사용한다.

### 결과 적용 상태와 복구

Proposal·Image·Speech 등록은 Request 논리 Key 소유권을 먼저 얻고 Project를 저장한다. 적용 중인 요청은 `applying`이며 생성 Pending 목록과 실패율에서 제외된다. Fail·Supersede가 먼저 끝나면 결과 등록을 거부하고, 적용이 먼저 시작되면 경쟁 종결은 `CODEX_REQUEST_APPLY_IN_PROGRESS` 409로 응답한다. `completed`는 결과가 저장됐다는 뜻이며 Text Confirm·Frame Accept·Shot Approval이나 Final Ready를 뜻하지 않는다.

```sh
npm run codex-workbench -- apply-status --request <UUID>
npm run codex-workbench -- reconcile --request <UUID>
```

HTTP는 `GET /api/codex/requests/:requestId/apply-status`, `POST /api/codex/requests/:requestId/reconcile`을 제공한다. Status는 `applying`, `committed-awaiting-request-settlement`, `completed`, `recovery-required`, `evidence-conflict`를 Request·Project ID와 검증된 `committedRevision`으로 구분한다. `/api/status`의 `applyRecovery`와 생성 지표에도 반영한다. App 시작과 일반 Workbench 명령은 중단된 Applying을 정산한다. `apply-status`는 Apply 정산을 실행하지 않고 `reconcile`은 지정한 요청을 처리한다. 두 CLI 모두 일반 저장소 초기화는 수행한다. 원본을 전혀 변경하지 않는 감사에는 Review Bundle의 읽기 전용 경로를 사용한다.

`resultRevision`은 Generation Record가 처음 도입된 검증된 Version이다. 후속 편집의 현재 Revision으로 대체하지 않는다. Commit이 입증되면 입력 파일 없이도 `reconcile`할 수 있으며 Project·Asset·Record를 다시 생성하지 않는다. 동일 Request에 다른 결과를 등록하면 `CODEX_APPLY_RESULT_CONFLICT` 409다. Legacy Proposal·Speech에 입력 동일성 Hash가 없으면 파일 재등록으로 동일성을 추정하지 않고 입력 없는 `reconcile`을 사용한다. 과거 Failed/Superseded와 Record의 공존, 잘못된 Completed Revision, 해석 불가능한 Intent는 423 검토 오류이며 자동 덮어쓰지 않는다. 이 오류는 해당 Request 범위이고 다른 Project 편집을 잠그지 않는다.

로컬 macOS·Ubuntu 파일 시스템의 협력 Writer를 대상으로 한다. 분산 파일 시스템·임의 파일 조작·외부 모델 호출 자체의 최대 1회 실행은 보장 범위에 포함하지 않는다. 저장 계약과 복구 증명은 Design, 실행 결과는 Report를 따른다.

## 검증

```sh
npm run check
```

이 명령은 서버·도메인 타입 검사, 웹 타입 검사, 자동 테스트, 필수 테스트 이름, 생성 스키마 정합성, 운영 웹 빌드를 순서대로 실행한다. 실제 단위·통합·Playwright 실행 수와 Required Registry 결과는 [검증 보고서](docs/04-report/storyboard-generator.report.md)를 기준으로 한다. 실제 `HTMLAudioElement` 6개 시나리오는 WAV 디코딩, metadata, Seek, Cue 종료, Monitor 종료와 Project 전환 정리를 검사하며 Audio API를 대체하지 않는다. PRJ-007 Golden은 12개 Scene, 32개 Segment, 79개 screenplay Source Unit, 16개 Panel Turn, Text Placement 25개, 1,500,000ms와 원문 불변을 확인한다. `UNIT-045` 회귀 fixture는 48,000Hz mono PCM16 WAV 2,000ms와 849,000–851,000ms J-cut을 유지한다.

브라우저와 실제 HTTP 검증은 다음 명령을 사용한다. `npm run smoke`는 임시 data/request root와 동적 포트를 만들고 종료 시 listener, Worker, timer와 임시 파일을 정리한다.

```sh
npx playwright install chromium
npm run test:e2e
npm run smoke
```

자산 수리 후 **REFRESH**를 누르면 웹이 `/asset-integrity`를 다시 조회해 해결된 항목을 제거한다. API 사용자는 같은 endpoint의 `issues`가 빈 배열인지 확인한다.

스키마의 기준은 `src/domain/schema.ts`다. 타입 변경 후 `npm run schemas:write`로 JSON Schema를 갱신하고 `npm run schemas:check`로 일치 여부를 확인한다. 제품 범위와 구현 원칙은 [`AGENTS.md`](AGENTS.md), 데이터 흐름과 API 설계는 [Design](docs/02-design/features/storyboard-generator.design.md)을 따른다.

별도 [Native Audio Stress](.github/workflows/audio-stress.yml)는 Ubuntu·Node 24·Chromium에서 기본 50회, 수동 실행 시 75·100회도 선택한다. Workflow 파일을 변경한 PR에서는 병합 전에 50회를 실행한다. 기본 Branch에 반영된 뒤에는 수동 실행과 주간 schedule을 사용할 수 있다. 일반 PR의 3회 반복·기본 Timeout·Retry 0은 유지한다. 첫 실패에 중단하고 Trace·JSON Summary·브라우저 및 서버 수명 로그를 실패 Artifact로 보존한다. 로컬 실행은 `npm run test:e2e -- tests/e2e/real-audio.spec.ts --repeat-each=50 --max-failures=1 --reporter=list,./scripts/audio-stress-reporter.ts`다. 반복 성공만으로 이전 Linux 간헐 실패의 근본 원인이 해결됐다고 판단하지 않는다.
