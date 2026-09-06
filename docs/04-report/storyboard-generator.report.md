# 범용 콘티 도구 — 1.3.0 구현 보고서

## 1. 작업 기준

- 시작 Branch: `codex/storyboard-generator`
- 3차 검토 기준이자 구현 시작 HEAD: `e5e5dc78f0b61a71cf134800598336d91f7bc288` (`feat: add temporal storyboard mappings`)
- 후속 감사 시작 HEAD: `f895f12d114a396fb11ebbdfc40e0034a1f2bd3c`
- 종료 상태: 1.3 보강 변경은 Working Tree에 있으며 최종 commit과 GitHub CI 결과는 이 문서의 CI 절에서 구분한다.
- 기존 Project Schema: `1.2.0`
- 신규 Project Schema: `1.3.0`
- 생성 실행: Codex App의 현재 모델, 내장 `image_gen`, 설정된 macOS 음성을 사용한다. `OPENAI_API_KEY`와 OpenAI SDK는 사용하지 않는다.

## 2. 재현한 결함

| 결함 | 재현 테스트 | 기존 잘못된 동작 | 수정 후 동작 |
|---|---|---|---|
| Unit-order 조기 공개 | `unit_order_gate_blocks_segment_start_frame` | 시간 Anchor가 없는 후반 Unit 정보가 Segment 시작부터 허용될 수 있었다. | Gate를 `reviewRequired`로 두고 승인·프레임 생성·제안 적용을 차단한다. |
| Audio Gate 조기화 | `measured_audio_cannot_advance_base_gate` | 측정 Cue를 앞으로 옮겨 기준 Gate를 앞당길 수 있었다. | Base 하한과 더 늦은 Unit-order 근거를 유지하고 앞선 Audio는 충돌로 기록한다. |
| 휴리스틱 Gate 영속 | `derived_gate_is_not_persisted_as_source` | 가져오기 시 계산한 후보 시각이 원본 규칙처럼 남을 수 있었다. | Dataset에는 Base Rule만 저장하고 Effective Gate는 현재 상태에서 재계산한다. |
| 연속 Shot 후반 공개 | `continuous_shot_can_reveal_at_key_frame` | Shot 시작 시각만 검사해 후반 Key Frame의 정상 공개를 승인할 수 없었다. | Source Anchor의 절대 시각으로 검사해 후반 공개를 지원한다. |
| 모순된 Text Mapping | `text_mapping_relation_invariants` | Canonical, 별도 렌더링, 시간 필드의 모순된 조합이 가능했다. | relation별 불변식을 Zod와 공통 Review에서 강제한다. |
| 중복 exact 후보 | `duplicate_exact_text_remains_unresolved` | 같은 문구의 첫 후보를 임의 확정할 수 있었다. | 복수 exact는 Canonical을 비우고 unresolved로 남긴다. |
| Source Usage 우회 | `proposal_rejects_all_nonvisual_usage` | 모든 원문을 비시각 용도로 지정해 순서와 시각 근거 검사를 피할 수 있었다. | 제안과 승인 모두 직접 시각 Source를 요구한다. |
| unresolved 분할 근거 | `unresolved_mapping_is_not_split_evidence` | 미확정 Placement 시각을 Source 분할의 확정 근거로 사용할 수 있었다. | 확정 관계만 사용하고 불확실한 Link는 mapping-required로 둔다. |
| 약한 이미지 검사 | `frame_generation_checks_all_mapping_conflicts` | confirmed 표지만 있으면 의미적으로 틀린 Mapping이 이미지 문맥에 들어갈 수 있었다. | Canonical 존재·구간·종류·exact 문구·별도 시간과 Gate를 공통 Review로 검사한다. |
| Unknown Rule UI 예외 | `unknown_information_rule_returns_review_issue` | Inspector 계산 중 `effectiveInformationGate` 예외로 렌더가 중단될 수 있었다. | `UNRESOLVED_INFORMATION_RULE` 구조화 Issue를 반환한다. |

후속 코드 감사에서는 `separate-element` Cue 결합, 확정 Mapping 의미 충돌 누락, 측정 Audio 변경의 관련 컷 미무효화, exact-time 증거 우선순위, 프레임 이동 후 Anchor 잔존, Anchor 종료점 포함 판정의 6개 회귀를 실패 테스트로 재현했다. 최초 보강 실행은 31개 중 6개 실패, 25개 통과였고 수정 후 미래 Text Mapping 유출과 보수적 Migration까지 추가한 33개가 모두 통과했다.

