# 범용 콘티 제작 도구

구조화된 영상 제작 자료를 검증해 컷 단위 콘티로 만들고, 원문·시간표·생성 자산·검토 상태를 함께 편집하는 로컬 웹 도구다. 작품별 데이터는 입력 어댑터와 프로젝트 저장소로 분리하므로 특정 프로젝트 ID, 인물, 장면 수, 분량이나 영상 모드에 의존하지 않는다.

현재 첫 완성본은 다음 흐름을 지원한다.

- `native-v1` 또는 `production-v1` 입력 패키지 검증과 프로젝트별 저장
- 장면·구간 탐색, 원문 및 제작 지시 확인, 컷 분할·병합·재정렬·수정·전환·잠금·확정
- 축약 자막과 Canonical 원문의 관계 검토, Shot별 역할 기반 Source Mapping, Segment 내부 정보 공개 Gate
- 화면비·매체·그림 스타일과 인물·장소·소품 기준 이미지 관리
- Codex App 기반 컷 제안, 기준 이미지를 포함한 프레임 생성, 로컬 가이드 음성 생성
- 시작·키·끝 프레임 편집, 독립 오디오·글자 트랙 타이밍, 그림·자막·음성의 시간순 재생
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

자막 Placement마다 `TextMappingDecision`이 생긴다. 문자열이 정확히 같으면 `exact/confirmed`, 축약 후보나 독립 요소가 감지되면 `unresolved`로 시작한다. `abbreviation`과 `replacement`는 별도 Canonical 렌더링을 끌 수 있고, `separate-element` 또는 별도 렌더링은 Canonical 문구의 시작·종료 시각을 명시해야 한다. 미해결 결정은 초안 저장을 막지 않지만 관련 컷의 확정·이미지 생성·구간 제안 적용을 막는다.

각 컷은 `sourceLinks`를 권한 원본으로 사용한다. Link는 `primary-visual`, `continued-visual`, `audio-only`, `context-only` 용도와 `confirmed`, `mapping-required` 상태를 가진다. 수동 분할에서 시간 근거가 없는 원문은 한쪽 후보에만 배치되고 `mapping-required`로 표시된다. Inspector의 **TEXT MAPPING REVIEW**와 **SOURCE MAPPING**에서 관계·시각·용도·상태를 검토하고 같은 구간의 앞뒤 컷으로 연결을 이동할 수 있다.

## CLI

브라우저 없이 가져오기·검증·JSON/CSV 출력을 확인할 수 있다.

```sh
npm run cli -- --help
npm run cli -- outline --handoff tests/fixtures/native/storyboard_handoff.json --output .local/plant-care.project.json --text-hold-ms 3000
npm run cli -- validate --project .local/plant-care.project.json
npm run cli -- export-csv --project .local/plant-care.project.json --output .local/plant-care.shots.csv
```

`outline`은 구간마다 편집 시작용 컷과 프레임을 만든다. 카메라·화면 위치·출연 인물을 임의로 확정하지 않는다. 음성 슬롯은 글자 수에 비례한 제안 시간이며 생성한 가이드 음성의 WAV 길이를 측정한 뒤 `measured` 상태가 된다. 원본에 화면 글자 종료점이 없으면 `--text-hold-ms` 값이 제안값으로 기록된다. 기존 출력 경로를 덮어쓰지 않는다.

현재 프로젝트 형식은 `1.2.0`이다. `1.0.0` 저장본은 먼저 0ms 직접 전환을 명시한 `1.1.0` 구조로 변환한 뒤 `1.2.0`으로 올린다. 기존 `sourceUnitIds`는 손실 없이 `context-only/mapping-required` Link로 바꾸고, 자막 결정은 원문과 정확히 일치하는 경우에만 자동 확정한다. 축약·모호한 후보는 `unresolved`로 남으므로 사용자가 Mapping을 확인해야 한다. 원문·컷 시간·자산·기존 검토 상태는 유지된다.

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

이 명령은 서버·도메인 타입 검사, 웹 타입 검사, 자동 테스트, 생성 스키마 정합성, 운영 웹 빌드를 순서대로 실행한다. 테스트는 구성과 길이가 다른 두 프로젝트, 겹치는 원본 ID의 분리, 실제 제작 자료 전체, 원문·시간·정보 공개·잠금·원본 갱신·자산·저장·Codex 요청·결과 적용·API·JSON/CSV/PDF를 검사한다. PRJ-007 Golden 검사는 12개 Scene, 32개 Segment, 79개 screenplay Source Unit, 16개 Panel Turn, 1,500,000ms 전체 시간과 원문 불변을 확인한다. `SEG-024`에서는 1,088,000ms, 1,108,000ms, 1,148,000ms의 순차 공개와 Canonical 원문 조기 렌더링·후반 정보 조기 전달이 없음을 검사한다. `SEG-008`에서는 Codex App으로 5개 컷을 제안하고, 첫 프레임을 재생성·승인했으며, 한 발화의 실제 WAV 길이를 측정해 반영했다. 전체 분량의 그림 연속성·연출·낭독 품질은 별도 제작 검토 대상이다.

스키마의 기준은 `src/domain/schema.ts`다. 타입 변경 후 `npm run schemas:write`로 JSON Schema를 갱신하고 `npm run schemas:check`로 일치 여부를 확인한다. 제품 범위와 구현 원칙은 [`AGENTS.md`](AGENTS.md), 데이터 흐름과 API 설계는 [Design](docs/02-design/features/storyboard-generator.design.md)을 따른다.
