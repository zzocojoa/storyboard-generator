# 범용 콘티 도구 — Final Readiness Hardening 검증 보고서

## 판정과 작업 기준

13개 권장 수정과 Project Schema 1.8.0 Migration을 구현했다. 생성 완료와 Final Ready는 독립이며 기계적 출력 계약의 통과가 연출 완성도 승인을 대신하지 않는다. 병합 인수 조건은 Hardening PR의 현재 HEAD에서 `check`와 `e2e` 성공이다. master와 기존 PR #4에는 병합하지 않는다.

- 작업 Branch: `codex/storyboard-final-readiness-hardening`.
- Base Branch: `codex/storyboard-final-readiness`, SHA `10ca4e1a776e56a5d934e5f61fd0cfbe72148463`.
- master 기준: `98fea61c75c454078118234078597a801a2a074d`. 기존 PR #4는 열려 있고 미병합이다.
- Project 1.8.0 / Journal 3 / Lock 3 / Process Registry 1 / App 0.1.0.
- Node 24.6.0 / npm 11.5.1. Codex App·내장 image_gen·로컬 macOS Speech 계약을 유지한다.
- 기존 서버 4317/PID 89219는 그대로 두었다. 별도 임시 App·Store만 종료한 뒤 Root를 삭제한다. 운영 `.worktrees/storyboard-generator/.local`은 읽기 전용이며 결과는 현재 작업 영역의 `.local/reviews/final-readiness-hardening/`에 작성한다.

## 권장 수정 일치

| 우선순위 | 권장 수정 | 구현·회귀 근거 |
|---|---|---|
| P0 | Atomic Visual Plan | `edit.ts`, `/visual-plan`, `VisualPlanEditor`; sourced↔black/hold 단일 revision, 실패 불변 |
| P0 | Temporal First Reveal | `source-policy.ts`; Unit별 최소 확정 시각, 수동/Proposal/승인/Final 공통 |
| P1 | Build 생성 계약 Fingerprint | `build-inputs.ts`, `build-fingerprint.ts`; Skill·AGENTS·Schema·Runtime Voice |
| P1 | 이전 Build Pending Supersede | `codex/requests.ts`; 새 ID·원본 요청 보존·실패율 제외 |
| P1 | Review Storage Health | `review-storage-health.ts`; Lock·Transaction·Recovery·Future·Canonical·중간 변경 |
| P1 | Bundle 결정성 | `stable-json.ts`, `review-bundle.ts`, PDF RGB Projection; 정렬·체크섬 재현 |
| P1 | Transition 노출 | `transition.ts`; 종류별 실제 Incoming 시각·공통 Gate |
| P1 | Status 외부 Lock 탐지 | `store.ts`; 초기화 이후 외부 Create/Update·손상 Entry 분리 |
| P1 | Builder/Generation Build 의미 | `generation-build-summary.ts`; 실제 생성별 집계·Legacy/Unlinked 보존 |
| P2 | HEAD와 Dirty 분리 | `build-inputs.ts`, Build Schema; dirty여도 실제 HEAD 유지 |
| P2 | Internal/External Redaction | `review-redaction.ts`, CSV/PDF DTO, CLI; PII 치환·이미지 Placeholder |
| P2 | 목록 Integrity Cache | `store.ts`, `safe-filesystem.ts`; bounded cache·Final/Safe 강제 재검증 |
| P2 | Invalid Range 416 | Safe Audio HTTP; `Content-Range: bytes */full-size`, 206/200 유지 |

신규 회귀는 변경 전 결함을 재현한 뒤 통과시켰다. 실패 재현 로그는 visual/build/storage/bundle/status/range/cache/redaction별로 보존한다. PNG alpha의 PDFKit 비동기 객체 게시 순서가 Bundle 체크섬을 흔드는 현상을 실제 회귀에서 발견했고 출력용 RGB 정규화로 해결했다. 원본 Asset은 변경하지 않는다.

## 현재 출력·생성 계약

Text proposed는 표시된 Draft에서만 허용한다. Final은 `TEXT_TIMING_CONFIRMATION_REQUIRED`이며 Confirm 뒤에도 권한·Mapping·Gate·다른 Cue·Asset을 검사한다. Final Readiness는 실제 Project/Asset에서 단계를 파생하고 실패한 Final PDF·CSV·Bundle은 성공 파일을 만들지 않는다. 실제 Playhead의 활성 Source와 전환 노출 시각을 검사하므로 과거 Frame 생성 시점의 안전성으로 현재 Gap을 우회할 수 없다.

Visual Plan은 Mode와 전체 Source Links를 동시에 검사한다. 성공은 revision 하나, Shot proposed·Frame pending 전이이며 Asset·Record는 보존한다. 실패는 부분 저장이 없다. Unit 순서는 실제 최초 시각 공개로 검사하고 동시 공개·이후 continuation은 역전으로 취급하지 않는다. `cut`·`fade`는 조기 Incoming 없음, dissolve/wipe/match-cut은 전환 시작, after-black-midpoint는 중간 이후, custom 미정은 차단이다. `fade`의 의미는 fade-to-black이며 안전성 정책을 완성 영상 Compositor로 설명하지 않는다.

