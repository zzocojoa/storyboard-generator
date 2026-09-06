# 범용 콘티 도구 — 미디어·저장·재생 운영 경계 보고서

## 1 작업 기준

- Branch: `codex/storyboard-generator`
- Working Tree: `/Users/beatlefeed/Documents/ChatGPT/콘티제작/.worktrees/storyboard-generator`
- Project Schema: `1.5.0`
- 생성 환경: Codex App 현재 모델, 내장 `image_gen`, 설정된 macOS 음성이다. `OPENAI_API_KEY`, OpenAI SDK, 외부 AI 생성 fallback은 사용하지 않는다.
- 범위: 모든 지원 프로젝트에 적용되는 기능이다. PRJ-007은 실제 fixture를 쓰는 회귀 사례에만 한정한다.

## 2 재현한 결함

| 실패 조건 | 기존 동작 | 수정 결과 |
|---|---|---|
| SFX·Music 실제 파일 등록 | 정상 사용자 API가 없었다 | 모든 Audio Cue 종류에 multipart PCM WAV 등록 경로를 제공한다 |
| 파일 없는 Audio metadata | 선택자만 통과할 수 있었다 | 안전 출력에서 실제 파일·해시·구조를 다시 검사한다 |
| 잘린 이미지와 저장 파일 변조 | header 또는 metadata만 믿을 수 있었다 | 전체 decode, MIME, SHA-256, 크기와 픽셀 수를 확인한다 |
| 독립 Placement의 빈 Information ID | 비정보성 확인 없이 출력될 수 있었다 | 명시적 `unresolved` 판정으로 시작해 출력을 차단한다 |
| TextCue Source Unit 종류와 중복 | ACTION·SOUND·MUSIC 또는 중복 Cue 우회가 가능했다 | 종류별 허용 표현을 고정하고 같은 Source Unit의 중복 Cue를 거부한다 |
| Ready 수치 | stale Frame과 proposed Audio를 포함할 수 있었다 | ASSET, REVIEWED, OUTPUT SAFE를 별도로 계산한다 |
| Source Update의 Text Anchor | 과거 자동 후보 Anchor가 남을 수 있었다 | 현재 Mapping으로 다시 만들고 실패하면 `unresolved/source-update`로 둔다 |
| 유효한 이전 WAV | 프로젝트 sample rate 차이를 손상과 구분하지 못했다 | `AUDIO_ASSET_NORMALIZATION_REQUIRED`로 표시하고 새 Asset 버전으로 복구한다 |
| 악성 WAV 정규화 | 입력 한도 안에서도 큰 출력 Buffer와 과도한 chunk 순회를 유발할 수 있었다 | sample rate·chunk 수·예상 정규화 크기를 할당 전에 제한한다 |
| PCM24·sample rate 변환 | 동기 Sample loop가 서버 Event Loop를 점유했다 | 제한된 Worker Thread에서 변환하고 시간·메모리 한도를 적용한다 |
| 저장 중 process 종료 | Asset·revision·현재본의 일부만 게시될 수 있었다 | 내구성 journal과 시작 복구로 commit 또는 이전 revision을 확정한다 |
| Rollback 파일 충돌 | journal 경로만으로 기존 Asset·revision을 삭제할 수 있었다 | ID·경로·SHA-256·현재 참조로 Transaction 소유가 증명된 파일만 삭제한다 |
| 최초 Project 생성 중 종료 | 완성되지 않은 최종 Project 디렉터리가 남을 수 있었다 | create journal 안에서 완성한 디렉터리를 원자적으로 게시하고 시작 시 복구한다 |
| Source Update의 복수 Text Cue | 같은 Unit의 첫 Cue를 임의로 Anchor에 사용할 수 있었다 | 후보가 정확히 하나일 때만 Anchor를 확정하고 복수 후보는 재검토로 보낸다 |
| 브라우저 Audio 종료 | Cue 종료·프로젝트 변경 뒤 Audio가 남을 수 있었다 | 종료 timer와 중앙 controller가 활성 Audio와 비동기 완료를 정리한다 |

각 조건은 `tests/media-workflow-regression.test.ts`의 지정된 회귀 이름으로 재현하고 수정 후 통과시켰다.

## 3 Placement Information

- Project 편집 Entity `TextPlacementInformationDecision`은 `unresolved`, `non-informational`, `informational`을 구분한다. informational에는 존재하는 Information ID가 한 개 이상 필요하고 Placement당 판정은 최대 하나다.
- exact·abbreviation·replacement는 Canonical Unit의 정보를 상속하고 독립 판정을 갖지 않는다. separate-element의 Placement와 standalone-placement는 독립 판정이 필수이며 unresolved이면 안전 출력되지 않는다. separate-element의 별도 Canonical Cue는 기존 Canonical 정보를 유지한다.
- `PATCH /api/projects/:projectId/text-placements/:placementId/information`은 `expectedRevision`으로 판정을 바꾼다. UI는 Placement·Mapping·판정 상태, Information ID별 Base/Effective Gate, 출력 결과와 Issue code를 표시하며 비정보성 확정·ID 선택·미해결 초기화를 제공한다. Placement 시각은 이 화면에서 읽기 전용이다.
- 판정 변경은 관련 Shot·Frame·text-cue Anchor를 재검토 상태로 돌리고 Codex basis를 바꾼다. Mapping 관계 변경은 판정 생성·제거를 원자적으로 수행한다. Source Update는 완전히 같은 Placement의 기존 판정만 보존한다.

