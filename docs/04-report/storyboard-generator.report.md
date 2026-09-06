# 범용 콘티 도구 — 1.3.0 보고서

## 1. 작업 기준

구조화 제작 자료를 프로젝트별로 가져와 컷·프레임·오디오·글자·전환·연속성을 편집하고, Codex App에서 컷 제안·이미지·가이드 음성을 생성한 뒤 시간순으로 검토하는 범용 로컬 웹 도구를 기준으로 작업했다. 생성 실행 주체는 Codex App이며 현재 모델, 내장 `image_gen`, 설정된 macOS 음성을 사용한다. `OPENAI_API_KEY`와 OpenAI SDK는 사용하지 않는다.

## 2. 재현한 결함

구현 전 회귀 검사에서 다음 10개 결함을 실제 실패로 재현했다.

- Unit 순서 Gate가 구간 시작 프레임을 차단하지 못함
- 측정 음성이 기준 Gate를 앞당길 수 있음
- 유도 Gate가 원본 규칙처럼 저장됨
- 연속 컷의 키 프레임 공개를 표현하지 못함
- Text Mapping 관계 조합이 잘못된 상태를 허용함
- 중복 정확 일치를 임의로 확정함
- 모든 Source를 비시각 용도로 돌린 제안을 허용함
- unresolved Mapping을 분할 근거로 사용함
- 프레임 생성이 일부 Mapping 충돌만 검사함
- 알 수 없는 Information Rule 검토가 예외로 중단됨

## 3. 핵심 구현

1.3.0은 권한 `baseNotBeforeMs`와 동적으로 계산하는 `effectiveNotBeforeMs`를 분리한다. 직접 시각 Source Link는 컷 상대 구간, 특정 프레임 또는 검토 필요 상태의 `temporalAnchor`를 가진다. Text Mapping 상태 기계, Source 사용·순서 정책, 오디오 근거 검증과 프로젝트/구간/컷/프레임 공통 Review 함수를 하나의 승인·생성 경계에 연결했다.

웹 Inspector에서 **SOURCE TEMPORAL MAPPING**, **TEXT MAPPING REVIEW**, **INFORMATION GATE**, **APPROVAL BLOCKED**를 확인하고 수정할 수 있다. 모든 Mapping 쓰기는 `expectedRevision`을 검사한다. 이미지 문맥은 선택 프레임 시각에 실제 활성화된 직접 Source만 포함한다.

## 4. 변경 파일

| 영역 | 주요 파일 |
|---|---|
| Schema·Migration | `src/domain/schema.ts`, `src/io/project.ts` |
| Gate·Mapping·정책 | `src/domain/mapping.ts`, `src/domain/source-policy.ts`, `src/domain/validation.ts` |
| 편집·트랙·자산 | `src/domain/edit.ts`, `src/domain/frame.ts`, `src/domain/tracks.ts`, `src/domain/media.ts`, `src/domain/source-update.ts` |
| 제안·생성 문맥 | `src/proposal/outline.ts`, `src/proposal/model.ts`, `src/proposal/context.ts` |
| UI·출력 | `web/src/App.tsx`, `src/exporters/csv.ts`, `src/exporters/pdf.ts` |
| 검사·운영 | `tests/information-interlock.test.ts`, 기존 회귀 검사, `.github/workflows/ci.yml` |

## 5. Migration

`1.0.0 → 1.1.0 → 1.2.0 → 1.3.0` 변환을 지원한다. 1.2 Link에는 보수적인 `unresolved/migration` Anchor를 부여하고 승인 상태를 재검토한다. 보관된 입력 snapshot에서 Information Rule의 기준 시각을 복원하며 원문, 컷, 시간, 자산과 생성 기록은 유지한다.

## 6. 테스트 결과

로컬에서 19개 파일, 92개 테스트가 통과했다. 요구된 이름의 정보 공개 회귀 시나리오 27개가 모두 포함돼 있다. 서버/도메인 TypeScript, Web TypeScript, 생성 Schema drift 검사와 운영 Web build는 최종 품질 명령으로 함께 검사한다.

## 7. PRJ-007 Golden

PRJ-007은 제품 분기가 아닌 실제 회귀 자료다. Golden 검사는 12 Scene, 32 Segment, screenplay Unit 79개, Panel Turn 16개, 총 1,500,000ms와 원문·시간·참조 보존을 확인한다. `SEG-024`의 정보 공개 시각은 1,088,000ms, 1,108,000ms, 1,148,000ms이며 기준/유효 Gate와 확정 Anchor로 검사한다.

## 8. CI

GitHub Actions는 pull request와 `master`, `codex/storyboard-generator` push에서 Node.js 24로 `npm ci`와 `npm run check`를 실행하도록 구성한다. 실제 원격 실행 결과는 해당 commit의 Actions 상태를 기준으로 판단한다.

## 9. 남은 위험

- PRJ-007 전체 분량의 이미지 연출·시각 연속성과 낭독 호흡은 사람 검토가 필요하다.
- 구조가 다른 두 번째 실제 작품의 제작 품질과 입력 계약 적합성 검증이 남아 있다.
- 축약·대체·별도 요소 Mapping과 이미지 속 간접 정보 노출은 사용자 판단이 필요하다.
- Codex App이 요청별 비용을 제공하지 않으므로 비용은 `N/A`로 기록한다.