Build는 실제 HEAD·전체 dirty·생성 입력 dirty를 분리한다. Runtime Source, 생성 계약, 비밀 아닌 Runtime 생성 설정의 세 SHA-256과 Schema Version이 Stable Fingerprint다. `builtAt`, Host, PID, 절대경로, Secret은 동일성에서 제외한다. 같은 Target/Basis라도 이전 Build의 Pending을 재사용하지 않고 superseded로 보존한다. Schema 1.7→1.8은 Legacy Build 신규 필드의 unknown/null과 Transition의 기존 의미를 메모리에서 이관하며 원문·ID·시간·Anchor·Asset·Record·Version bytes를 보존한다.

Review Reader는 저장 Lock을 획득하거나 복구·Heartbeat·mkdir를 하지 않는다. Final은 Quiescence를 요구하고 Draft는 저장 문제와 감사 불가 원인을 표시한다. 검토 도중 증거가 달라지면 결과 게시를 차단한다. 숫자 Version 정렬·Stable JSON·경로 정규화는 의미 있는 배열 순서를 바꾸지 않는다. 실제 생성 이력은 Builder Build와 구분하고 알 수 없는 과거 Build를 현재 값으로 채우지 않는다.

Bundle은 기본 11개 파일이며 Manifest가 나머지 10개 파일을 검사한다. 파일 목록과 CLI 사용법은 [README](../../README.md), 필드·정책 경계는 [Design](../02-design/features/storyboard-generator.design.md)을 기준으로 한다. Internal은 전체 원문·Prompt·이미지를 보존한다. External은 동일 정책을 JSON·CSV·PDF Projection에 적용하며 Source Content·Prompt·절대경로·이메일·전화번호·지정 패턴을 치환한다. Redaction Manifest에는 원문 없이 category·path·hash·개수만 남긴다. External은 EXTERNAL REDACTED Label, 이미지 Placeholder와 `embeddedImageRedaction: not-performed`를 명시하고 media 포함을 거부한다.

목록 Summary의 Integrity Cache는 최대 1,024개이고 Project/Asset/file identity·metadata에 묶인다. Final Readiness·Final PDF/CSV/Bundle·Safe Visual/Frame/Audio·다운로드·생성 Reference는 실제 파일 hash·decode 검사를 강제한다. Safe Audio는 전체 파일 검사 뒤 단일 Range를 제공하며 Invalid/Multi Range는 416·전체 크기 Header, 정상 Partial은 206, Full은 200이다.

## 운영 저장본 보존

| Root | Project | Revision | Domain Final | Storage quiescent | 출력 | Source/Version/Asset 파일 |
|---|---|---:|---|---|---|---:|
| data | plant-care-demo | 9 | 차단, 45 Issues | false | 경고 Draft | 13 |
| data | PRJ-007 | 11 | 차단, 686 Issues | false | 경고 Draft | 16 |
| data-1.6 | PRJ-007 | 283 | 통과 | true | Final | 392 |
| data-4318 | PRJ-007 | 0 | 차단, 444 Issues | true | Draft | 2 |

기준 `verified-10ca4e1/existing-projects.json`과 현재 읽기 전용 결과를 대조했다. Current 4개, Version 307개, Asset 112개, 합계 423개와 중복을 제거한 요청 104개 모두 SHA-256 변경 0이다. 검토 전후 저장 증거도 동일하다. Source Snapshot·Version·Asset·Request 수정, 자동 Confirm·Accept·Asset 교체는 없다. 전체 해시 목록은 `verified-current/existing-projects.json`, 비교 결과는 `data-preservation.json`에 있다.

`data` Root의 기존 `INVALID_PROJECT` Recovery Marker는 현재 Schema로 식별을 확정할 수 없는 Evidence이므로 두 Project의 Storage Health에 보수적으로 보고한다. 파일을 격리하거나 삭제하지 않았으며 Final 차단·Draft 경고로 보존했다. revision 283은 컷 40/40 승인, 필요한 Frame 33/33 accepted, Audio 63/63 playable, Hold 6개 안전이다. 비생성 Frame 7개의 기존 pending 상태는 그대로다.

PRJ-007 회귀 fixture는 12 Scene·32 Segment·79 screenplay Unit·16 Panel Turn·25 Placement·1,500,000ms를 보존한다. UNIT-045 fixture는 849,000–851,000ms J-cut·PCM16 mono 48,000Hz 2초다. 실제 revision 283의 기존 850,000–855,000ms, 5초 within-segment SFX와의 차이를 제작 결정으로 보존하며 자동 보정하지 않는다.

## 실행 검증

