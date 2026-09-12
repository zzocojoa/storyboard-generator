# 구간 제목형 제작 문서 가져오기 검증

2026-09-10 · 구현과 로컬 서버 반영 완료. 지원 계약은 [Design](../02-design/features/document-handoff.design.md)의 `section-markers-v1`을 따른다.

## 실제 입력과 결과

실제 입력: `/Users/beatlefeed/Documents/ChatGPT/유튜브_V2/PROJECTS/PRJ-008/09_PRODUCTION`.

- 작품: PRJ-008 「같은 하루」. 제목에 프로젝트 ID가 없는 문서도 별도 제작 메타데이터와 manifest를 대조한다.
- 장면 12개, 방송 구간 24개, 원문 208개, 내레이션 6개, 패널 발화 24개, 자막 계획 155개를 보존한다.
- 인물 8명·장면 12개·원문 208개의 명시적 문서 연결 완료. 미연결 0개.
- 은경↔CHAR-05, 정호↔CHAR-04를 포함해 명단 순서와 다른 연결도 촬영 원문 ID와 방송 대본의 정확한 원문·유형·순서 대조로 확인했다.
- 패키지 재읽기와 편집 초안에서 24컷·146개 음성 계획·155개 글자 계획을 확인했다. 내면 독백 2개는 voiceover이며 문자·메모는 음성 Cue로 만들지 않는다.
- 25분은 제작 계획으로 보존한다. 개별 자막 시작·종료는 원본에 없으므로 확정 Placement를 만들지 않고 편집 가능한 proposed Cue를 제공한다. 시각 미확정·자산 부재 등 Final 차단은 유지한다.
- 지정된 외부 8개 파일은 복사한 회귀 Fixture와 바이트 단위로 일치한다. 원본 파일 변경은 없다.

현재 공개 회귀 자료는 독립 작성한 합성 이야기 `garden-steps-demo`로 교체했다. 위 실제 자료 대조는 당시 실행의 증거이며 현재 Fixture가 실제 작품의 사본이라는 뜻은 아니다. 이전 사본은 Git 제외 영역 `.local/private-fixtures/section-documents-prj008/`에 바이트 그대로 보존하고 해시 목록을 `.local/validation/automation-runtime/private-section-fixture-preservation.json`에 기록했다. 새 자료도 8문서·12장면·24구간·208원문·155자막·25분, 명단 순서와 다른 명시 인물 연결·독백·문자·메모·패널·내레이션을 포함한다. 제품 파서의 입력 규칙은 완화하지 않았다. 실제 작품의 전체 자동 제작 검증은 [자동 제작 Report](storyboard-automation-runtime.report.md)에서 별도로 기록한다.

## 실행 검증

| 검증 | 결과 | 실행 증거 |
|---|---|---|
| `npm run check` | 64개 파일, 1,228개 테스트 통과. 타입·웹 타입·스키마·웹 빌드 통과 | `.local/validation/section-check-final.log` |
| Required Registry | 419개, missing/duplicate/skip/only 모두 0 | `.local/validation/section-registry-final.log` |
| 문서·원본 변경 대상 검사 | 3개 파일, 23개 테스트 통과 | `.local/validation/section-focused-final.log` |
| 기존 브라우저 회귀 | 기존 24개 통과 | `.local/validation/section-e2e.log` |
| 신규 브라우저 흐름 | 초안 유지 시간까지 명시한 최종 시나리오 1개 통과. 검토→자동 연결→설정→생성→불러오기→새로고침 | `.local/validation/section-e2e-final.log` |
| 실제 입력 CLI | 원문 수·연결 결과 확인 | `.local/validation/prj-008-section-preview.json` |
| 실제 UI | 기존 Codex Browser 탭 3, 4317에서 최신 화면을 읽고 실제 PRJ-008 폴더 재검토. 2단계에 연결 확인 필요 0개 표시 | 현재 사용자 탭 |

일반 sandbox 검사에서 HTTP listen 권한 오류가 발생한 항목은 로컬 포트 권한으로 전체 검사를 실행해 통과했다. 신규 E2E 초안에서 필수 글자 유지 시간 입력이 빠졌던 검사 코드는 실제 UI 계약에 맞춰 입력을 명시하고 해당 흐름 전체를 다시 실행했다. timeout·retry·제품 검증 조건은 완화하지 않았다.

독립 합성 이야기에서도 서로 다른 ID 접두사, 20초·2구간, 패널·내레이션 부재, 무언 인물의 미해결 상태와 명시적 연결을 검증했다. 기존 PRJ-007 표형 입력은 그대로 지원한다. 프로젝트 ID 혼입, 중복·누락 마커, 원문·화자·시간 불일치, 잘못된 자막 ID·본문·유형과 지정 자막 Cue 삭제를 차단한다.

## 실행 상태와 남은 사용자 입력

4317 서버와 JS/CSS 응답이 정상이다. Runtime Source SHA-256은 `4453232cd68762b0a4c95e7965e99d306a63142bb5ae40d77990ef80b44150f5`다. 서버 로그는 `.local/validation/section-server.log`에 있다.

현재 실제 사용자 탭은 PRJ-008의 연결·설정 단계다. 새 작품의 프레임레이트·음성 샘플레이트·화면비는 사용자가 지정해야 하므로 이전 작품 값을 복사하지 않았다. 패키지 생성·저장 재열기 검증은 격리된 테스트 출력에서 수행했다. 실제 제작 저장소에 PRJ-008 콘티를 새로 생성하거나 기존 PRJ-007 콘티를 덮지 않았다. 최종 그림 콘티의 생성·승인 완료를 의미하지 않는다.
