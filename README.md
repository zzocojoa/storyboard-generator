# 범용 콘티 제작 도구

구조화된 영상 제작 자료를 검증해 컷 단위 콘티로 만들고, 원문·시간표·생성 자산·검토 상태를 함께 편집하는 로컬 웹 도구다. 작품별 데이터는 입력 어댑터와 프로젝트 저장소로 분리하므로 특정 프로젝트 ID, 인물, 장면 수, 분량이나 영상 모드에 의존하지 않는다.

현재 첫 완성본은 다음 흐름을 지원한다.

- `native-v1`·`production-v1`·`production-documents-v1` 입력 패키지 검증과 프로젝트별 저장
- 스토리별 제작 문서 8개에서 입력 패키지 생성, 연결 검토와 제작 설정 입력
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

1. 왼쪽 **프로젝트 불러오기**에 `storyboard_handoff.json` 경로를 입력하고 가져온다. 동작 확인용 production 예시는 `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator/tests/fixtures/production/storyboard_handoff.json`이다. 제작 문서 8개가 있는 폴더는 아래 **제작 문서 8개로 새 패키지 만들기**에서 먼저 변환한다.
2. **제작 현황**에서 진행 상태와 다음 작업을 확인하고 **제작 설정**에서 제작 방식·그림 스타일·기준 이미지를 정한다. **컷 편집**에서는 장면과 구간을 고른 뒤 오른쪽의 **연출 / 원문 연결 / 그림 / 음성 / 글자**를 사용한다. 컷 연출·원문 연결·프레임·음성 시각/음량·글자 시각/문구 연결·제작 프로필·글자 배치/읽기 기준의 작성 중 입력은 이 브라우저에 보관한다. 새로고침이나 프로젝트 전환 후에도 해당 폼으로 돌아오면 복원하며, 서버에 반영하려면 각 저장 버튼을 누른다. 그동안 서버 revision이 바뀌면 현재 값과 작성 값을 비교해 선택한다. 두 탭에서 각각 수정했다면 사용할 입력을 고른다. 브라우저 저장 공간·권한 오류가 표시되면 현재 값을 복사하고 저장 공간·권한을 복구한다. 파일 선택은 다시 해야 한다.
3. 상단 **자동 제작** 또는 **제작 현황**에서 대상 구간과 실행 한도를 확인하고 **자동 제작 시작**을 누른다. 원문의 음악·환경 음향 검토 → 자동 설정을 선택한 글자 배치 → 비어 있는 제작 기준 → 기준 그림 → 컷·대사·글자 시각 → 콘티 그림을 서버가 설치된 Codex App으로 순서대로 만든다. 기본은 **콘티만 제작**이며, **가이드 음성도 생성**을 선택했을 때만 음성 합성과 실측 배치·음량 계획을 추가한다. **일시 중지 / 이어 만들기 / 실행 취소**로 제어하며 완료 결과는 보존한다. 개별 **Codex 컷 제안 / 그림 요청 / 가이드 음성 요청**은 기존 대기열 방식이며 **Codex로 생성하는 방법**의 작업 문구로 처리한다.
4. 자동 제작의 **생성 결과 불러와 검토**를 누르면 최신 결과를 읽고 미승인 그림이 포함된 초안 재생 화면을 연다. **검토 재생 / 검토 일시 정지**와 탐색 막대로 그림·음성·자막을 확인한다. **이 그림 편집**으로 이동해 **이미지 승인**하거나 **재생성 표시**한다. **음성** 탭에서는 생성된 가이드 음성과 등록한 음향 파일을 개별 재생할 수 있다. 다른 탭·프로젝트로 이동하거나 시간순 미리보기를 열면 개별 재생을 멈춘다. 재생성 표시는 해당 구간의 새 자동 실행에서 처리한다. 이후 **새로고침**을 누르고 하단 **시간순 재생**으로 이미지·음성·자막·공개 시점을 확인한다. 종료가 없는 글자는 **글자**에서 종료 시각을 저장하고 **시각 확정**으로 검토를 마친다. `sourced`는 직접 시각 원문이 컷 전체를 덮어야 하며, `black`은 검은 화면, `hold-previous`는 직전 안전 프레임을 유지한다.
5. **검토·출력**에서 종류별 차단 항목을 펼치고 **편집하기**로 해당 컷·구간에 이동한다. 초안 재생에는 원문·시각·자산 검사를 통과한 미승인 그림도 표시한다. **DRAFT PDF/CSV**는 기존 출력 조건을 충족하는 그림을 사용하고 미승인 그림은 차단 상태로 표시한다. 모든 조건이 통과하면 **FINAL PDF/CSV**가 활성화된다. 프로젝트 JSON은 편집 상태를 보존한다. 상단 Codex 지표는 모든 프로젝트의 요청 상태이며 현재 프로젝트의 완성도와 구분한다. 작은 화면의 프로젝트 목록은 상단 **프로젝트** 버튼으로 연다.

자동 그림 생성에서 인물·공간·소품 기준이 5개를 넘으면 전체 기준 이미지를 번호가 있는 참조 보드로 묶어 전달합니다. 원본은 보존되며 사용자가 따로 합칠 필요는 없습니다. 한 프레임의 원본 참조는 최대 20개·합계 20MiB입니다. 결과 그림의 인물·의상·소품 일관성은 생성 후 검토하세요.

PDF는 프레임마다 새 페이지에서 시작하며 긴 연출·원문·글자·음향 내용을 다음 페이지로 이어서 제공한다. 글자와 음향 목록에는 시작/종료 타임코드와 정확한 ms 범위가 포함된다. 그림 위 글자는 검토 화면과 같은 조판을 사용한다. **검토·출력**에서 용지·방향·상세/그림 목록과 대표/전체 프레임 범위를 선택한다.

`proposed` Text Cue는 Draft에서 `DRAFT · TIMING UNCONFIRMED`로 표시한다. Final에서는 `TEXT_TIMING_CONFIRMATION_REQUIRED`로 차단한다. **시각 확정**은 해당 Cue의 시간 검토 완료이며 원문 권한·Mapping·정보 Gate·자산·다른 컷의 안전성까지 승인하는 동작은 아니다. Draft도 미해결 Mapping, 종료 시각 부재와 Gate 위반의 본문은 출력하지 않는다.

**컷 편집 → 글자**의 독립 정보 선택·검토 메모와 **본문 근거 종류 / 연결할 근거** 입력도 새로고침 후 복원한다. 복원만으로 정보성이나 글자 권한이 확정되지는 않는다. 원본 교체 후 선택했던 근거가 없으면 그 값을 표시하고 저장을 막는다. 새 근거를 직접 고르거나, 없어진 정보 ID의 선택을 해제하고 다시 검토한다. 원본 교체로 컷이 바뀌었다면 장면 목록에서 새 컷을 선택한다.

`GET /api/projects/:id/final-readiness`는 현재 Project와 실제 자산 검사에서 `generated → reviewed → text-confirmed → visual-timeline-safe → final-ready` 단계와 차단 Issue를 계산한다. 모든 컷 승인, 필요한 Frame 승인, Text 확정, 전체 시각 구간, 대사·음향 지시의 원문·시각과 현재 시각 출력 자산이 통과해야 Final Ready다. 실제 음원은 선택이며 재생 문제는 `optionalAudioIssues`에서 별도로 확인한다. CSV·PDF의 `?maturity=final`은 조건 미달 시 파일 대신 모든 Issue를 포함한 `FINAL_OUTPUT_NOT_READY` 409를 반환한다. Query 생략은 하위 호환 Draft다.

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