## 4 Audio Asset Workflow

- 지원 형식은 mono/stereo 16/24-bit PCM WAV다. AIFF·MP3와 다른 컨테이너·코덱은 명시적으로 거부한다.
- `POST /api/projects/:projectId/audio/:cueId/asset`은 `multipart/form-data`, 파일 한 개, `expectedRevision`, 50MB 한도를 요구한다. 파일명은 설명에만 쓰며 저장 경로는 새 Asset ID의 hash로 만든다.
- WAV chunk 구조, MIME, codec, 채널, 실제 duration, sample rate, 1시간 상한을 검사한다. 입력 sample rate는 8,000–384,000Hz, chunk는 최대 4,096개이며 정규화 결과는 50MB 이하여야 한다. 출력 Frame·Byte·Sample 연산량을 먼저 계산한 뒤 프로젝트 `handoff.timebase.sampleRate`의 PCM16 WAV로 정규화하고 결과를 다시 검사한다.
- 정규화 Sample loop는 서버 Event Loop 밖의 Worker Thread에서 실행한다. `storyboard.config.json`의 `maxWorkers`, `timeoutMs`와 V8 세대·stack 메모리 한도를 적용하며, Worker 시작·실행·응답 실패는 구체적인 오류로 끝난다. 실패 시 ProjectStore update가 시작되지 않아 revision과 Asset 디렉터리가 바뀌지 않는다.
- 실제 duration으로 `endMs`를 계산하고 `timingStatus=measured`, 신규 `assetId`를 설정한 뒤 Audio Relation과 Information Gate를 다시 검사한다. 교체 시 기존 Asset을 보존하고 신규 version을 올린다.
- 저장된 Audio는 실제 WAV의 duration·sample rate·channel·codec이 Asset metadata와 맞고 Asset 길이가 Cue 타임라인과 맞아야 안전 출력된다.
- `POST /api/projects/:projectId/audio/:cueId/normalize`는 hash와 구조가 유효한 이전 WAV를 읽어 프로젝트 PCM 형식의 새 Asset 버전으로 복구한다. 이전 Asset과 파일은 감사용으로 보존한다.

## 5 Media Integrity

- `sharp` 0.35.4(Apache-2.0)는 macOS·Linux에서 PNG·JPEG·WebP의 실제 MIME, 전체 decode, width·height와 40MP 상한을 확인한다.
- `@fastify/multipart` 10.1.1(MIT)은 Node.js에서 오디오 업로드 파일 수·필드 수·50MB 한도를 적용한다. 오디오 import는 시스템 `ffmpeg` 또는 `afconvert`에 의존하지 않는다.
- ProjectStore의 Raw Asset fetch와 안전 출력은 프로젝트 내부 경로, 파일 존재, 저장 metadata의 SHA-256, MIME, 이미지 decode 또는 WAV parse와 실제 Audio metadata를 매번 확인한다.
- Program Monitor는 `GET /output/frame/:frameId`와 `GET /output/audio/:cueId`만 사용한다. 두 경로는 현재 출력 판정도 다시 실행하고 `Cache-Control: no-store`를 반환한다.
- PDF에서 손상된 Frame은 bitmap 대신 Frame ID, Asset ID, Issue code가 있는 placeholder로 바뀐다. CSV는 Asset metadata와 현재 integrity/output 상태, Placement Information 판정을 제공한다.

## 6 저장과 브라우저 재생