## 3. 핵심 구현

### Base Information Rule

`InformationRule.baseNotBeforeMs`와 원본 Segment·Unit·정밀도·Source Reference를 권한 입력으로 보존한다. production-v1의 Base는 presentation plan이 지정한 Segment 하한이며 native-v1의 명시적 exact-time은 후보 계산으로 덮어쓰지 않는다.

### Effective Information Gate

`effectiveInformationGate`는 Base Rule, 현재 Text Mapping과 Placement, Source Anchor, 유효한 measured Audio, Unit 순서를 매번 읽는다. Derived 값은 Dataset에 저장하지 않는다. 결과 시각은 Base보다 빠를 수 없으며, Source·Audio가 더 늦은 Unit-order 근거보다 앞서면 후반 하한과 검토 상태를 유지한다.

### Source Temporal Anchor

직접 시각 Link는 컷 상대 `shot-offset`, 동일 컷의 `frame`, 또는 `unresolved` Anchor를 가진다. 활성 구간은 `[startMs, endMs)`다. 분할·병합·재정렬·Link 이동에서 절대 의미를 보존하거나 명시적으로 재검토하며, 연결 프레임의 offset 변경은 `unresolved/frame-change`로 전환한다. Inspector는 절대 공개 시각과 정보별 Gate 비교를 표시한다.

### Text Mapping 상태 머신

`exact`, `abbreviation`, `replacement`, `separate-element`, `standalone-placement`의 Canonical·별도 렌더링·시간 조합을 강제한다. 후보는 명시적 `placement.unitId`, 허용 화면 글자 종류의 유일한 exact, 유일한 휴리스틱 순서다. `separate-element`는 Placement Cue와 Canonical Cue를 독립시키고 분할에는 Canonical 시각을 사용한다.

### Audio Gate 보호

Gate 증거가 되는 measured Audio는 연결 Asset의 종류·subject·길이, Unit과 Rule의 Segment, Cue의 Segment 범위를 모두 만족해야 한다. Base 또는 Unit-order 하한보다 앞선 Audio는 공개 권한이 되지 않는다. 측정 Cue의 시간 변경은 measured 상태를 해제하고 관련 Anchor, 컷 승인, 프레임 검토를 무효화한다. Cross-Segment Audio는 재생할 수 있지만 Gate 증거로 사용하지 않는다.

### Approval / Generation Review 통합

프로젝트·구간·컷·프레임 Review가 Text Mapping, Source Usage, Temporal Anchor, Information Gate를 같은 함수 계층으로 검사한다. 프레임 문맥에는 해당 시각에 활성인 직접 시각 Link와 Text Mapping만 들어간다. `APPROVAL BLOCKED`는 code, entity, field, 기대값, 현재값, Source Reference를 표시한다. Codex 요청은 이 검사를 통과한 뒤에만 생성된다.

## 4. 변경 파일