**제작 현황 → 제작 범위와 실행 설정 → 콘티 상세도**에서 **원문에 맞춤 / 간략 / 상세**를 선택한다. 간략은 이어지는 동작을 묶고 상세는 손동작·시선·상태 변화를 더 나누어 계획한다. 컷 수는 고정하지 않으며 원문 공개에 필요한 그림은 유지한다. **같은 그림 표시 검토 기준**은 기본 15초인 수정 가능한 검토 기준이다. 오래 유지되는 그림은 원문에 맞는 보완을 시도하고 의도된 정적 장면이면 검토 대상으로 남긴다. 결과를 불러오면 실제 컷·시작/키/끝 프레임·그림 대상 수와 긴 표시 구간을 확인하고 **이 컷 검토**로 이동한다. 선택은 실행 이력에 저장되며 재개·재열기 뒤에도 확인할 수 있다. 기존 편집 컷은 설정만으로 재분할하지 않는다.

자동 제작의 **저장 공간**에서 현재 사용 가능 용량과 필요 예상량을 확인할 수 있습니다. **저장 공간 다시 확인**은 실제 디스크를 다시 읽습니다. 실행 설정의 파일 한도를 바꾸면 예상량도 다시 계산합니다. 서버 `automation.minimumFreeBytes`는 디스크별 예비 공간(bytes)이며 현재 설정은 `2147483648`(2GiB)입니다. 이전 설정 파일을 사용할 때도 이 값을 명시해야 합니다. 모델·이미지·새 음성 생성 전에 실제 공간을 검사하고, 부족하면 **확인이 필요합니다**로 멈춥니다. 공간을 확보한 뒤 같은 실행의 **이어 만들기**를 누르면 저장한 후보와 음성을 검증해 이어 씁니다. 시작 전 공간 부족은 생성 시도 횟수를 소모하지 않습니다. 실행 기록 자체를 저장할 최소 공간도 없으면 새 실행을 만들기 전에 거부합니다. 자동으로 이전 자산이나 작업 이력을 삭제하지 않습니다. 예상량은 임시·복사 공간을 포함한 운영 기준이며 실제 생성량이나 공간 예약을 의미하지 않습니다.

자동 제작의 **제작 범위와 실행 설정**은 프로젝트별로 이 브라우저에 보관됩니다. 새로고침 후 구간 선택·모델·음성·생성 한도를 복원하며, 잘못 입력한 값도 수정할 수 있게 유지합니다. 프로젝트나 다른 탭의 설정이 바뀌었다면 비교 후 사용할 값을 선택하세요. 입력 복원만으로 제작을 시작하거나 이전 실행을 재개하지 않습니다.

**음악·환경 음향 지시**는 컷 편집의 **음성** 탭에서 검토합니다. Codex가 원문에 음악이 없는지, 기존 트랙으로 충족되는지, 별도 음향 트랙이 필요한지를 제안합니다. 근거와 연결을 확인하고 **음향 판정 확인**을 누르세요. 수정한 값은 **음향 판정 저장** 후 확인합니다. 기본 콘티는 필요한 소리의 지시와 계획 시각을 검토·확인하면 됩니다. 소리도 재생하려면 아래 연결된 트랙의 **WAV 준비 · 자동 제작으로 이동**으로 파일을 등록하고 자동 제작에서 배치합니다. 음악·효과음 WAV를 자동 생성하는 제공자는 연결되어 있지 않습니다. 파일이 없어도 필요한 소리는 지시로 보존하며, 음원 부재는 기본 Final 출력을 차단하지 않습니다.

자동 제작은 `storyboard.config.json`의 `automation` 실행 경로와 `.local/automation` 저장소를 사용한다. 브라우저를 닫아도 서버가 켜져 있으면 계속되며 서버 재시작 뒤에는 저장한 실행을 사용자가 재개한다. 저장을 마친 가이드 음성은 같은 실행의 재개에서 원문·음성 설정·실제 WAV를 다시 검사해 재사용한다. 새 실행은 별도 저장 범위를 사용한다. 음성 보존 파일도 준비 파일 한도에 포함된다. 자동 구간 계획은 기존 WAV의 파일·길이·현재 배치를 확인하고, 시간이 일치하면 재합성 없이 측정 상태를 복원한다. 저장한 시작·종료 시각은 바꾸지 않는다. 수동 편집한 구간은 컷의 길이·연출·기존 프레임을 유지한 채 미정 원문 연결과 등록된 음원을 별도로 검토한다. **가이드 음성도 생성**을 선택한 실행은 미등록 대사·내레이션·패널 발화의 가이드 음성을 준비하고 현재 발화의 시작·종료 범위 안에서 실제 길이로 배치한다. 원문 공개 시점도 같은 후보에서 검증한다. 한 번 준비한 음성은 계획 보정·중단 후 재개에서 재사용한다. 새 공개 시점에 필요한 키 프레임만 추가하고 빈 기준·그림 작업으로 이어진다. 잠금·확정 컷과 승인 그림, 그 컷과 공유하거나 겹치는 음원은 보존한다. 효과음·음악은 낭독하지 않으며 실제 재생을 선택했을 때 파일 등록이 필요하다. 음성·음향 탭에서 WAV를 선택하고 **WAV 준비 · 자동 제작으로 이동**을 누르면 실제 파일을 측정해 보관한다. 제작 현황에서 범위와 실행 설정을 확인하고 자동 제작을 시작하면 Codex가 같은 파일을 원문 공개 시점에 맞춰 배치한다. 준비 상태의 시작·종료는 허용 범위이며 실제 타임라인 음성 재생은 아직 차단된다. 콘티 Final은 원문·계획 시각·그림과 검토 상태로 별도 판정한다. 미등록 within-segment는 원본 구간 전체, J/L컷은 저장한 범위를 사용한다. 준비 파일은 개별 재생으로 먼저 확인할 수 있고, 기존 배치 음원은 보존한다. 기존 컷·자막·발화 범위 안에서 연결을 해결할 수 없으면 충돌을 표시하며 임의로 시간을 바꾸지 않는다. 사람 승인과 Final 검사는 자동 생략하지 않는다.

개별 컷·이미지·가이드 음성 요청은 기존 스킬 방식도 지원한다. 화면에서 `CODEX CUT`, `IMAGE`, `CODEX VOICE`를 누르면 `.local/codex-requests`에 요청이 저장된다. 같은 저장소의 Codex App 작업에서 다음 스킬을 실행한다.

```sh
$storyboard-workbench 대기 중인 콘티 생성 요청을 처리해 주세요.
```

저장소 스킬 [storyboard-workbench](.agents/skills/storyboard-workbench/SKILL.md)이 현재 Codex 모델로 컷 JSON을 작성하고, 내장 `image_gen`으로 그림을 만들고, macOS `say`의 한국어 음성을 WAV로 변환해 프로젝트에 반영한다. `OPENAI_API_KEY`와 OpenAI SDK는 사용하지 않는다. 생성 중에도 웹 편집은 계속할 수 있으며, 결과 반영 후 화면의 `REFRESH`를 누르면 새 프로젝트 revision을 읽는다.

요청 위치, 로컬 음성, Audio Worker·queue 수, 예약 byte, queue·실행 timeout과 메모리 한도는 [`storyboard.config.json`](storyboard.config.json)에서 관리한다. 요청에는 대상 원문·컷·시각 기준의 해시가 들어간다. 요청 뒤 대상이 바뀌면 Codex 결과 적용을 거부하고 새 요청을 요구한다. 화면 상단의 Codex 상태에서 완료·대기·실패, 평균·최대 처리 시간, 같은 대상의 반복 생성 횟수와 최근 실패 원인을 확인한다. Codex App은 요청별 API 비용을 제공하지 않으므로 비용은 0으로 기록하지 않고 `N/A`로 표시한다.

