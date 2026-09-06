# 범용 콘티 도구 — 1.4.0 구현 보고서

## 1. 작업 기준

- Branch: `codex/storyboard-generator`
- 구현 시작 HEAD: `34646b9261fff80aefe915944e742e72fa457663`
- 구현 종료 HEAD: `fdc24dc19f065a73b424074553ab56878e6b7ae1`
- Project Schema: `1.3.0 → 1.4.0`
- 실행 경계: Codex App의 현재 모델, 내장 `image_gen`, 설정된 macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 fallback은 사용하지 않는다.
- 범위: 특정 프로젝트에 종속되지 않는 최종 정보 출력 경계다. PRJ-007은 fixture와 Golden 회귀로만 사용한다.

## 2. 재현한 결함

| 재현 테스트 | 기존 동작 | 수정 | 수정 후 결과 |
|---|---|---|---|
| `playback_does_not_render_review_required_text` 외 Text 9개 | Text Cue의 본문 권한과 Gate가 실제 Monitor 출력 경로에서 강제되지 않았다. | Cue authority와 공통 출력 판정, 안전 선택자를 추가했다. | 권한 미확정·조기 정보는 본문 없이 code와 ID만 표시된다. |
| `proposed_audio_asset_is_not_playable` 외 Audio 7개 | proposed 또는 자산·Gate가 유효하지 않은 Audio를 실제 재생할 수 있었다. | measured Asset·관계·정보 Gate를 함께 검사하는 재생 선택자를 연결했다. | 안전한 Cue만 `Audio.play()`에 도달한다. |
| `end_frame_uses_last_inside_instant` 외 End Frame 6개 | `offsetMs === shot duration`인 End Frame을 반열린 범위 밖으로 평가했다. | 표시 시각과 평가 시각을 분리했다. | End Frame은 종료점에 표시되고 마지막 내부 ms에서 Source·Mapping·Gate를 평가한다. |
| `j_cut_requires_previous_adjacent_segment` 외 J/L 13개 | Cross-Segment Audio의 의도를 구조적으로 구분하지 못했고 Gate 증거가 될 수 있었다. | 세 관계와 인접 범위 검사를 추가하고 J/L을 Gate 증거에서 제외했다. | 합법 J/L만 저장·재생되고 범위 위반과 Gate 조기화는 차단된다. |
| `migration_130_to_140_preserves_data` 외 Migration 5개 | 1.3 저장본에 새 권한·관계 필드가 없었다. | 기존 근거에서 보수적으로 값을 복원하는 1.4 Migration을 추가했다. | 원문·컷·자산은 보존되고 모호한 Text Cue는 review-required가 된다. |

첫 출력 경계 실행은 import 누락으로 실패했고, 구현 후 40개 중 39개가 통과했다. 남은 End Frame 진단을 수정한 뒤 출력 경계 40개와 PRJ-007 Golden 4개가 모두 통과했다.

## 3. 핵심 구현

- **Information Emission Interlock:** 이미지, Text Overlay, Audio Playback, Speech Generation, Proposal, Export가 `reviewInformationEmission`의 원본 근거·Rule 존재·review 상태·유효 Gate 판정을 공유한다.
- **TextCue authority:** `placement`, `mapping-decision`, `source-unit`, `review-required`와 연결 ID를 Schema에 저장한다. Mapping 파생 Cue의 직접 본문·시각 변경은 거부하고 Source Unit Cue 편집은 Gate를 검사한다.
- **Safe Text playback:** Program Monitor는 `playableTextCuesAt`만 렌더링한다. 차단된 Cue는 본문 대신 cue ID, information ID, issue code를 표시한다.
- **Safe Audio playback:** `playableAudioCuesAt`은 measured 상태, Audio Asset의 대상·길이, timing relation, 정보 Gate를 모두 검사한다. Timeline과 실제 Audio 요소가 같은 결과를 사용한다.
- **End Frame:** display time은 `endMs`, evaluation time은 `max(startMs, endMs - 1)`다. 이미지 문맥, Source Anchor, Text Mapping, Gate, 재생, CSV·PDF에 같은 경계를 적용한다.
- **J/L-cut:** Audio Cue는 `within-segment`, `j-cut`, `l-cut` 중 하나를 명시한다. J-cut은 바로 앞 Segment부터 원본 Segment 안까지, L-cut은 원본 Segment부터 바로 다음 Segment까지 허용한다. J/L은 Gate 증거가 아니다.
- **Speech apply:** 요청 문맥에 timing relation·overhang·information IDs·Segment 범위를 넣는다. 생성 WAV의 측정 길이로 만든 후보가 관계·Gate 검사를 통과한 뒤에만 Asset과 measured Cue를 반영한다.

