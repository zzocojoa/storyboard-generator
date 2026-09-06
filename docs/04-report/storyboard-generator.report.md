# 범용 콘티 도구 — 출력 안전성 구현 보고서

## 1 작업 기준

- Branch: `codex/storyboard-generator`
- 구현 시작 HEAD: `c985dd24671747e29ebe92b0c0dd921839c48cd2`
- Project Schema: `1.4.0`
- 실행 경계: Codex App의 현재 모델, 내장 `image_gen`, 설정된 macOS 음성을 사용한다. `OPENAI_API_KEY`, OpenAI SDK, 외부 생성 fallback은 사용하지 않는다.
- 범위: 범용 Text·Frame 출력 안전성이다. PRJ-007 ID와 시각은 production fixture와 Golden 회귀에서만 사용한다.

## 2 재현한 결함

- 미해결 Placement Mapping은 Information ID가 빈 배열이어서 Program Monitor와 내보내기 검사를 우회할 수 있었다.
- `separate-element` Placement가 별도 Canonical Cue의 Information ID를 잘못 상속했다.
- Canonical Cue 재사용이 Mapping Decision이 아닌 Canonical Unit ID를 기준으로 해 같은 Unit을 쓰는 두 결정이 충돌했다.
- Frame의 `imageAssetId`가 남아 있으면 pending·rejected·stale 상태에서도 Program Monitor와 PDF가 bitmap을 읽을 수 있었다.
- PRJ-007 SEG-018 호출음 J-cut 회귀가 실제 SOUND Source 대신 SEG-018 NARRATION `UNIT-044`를 대상으로 했다.

## 3 Text 출력 수정

- `resolveTextCueMapping`이 Placement별 결정 수와 상태를 `resolved`, `review-required`, `missing`, `ambiguous`로 판정한다.
- 결정이 유일하게 확정되지 않으면 `TEXT_MAPPING_REVIEW_REQUIRED`, `TEXT_MAPPING_DECISION_MISSING`, `TEXT_MAPPING_DECISION_AMBIGUOUS`로 본문을 차단한다.
- exact·abbreviation·replacement Placement만 Canonical Information ID를 상속한다. separate-element·standalone Placement는 상속하지 않는다.
- Canonical Cue는 `mappingDecisionId`로 생성·재사용한다.
- review-required Text Cue는 `expectedRevision` API와 Inspector에서 Placement, Mapping Decision, Source Unit 권한으로 원문 기반 재구성하거나 필수 커버리지 검증 뒤 삭제할 수 있다.

## 4 Frame 출력 수정

- `reviewFrameOutput`이 Program Monitor, transition preview, PDF, CSV의 자산 존재·종류·대상 Frame, 시각 승인, Source Mapping, Information Gate를 함께 검사한다.
- 차단된 bitmap은 Program Monitor와 전환에서 placeholder로 보이고 PDF 자산 로더에 전달되지 않는다. PDF placeholder와 CSV에는 Frame ID와 Issue code가 남는다.
- Shot Board와 Frame Editor는 이전 bitmap을 검토할 수 있으며 `CURRENT`, `PENDING REVIEW`, `STALE`, `REJECTED`, `OUTPUT BLOCKED` 상태를 표시한다.
- JSON은 기존 `imageAssetId`와 Asset을 보존한다. Frame·Shot·Mapping·Source·프로필·기준 자산 변경은 관련 Frame을 pending, Shot을 proposed로 되돌린다.

## 5 PRJ-007 J-cut Traceability

- 편집 원본의 SEG-018 지시는 호출음 J-cut으로 아파트 내부에 재진입하도록 요구한다.
- 촬영 원본은 인터폰 호출음을 선행한 뒤 태균 표정으로 컷 인하도록 요구한다.
- 실제 호출음 Source는 `SEG-019`, `UNIT-045`, `SOUND`이고 SEG-018→SEG-019 경계는 850,000ms다.
- 849,000–851,000ms J-cut은 1초 선행하는 제작 결정으로 저장·재열기·재생되며 원본 절대시간 지시로 취급하지 않는다. `UNIT-044`는 SEG-018 NARRATION으로 유지한다.

## 6 Schema와 Migration

- 새 안전성 정보는 저장 필드가 아니라 현재 Project에서 계산하는 출력 판정이다. 따라서 Schema와 Migration은 `1.4.0`을 유지한다.
- Migration에서 보존한 review-required Cue는 새 권한 복구·삭제 API로 처리한다.
- stale Frame Asset은 삭제하거나 덮어쓰지 않고 기존 Project JSON에 보존한다.

## 7 테스트 결과

필수 검증 명령은 `schemas:write`, 서버·웹 typecheck, 21개 파일의 190개 테스트, `schemas:check`, 운영 웹 build, 통합 `check`다. 회귀는 Placement Mapping 11개, Text 권한 8개, Canonical identity 3개, Frame 출력 13개, PRJ-007 Source fidelity 10개, Golden 격리·보고 3개를 포함하고 프로필·기준 자산 무효화도 확인한다.

## 8 PRJ-007 Golden

- Scene 12, Segment 32, screenplay Source Unit 79, Panel Turn 16, 전체 1,500,000ms와 원문·참조를 유지한다.
- SEG-024 Mapping helper는 명시한 Segment 결정만 변경한다.
- SEG-024 Text는 세 공개 시점을 검증한다. Audio는 실제 발화 Source와 측정 Cue가 뒷받침하는 단계만 보고하며 전체 세 단계를 검증했다고 주장하지 않는다.
- SEG-018 호출음은 `UNIT-045` J-cut으로 검증하고 Information Gate 목록을 변경하지 않는다.

## 9 CI

GitHub Actions는 깨끗한 Ubuntu runner와 Node.js 24에서 `npm ci`와 `npm run check`를 실행한다. 완료 보고에는 push한 최종 HEAD와 동일한 run의 결과만 기록한다.

## 10 남은 위험

- 정보 ID 검사는 bitmap이 사실을 간접 암시하는지 판정하지 못하므로 시각 검토가 필요하다.
- PRJ-007 전체 분량의 연출·자막 가독성·가이드 음성 호흡은 제작 검토가 남아 있다.
- 지원 입력은 `native-v1`, `production-v1`이다. 임의 문서 입력, 클라우드 협업, 완성 영상 렌더링은 현재 범위가 아니다.
- Codex App은 요청별 비용을 노출하지 않아 비용을 `N/A`로 표시한다.