제작 설정의 **글자 배치**에서 글자 크기·줄 간격·여백·최대 줄 수와 고지/소품/자막 위치를 저장한다. **배치 설정 방식 → Codex 자동 설정**을 저장하고 자동 제작의 **글자 배치 계획 → 자동 설정 대상의 배치 계획**을 선택하면, 다음 실행에서 Codex가 작품 전체의 문구 길이·종류·화면비를 보고 배치를 제안한다. 구간을 일부 선택해도 배치 프리셋은 작품 전체에 적용된다. 새 콘티는 자동 설정이며 이전 저장본은 기존 배치를 보존한다. 직접 수치를 수정하면 수동 설정으로 전환된다. **최근 자동 글자 배치**에서 제안 이유·잔여 조판 문제와 현재 배치의 일치 여부를 확인한다. 확정/잠금 컷 또는 승인 그림이 있으면 자동 계획도 현재 배치를 유지한다. 같은 위치의 글자는 차례로 쌓이며 검토 재생과 PDF가 같은 글꼴·좌표를 사용한다. 자동 구간 계획은 겹침을 검사하고 보정 가능한 미확정 글자의 시각을 지정한 횟수 안에서 다시 배치한다. 본문을 줄이거나 정상 표시 길이를 단축해 겹침 검사만 통과시키지 않는다. 해결되지 않은 항목은 **검토·출력 → 편집하기**로 글자 설정을 조정한다. 원문과 확정된 표시 시간은 바뀌지 않는다. 개별 문구의 배치는 아래 편집 기능을 사용한다.

**글자 읽기 기준**에서 읽기 속도와 최소/최대 표시 시간을 저장한다. 초기값은 공백을 제외한 초당 표시 문자 12개, 최소 1초, 최대 8초인 수정 가능한 초안 기준이다. 저장만으로 기존 시각을 바꾸지 않으며 다음 자동 구간 계획에 적용한다. 미정 종료는 읽을 시간을 확보하도록 제안하고, 최대 기준보다 긴 미확정 초안은 필요한 시간을 지키며 줄일 수 있다. 원본에서 고정한 시각과 이미 **시각 확정**한 글자는 유지한다. 시간표나 설정 안에 맞지 않으면 검토 항목에 이유를 남긴다. 제작자가 의도된 시각을 확인해 **시각 확정**하면 초안 읽기 경고는 해제되며 원문·자산·Final 검사는 별도로 유지된다.

제작 설정의 **화면 글꼴과 언어**에서 이 콘티의 글꼴과 문구 언어(`ko`, `en`, `ja`, `zh-Hans`, 미지정 `und`)를 정한다. **선택한 글꼴 미리보기**는 첫 글자 시점을 그리고 작품 전체의 조판 문제를 검사하며 저장하지 않는다. **글꼴·언어 저장** 후 화면 재생과 PDF 그림에 같은 글꼴이 적용된다. 원문·표시 시각·그림 승인·이전 자산은 유지한다. 언어 태그는 문자 분할에 쓰며 번역이나 새 대사를 만들지 않는다. PDF 설명 본문은 서버의 기본 글꼴을 사용한다.

Codex 자동 글자 배치는 등록된 글꼴의 실제 지원 문자·해시를 보고 빈 글꼴·언어 설정도 채운다. 이미 저장한 선택은 유지하며, 승인 출력이 있으면 기존 표시를 보존한다. 사라지거나 바뀐 글꼴은 최종 출력을 차단한다. 설정에서 원래 글꼴을 복원하거나 **현재 글꼴 파일 선택** 또는 다른 글꼴 선택 후 저장한다. 미지원 글자는 미리보기·최종 검사에 남으므로 검토하고 지원하는 글꼴을 선택한다. 추가 글꼴은 `storyboard.config.json`의 `textFonts`에 `{ "id": "my-font", "label": "표시 이름", "path": "assets/fonts/MyFont.ttf" }` 형식으로 등록하고 서버를 재시작한다. 경로는 설정 파일 기준이며 `default`는 기존 `pdfFontPath`를 가리킨다. 프로젝트에는 경로 대신 ID·파일 해시·언어를 저장한다.

**컷 편집 → 글자 → 개별 글자 배치**에서 문구 하나의 가로·세로 위치, 영역 폭, 글자 크기, 세로 기준, 정렬, 레이어와 밝은/어두운 배경을 지정한다. **개별 배치 미리보기**로 실제 글꼴과 동시 표시 문구를 확인한다. **그림과 크게 보기**를 누르면 미저장 배치를 실제 콘티 그림 위에서 크게 볼 수 있다. 문구 표시 구간의 슬라이더로 시점을 옮기며 인물·소품 가림과 전환을 확인하고, 닫은 뒤 **개별 배치 저장**한다. 이 미리보기는 미승인 그림을 포함하지만 원문·공개 조건·파일 검사를 유지하며 저장이나 승인을 수행하지 않는다. 가로 위치는 영역의 왼쪽, 세로 위치는 선택한 세로 기준점이며 크기는 화면의 짧은 변에 대한 비율이다. **공통 배치 사용**은 개별 지정을 해제한다. 작성 중 입력은 재열기 후 복원된다. 자동 제작은 문구마다 공통/개별 배치 결론을 내고 수동 지정은 유지한다. 레이어를 바꿔도 겹침·넘침 검사는 유지되며 문제 있는 초안은 Final로 출력되지 않는다. 원문·시각·사용자 승인은 별도로 보존한다.

## 미저장 편집 기록 찾기

**제작 현황 → 미저장 편집 기록**에서 컷·프레임·음성·글자와 제작 프로필의 임시 편집을 찾을 수 있습니다. 원본 변경이나 컷 재구성으로 이전 편집기를 열 수 없을 때는 **대상이 없거나 확인이 필요한 기록**을 선택하세요. 항목을 펼치면 작성 내용과 편집을 시작할 때의 기준이 보입니다.

**작성 내용 복사**로 필요한 값을 현재 편집기에 옮기거나 **기록 JSON 보관**으로 브라우저 밖에 보관할 수 있습니다. 현재 대상이 남아 있으면 **현재 편집 대상 열기**를 눌러 기존 복원·기준 비교 절차를 이어갑니다. 기록 조회·복사·보관은 콘티에 저장하거나 승인하지 않습니다. 사라진 대상의 내용을 다른 컷에 자동 배정하지 않으며 여러 탭의 기록은 각각 표시합니다. 손상된 기록은 오류를 표시하고 보존합니다. 기록 JSON은 프로젝트 가져오기나 그림·음성 파일을 포함하는 백업이 아닙니다. 브라우저 저장소를 삭제하면 보관하지 않은 임시 기록은 복원할 수 없습니다.

## 같은 패키지로 별도 콘티 시작

이미 만든 패키지를 새 작업으로 시작하려면 왼쪽 상단 **＋ 새 콘티 시작**을 누른다. `storyboard_handoff.json` 경로, 새 콘티 이름, 초안 글자 유지 시간을 입력하고 **별도 콘티 생성·열기**를 누르면 왼쪽 목록에 추가되고 새 편집기가 열린다. 기존 콘티와 동일한 원본 이야기여도 각각 편집·저장할 수 있다. 기존 그림·음성·편집 이력을 복사하는 기능은 아니며, 패키지 원문과 설정으로 새 초안을 만든다. 글자 유지 시간은 미정 종료 시각의 편집용 제안이다.

## 프로젝트 불러오기

웹 화면의 `IMPORT PACKAGE`에 `storyboard_handoff.json`의 절대경로 또는 저장소 루트 기준 상대경로를 입력한다. 입력 계약은 파일 역할·상대경로·필수 여부·해시 방식·필드별 기준 원본과 제작 설정을 명시한다.

- [`storyboard_handoff.schema.json`](schemas/storyboard_handoff.schema.json): 입력 패키지 계약
- [`native_dataset.schema.json`](schemas/native_dataset.schema.json): 범용 원본 데이터 계약
- [`storyboard_project.schema.json`](schemas/storyboard_project.schema.json): 재편집 프로젝트 계약
- [검증 fixture 설명](tests/fixtures/README.md): 합성 범용 사례와 초기 실제 회귀 사례의 구분