| 명령·시험 | 결과 | 파일 | 테스트·점검 수 | 비고 |
|---|---|---:|---:|---|
| npm ci | 성공 | - | - | lockfile 재설치 |
| npm run schemas:write | 성공 | - | - | Project 1.8.0 |
| npm run typecheck | 성공 | - | - | Domain·Server·Script·Test |
| npm run typecheck:web | 성공 | - | - | Web |
| npm test | 성공 | 48 | 1,053 | 단위·통합 |
| npm run test:names | 성공 | - | 255 | missing/duplicate/skip/only 0 |
| npm run schemas:check | 성공 | - | - | 생성 Schema 일치 |
| npm run build:web | 성공 | - | - | Vite |
| npm run test:e2e | 성공 | 2 | 15 | 실제 Chromium |
| 실제 Audio 반복 | 성공 | 1 | 6 × 3 | mock 없는 HTMLAudioElement |
| 주기 Heartbeat 반복 | 성공 | 1 | 5 × 3 | 나머지는 이름 필터로 미선택 |
| Bundle Hardening 반복 | 성공 | 1 | 13 × 3 | 각 실행에서 3개 shuffled 순서 × 3회 |
| Review CLI·Redaction | 성공 | 1 | 15 | JSON·CSV·실제 PDF text/images·오류 계약 |
| npm run smoke | 성공 | - | 54 | 동적 포트·cleanup=true |
| npm run check | 성공 | 48 | 1,053 | 타입·이름·Schema·빌드 포함 |
| git diff --check | 성공 | - | - | 공백 오류 0 |

Required Registry에는 모든 신규 필수 계약을 등록했다. `.skip`·`.only` 선언과 누락·중복은 0이며 반복 시험의 이름 필터 제외와 구분한다. 의도하지 않은 Heartbeat 오류는 없고 fault injection의 예상 경고는 별도다. PDF Redaction 검증은 pdfjs-dist 6.3.289로 실제 text를 추출하고 image operator 수를 검사한다. 기존 Playwright 1.55.0의 npm audit High 2개는 브라우저 다운로드 인증서 검증 관련 기존 전이 의존성 경고이며 이번 새 PDF 검증 의존성에서 발생하지 않았다. 임의 force upgrade는 하지 않았다.

## Runtime Smoke·자원 정리

실제 동적 포트 54844, 54848, 54853, 54857, 54859, 54862에서 54개 점검을 통과했다. 정상 200/201/202, Visual Plan·Temporal 정책 실패 400, revision·Final 충돌 409, Project/Asset 무결성 423, 일시 Store 503, Invalid Range 416·Content-Range, 정상 Partial 206·Full 200을 확인했다.

sourced→black→sourced, sourced→hold→sourced를 실제 API로 왕복했고 각 성공의 단일 revision과 실패 불변을 확인했다. 7개 Transition 정책, 초기화 뒤 외부 Create/Update 탐지, 이전 Build Pending Supersede, Non-quiescent Draft/Final, Internal/External·media 거부, 목록 cache hit 뒤 손상 Asset의 실제 안전 출력 차단을 검사했다. 모든 임시 App·Store·Worker·Timer·Listener를 종료하고 Process Registry가 비어 있음을 확인한 뒤 Root를 삭제했다. `cleaned:true`는 삭제 뒤 출력한다. 여섯 포트는 모두 닫혔고 기존 4317/PID 89219는 유지됐다.

## CI와 병합 경계

Hardening PR은 `codex/storyboard-final-readiness`를 Base로 한다. 기존 [PR #4](https://github.com/zzocojoa/storyboard-generator/pull/4)는 master 대상이며 미병합이다. Ubuntu·Node 24의 `check`가 성공한 뒤 `e2e`가 Chromium 설치·빌드·실제 브라우저 검증을 실행한다. 최종 PR 설명과 완료 보고에서 정확한 HEAD·Workflow Run·두 Job 결과를 확인한다. 이전 Commit의 CI 성공을 최종 HEAD의 성공으로 대체하지 않는다.

변경은 Visual/Temporal 정책, Build/Request/Schema, Storage/Bundle/Status/Range, Summary Cache, Redaction/CLI, Runtime 검증, 문서로 나눠 Commit한다. 사용자 미추적 파일·다른 Worktree·실제 생성 미디어를 Stage하지 않는다. force push·master Commit·자동 병합은 하지 않는다.

## 사람이 확인할 범위

이미지의 간접 정보 노출, 전체 영상 연출·자막 가독성·음성 호흡·제작 가능성은 사람이 확인한다. External 출력은 명시된 규칙에 따른 치환이며 문맥적 개인정보 완전 제거·OCR 검토를 보장하지 않는다. 결정성은 동일 Snapshot·Build·시각·Font/Renderer 계약에서 확인하며 다른 버전의 Renderer까지 같은 bytes를 보장하지 않는다. 로컬 협력 writer 계약이며 SMB/NFS 다중 Host·완성 영상 자동 합성·업로드는 범위 밖이다.
