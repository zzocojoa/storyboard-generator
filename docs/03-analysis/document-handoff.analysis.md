# 제작 문서 입력 패키지 생성 — Check

## 요구사항별 근거

| ID | 구현·검증 근거 | 판정 |
|---|---|---|
| DH-01 | `codex/document-handoff`, 기능별 Plan·Design | 검증됨 |
| DH-02 | `readDocumentSources`, 격리된 8개 원본의 변환 전후 바이트 대조 | 검증됨 |
| DH-03 | 전체 실제 원문의 유형·화자·구간·순서를 기존 원본과 대조하는 `documents_eight_files_preserve_full_sources_timeline_and_reopen` | 검증됨 |
| DH-04 | 미해결 인물 ID, 장면 ID, 여러 시각 구간과 반복 발화 occurrence 테스트 | 검증됨 |
| DH-05 | `DocumentSettingsSchema`, 빈 FPS/화면비 입력, 설정 누락 거부 | 검증됨 |
| DH-06 | CLI에서 생성한 handoff → readPackage → outline → parseProject, 원본 8개와 설정 포함 | 검증됨 |
| DH-07 | CLI와 preview/create API, 독립 3단계 화면, 두 스토리 가져오기·모바일 오류 및 재시도 E2E | 검증됨 |
| DH-08 | 변조·해시·버전·잘못된 행·중복 결정·symlink·UTF-8·크기·기존 출력 보호 테스트 | 검증됨 |
| DH-09 | 독립 합성 스토리, 내레이션 전용 구성, 여러 시각 구간, 임의 ID와 비연속 장면 번호 | 검증됨 |
| DH-10 | README·설정 스키마·합성 예시·Required Registry, 전체 check/e2e | 검증됨 |

## 검토 중 보완한 항목

동일한 대사가 반복되면 각각의 인물 대본 occurrence 행을 연결한다. 단일 내레이션 구간의 지문도 배정할 수 있고 여러 구간이면 결정을 받는다. 형식이 잘못된 문서 행을 누락시키지 않는다. 재사용한 편집표 파서의 충돌 근거는 기존 원문 행 형식을 유지해 저장본 재열기 계약을 보존한다. 웹의 프레임레이트·샘플레이트 선택에는 명시적인 접근성 이름을 제공한다.

## 지원 경계

각 스토리는 같은 지원 형식의 8개 파일을 제공한다. 문서에 없는 이름↔manifest ID 대응과 제작 설정은 명시적 입력이다. 문서상의 원문·시간·지시·행 출처를 보존하며 Canonical fact/clue 연결이나 상위 footprint를 재구성·검증했다고 주장하지 않는다. 반복 문구의 의미상 같은 정보 여부, 그림 품질, 실제 낭독 길이는 입력 패키지 생성의 자동 완료 판정에 포함하지 않는다. 자막 종료와 축약 관계는 기존 편집기의 검토 상태로 이어진다.

요구사항 10개 모두 구현·검증 근거가 있어 이 입력 기능의 Plan 일치율은 10/10이다. 전체 그림 콘티의 제작 품질 일치율을 의미하지 않는다. 실제 실행 수와 최종 결과는 [Report](../04-report/document-handoff.report.md)에 기록한다.