`native-v1`은 한 개의 공통 데이터 파일을 읽는다. `production-v1`은 구조화 대본·시간표·인물·장면과 제작 문서 역할을 명시적으로 연결한다. 형식 전용 파일명과 필드는 각 어댑터 안에서만 처리한다. `production-documents-v1`은 제작 문서 8개에서 원문과 편집표를 읽는다. 지원하지 않는 임의 문서는 오류로 처리하며 파싱 실패 시 추론 기반 가져오기로 전환하지 않는다.

파일 경로는 패키지 루트 안으로 제한한다. `bytes-sha256`은 UTF-8 파일 바이트를 검사하고, `sorted-json-sha256`은 유니코드 코드 포인트 순으로 키를 정렬한 공백 없는 JSON을 검사한다. 필수 파일 누락, 해시 불일치, 끊어진 참조, 미지원 버전은 구체적인 오류로 끝난다. 문구나 선언의 제작상 차이는 원문을 고치지 않고 검토 항목으로 보존한다.

자막 Placement마다 `TextMappingDecision`이 생긴다. 문자열이 정확히 같으면 `exact/confirmed`, 축약 후보나 독립 요소가 감지되면 `unresolved`로 시작한다. `separate-element`와 `standalone-placement`에는 별도의 `TextPlacementInformationDecision`이 필요하다. `unresolved`는 출력을 차단하고, 사용자가 `non-informational`로 확인하거나 하나 이상의 Information ID를 가진 `informational`로 확정해야 출력할 수 있다. `separate-element`에서는 Placement Cue와 Canonical Cue가 서로 다른 화면 요소와 시각을 유지하며 Placement가 Canonical 정보 ID를 상속하지 않는다. Mapping 결정이 없거나 중복되거나 미해결이면 Placement 본문은 Program Monitor·PDF·CSV 안전 출력에서 차단된다. Migration에서 권한을 확정하지 못한 Text Cue는 Inspector에서 Placement, Mapping Decision, Source Unit 중 하나로 원문 기반 복구하거나 필수 커버리지를 해치지 않는 경우 삭제할 수 있다.

각 컷은 `sourceLinks`를 권한 원본으로 사용한다. Link는 `primary-visual`, `continued-visual`, `audio-only`, `context-only` 용도와 `confirmed`, `mapping-required` 상태, 컷 안에서 처음 유효해지는 `temporalAnchor`를 가진다. Anchor는 컷 상대 반열린 구간이나 특정 프레임으로 확정하거나 검토 필요 상태로 둘 수 있다. Anchor에 연결된 프레임 시각을 바꾸면 해당 Link와 승인을 자동으로 재검토 상태로 돌린다. 수동 분할에서 시간 근거가 없는 원문은 한쪽 후보에만 배치되고 `mapping-required`로 표시된다. Inspector의 **TEXT MAPPING REVIEW**, **SOURCE TEMPORAL MAPPING**, **INFORMATION GATE**에서 절대 공개 시각, Gate 비교 결과, 관계·용도·상태와 기준/유효 공개 시점을 검토하고 같은 구간의 앞뒤 컷으로 연결을 이동할 수 있다.

Codex 컷 제안의 선택적 `sourceLinks[].anchor`는 `startPermille`, `endPermille`로 컷 내부 상대 범위를 표현한다. 범위는 `0 ≤ start < end ≤ 1000`이고, 생략하면 기존처럼 컷 전체를 사용한다. 컷 길이를 weight로 배분한 뒤 시작은 내림, 끝은 올림해 최소 1ms의 실제 offset으로 바꾼다. Information Gate와 원문 순서는 컷 시작이 아니라 이 실제 anchor 시작 시각으로 검사하며, 앞 프레임의 이미지 문맥에는 아직 시작하지 않은 source와 정보가 들어가지 않는다. 웹·CSV·PDF의 시간 표시는 프로젝트 timebase의 정수 프레임 산술을 공유하므로 PRJ-007의 500ms는 24fps 기준 `00:00:12`다.

Source Update 뒤 Text 기반 Anchor 후보가 없으면 `MISSING_TEXT_ANCHOR_SOURCE`, 둘 이상이면 `AMBIGUOUS_TEXT_ANCHOR_SOURCE`가 Mapping Review에 표시된다. Issue에는 Shot·Source Unit, 후보 Cue와 Mapping Decision ID, 대상 필드와 해결 방향이 들어가며 복수 후보의 첫 항목을 자동 선택하지 않는다.

## 제작 문서 8개에서 패키지 만들기

한 폴더의 8개 문서가 한 스토리다. 편집표를 사용하는 문서와 구간별 제목·촬영/녹음/자막 마커를 사용하는 문서를 지원한다. 제목에 프로젝트 ID가 없어도 지원하는 제작 메타데이터에 ID가 있으면 manifest와 대조한다. 다른 스토리도 같은 형식의 8개 문서와 그 작품의 설정으로 처리한다. `production-documents-v1`은 다음 파일을 요구하며 상위 구조화 파일 7개나 API 키를 읽지 않는다.

`broadcast_readable_script.md`, `reenactment_character_script.md`, `edit_script.md`, `shooting_script.md`, `narration.md`, `panel_reaction_script.md`, `subtitle_script.md`, `production_manifest.json`.

입력은 현행 한국어 표·발화 형식, 인물 대본 프로필 1.0.0, manifest 1.1.0이다. 패널·내레이션·자막을 사용하지 않는 작품은 해당 파일을 제목과 부재 설명만으로 제공할 수 있다. 파일당 4MB 이하의 UTF-8 일반 파일을 지원한다. 임의 Markdown/PDF 형식은 지원하지 않는다.

1. 왼쪽의 **제작 문서 8개로 새 패키지 만들기**를 누른다. 넓은 별도 화면에서 **제작 문서 폴더 → 문서 검토**를 진행한다. 기존 handoff 가져오기는 **프로젝트 불러오기**에 있다.
2. **연결·설정**에서 **Codex로 검토하고 채우기**를 누르면 설치된 Codex App 엔진이 8개 문서를 읽고 빈 연결·제작 설정을 채운다. **항목별 검토 근거**의 추론·추천을 확인하고 **입력된 제안 모두 확인** 또는 개별 확인을 누른다. 근거가 부족한 연결은 보류 이유를 확인하고 **인물 대응표로 보완**한다. 장면·구간·원문 수와 연결할 항목도 확인한다. 문서로 연결된 항목은 접혀 있으며 펼쳐 수정할 수 있다. 촬영 원문에 인물 ID가 있고 방송 대본과 정확히 대조되는 경우 이름·장면·원문이 자동 연결된다. 이름↔ID 대응이 없는 인물은 **후보의 문서 근거 확인**에서 등장 장면·출처를 참고해 직접 연결한다. 장면 연결을 바꾸면 **연결 다시 확인**으로 원문 구간 후보를 갱신한다.
3. 프레임레이트·음성 샘플레이트·화면비·시작 타임코드를 지정하고 **생성 내용 확인**을 누른다. 미해결·중복 연결과 잘못된 입력은 수정할 필드로 이동하는 안내를 표시한다. 매체와 그림 스타일은 기존 편집기의 제작 프로필에서 정한다. 웹은 표시된 non-drop 프레임레이트 선택지를 지원하며 다른 유효 timebase는 CLI 설정을 사용한다.
4. **생성·불러오기**에서 설정 요약을 확인하고 패키지 버전과 원본 폴더 밖의 **새 패키지 폴더**를 지정한다. 상위 폴더는 먼저 존재해야 한다. **패키지 생성**은 기존 폴더·파일을 덮어쓰지 않는다.
5. 생성된 handoff 경로를 확인하고 초안 글자 유지 시간을 입력한 뒤 **생성 패키지 불러오기**를 누른다. 같은 이야기의 콘티가 이미 있으면 새 콘티 이름도 입력하고 **별도 콘티 생성·열기**를 누른다. 성공하면 새 항목이 왼쪽 목록에 표시되고 편집기가 열린다. 이 시간은 미정 자막 종료의 편집용 제안이며 제작 확정이 아니다. 불러오기에 실패해도 생성된 패키지 경로를 유지하므로 원인을 해결한 후 재시도할 수 있다.