## 4. Schema와 Migration

- `storyboard_project.schema.json`의 version은 `1.4.0`이다.
- `AudioCue.timingRelation`은 필수다.
- `TextCue.mappingDecisionId`와 `TextCue.authority`는 필수이며 Zod가 authority별 연결 불변식을 검사한다.
- 저장본은 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0` 순서로 변환한다.
- 1.3 Audio Cue는 기존 Segment 내부 계약에 따라 `within-segment`가 된다. Text Cue는 Placement, exact Mapping, Source Unit 순서로 권한을 복원하고 유일하지 않은 경우 `review-required`로 둔다.
- Migration은 source snapshot, 원문·ID, Segment·Shot·Frame 시간, Asset, Generation Record를 보존한다. display/evaluation time은 유도값이라 저장하지 않고 다시 계산한다.

## 5. 변경 파일

- 신규: `src/domain/audio.ts`, `src/domain/emission.ts`, `tests/output-boundary-regression.test.ts`
- Domain/Codex: `schema.ts`, `time.ts`, `mapping.ts`, `tracks.ts`, `playback.ts`, `media.ts`, `validation.ts`, `proposal/context.ts`, `proposal/outline.ts`, `codex/work.ts`
- IO/출력: `io/project.ts`, `importers/import-package.ts`, `exporters/csv.ts`, `exporters/pdf.ts`, 생성 Project Schema
- UI: `web/src/App.tsx`, `web/src/styles.css`
- 검증: 기존 7개 테스트 파일과 PRJ-007 Golden
- 문서: `README.md`, `AGENTS.md`, Design, Analysis, Report, `storyboard-workbench` Skill
- 사용자 소유 untracked 파일 `README 2.md`는 수정·추적하지 않았다.

## 6. 테스트 결과

| 명령 | 결과 | 파일/테스트 | 확인 내용 |
|---|---:|---:|---|
| `npm run schemas:write` | 성공 | 해당 없음 | 1.4.0 JSON Schema 생성 |
| `npm run typecheck` | 성공 | 해당 없음 | Domain·Server strict type 검사 |
| `npm run typecheck:web` | 성공 | 해당 없음 | React UI strict type 검사 |
| `npm test` | 성공 | 20 / 142 | 기존 98개와 신규 44개 회귀 |
| `npm run schemas:check` | 성공 | 해당 없음 | Zod와 생성 Schema 정합성 |
| `npm run build:web` | 성공 | 해당 없음 | 운영 Vite bundle |
| `npm run check` | 성공 | 20 / 142 | 전체 통합 검사 |

## 7. PRJ-007 Golden

- 기존 구조: Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, 전체 1,500,000ms, 원문 변경 0건을 유지한다.
- SEG-024 Text·Audio는 FACT-03 1,088,000ms, FACT-02·FACT-09 1,108,000ms, FACT-10 1,148,000ms의 3단계 Gate 전에는 출력되지 않는다.
- SEG-018의 UNIT-044 Audio는 829,000–831,000ms J-cut으로 저장·JSON 재열기·재생되며 기존 Effective Gate 목록을 바꾸지 않는다.
- End Frame은 마지막 내부 시각의 Source만 사용하며 다음 Shot의 정보와 후반 Text Mapping을 포함하지 않는다.
- PRJ-007의 ID와 시각은 fixture와 Golden Test에만 있고 공통 로직에는 없다.

## 8. CI

- Push HEAD: `fdc24dc19f065a73b424074553ab56878e6b7ae1`
- Workflow Run ID: `34012724139`
- 실행 결과: [GitHub Actions CI](https://github.com/zzocojoa/storyboard-generator/actions/runs/34012724139) 성공
- GitHub는 깨끗한 Ubuntu runner와 Node.js 24에서 `npm ci`, `npm run check`를 실행했다.
- 로컬은 Schema 생성 후 각 typecheck·test·Schema check·web build를 개별 실행하고 `npm run check`를 다시 실행했다. GitHub는 생성 파일을 수정하지 않고 저장소에 반영된 Schema의 drift를 검사했다.

## 9. 남은 위험

- 정보 ID와 원문 관계 검사는 이미지가 사실을 간접적으로 암시하는지 판단하지 못한다. 생성 그림의 사람 검토가 필요하다.
- PRJ-007 전체 분량의 연출·시각 연속성·자막 가독성·가이드 음성 호흡은 제작 검토가 남아 있다.
- 지원 입력은 `native-v1`, `production-v1`이다. 임의 문서 입력, 클라우드 협업, 완성 영상 렌더링은 현재 범위가 아니다.
- Codex App은 요청별 비용을 노출하지 않아 비용을 `N/A`로 표시한다.