- ProjectStore는 이전/다음 Project, 새 revision, 새 Asset을 transaction 디렉터리에 기록하고 각 파일과 디렉터리를 동기화한다. journal version 2를 준비 완료 표식으로 마지막에 저장한 뒤 hard link로 Asset → revision을 게시하고 현재본의 원자 rename을 commit point로 사용한다.
- journal은 이전·다음 Project, revision, 각 Asset의 SHA-256과 Asset ID·상대경로·staging 이름을 기록한다. 서버 시작 시 현재 revision, 파일 해시와 현재 Project 참조를 모두 대조한다. 게시 전 중단은 증명된 신규 파일만 제거하고, 유효하게 완료된 게시는 유지하며, 현재본만 바뀌고 게시 파일이 없으면 증명된 이전 Project를 복원한다.
- 기존 Asset·revision이 journal 해시와 다르거나 현재 Project가 참조하면 삭제하지 않는다. journal·lock이 손상됐거나 소유권을 정할 수 없는 상태도 보존하고 `STORE_RECOVERY_REQUIRED`로 차단한다. journal Asset 경로는 해당 Project의 `assets` 디렉터리 안으로 제한한다.
- lock은 Project ID, Host, PID와 transaction ID를 기록한다. 같은 Host의 종료된 PID와 정확한 소유권만 자동 정리하고, 살아 있는 PID는 `PROJECT_BUSY`, 다른 Host나 해석할 수 없는 lock은 `STORE_RECOVERY_REQUIRED`로 유지한다.
- 최초 Project는 `.create-transactions`에서 current·revision 파일과 빈 Asset·update transaction 디렉터리를 완성하고 동기화한 뒤 최종 Project 디렉터리로 원자 rename한다. 시작 복구는 게시 전 staging을 rollback하고 해시가 맞는 게시 후 Project를 보존한다. 복구 결과는 구조화 로그와 `/api/status.storageRecovery`에 남는다.
- Browser Audio controller는 안전 선택자가 허용한 Cue를 현재 offset에서 시작하고 남은 Cue 길이만큼 종료 timer를 둔다. playhead가 Cue 밖으로 이동하거나 재생을 멈추고, 프로젝트·revision이 바뀌거나 Monitor가 닫히면 모든 활성 Audio를 정리한다. 이전 `play()` Promise나 timer는 현재 entry와 같을 때만 새 상태를 바꾼다.

## 7 PRJ-007 UNIT-045

- Fixture: `tests/fixtures/media/unit045-intercom-48000.wav`
- 형식: WAV, PCM16, mono, 48,000Hz, 2,000ms
- Source: `SEG-019 / UNIT-045 / SOUND`
- J-cut: 849,000–851,000ms, 경계 850,000ms
- 실제 bytes를 ProjectStore의 hash 기반 `assets/*.wav` 경로에 쓰고 안전 Audio HTTP 경로에서 같은 bytes를 읽는다.
- 849,500ms playback selector가 Cue를 선택한다. 저장·JSON 재열기 뒤 relation과 Asset 연결이 유지되며 Effective Gate 목록은 바뀌지 않는다.
- metadata만 메모리에 넣는 기존 검사는 도메인 판정 회귀다. 이 fixture의 저장·HTTP 재읽기 검사가 실제 Audio Asset E2E 완료 근거다.

## 8 Schema와 Migration

- `1.4.0 → 1.5.0`은 독립 Mapping 관계에만 `unresolved` Placement Information Decision을 생성한다. Canonical 상속 관계에는 생성하지 않는다.
- 원문, ID, Timeline, Source Snapshot, TextCue Authority, Mapping, 기존 Asset과 GenerationRecord를 보존한다. 기존 accepted Frame을 임의로 변경하지 않고 파일 무결성은 출력 시 파생한다.
- 전체 경로는 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.5.0`이다. Zod가 런타임 기준이며 생성 JSON Schema와 일치 여부를 검사한다.

## 9 테스트 결과

- `npm run schemas:write`: 생성 Schema 갱신
- `npm run typecheck`: 서버·도메인 TypeScript 검사
- `npm run typecheck:web`: Web TypeScript 검사
- `npm test`: 23개 파일, 321개 테스트
- `npm run schemas:check`: Zod와 JSON Schema drift 검사
- `npm run build:web`: 운영 웹 빌드
- `npm run check`: 위 검사의 통합 실행

기존 검사를 유지하고 Worker 이벤트 루프 응답·시간 초과 무변경, Hash·참조 기반 rollback, 다른 Host·손상 lock 보존, update·initial create crash 복구의 반복 실행, 복수 Text Cue Anchor를 포함해 23개 파일의 321개 검사를 적용했다. test skip/only와 metadata-only E2E 대체는 사용하지 않았다.

## 10 CI

GitHub Actions는 Ubuntu와 Node.js 24에서 `npm ci`와 `npm run check`를 수행한다. feature branch에 push한 종료 HEAD와 run head SHA가 같은 성공 결과만 완료 근거로 사용한다.

## 11 남은 위험

- 지원 오디오 형식은 PCM WAV뿐이다. AIFF·MP3와 압축 WAV codec은 지원하지 않는다.
- `sharp` prebuilt package를 받을 수 없는 환경에서는 설치가 실패하며 이미지 검증을 우회하지 않는다.
- 정보 ID 검사는 bitmap의 간접 암시를 자동 판정하지 못하므로 사람의 시각 검토가 필요하다.
- PRJ-007 전체 32개 Segment의 연출·자막 가독성·음성 호흡과 실제 제작 품질 검토는 남아 있다.
- 지원 입력은 `native-v1`, `production-v1`이다. 임의 문서 입력, 클라우드 협업, 완성 영상 렌더링은 현재 범위가 아니다.
