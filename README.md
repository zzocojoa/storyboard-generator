# 범용 콘티 제작 도구

구조화된 영상 제작 자료를 검증해 컷 단위 콘티로 만들고, 원문·시간표·생성 자산·검토 상태를 함께 편집하는 로컬 웹 도구다. 작품별 데이터는 입력 어댑터와 프로젝트 저장소로 분리하므로 특정 프로젝트 ID, 인물, 장면 수, 분량이나 영상 모드에 의존하지 않는다.

현재 첫 완성본은 다음 흐름을 지원한다.

- `native-v1` 또는 `production-v1` 입력 패키지 검증과 프로젝트별 저장
- 장면·구간 탐색, 원문 및 제작 지시 확인, 컷 분할·병합·재정렬·수정·잠금·확정
- 화면비·매체·그림 스타일과 인물·장소·소품 기준 이미지 관리
- OpenAI 구조화 출력 기반 컷 제안, 기준 이미지를 포함한 프레임 생성, 가이드 음성 생성
- 그림·원문 화면 글자·음성의 시간순 재생과 프레임 시각 검토
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

OpenAI 생성 기능을 사용하려면 예시 환경 파일을 복사하고 본인의 API 키를 입력한다.

```sh
cp .env.example .env
npm start
```

`.env`는 Git에서 제외되며 키는 프로젝트 JSON, 브라우저 API 응답, 로그에 기록되지 않는다. 키가 없어도 가져오기·편집·저장·재생·검증·내보내기는 사용할 수 있다. 화면에서 생성 버튼은 설정 필요 상태로 표시된다. 가이드 음성은 AI가 생성한 음성이다.

OpenAI 모델과 이미지 품질, 음성, 요청 제한은 [`storyboard.config.json`](storyboard.config.json)에서 명시적으로 관리한다. 기본값은 컷 제안 `gpt-6-astra`, 그림 `gpt-image-2`, 음성 `gpt-4o-mini-tts`다. 계정의 모델 접근 권한과 실제 비용·지연은 실제 호출 결과로 확인한다.

## 프로젝트 불러오기

웹 화면의 `IMPORT PACKAGE`에 `storyboard_handoff.json`의 절대경로 또는 저장소 루트 기준 상대경로를 입력한다. 입력 계약은 파일 역할·상대경로·필수 여부·해시 방식·필드별 기준 원본과 제작 설정을 명시한다.

- [`storyboard_handoff.schema.json`](schemas/storyboard_handoff.schema.json): 입력 패키지 계약
- [`native_dataset.schema.json`](schemas/native_dataset.schema.json): 범용 원본 데이터 계약
- [`storyboard_project.schema.json`](schemas/storyboard_project.schema.json): 재편집 프로젝트 계약
- [검증 fixture 설명](tests/fixtures/README.md): 합성 범용 사례와 초기 실제 회귀 사례의 구분

`native-v1`은 한 개의 공통 데이터 파일을 읽는다. `production-v1`은 구조화 대본·시간표·인물·장면과 제작 문서 역할을 명시적으로 연결한다. 형식 전용 파일명과 필드는 각 어댑터 안에서만 처리한다. 구조화 원본이 없는 임의 문서는 현재 지원하지 않으며 파싱 실패 시 추론 기반 가져오기로 전환하지 않는다.

파일 경로는 패키지 루트 안으로 제한한다. `bytes-sha256`은 UTF-8 파일 바이트를 검사하고, `sorted-json-sha256`은 유니코드 코드 포인트 순으로 키를 정렬한 공백 없는 JSON을 검사한다. 필수 파일 누락, 해시 불일치, 끊어진 참조, 미지원 버전은 구체적인 오류로 끝난다. 문구나 선언의 제작상 차이는 원문을 고치지 않고 검토 항목으로 보존한다.

## CLI

브라우저 없이 가져오기·검증·JSON/CSV 출력을 확인할 수 있다.

```sh
npm run cli -- --help
npm run cli -- outline --handoff tests/fixtures/native/storyboard_handoff.json --output .local/plant-care.project.json --text-hold-ms 3000
npm run cli -- validate --project .local/plant-care.project.json
npm run cli -- export-csv --project .local/plant-care.project.json --output .local/plant-care.shots.csv
```

`outline`은 구간마다 편집 시작용 컷과 프레임을 만든다. 카메라·화면 위치·출연 인물을 임의로 확정하지 않는다. 음성 슬롯은 글자 수에 비례한 제안 시간이며 생성한 가이드 음성의 WAV 길이를 측정한 뒤 `measured` 상태가 된다. 원본에 화면 글자 종료점이 없으면 `--text-hold-ms` 값이 제안값으로 기록된다. 기존 출력 경로를 덮어쓰지 않는다.

CSV에서 같은 오디오 이벤트가 여러 컷 행에 나타나면 하나의 이벤트 ID를 공유하는 것이며 발화를 반복 생성하지 않는다. 스프레드시트 수식으로 해석될 수 있는 셀은 작은따옴표로 보호한다. 원문 그대로의 교환과 재편집에는 프로젝트 JSON을 사용한다.

## 검증

```sh
npm run check
```

이 명령은 서버·도메인 타입 검사, 웹 타입 검사, 자동 테스트, 생성 스키마 정합성, 운영 웹 빌드를 순서대로 실행한다. 테스트는 구성과 길이가 다른 두 프로젝트, 겹치는 원본 ID의 분리, 실제 제작 자료 전체, 원문·시간·정보 공개·잠금·원본 갱신·자산·저장·API·JSON/CSV/PDF를 검사한다. OpenAI 호출은 모의 커넥터로 검증하므로 실제 그림의 연속성, 연출 품질, 낭독 자연스러움, 계정별 접근 권한과 비용은 API 키로 대표 구간을 생성해 사람이 확인해야 한다.

스키마의 기준은 `src/domain/schema.ts`다. 타입 변경 후 `npm run schemas:write`로 JSON Schema를 갱신하고 `npm run schemas:check`로 일치 여부를 확인한다. 제품 범위와 구현 원칙은 [`AGENTS.md`](AGENTS.md), 데이터 흐름과 API 설계는 [Design](docs/02-design/features/storyboard-generator.design.md)을 따른다.