인물 연결이 남으면 **인물 대응표로 보완**에 사용할 인물 원본 JSON과 제작 근거 JSON의 경로를 직접 입력한다. 현재 지원 형식은 `production-characters-v1`이다. 인물 원본에는 `project_id`, `characters[].name`, `characters[].character_id`가 있어야 하고, 제작 근거는 `production-footprint` 1.0.0이며 `source_artifact_hashes.characters`가 인물 원본의 정규 JSON 해시와 일치해야 한다. 입력 manifest의 `source_footprint_sha256`도 해당 제작 근거와 일치해야 한다. 파일명·위치를 자동 탐색하지 않으며 각 파일은 256KB 이하의 UTF-8 일반 파일이어야 한다.

**최종 인물 연결**에서 이름별 선택 ID와 완료·제안 확인·결정 보류 상태를 확인한다. Codex 추론은 **이름 → ID 확정**으로 확인하며, 미연결은 **인물 보충 파일 지정하기** 또는 해당 인물의 **직접 선택**으로 이어진다. 가져올 인물 목록이 비어 있으면 인물 연결이 필요 없다고 안내한다. 목록에 있는 인물은 무언이거나 특정 컷에 나오지 않는다는 이유로 제외하지 않는다. 이미 모든 인물 연결을 완료했다면 보충 파일을 추가할 필요가 없다.

같은 8개 문서에서 보충 인물표 검토를 완료한 기록이 있으면, 저장된 인물 원본을 현재 문서와 다시 검증하고 **선택할 ID: …**를 적용 전에 표시한다. **확인된 N명 자동 선택**을 누르면 파일 경로를 다시 입력하지 않고 빈 연결을 채운다. 과거 모델 추론만 있는 기록은 재사용하지 않으며, 다른 작품·변경된 문서·현재 선택과 충돌하는 근거는 적용하지 않는다. 저장된 검증 근거가 없는 첫 가져오기에서는 두 보충 파일 또는 직접 확인한 대응이 필요하다.

두 보충 파일 경로를 지정한 뒤 **근거 확인 후 자동 연결**을 누르면 원본 검증·재확인·빈 연결 적용을 연속 수행하고 최종 이름–ID 대응표로 이동한다. 적용 전에 대응표를 보려면 **인물 근거 확인**에서 현재 값·연결할 값과 출처를 비교하고 **연결 적용하고 Codex 검토**를 누른다. 두 경로 모두 빈 연결만 채우고 현재 제작 설정·연결은 유지한다. 기존 연결과 충돌하면 해당 항목을 확인하도록 안내한다. 적용 직전에 파일을 다시 읽어 변경 여부를 검사하고 Codex가 보완된 입력을 이어서 검토한다. **보충 근거 해제**는 그 근거로 채운 연결을 비우며, 별도로 수정한 사용자 값은 유지한다. 원본에 없는 이름·ID 대응을 새로 추측하지 않는다.

상단의 **1 문서 확인 · 2 연결·설정 · 3 생성·불러오기** 버튼으로 이미 진행한 단계를 바로 열 수 있다. 패키지 생성 후에도 이동할 수 있고, 폴더·연결·설정·출력 입력과 생성 결과를 유지한다. 3단계로 돌아갈 때 원본 변경·연결·설정·제안 확인 상태를 다시 검사한다. 생성 후 내용을 수정하면 이전 패키지 경로를 보여 주고 **새 폴더와 새 버전**으로 저장하도록 안내한다. 새 원본 폴더를 입력하면 이전 이야기의 입력을 초기화한다. 문서 검토·Codex 검토·생성·불러오기 중에는 단계 이동을 잠근다.

**닫기 · 나중에 계속** 또는 Escape로 편집기에 돌아갔다가 다시 열면 이번 페이지의 입력과 단계를 유지한다. 페이지 새로고침 후에도 입력과 단계를 복원하며 **원본 다시 확인**을 거친 뒤 이어간다. 같은 원본 ID의 콘티가 이미 저장돼 있으면 이를 미리 알리고 **별도 콘티 생성·열기**로 독립 작업을 시작할 수 있다. 새 패키지는 별도로 만들 수 있으며 기존 콘티의 원본 변경은 편집기의 **SOURCE UPDATE → 변경 영향 확인**으로 검토한다.

문서 Codex 검토 중 새로고침했다면 **원본 다시 확인 → 이전 검토에 다시 연결**을 누르세요. 새 검토를 만들지 않고 같은 요청의 진행 상태·결과를 가져옵니다. 이미 반영한 결과는 근거만 다시 보여 주며 현재 입력과 확인 상태를 유지합니다. 검토 중 직접 수정했다가 비운 제작 설정도 보호합니다. 원본·연결을 바꾸었다면 현재 입력으로 다시 검토해야 합니다. 브라우저가 요청 ID를 받기 전에 연결이 끊겼거나 기록을 보관하지 못한 경우에는 이 재연결을 보장하지 않습니다.

자동 검토는 현재 `storyboard.config.json`의 `documentReview.executable`에 지정된 설치 엔진을 `app-server --listen stdio://`로 실행한다. Codex App의 ChatGPT 로그인을 사용하며 API 키를 요구하지 않는다. 모델은 Codex 사용자 설정을 상속하고 결과에 실제 모델을 표시한다. 선택한 문서·현재 입력·선택 프리셋과 검증된 보충 인물 대응만 전달한다. 한 번에 1개 검토, 전체 입력·응답 각각 2MB, 설정된 `timeoutMs`(현재 240초)를 적용한다. 엔진 경로가 다른 컴퓨터에서는 해당 설정을 설치 위치에 맞춰 수정한다. 실행 기록·스냅샷·프리셋은 `documentReview.requestRoot` 아래에 보존된다. 설정이 없는 서버는 수동 가져오기만 제공한다.

검토 중 입력을 수정할 수 있다. 제작 설정 수정값은 보존하며 연결이나 원본이 바뀌면 자동 반영을 중단하고 **현재 값으로 다시 검토**를 안내한다. **검토 취소**는 엔진 실행을 중단한다. 실패·시간 초과는 원인을 표시하고 재시도는 새 요청으로 기록한다. 페이지 새로고침 뒤에는 **원본 다시 확인 → 이전 검토에 다시 연결**로 같은 검토의 진행 상태와 결과를 불러온다. 전송 전에 요청 ID와 입력을 보관하므로 첫 응답을 받지 못해도 복구할 수 있다. 접수 여부를 확인할 수 없으면 **같은 요청 재전송**을 사용한다. 이미 접수된 작업은 중복 실행하지 않고, 미접수 요청만 한 번 시작한다. 보관한 당시 입력으로 검토하며 이후 수정한 값은 유지한다. 이미 반영된 결과를 다시 열어도 확인 상태를 덮지 않는다. 서버 재시작 시 미완료 요청은 중단 상태로 기록한다. **내 제작 프리셋**에서 확인한 설정을 저장하고 다른 스토리에서 선택할 수 있다. 프리셋 선택은 제작 설정 5개를 함께 적용하며 인물·장면 연결은 가져오지 않는다.

구간 제목형 문서의 자막은 개별 표시 시간이 없는 계획이다. 모든 지정 원문을 미확정 글자 트랙으로 가져오며 시작·종료를 편집한 뒤 시각을 확정한다. 문자·메모는 자동 낭독하지 않고, 내면 독백은 음성으로 구분한다.

