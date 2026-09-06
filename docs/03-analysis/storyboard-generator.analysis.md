# 범용 콘티 도구 — 구현 일치 분석

분석 기준은 [Plan](../01-plan/features/storyboard-generator.plan.md)의 첫 완성본 필수 요구사항 FR-01~FR-10, [Design](../02-design/features/storyboard-generator.design.md), 1.2.0의 Text/Source Mapping과 Information Gate 계약이다. 완료 판단은 문서가 아니라 현재 코드, 생성 Schema, fixture, 자동 검사 결과를 따른다.

## 결과

필수 요구사항 10개는 모두 코드와 자동 검사에 연결되어 코드 기준 일치율은 **100%**다. 이번 P0 세 영역도 Schema, Migration, Domain, Validator, API, UI, Export, Test에 반영됐다. 제작 이미지의 의미·연출과 낭독 품질은 자동 검사 대상이 아니며 사람이 별도로 검토한다.

| 요구사항 | 판정 | 구현·검증 근거 |
|---|---|---|
| FR-01 입력 패키지 | 일치 | `native-v1`, `production-v1`, 경로·버전·해시·권한 검사, 서로 다른 fixture 및 PRJ-007 전체 가져오기 |
| FR-02 차이·누락·미정 표시 | 일치 | 불변 `importIssues`, 별도 `TextMappingDecision`, Mapping review API·화면 |
| FR-03 제작 프로필·시각 기준 | 일치 | 프로젝트별 profile과 인물·장소·소품 기준 자산, 이미지 문맥 연결 |
| FR-04 컷 생성·편집 | 일치 | 역할 기반 `sourceLinks`, 순서 검사, 분할·병합·재정렬·수동 Mapping 편집 |
| FR-05 구도·행동·독립 트랙 | 일치 | 컷 연출·전환, Audio/Text Cue 독립 시간, 축약/Canonical 단일·별도 렌더링 결정 |
| FR-06 그림 콘티 생성 | 일치 | Codex App 큐, `image_gen`, 직접 시각 Link 제한, Mapping·정보 Gate 차단 |
| FR-07 시간순 재생 | 일치 | 프레임 절대 시각, 독립 글자·음성 트랙, 컷 전환 미리보기 |
| FR-08 자동·사람 검토 | 일치 | 구조 오류와 승인 검토 분리, 구체적인 승인 차단 사유, Frame 시각 검토 상태 |
| FR-09 잠금·revision·영향 범위 | 일치 | 낙관적 revision, Mapping 변경 무효화, Information Rule 포함 Source Impact·Update |
| FR-10 JSON·PDF·CSV | 일치 | 1.2.0 JSON과 Migration, Source Link 역할·상태를 보존하는 PDF·CSV |

## P0 해결 분석

### 축약 자막과 Canonical 원문

Placement마다 원본 검토 항목과 독립된 `TextMappingDecision`을 만든다. 문자열이 정확히 일치할 때만 `exact/confirmed`가 되고, 축약 후보와 별도 요소는 `unresolved`다. 미해결 상태에서도 원본 Placement Cue는 원래 시각에 남지만 Canonical 전체 문구를 Segment 시작에 만들지 않는다. `abbreviation` 또는 `replacement`를 별도 렌더링 없이 확정하면 하나의 Cue만 유지한다. 별도 요소는 Canonical 시작·종료 시각이 없으면 승인할 수 없다.

### Shot–Source 시간 Mapping

1.2.0의 권한 필드는 `sourceLinks` 하나다. Link는 시각·연속·음성·문맥 용도와 확정 상태를 가진다. 모델 제안은 Unit 누락·혼입·primary 중복·순서 역전을 거부한다. 수동 분할은 Audio/Text Cue의 분할점 관계를 사용하고, 시간 근거가 없는 원문은 한쪽에만 `mapping-required`로 배치한다. 승인과 이미지 생성은 미확정 Link를 거부하며 UI에서 용도·상태 수정과 같은 Segment의 앞뒤 컷 이동을 제공한다.

### Segment 내부 Information Gate

`InformationRule`은 Segment, 시각, 최초 Unit·순서, 정밀도를 보존한다. 유효 Gate는 확정 Text Placement, 측정 Audio Cue, Unit 순서, Segment 시작의 순서로 계산한다. 이미지 문맥은 직접 시각 Link의 정보와 컷 정보를 합쳐 `shot.startMs + frame.offsetMs`에서 검사한다. 승인 검사도 직접 시각 Link가 포함한 후반 정보를 검사하므로 빈 `informationIds`로 우회할 수 없다. Mapping과 Gate는 Codex basis hash 문맥에 포함된다.

## Migration과 호환성

`1.0.0 → 1.1.0`의 전환 기본값 변환을 유지하고 `1.1.0 → 1.2.0`을 추가했다. 기존 `sourceUnitIds`는 원문 ID를 보존한 `context-only/mapping-required` Link가 된다. 기존 Placement에서는 정확한 문자열 일치만 자동 확정하며 축약·모호한 후보는 `unresolved`다. 기존 원문·컷·시간·자산·생성 기록·검토 상태는 보존한다. 이전 프로젝트는 열 수 있지만 Mapping 검토를 끝내기 전 관련 승인·생성은 차단된다.

## 검증 결과

- P0 재현 테스트는 구현 전 Canonical 조기 렌더링, 분할 Source 전체 복제, 프레임 시각 오계산을 각각 재현했다.
- 전체 자동 검사는 18개 테스트 파일의 65개 테스트를 통과한다.
- 생성 JSON Schema는 Zod 기준과 일치하고 운영 웹 빌드가 완료된다.
- 로컬 브라우저에서 이전 1.1 저장 프로젝트가 1.2.0으로 열리고, `SEG-024`에 Source Mapping 7개, unresolved Text Mapping 2개, 정확한 세 Placement 시각과 구체적인 승인 차단 사유가 표시됨을 확인했다. 미해결 상태의 이미지 요청은 큐를 만들지 않고 관련 Mapping ID와 함께 거부된다.
- PRJ-007 Golden은 Scene 12개, Segment 32개, screenplay Source Unit 79개, Panel Turn 16개, 1,500,000ms, 원문 변경 0건과 Segment 공백·겹침 0건을 확인한다.
- `SEG-024`의 공개 Gate는 1,088,000ms, 1,108,000ms, 1,148,000ms를 유지한다. Canonical 조기 렌더링, Unit 역순, 다른 Segment 혼입, 미확정 Mapping 승인, 후반 정보의 앞 프레임 전달을 거부한다.

GitHub Actions workflow는 현재 저장소에 없으므로 이 결과는 로컬 검증 결과다.

## 남은 제작 검토

- PRJ-007 전체 32개 구간의 이미지 연출·시각 연속성과 낭독 호흡 검토
- 구조가 다른 실제 두 번째 작품의 제작 품질과 입력 계약 적합성 검토
- 사람 판단이 필요한 축약·대체·별도 요소 Mapping의 실제 확정

지원 입력은 `native-v1`과 `production-v1`이다. 임의 문서 가져오기, 클라우드 협업, 전체 영상 렌더링은 현재 범위가 아니다.
