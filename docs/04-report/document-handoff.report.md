# 제작 문서 입력 패키지 생성 — Report

## 구현 범위

`codex/document-handoff`에서 제작 문서 8개를 하나의 스토리로 읽는 `production-documents-v1`을 구현했다. 파일에서 작품별 원문·시간표·등장인물·제작 지시를 추출하고 명시적 연결·제작 설정을 받아 자체 완결 패키지를 만든다. 웹과 CLI는 같은 변환을 사용하며 생성된 `storyboard_handoff.json`을 기존 콘티 편집기로 불러올 수 있다.

요구사항은 [Plan](../01-plan/features/document-handoff.plan.md), 계약은 [Design](../02-design/features/document-handoff.design.md), 항목별 근거는 [Check](../03-analysis/document-handoff.analysis.md)를 기준으로 한다. 사용 절차와 설정 예시는 [README](../../README.md#제작-문서-8개에서-패키지-만들기)에 있다. 전용 bkit MCP 도구의 상태 등록은 수행하지 않았다.

## 범용성과 원본 보존 근거

| 입력 | 확인한 내용 |
|---|---|
| 실제 제작 자료 PRJ-007 | 상위 원본 없이 8개 파일만 있는 격리 폴더에서 전체 12장면·32구간·95개 Unit·25분·자막 Placement 25개를 변환했다. 원문 유형·화자·구간·순서를 기존 구조화 원본과 대조했다. 기존 원본은 변환 후 비교 기준으로만 읽었다. |
| 독립 합성 스토리 `plant-doc-demo` | 다른 이름·임의 ID·비연속 장면 번호·20초·2장면·4개 Unit을 처리했다. 패널·내레이션·자막 내용이 없는 8개 파일도 같은 어댑터로 처리했다. |
| 구성 경계 | 내레이션 전용 장면의 지문, 여러 시각 구간의 명시적 연결, 반복 대사 occurrence별 행 출처를 검사했다. |
| 브라우저 | 두 스토리의 검토·서로 다른 제작 설정·패키지 생성·가져오기를 실행하고 저장 프로젝트의 원문 분리와 재열기를 확인했다. |

8개 원본 복사본의 바이트와 SHA-256, 문서 행 출처를 보존한다. 기존 출력과 원본 폴더 내부 출력, symlink 입력, 잘못된 UTF-8·크기·버전·해시·문서 행, 검토 후 변경을 거부한다. 인물 표 순서로 ID를 부여하지 않는다. 기존 `production-v1` 편집표 충돌 근거와 저장본 재열기 계약도 회귀 검사한다.

실제 첨부 경로의 CLI 미리보기와 합성 예시의 CLI 패키지 생성→outline→validate도 실행했다. 실행 산출물과 로그는 저장소의 무시된 `.local/validation/` 아래에 보관하며 소스 커밋에 포함하지 않는다.

## 최종 검증

2026-09-09 로컬 검증에서 DH-01부터 DH-10까지 모두 충족했다. 아래 명령은 모두 종료 코드 0이다.

| 명령·검사 | 결과 | `.local/validation/` 로그 |
|---|---|---|
| `npm run check` | 서버·웹 타입 검사, 60개 파일의 1,214개 테스트, 스키마 일치, 웹 빌드 통과 | `document-handoff-check-final.log` |
| Required Registry | 397개 필수 이름, missing·duplicates·skip·only 모두 0 | 위 check 로그 |
| `npm run test:e2e` | 두 스토리 문서 가져오기를 포함한 17개 통과 | `document-handoff-e2e.log` |
| `npm run test:e2e -- tests/e2e/real-audio.spec.ts --repeat-each=3` | 기존 실제 오디오 7개 검사의 별도 3회 반복, 21개 통과 | `document-handoff-audio-repeat.log` |
| `git --no-pager diff --check`, 문서 링크 검사 | 공백 오류와 새 기능 문서의 끊어진 로컬 링크 없음 | 명령 출력 확인 |

최종 check와 전체 E2E의 소스 트리 SHA-256은 `d0f071537a4cd16307f3410e52bc3239980ad404ef3e76c43e3a0f65c14b95f6`이다. 오디오 별도 반복은 출력 경로 계산의 마지막 수정 전에 실행했고 이후 오디오 구현·테스트는 변경하지 않았다. 일반 CI의 반복 횟수·retry·timeout은 변경하지 않았다.

## 지원 경계와 후속 검토

범용성은 같은 지원 형식의 8개 문서에 적용한다. 문서에 없는 인물 이름↔manifest ID 대응, 모호한 장면·구간 연결과 제작 설정은 작품별 명시적 입력이다. 지원 버전과 문법은 README를 따른다.

이 기능의 완료 범위는 입력 패키지 생성과 편집기 연결이다. 패키지가 생성됐다는 이유로 최종 그림 콘티를 승인하지 않는다. Canonical fact/clue ID·상위 footprint는 복원하거나 검증하지 않으며 자막 종료·축약 관계·의미상 정보 공개·그림과 낭독 품질은 기존 검토 단계에 남는다. 합성 스토리 검증을 다른 실제 작품의 제작 품질 검증으로 간주하지 않는다.

현재 작업은 로컬 기능 브랜치의 구현·검증 범위다. 원격 PR·CI·병합과 기존 실행 서버의 배포 상태는 이번 로컬 결과로 대신하지 않는다.