출력은 `storyboard_handoff.json`, `document-settings.json`, 원본 8개를 보존한 `09_PRODUCTION/`이다. 웹에서 생성한 설정 1.1.0의 `reviewAudit`에는 최종 값별 문서 확인·Codex 추론·추천·프리셋·사용자 지정, 근거, 요청 ID, 실제 모델과 확인 상태를 보존한다. 보충 인물표를 적용하면 설정 1.2.0에 `identityEvidence`(검증 당시 인물 원본·제작 근거의 내용과 바이트 해시)를 함께 보존하며, 해당 연결의 출처는 `identity-document`다. 외부 원본이 이동해도 패키지 자체로 해시 사슬과 연결을 다시 검사한다. 기존 1.0.0·1.1.0 설정도 읽을 수 있다. 각 원본의 SHA-256과 문서 행 출처를 유지한다. 검토 뒤 원본이 변경되면 다시 검토해야 한다. 파일 쓰기 도중 오류가 나면 성공 handoff를 만들지 않으며, 남은 출력 폴더를 자동 덮거나 삭제하지 않는다.

자막 축약·표시 시점 차이는 기존 Text Mapping 검토로 이어지고 종료 시각은 미정이다. 문서에 없는 Canonical Unit·fact·clue ID는 복원하지 않는다. 새 문서 내부 Unit ID로 최초 공개 순서를 추적하지만 의미상 동일 정보의 재등장·반전 연결까지 자동 증명하지 않는다. 공통 제작 지시와 원문 스냅샷을 보존하며 의미·연출 검토는 계속 필요하다. manifest가 가리키는 상위 footprint 파일은 읽지 않으므로 검증했다고 표시하지 않는다.

CLI도 같은 변환을 실행한다. 아래 설정 예시는 **독립 합성 스토리 전용 테스트값**이다. 실제 작품에는 미리보기의 `sourceFingerprint`와 제작자가 정한 값을 사용한다. 설정 계약은 [document_settings.schema.json](schemas/document_settings.schema.json), 예시는 [document-settings.example.json](tests/fixtures/document-settings.example.json)을 참고한다.

```sh
npm run cli -- documents-preview --input tests/fixtures/documents
npm run cli -- documents-package --input tests/fixtures/documents --settings tests/fixtures/document-settings.example.json --output .local/document-package-demo
```

`bindings.people`는 이름→manifest 인물 ID, `bindings.scenes`는 장면 제목→편집표 장면 ID, `bindings.units`는 문서 Unit ID→편집 구간 ID 배열이다. 각 항목은 `{ "key": "검토 항목 키", "targetId": "선택한 ID" }` 형태다. 유일하게 확인된 연결은 생략할 수 있다. CLI에서 결정 목록을 반영해 다시 검토하려면 `documents-preview --input <폴더> --bindings <결정 목록 JSON>`을 사용한다.

## CLI

브라우저 없이 가져오기·검증·JSON/CSV 출력을 확인할 수 있다.

```sh
npm run cli -- --help
npm run cli -- outline --handoff tests/fixtures/native/storyboard_handoff.json --output .local/plant-care.project.json --text-hold-ms 3000
npm run cli -- validate --project .local/plant-care.project.json
npm run cli -- export-csv --project .local/plant-care.project.json --output .local/plant-care.shots.csv
```

`outline`은 구간마다 편집 시작용 컷과 프레임을 만든다. 카메라·화면 위치·출연 인물을 임의로 확정하지 않는다. 음성 슬롯은 글자 수에 비례한 제안 시간이며 생성한 가이드 음성의 WAV 길이와 선언한 구간 관계를 검증한 뒤 `measured` 상태가 된다. `j-cut`은 바로 앞 구간부터 원본 구간 안까지, `l-cut`은 원본 구간부터 바로 다음 구간까지만 걸칠 수 있다. 두 관계는 정보 Gate를 앞당기는 증거로 사용하지 않는다. 원본에 화면 글자 종료점이 없으면 `--text-hold-ms` 값이 제안값으로 기록된다. `proposed` 글자 큐는 안전 미리보기와 초안 내보내기에 포함되며, 최종 편집 완료 전에는 Inspector에서 종료 시각을 검토하고 `confirmed`로 확정한다. 기존 출력 경로를 덮어쓰지 않는다.