- 신규 파일: `.github/workflows/ci.yml`, `src/domain/source-policy.ts`, `tests/information-interlock.test.ts`, `assets/fonts/NanumGothic-Regular.ttf`, `assets/fonts/OFL.txt`
- 수정 파일: `.agents/skills/storyboard-workbench/SKILL.md`, `AGENTS.md`, `README.md`, Design·Analysis·Report, Domain Schema·Mapping·Validation·Edit·Frame·Tracks·Media·Source Update, Importer, Proposal, IO, Exporter, Web Inspector, 관련 기존 테스트와 설정
- 삭제 파일: 없음
- 생성 Schema: `schemas/shot.schema.json`, `schemas/storyboard_project.schema.json`
- Migration: `src/io/project.ts`의 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0`
- PRJ-007 ID와 시각은 fixture와 Golden Test에만 있으며 공통 도메인 로직에는 없다.

## 5. Migration

- 1.0.0: 각 Shot에 명시적 cut `transitionOut`을 추가해 1.1.0으로 올린다.
- 1.1.0: 원본 Unit과 Segment에서 Information Rule 메타데이터를 복원하고 `sourceUnitIds`를 `context-only/mapping-required` Link로 바꿔 1.2.0으로 올린다.
- 1.2.0: 저장된 handoff와 source snapshot에서 권한 Base Rule을 다시 만들고, 모든 기존 Link에 `unresolved/migration` Anchor를 부여해 1.3.0으로 올린다.
- 불확실한 값: Canonical이 없는 Mapping은 `standalone-placement/unresolved`로, 시간이 부족한 `separate-element`는 unresolved 관계로 보수적으로 변환한다.
- 기존 승인 상태: 모든 이관 Shot을 proposed로 바꿔 Source 시간과 Gate를 다시 확인하게 한다.
- 보존: source snapshot, 원문 문자열·ID, Segment 시간, Shot 내용, Frame, Audio/Text Cue, Asset, GenerationRecord를 유지한다.
- 호환성 제한: 1.2 저장본에 handoff 또는 source snapshot이 없으면 Base 권한을 추측하지 않고 `MIGRATION_SOURCE_REQUIRED`로 중단한다.

## 6. 테스트 결과

| 명령 | 결과 | Test File | Test 수 | 실패 후 수정한 내용 |
|---|---:|---:|---:|---|
| `npm run schemas:write` | 성공 | 해당 없음 | 해당 없음 | `frame-change` Anchor basis를 생성 JSON Schema에 반영 |
| `npm run typecheck` | 성공 | 해당 없음 | 해당 없음 | Domain·Server 타입 확인 |
| `npm run typecheck:web` | 성공 | 해당 없음 | 해당 없음 | Inspector 비교 모델 타입 확인 |
| `npm test` | 성공 | 19 | 98 | 6개 보강 회귀와 PRJ-007의 앞선 Source 대 Unit-order 충돌 계산 수정 |
| `npm run schemas:check` | 성공 | 해당 없음 | 해당 없음 | Zod와 생성 Schema 일치 확인 |
| `npm run build:web` | 성공 | 해당 없음 | 해당 없음 | Vite production bundle 확인 |
| `npm run check` | 성공 | 19 | 98 | 위 검사를 한 번 더 통합 실행 |

요구된 27개 이름의 회귀 테스트를 모두 유지한다. `tests/information-interlock.test.ts`에는 Cue 독립성, 프레임 이동 무효화, 반열린 Anchor 경계, 미래 Mapping 제외, 보수적 Canonical Migration을 포함한 33개 시나리오가 있다.

## 7. PRJ-007 Golden 결과

- Scene: 12
- Segment: 32
- screenplay Source Unit: 79
- Panel Turn: 16
- 전체 길이: 1,500,000ms
- 원문 변경: 0건
- Segment Gap / Overlap: 0건
- 다른 Segment Source 혼입: 0건
- 18:00 Canonical 상세 문구 조기 Cue: 0건
- SEG-024 공개 시각: FACT-03 1,088,000ms, FACT-02 1,108,000ms, FACT-09 1,108,000ms, FACT-10 1,148,000ms
- Audio 조기화 차단: Base 및 더 늦은 Unit-order 하한 전에는 Gate를 앞당기지 않고 관련 승인을 무효화한다.
- Continuous Shot Key Frame 공개: Shot 시작이 1,080,000ms여도 UNIT-064의 1,148,000ms Frame Anchor에서는 허용된다.
- Future Information 차단: UNIT-064는 1,148,000ms 전 프레임에 전달되지 않으며, 이전 프레임 문맥에 1,108,000ms·1,148,000ms Text Mapping을 포함하지 않는다.

## 8. CI 결과

- Workflow 추가: 예. pull request와 `master`, `codex/storyboard-generator` push에서 Node.js 24, `npm ci`, `npm run check`를 실행한다.
- Workflow 실행: `f895f12d114a396fb11ebbdfc40e0034a1f2bd3c`까지 원격 실행됨.
- 실제 GitHub 결과: 해당 실행은 성공했다. 현재 Working Tree의 후속 보강은 commit·push 후 새 실행 결과로 갱신해야 한다.
- 로컬과 GitHub의 차이: 위 98개 결과는 현재 Working Tree의 로컬 결과이고, GitHub 성공은 직전 push의 결과다. Workflow 파일의 존재만으로 현재 변경의 CI 통과를 주장하지 않는다.

## 9. 남은 위험

- 정보 ID와 원문 연결 검사는 이미지가 간접적으로 암시하는 반전까지 판정하지 못하므로 생성 그림의 사람 검토가 필요하다.
- PRJ-007 전체 분량의 연출·시각 연속성·자막 가독성과 가이드 음성 호흡은 제작 검토가 남아 있다.
- `native-v1`, `production-v1` 외 임의 문서 입력은 지원하지 않는다.
- Codex App은 요청별 비용을 제공하지 않아 비용은 `N/A`로 기록한다.
