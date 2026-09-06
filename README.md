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

Node.js 24.6 이상인 24.x와 npm을 사용한다.

```sh
npm ci
npm run build:web
npm start
```

브라우저에서 `http://127.0.0.1:4317`을 연다. 프로젝트와 생성 자산은 `.local/data` 아래에 프로젝트별로 분리되며 Git에 포함되지 않는다. 각 변경은 현재본과 별개의 revision JSON으로 저장된다.

생성은 서버가 외부 API를 직접 호출하지 않는다. 화면에서 `CODEX CUT`, `IMAGE`, `CODEX VOICE`를 누르면 `.local/codex-requests`에 요청이 저장된다. 같은 저장소의 Codex App 작업에서 다음 스킬을 실행한다.

```sh
$storyboard-workbench 대기 중인 콘티 생성 요청을 처리해 주세요.
```

저장소 스킬 [storyboard-workbench](.agents/skills/storyboard-workbench/SKILL.md)이 현재 Codex 모델로 컷 JSON을 작성하고, 내장 `image_gen`으로 그림을 만들고, macOS `say`의 한국어 음성을 WAV로 변환해 프로젝트에 반영한다. `OPENAI_API_KEY`와 OpenAI SDK는 사용하지 않는다. 생성 중에도 웹 편집은 계속할 수 있으며, 결과 반영 후 화면의 `REFRESH`를 누르면 새 프로젝트 revision을 읽는다.

요청 위치와 로컬 음성은 [`storyboard.config.json`](storyboard.config.json)에서 관리한다. 요청에는 대상 원문·컷·시각 기준의 해시가 들어간다. 요청 뒤 대상이 바뀌면 Codex 결과 적용을 거부하고 새 요청을 요구한다. 화면 상단의 Codex 상태에서 완료·대기·실패, 평균·최대 처리 시간, 같은 대상의 반복 생성 횟수와 최근 실패 원인을 확인한다. Codex App은 요청별 API 비용을 제공하지 않으므로 비용은 0으로 기록하지 않고 `N/A`로 표시한다.

## 프로젝트 불러오기

웹 화면의 `IMPORT PACKAGE`에 `storyboard_handoff.json`의 절대경로 또는 저장소 루트 기준 상대경로를 입력한다. 입력 계약은 파일 역할·상대경로·필수 여부·해시 방식·필드별 기준 원본과 제작 설정을 명시한다.

- [`storyboard_handoff.schema.json`](schemas/storyboard_handoff.schema.json): 입력 패키지 계약
- [`native_dataset.schema.json`](schemas/native_dataset.schema.json): 범용 원본 데이터 계약
- [`storyboard_project.schema.json`](schemas/storyboard_project.schema.json): 재편집 프로젝트 계약
- [검증 fixture 설명](tests/fixtures/README.md): 합성 범용 사례와 초기 실제 회귀 사례의 구분

`native-v1`은 한 개의 공통 데이터 파일을 읽는다. `production-v1`은 구조화 대본·시간표·인물·장면과 제작 문서 역할을 명시적으로 연결한다. 형식 전용 파일명과 필드는 각 어댑터 안에서만 처리한다. 구조화 원본이 없는 임의 문서는 현재 지원하지 않으며 파싱 실패 시 추론 기반 가져오기로 전환하지 않는다.

파일 경로는 패키지 루트 안으로 제한한다. `bytes-sha256`은 UTF-8 파일 바이트를 검사하고, `sorted-json-sha256`은 유니코드 코드 포인트 순으로 키를 정렬한 공백 없는 JSON을 검사한다. 필수 파일 누락, 해시 불일치, 끊어진 참조, 미지원 버전은 구체적인 오류로 끝난다. 문구나 선언의 제작상 차이는 원문을 고치지 않고 검토 항목으로 보존한다.

자막 Placement마다 `TextMappingDecision`이 생긴다. 문자열이 정확히 같으면 `exact/confirmed`, 축약 후보나 독립 요소가 감지되면 `unresolved`로 시작한다. `separate-element`에서는 Placement Cue와 Canonical Cue가 서로 다른 화면 요소와 시각을 유지하며 Placement가 Canonical 정보 ID를 상속하지 않는다. Mapping 결정이 없거나 중복되거나 미해결이면 Placement 본문은 Program Monitor·PDF·CSV 안전 출력에서 차단된다. Migration에서 권한을 확정하지 못한 Text Cue는 Inspector에서 Placement, Mapping Decision, Source Unit 중 하나로 원문 기반 복구하거나 필수 커버리지를 해치지 않는 경우 삭제할 수 있다.

각 컷은 `sourceLinks`를 권한 원본으로 사용한다. Link는 `primary-visual`, `continued-visual`, `audio-only`, `context-only` 용도와 `confirmed`, `mapping-required` 상태, 컷 안에서 처음 유효해지는 `temporalAnchor`를 가진다. Anchor는 컷 상대 반열린 구간이나 특정 프레임으로 확정하거나 검토 필요 상태로 둘 수 있다. Anchor에 연결된 프레임 시각을 바꾸면 해당 Link와 승인을 자동으로 재검토 상태로 돌린다. 수동 분할에서 시간 근거가 없는 원문은 한쪽 후보에만 배치되고 `mapping-required`로 표시된다. Inspector의 **TEXT MAPPING REVIEW**, **SOURCE TEMPORAL MAPPING**, **INFORMATION GATE**에서 절대 공개 시각, Gate 비교 결과, 관계·용도·상태와 기준/유효 공개 시점을 검토하고 같은 구간의 앞뒤 컷으로 연결을 이동할 수 있다.

## CLI

브라우저 없이 가져오기·검증·JSON/CSV 출력을 확인할 수 있다.