현재 프로젝트 형식은 `1.12.0`이다. 이전 저장본은 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.5.0 → 1.6.0 → 1.7.0 → 1.8.0 → 1.9.0 → 1.10.0 → 1.11.0 → 1.12.0` 순서로 메모리에서 변환한다. 1.5 Shot은 `visualMode: sourced`, 이전 Generation Record는 `generatorBuild: null`로 이관한다. 1.10 저장본은 제작 기준을 뜻하는 `productionPlan: null`을 추가한다. 원문·ID·시간·Anchor·Frame·Text·Audio·Asset과 기존 생성 metadata는 보존하며 Version 파일을 재작성하지 않는다. 기존 `frame` Anchor는 공개 시점만 증명한다. 표시 구간은 명시적 `frame-range`의 `endOffsetMs` 또는 `shot-offset`으로 확정해야 하며 1ms 구간이나 다음 Frame까지로 추측하지 않는다. 구간 미확정은 `SOURCE_VISUAL_INTERVAL_REQUIRED`와 Coverage Gap으로 차단한다.

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

### 콘티 완료 기준과 선택 음성

**제작 현황 → 음성 제작 → 콘티만 제작 (추천)**이 기본입니다. 그림·연출·시간·대사·음향 지시를 자동으로 만든 뒤 결과를 검토하고 확정하면 Final PDF·CSV를 출력합니다. 실제 음원은 필요하지 않습니다. 대사와 음향 지시는 원문과 계획 시각으로 내보냅니다.

소리도 듣고 싶으면 **가이드 음성도 생성**을 선택하세요. 이때 인물별 음성과 음량 설정이 나타납니다. 음악·효과음은 별도 WAV로 준비할 수 있습니다. **검토·출력 → 선택 음성 재생 점검**은 실제 재생용 파일 상태이며 기본 콘티 완료와 구분합니다. 이전 실행을 재개할 때는 그 실행에 저장한 선택을 유지합니다.

**초안 미리보기**에서는 현재 시점의 대사·음향 지시를 그림 아래에서 읽을 수 있습니다. 원문 연결·계획 시각·공개 조건을 통과한 내용만 표시합니다. 음원이 없으면 **선택 음성 재생 안내**에서 확인하며 그림 콘티의 출력 차단으로 표시하지 않습니다.

음향 칸이 비어 있어도 대본에 문 두드림이나 알림음 등이 적혀 있으면 자동 제작이 해당 문구를 연결합니다. **컷 편집 → 음성 → 콘티에 기록할 소리의 원문**에서 인용과 근거를 확인하세요. 필요한 소리를 임의로 생략하거나 빈칸 표시 자체를 음향 지시로 출력하지 않습니다.

한 지시에 여러 시점의 소리가 있으면 **소리별 원문과 시각**에 각각 표시됩니다. 자동 제작이 발생별 시각을 제안하며, 아래 같은 원문의 트랙에서 **START MS / END MS → 타이밍 저장**으로 수정할 수 있습니다. 인용·연결·근거를 바꿨다면 **음향 판정 저장** 후 검토하고 **음향 판정 확인**을 누르세요. 같은 소리가 지문과 효과음에 함께 있으면 **같은 소리의 보충 원문**으로 묶고 기존 트랙을 재사용합니다. 다른 시점의 소리는 **소리 발생 추가**로 나눕니다. 새 발생을 저장한 뒤 자동 제작을 실행하면 기존 컷을 유지하며 현재 허용 범위 안에서 시간을 계획합니다.

### 생성된 인물·공간·소품 기준 검토

**제작 설정 → 기준 이미지 검토·재생성**에서 검토할 제작 기준을 선택합니다. 현재 이미지·설명·연결 구간을 확인하고 **이번 이미지 수정 요청**에 바꿀 부분을 적은 뒤 **선택 기준만 다시 생성**을 누릅니다. Codex App에 수정 요청과 현재 그림이 함께 전달됩니다. 빈칸이면 기존 설명으로 다시 생성합니다. 수정 요청은 원문이나 제작 설명을 변경하지 않으며 실행 기록에서 다시 확인할 수 있습니다. 기존 자동 실행이 남아 있으면 제작 현황에서 완료하거나 취소한 뒤 시작하세요. 확정·잠금 컷이 사용하는 기준은 먼저 검토 대기로 변경하고 잠금을 해제해야 합니다.

같은 소품이 뒤 장면에서 다른 모양으로 생성되면 **같은 소품의 모양 이어 쓰기**에서 앞선 기준을 선택하고 원문에서 같은 물건임을 확인한 근거를 입력합니다. 이전 그림의 미리보기를 확인한 뒤 **선택 기준만 다시 생성**을 누릅니다. 새 그림과 연결이 함께 저장되며, 실패하면 기존 결과는 유지됩니다. 판형·색상·표 구획을 이어 쓰되 현재 장면의 상태는 다시 검토해야 합니다.

완료 후 **새 기준 결과 불러오기 → 이전 기준 비교**로 이전 파일과 나란히 봅니다. 같은 장소의 시간대 변형은 앞선 기본 공간을 참조하며, 사람과 공간이 같아도 생성 품질은 직접 검토해야 합니다. 선택 기준의 연결 컷·그림은 검토 대기로 바뀌고 이전 파일은 보존됩니다. 다른 기준이나 기존 컷 그림은 이 버튼으로 자동 교체하지 않으므로 필요하면 해당 기준 또는 컷 그림을 선택해 재생성합니다. 원문 대사·음원·사람 승인 상태는 자동 확정하지 않습니다.

### 자동 제작의 인물별 가이드 음성

**제작 현황 → 제작 범위와 실행 설정 → 인물별 가이드 음성**에서 **Codex 자동 배정**을 선택하면 자동 제작 시작 후 원문 언어·역할과 설치 음성을 검토해 미등록 발화의 목소리·속도를 배정합니다. 같은 원문의 저장된 배정은 재사용하며 이름·이유를 화면에서 확인할 수 있습니다. 다른 목소리를 원하면 개별 지정을 켜고 설치 목록에서 선택하세요. 개별 지정이 자동 배정보다 우선합니다. **공통·직접 지정 음성** 방식에서는 개별 지정을 해제하면 공통 음성을 사용합니다. 새로고침 후에도 시작 입력을 보존하고, 자동 제작을 시작하면 선택값을 해당 실행에 고정합니다.

이미 등록된 음원은 교체하지 않습니다. 새 음성의 실제 이름·속도는 **컷 편집 → 음성 → 음성·음향 개별 검토**에 표시됩니다. 배정한 목소리를 바꾸거나 선택 발화만 다시 만들려면 아래의 **발화 선택 생성·비교**를 사용하세요. 개별 **CODEX VOICE/RETAKE** 대기 요청은 기존 앱 공통 음성을 사용합니다. 합성 속도는 실제 발화 길이에 영향을 주므로 검토 재생 배속과 구별합니다.

### 검토 재생 속도

하단 타임라인, **초안 미리보기**, **컷 편집 → 음성**의 개별 음원에서 **검토 속도**를 선택합니다. 0.5·0.75·1·1.25·1.5·2배를 지원하며, 재생 중 바꿔도 현재 위치에서 이어집니다. 그림·글자·음성은 같은 원본 시각을 따르고 타임코드·전체 분량은 그대로 표시합니다. 합성 음성의 말하기 속도와 원본 WAV, 제작 설정·승인·출력 파일은 변경하지 않습니다.

속도는 프로젝트별로 브라우저에 기억하며 재열기만으로 재생하지 않습니다. 다른 탭에서 바꾼 값은 재열기 전 현재 청취에 끼어들지 않습니다. 저장 기록이 손상되면 속도를 다시 선택하고, 저장 공간 문제는 현재 화면에만 적용됨을 표시합니다. 실제 낭독 호흡과 최종 재생 시간은 **1배**로 검토하세요.

### 자동 음량과 청취 검토

새 자동 제작의 **음량·페이드 계획 → 실제 음원으로 자동 조정**은 파일이 준비되어 배치된 음원들을 함께 분석합니다. 대사·효과음·음악의 음량과 필요한 음향 페이드를 계획하며, 수동 설정과 확정·잠금 컷에 연결된 음원은 보존합니다. 효과음·음악의 실제 WAV는 준비가 필요합니다.

**컷 편집 → 음성 → 음량·페이드**에서 조정 이유와 실제 파일 측정값·남은 청취 검토를 확인합니다. **청취 음량**에서 저장한 설정과 원본 음량을 비교할 수 있습니다. 직접 값을 바꾸고 **음량 설정 저장**을 누르면 수동으로 보존됩니다. 다시 자동 조정을 원하면 **다음 자동 제작에서 조정**을 선택·저장한 뒤 해당 구간의 자동 제작을 시작합니다.

표본 피크·RMS는 원본 파일 분석이며 실제 동시 재생의 클리핑·LUFS 측정은 아닙니다. 원본 WAV, 발화 내용과 배치 시각은 유지하며 믹싱한 오디오 파일은 내보내지 않습니다. CSV/PDF에는 저장된 음량·페이드 지시가 포함됩니다.

### PDF·CSV 출력 구성

**검토·출력 → 출력할 콘티 구성**에서 다음을 선택합니다.

- 전체/선택 구간, 모든 프레임/컷별 대표 한 개
- A4/A3, 가로/세로
- **상세 제작 콘티**: 긴 연출·원문·자막·음향을 다음 페이지까지 이어서 출력
- **그림 비교용 목록**: 페이지당 2/4/6개 그림과 시간·검토 상태만 출력
- **제작용 CSV**: 한글 열과 읽을 수 있는 본문. **상세 데이터 CSV**는 기존 열 구조 유지

**출력 설정 저장**은 이 브라우저의 해당 프로젝트에 선호를 보존합니다. 새로고침하면 마지막으로 선택한 콘티를 다시 엽니다. 작업 공간·편집 탭·선택 컷·정지 재생 위치도 기억하며 재생은 자동으로 시작하지 않습니다. 재생 중 위치는 최대 1초 간격으로 기억합니다. 임시 입력은 브라우저 데이터 삭제나 저장 실패 뒤에는 복원을 보장하지 않습니다. 제작 문서 가져오기와 별도 콘티 생성 폼은 입력·단계·생성 결과를 기억합니다. 다시 열었을 때 **원본 다시 확인**을 누르면 원본 변경 여부를 검사하고 이어갑니다. 패키지 생성 중 응답을 놓쳤다면 **생성 결과 확인**으로 실제 파일을 대조해 결과를 복구하세요. 별도 콘티 생성은 같은 폼의 같은 입력으로 재시도하면 기존 생성 ID를 사용하므로 중복 콘티를 만들지 않습니다. 완료 후 새 폼에서 시작하는 생성은 별도 요청입니다. 기준 이미지의 종류·대상·설명과 원본 업데이트 경로·유지 시간도 복원합니다. 기준 이미지는 파일을 다시 선택하고, 원본 업데이트는 **변경 영향 확인 → 새 원본 적용** 순서로 진행하세요. 경로·설정·프로젝트 버전이나 원본 내용이 바뀌면 변경 영향을 다시 확인해야 합니다. 검토·전달 패키지의 입력과 생성 기록도 복원되며 새 생성 전에는 내용을 다시 확인합니다. **DRAFT PDF/CSV**로 내려받으며, 모든 차단 항목을 해결하면 **FINAL PDF/CSV**를 사용할 수 있습니다. 선택 구간만 내보내도 Final은 작품 전체를 검사합니다. 출력 중 편집되어 revision이 달라지면 새로고침 후 다시 내려받으세요. 원문·승인 상태는 출력 선택으로 바뀌지 않습니다.

파일 이름 뒤에 revision·초안/최종이 붙고 브라우저 다운로드 위치에 저장됩니다. **출력 선택 기록**은 같은 옵션과 실제 컷/프레임 목록의 JSON입니다. 기존 Review Bundle 명령에 `--output-selection <내려받은 출력 선택 기록.json>`을 추가하면 PDF·CSV에 적용합니다. 해당 기록의 Project/revision이 같아야 합니다. Bundle의 Project JSON·감사 자료·포함하기로 선택한 미디어는 작품 전체이며, 선택 구간만 공유하려면 단독 PDF·CSV를 사용하세요. 편집 가능한 Project JSON은 항상 전체 콘티입니다.

### 검토 자료를 한 폴더로 만들기

**검토·출력 → 출력 설정 → 검토 패키지 만들기**에서 사용 목적·수신자·내부/외부 범위와 이름·버전을 지정합니다. 내부 제작용은 입력 문서 전문·생성 프롬프트·전체 미디어 파일을 각각 포함할 수 있습니다. 전문을 제외해도 콘티의 대본 단위·연출·ID 연결·검증 기록은 남습니다. 외부 공유용은 전문·프롬프트·미디어를 제외하고 개인정보·절대경로를 가리며, 추가로 숨길 이름이나 문구는 한 줄에 하나씩 입력합니다. PDF의 그림은 자리 표시자로 대체됩니다.

**저장할 상위 폴더**에는 이미 있는 폴더의 절대경로를 넣으세요. **생성 내용 확인**을 누르면 그 안에 만들 새 폴더와 실제 포함 범위를 보여 줍니다. 예를 들어 이름 `검토본`, 버전 `02`, 수정번호 0의 초안은 `검토본-02-draft-r0` 폴더에 저장됩니다. 같은 이름의 폴더가 있으면 버전을 바꾸세요. 기존 파일은 덮어쓰지 않습니다.

**검토 패키지 생성**을 누르면 PDF·CSV·검토 JSON·자산 목록·검증 기록 등 기본 11개 파일과 선택한 미디어를 생성합니다. 웹 미디어 합계 한도는 256 MiB입니다. 설정·원본·글꼴이 달라지면 다시 확인해야 하며, 최종 패키지는 작품 전체의 Final 검사를 통과해야 합니다. 완료 후 **폴더 경로 복사**를 누르고 Finder의 **폴더로 이동(⌘⇧G)**에 붙여 넣으세요. 파일 목록에서 크기와 해시도 확인할 수 있습니다. 수신자 기록은 실제 전송을 실행하지 않습니다. 검토 JSON은 편집 가능한 재가져오기 JSON과 다릅니다. 패키지 입력과 마지막 생성 결과는 이 브라우저에서 복원됩니다. 결과의 경로·시각·파일 해시는 생성 당시 기록이며 현재 파일 존재나 최종 완료를 재검사한 결과는 아닙니다. 새로고침 뒤에는 **생성 내용 확인**부터 다시 진행하세요. 실제 출력 설정이나 프로젝트 버전이 바뀌면 작성한 값을 비교·선택합니다. 생성 응답을 받기 전에 페이지를 닫았다면 **생성 시도 · 결과 다시 확인**을 펼치고 해당 시도의 **파일 확인·기록 복구**를 누르세요. 생성 기록의 인증 코드와 모든 파일을 대조해 당시 결과를 복구합니다. 이미 수정한 콘티는 유지하며 새 패키지를 자동 생성하지 않습니다. 아직 폴더가 없다면 생성 완료 후 다시 확인하세요. 누락·변경된 파일은 덮거나 지우지 않습니다. 복구 키는 브라우저가 자동으로 보관하므로 따로 설정할 필요가 없지만, 브라우저 기록을 삭제한 경우와 이 기능 적용 전 만든 패키지는 자동 복구할 수 없습니다. 웹 전체 패키지는 512 MiB·20,000개 파일 이내이며 미디어 한도 256 MiB는 그대로 적용됩니다.


선택한 발화만 다시 만들려면 **컷 편집 → 음성 → 발화 선택 생성·비교**를 엽니다. 새 목소리와 합성 속도, 종료 허용 시각을 지정하고 **이 발화만 자동 생성**을 누르세요. 원문과 시작 시각을 유지하며 서버가 로컬 음성 합성·검사·저장까지 진행합니다. 완료 후 **새 음원 불러와 비교**로 현재 결과를 읽고, **보존된 이전 음원**에서 비교할 버전을 선택합니다. 작업 문구를 채팅에 붙여 넣을 필요가 없습니다.

고유명사·숫자의 발음을 보완하려면 같은 화면의 **읽는 방법 추가**를 누릅니다. **원문 표현**을 그대로 입력하고 반복되는 표현은 **등장 회차**를 지정한 뒤 **읽을 표기**를 입력하세요. 예를 들어 원문의 `AI`를 `에이아이`로 읽도록 지정할 수 있습니다. **합성할 낭독문**을 확인하고 자동 생성을 실행하면 선택한 발화만 바뀐 표기로 합성됩니다. 대본·자막·이전 음원은 보존되며, 실제로 같은 뜻과 올바른 발음인지 새 음원을 듣고 판단하세요. 보완을 모두 제거하면 다음 생성부터 원문대로 읽습니다. 최대 16개 표현을 지정할 수 있습니다. 이전 음원을 만든 뒤 원문이 바뀌었다면 현재 낭독문을 검토하고 **변경된 원문에서 발음 보완을 다시 확인했습니다**를 선택하거나 기존 보완을 제거하세요.

새 음성이 길이를 넘거나 같은 화자의 다음 발화와 겹치면 기존 음원을 유지합니다. 실행을 취소한 뒤 속도·종료 한도를 수정해 새로 시작하세요. 중단만 된 경우에는 **같은 설정으로 이어 만들기**를 사용합니다. 컷이 확정·잠금 상태라면 먼저 해당 컷의 잠금을 해제해 검토 상태로 돌려야 합니다. 그림과 이전 WAV는 보존되며 최종 출력 승인과 청취 검토는 별도로 진행합니다.

### 저장된 콘티 백업과 복원

제작 현황 → **저장된 콘티 백업**에서 **백업 상위 폴더**와 **새 백업 폴더 이름**을 입력하고 **백업 내용 확인 → 이 내용으로 백업**을 누르세요. 상위 폴더는 이미 있어야 하며 새 이름의 폴더는 프로그램이 만듭니다. **백업 파일 검증**으로 보관한 전체 파일을 다시 확인할 수 있습니다. 생성 응답을 받지 못했어도 같은 출력 경로를 먼저 검증하세요.

현재본·전체 편집 버전·등록된 그림/음원·저장된 원문 스냅샷을 함께 보관합니다. 외부 제작 문서 폴더와 브라우저 미저장 입력, 실행 중인 생성 작업/캐시는 별도로 보관해야 합니다. 최대 512MiB이며 저장·복구 진행 중에는 완료 후 다시 확인합니다. 기존 미디어 오류와 승인 상태도 그대로 보존하므로 백업 성공이 최종 콘티 완성을 뜻하지 않습니다.

운영 복원은 저장소를 선택하는 CLI로 제공합니다. 먼저 검증 결과의 `manifestSha256`을 확인한 뒤 새 저장소 폴더를 지정하세요. 아래 경로는 예시이며 실제 위치로 바꿉니다.

```sh
npm run project-backup -- verify /absolute/path/backup
npm run project-backup -- restore /absolute/path/backup /absolute/path/new-data-root 검증한_manifestSha256
```

복원 결과의 `dataRoot`를 사용할 서버 설정 파일의 `dataRoot`에 지정해 실행하면 같은 ID·이력의 콘티를 열 수 있습니다. 별도 서버를 함께 실행할 때는 포트와 Codex/문서검토/자동제작 저장 경로도 분리하세요. 기존 앱 설정은 자동으로 바꾸지 않으며 생성 작업도 다시 실행하지 않습니다. 이미 있는 폴더의 덮어쓰기·병합은 지원하지 않습니다.