```sh
npm run cli -- --help
npm run cli -- outline --handoff tests/fixtures/native/storyboard_handoff.json --output .local/plant-care.project.json --text-hold-ms 3000
npm run cli -- validate --project .local/plant-care.project.json
npm run cli -- export-csv --project .local/plant-care.project.json --output .local/plant-care.shots.csv
```

`outline`은 구간마다 편집 시작용 컷과 프레임을 만든다. 카메라·화면 위치·출연 인물을 임의로 확정하지 않는다. 음성 슬롯은 글자 수에 비례한 제안 시간이며 생성한 가이드 음성의 WAV 길이와 선언한 구간 관계를 검증한 뒤 `measured` 상태가 된다. `j-cut`은 바로 앞 구간부터 원본 구간 안까지, `l-cut`은 원본 구간부터 바로 다음 구간까지만 걸칠 수 있다. 두 관계는 정보 Gate를 앞당기는 증거로 사용하지 않는다. 원본에 화면 글자 종료점이 없으면 `--text-hold-ms` 값이 제안값으로 기록된다. 기존 출력 경로를 덮어쓰지 않는다.

현재 프로젝트 형식은 `1.4.0`이다. 이전 저장본은 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0` 순서로 변환한다. 기존 `sourceUnitIds`는 손실 없이 `context-only/mapping-required` Link로 바꾸고, 1.2 Link의 시간 Anchor는 자동 확정하지 않고 `unresolved/migration`으로 둔다. Canonical 연결이 없던 이전 자막 결정도 `standalone-placement/unresolved`로 보수적으로 변환한다. 1.3 Audio Cue는 `within-segment`로 이관하며 Text Cue 권한은 Placement, 정확한 Mapping, Source Unit 근거에서 복원한다. 근거를 유일하게 정할 수 없는 Text Cue는 `review-required`로 두어 화면·재생·내보내기에서 본문을 출력하지 않는다. 자막 결정은 유일한 정확 일치만 자동 확정하며 축약·대체·별도 요소·독립 Placement는 관계 불변식을 지켜야 한다. Information Rule의 `baseNotBeforeMs`는 원본 기준 하한으로 보존하고, 현재 Text Mapping·Source Anchor·검증된 같은 구간의 측정 Audio Cue에서 유효 Gate를 다시 계산한다. Source나 Audio가 더 늦은 Unit-order 근거보다 앞서면 Gate를 앞당기지 않고 검토를 요구한다. 원문·컷 시간·자산·생성 기록은 유지되며 불확실한 이전 승인 상태는 재검토된다.

Program Monitor와 실제 오디오 재생은 공통 출력 인터록을 통과한 Cue만 사용한다. `proposed` 음성, 자산·길이 불일치, 권한 미확정 Text Cue, 미해결 정보 규칙, Gate보다 이른 정보는 출력하지 않고 문제 코드와 대상 ID만 표시한다. Frame bitmap은 자산 종류·대상 Frame·시각 검토·Source Mapping·정보 Gate를 채널별 공통 판정으로 확인한다. 변경으로 stale·pending·rejected가 된 bitmap은 Shot Board의 검토 자료와 JSON에는 남지만 Program Monitor·전환·PDF에는 나타나지 않으며 CSV에는 `blocked`와 Issue code가 기록된다. End Frame은 컷 종료 시각으로 표시하되 반열린 시간 계약에 따라 마지막 내부 시각 `endMs - 1`에서 평가한다.

Codex App 생성 브리지의 현재 요청과 적용 명령은 다음과 같이 확인할 수 있다. 일반 사용에서는 저장소 스킬이 이 명령을 실행한다.

```sh
npm run codex-workbench -- pending
npm run codex-workbench -- context --request <UUID>
npm run codex-workbench -- --help
```

CSV에서 같은 오디오 이벤트가 여러 컷 행에 나타나면 하나의 이벤트 ID를 공유하는 것이며 발화를 반복 생성하지 않는다. 스프레드시트 수식으로 해석될 수 있는 셀은 작은따옴표로 보호한다. 원문 그대로의 교환과 재편집에는 프로젝트 JSON을 사용한다.

## 검증

```sh
npm run check
```

이 명령은 서버·도메인 타입 검사, 웹 타입 검사, 자동 테스트, 생성 스키마 정합성, 운영 웹 빌드를 순서대로 실행한다. 현재 자동 검사는 21개 파일의 190개 테스트다. 테스트는 구성과 길이가 다른 두 프로젝트, 원문·시간·정보 공개·잠금·원본 갱신·Codex 요청·API·JSON/CSV/PDF와 Text Mapping 및 stale Frame 출력 회귀를 검사한다. PRJ-007 Golden은 12개 Scene, 32개 Segment, 79개 screenplay Source Unit, 16개 Panel Turn, 1,500,000ms 전체 시간과 원문 불변을 확인한다. `SEG-024`의 Text는 세 공개 시점을 검사하고 Audio는 실제 발화 Source가 뒷받침하는 단계만 보고한다. `SEG-018` 호출음 J-cut은 `SEG-019` SOUND `UNIT-045`를 849,000–851,000ms로 사용하며 850,000ms 경계 이전 재생과 Gate 비조기화를 확인한다. 전체 분량의 제작 품질은 별도 사람 검토 대상이다.

스키마의 기준은 `src/domain/schema.ts`다. 타입 변경 후 `npm run schemas:write`로 JSON Schema를 갱신하고 `npm run schemas:check`로 일치 여부를 확인한다. 제품 범위와 구현 원칙은 [`AGENTS.md`](AGENTS.md), 데이터 흐름과 API 설계는 [Design](docs/02-design/features/storyboard-generator.design.md)을 따른다.
