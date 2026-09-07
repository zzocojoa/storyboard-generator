# 범용 콘티 도구 — Final Readiness 검증 보고서

## 1. 판정

로컬 구현·검증 GO. 생성 완료와 최종 출력 가능 상태를 분리한다. 제품의 Final Ready는 현재 제작 데이터의 기계적 출력 계약이며 작품의 연출 완성도 승인을 대신하지 않는다. 최종 인수에는 기능 PR의 동일 HEAD에서 `check`와 `e2e` 성공이 필요하다. master에는 병합하지 않는다.

## 2. 작업 기준

- 시작 master: `98fea61c75c454078118234078597a801a2a074d`; 기준 CI Run `34094714674` 성공.
- 새 Branch: `codex/storyboard-final-readiness`; 이전 작업 Branch는 재사용하지 않는다.
- Project Schema 1.7.0, Storage Journal 3, Store Lock 3, Process Registry 1, App 0.1.0.
- 최종 Commit과 CI 결과는 기능 PR의 Head·Checks를 기준으로 확인한다. 수정 중인 로컬 Build의 commitSha는 null이며 sourceTreeSha256으로 구분한다.
- 기존 서버 4317/PID 89219, 4318/PID 2286, 4319/PID 17388은 종료·재시작하거나 검증 서버로 사용하지 않았다.
- 사용자 미추적 파일과 다른 worktree는 변경하지 않는다. 실제 `.local` 저장본은 읽기 전용으로 검사하고 결과만 현재 worktree의 별도 review 디렉터리에 작성한다.
- Codex App·내장 image_gen·로컬 macOS 음성 계약을 유지한다. OpenAI API Key·SDK·외부 AI fallback은 추가하지 않는다.

## 3. 최초 재현 결함

| 결함 | 기존 결과 | 실패 재현 | 수정 결과 |
|---|---|---|---|
| 수동 Source 공백 | 새 공백 저장 가능 | manual_source_edit_cannot_introduce_visual_coverage_gap | 신규·확대 Gap 거부 |
| Gap 컷 승인 | 승인 가능 | sourced_gap_blocks_shot_approval | 승인 차단 |
| Frame Point | 1ms Coverage로 해석 | frame_anchor_reveal_does_not_create_one_millisecond_visual | 공개 시점과 표시 구간 분리 |
| Hold의 늦은 공백 | 이전 초반 Frame으로 통과 | hold_previous_source_gap_predecessor_is_not_output_ready | predecessor endMs - 1 검사 |
| 실제 Audio Seek | Range 없는 WAV 응답에서 seek가 0으로 돌아감 | e2e_real_audio_seek_uses_html_media_element | 전체 무결성 검사 뒤 206 byte range 제공 |

초기 전체 863개 실행은 862개 성공과 Codex I/O timeout 1개였으며 해당 파일의 독립 재실행은 5/5 성공했다. I/O 경쟁을 제한하도록 Vitest worker 수를 4개로 설정했다. 최초 네 안전 결함의 실패를 확인한 뒤 구현했고 현재 전체 940개가 성공한다.

## 4. Draft·Final Text

Draft proposed는 DRAFT·TIMING UNCONFIRMED로 표시하며 Final Safe로 세지 않는다. Final proposed는 Cue·Placement·시작/종료·상태·해결 방법을 포함한 TEXT_TIMING_CONFIRMATION_REQUIRED다. Confirm은 개별 Cue 시간 검토이며 Mapping·권한·Gate·다른 출력의 안전성을 보증하지 않는다.

Final Readiness API는 generated, reviewed, text-confirmed, visual-timeline-safe, final-ready 단계와 수치·차단 Issue를 파생한다. Final PDF·CSV·Bundle은 FINAL_OUTPUT_NOT_READY 409일 때 성공 파일을 만들지 않는다. Query 생략은 Draft이며 UI는 Preview·PDF·CSV 각각 Draft와 Final을 구분한다.

## 5. 실제 Playhead 출력

공통 Resolver는 반열린 활성 Source, Playhead 이전의 최신 Frame, 대상 Asset·검토·정보 Gate를 검사한다. 과거 생성 시점의 안전성이 현재 Gap을 덮지 못한다. 전환 미리보기는 실제 선행 노출 시점의 Gate를 추가로 검사한다. Black은 자산 없는 결정적 출력이다. Hold는 인접 이전 Shot의 종료 직전 안전 원본까지 방문 Set으로 추적하며 Gap·Pending·Rejected·파일 오류를 우회하지 못한다.

Safe Visual HTTP는 정수·범위를 검증하고 no-store bytes 또는 구조화된 차단 오류를 반환한다. Asset 오류는 Asset scope 423을 유지한다. 기존 Safe Frame Endpoint는 유지한다. Monitor·PDF·CSV·Summary·Final Readiness에 같은 핵심 판정을 적용한다.

## 6. 수동 편집·승인

Source 수정은 변경 전후 Gap을 비교해 새 Gap과 확대를 차단하며 기존 Gap 축소·제거는 허용한다. 이동은 양쪽 Shot을 검사하고 불확실한 Anchor를 Coverage로 세지 않는다. sourced 전환은 전체 Coverage, Black·Hold는 direct Source 부재를 요구한다. 승인에도 Source·Mapping·Gate·Coverage·Frame·Hold 구조를 포함한다. 생성 수치와 현재 출력 안전 수치는 별도다.

## 7. Anchor·Proposal·Migration

Frame Point는 공개 증거이며 시각 표시 범위가 아니다. frame-range는 명시적 endOffsetMs를 가진다. 모호한 Legacy 범위는 SOURCE_VISUAL_INTERVAL_REQUIRED로 남기고 추측하지 않는다. 명시 Frame끼리 같은 ms에 충돌하면 거부하고, 같은 위치의 파생 Frame만 명시 Frame으로 대체한다. Unit 순서는 최초 공개로 판정하며 continuation이 순서를 되돌리지 않는다.

1.6→1.7 메모리 Migration은 기존 Generation Record의 generatorBuild를 null로 추가한다. 기존 원문·ID·Shot·Frame·Text·Audio·Anchor·Asset을 보존하며 Version 파일을 재작성하지 않는다. 이전 전체 Migration 체인과 멱등성을 검사한다.

## 8. Generation Audit·Status

Revision별 Canonical Snapshot은 하나다. Current와 같은 Version이 안정적으로 불일치하면 AUDIT_CURRENT_VERSION_MISMATCH 423으로 해당 Project mutation만 차단한다. 제거·metadata 변경·재등장을 보고하고 absent→present만 재등장 revision으로 기록한다. Target History는 도입 revision부터 계산하며 도입 시 없는 Target은 나중에 나타나도 unresolved다.

Active Update 검증 실패는 activeUpdateErrors·기존 active 상태·Project 복구 상태에서 사라지지 않는다. 다른 Project는 계속 수정할 수 있고 실제 복구 뒤 반복 Status 조회에서도 오류·작업이 재등장하지 않는다.

## 9. 실제 Chromium Audio

Playwright 1.55.0, Chromium 140.0.7339.16의 실제 HTMLAudioElement를 사용한다. Audio와 HTMLMediaElement API를 대체하지 않는 6개 시나리오에서 PCM16 mono 48,000Hz 3초 WAV 디코딩, loadedmetadata duration=3, 약 1.5초 Seek, Cue 종료, Monitor 종료와 Project 전환 정리를 확인했다. 3회 연속 18/18 성공했다. 종료 뒤 paused=true, src 비움, DOM 분리, media error 0을 확인한다. 단위 테스트의 포트 대역은 별도 검증이다.

## 10. Build·Review Bundle

Build Manifest는 Commit SHA 또는 null, App·Schema 버전, builtAt, sourceTreeSha256과 저장 계약 버전을 기록한다. 런타임은 시작 시 읽은 Build를 고정하고 신규 요청·생성 Record에 실제 Build를 연결한다. 기존 생성 Commit은 증명할 수 없어 null로 보존한다.

읽기 전용 번들의 9개 기본 파일은 project.json, shots.csv, storyboard.pdf, final-readiness.json, generation-audit.json, asset-integrity.json, asset-manifest.json, build-manifest.json, bundle-manifest.json이다. 기본값에서 별도 원본 미디어 파일은 제외하고 명시적인 include-media에서만 추가한다. PDF는 콘티 이미지를 포함한다. Manifest의 파일 SHA-256·크기와 원본 Snapshot 해시, Asset 사용처·생성 Record·Build·감사 파일 연결을 검사한다. 고정 시각·같은 Build와 Snapshot에서 PRJ-007 번들 체크섬 재현을 확인한다.

검증 결과는 현재 worktree의 `.local/reviews/final-readiness/verified-current/`에 있으며 최종 Commit Build의 별도 재출력은 `verified-<HEAD>/`를 사용하고 각각의 build-manifest에서 정확한 Commit을 확인한다. 원본 저장 영역 안의 출력과 기존 Bundle 덮어쓰기를 거부한다. PDF의 Final 10개 페이지와 Draft 차단 페이지를 렌더링해 검토했다. 긴 Draft Issue 표시는 카드 영역 안에서 생략 기호로 제한하고 전체 Issue는 동봉 JSON·CSV에서 제공한다.

## 11. 기존 생성 콘티 읽기 전용 검사

| Data Root 하위 이름 | Project | Revision | Text proposed / confirmed | Final | 시각 Gap | 실제 Asset 검사 | 감사 Record | 대기 요청 |
|---|---|---:|---:|---|---:|---|---:|---:|
| data | plant-care-demo | 9 | 0 / 2 | 차단, 45 Issues | 4 | 이미지 1 정상, 오디오 1 metadata 불일치 | 3, historical mixed 경고 1 | 0 |
| data | PRJ-007 | 11 | 29 / 0 | 차단, 686 Issues | 37 | 이미지 2 정상, 오디오 1 metadata 불일치 | 4, 감사 Issue 0 | 0 |
| data-1.6 | PRJ-007 | 283 | 0 / 26 | 통과 | 0 | 107개 정상 | 94, 감사 Issue 0 | 0 |
| data-4318 | PRJ-007 | 0 | 26 / 0 | 차단, 444 Issues | 26 | 자산 없음 | 0 | 0 |

원본 root는 기존 `.worktrees/storyboard-generator/.local` 아래다. Current·모든 Version·읽을 수 있는 자산·요청 파일의 전후 SHA-256을 비교했으며 변경 0이다. 자동 Confirm·Frame Accept·Asset 교체는 수행하지 않았다. revision 283은 컷 40/40 승인, 필요한 sourced Frame 33/33 accepted, Audio 63/63 playable, Hold 6개 안전이다. 나머지 Frame 7개는 Black·Hold의 비생성 Frame이며 pending 상태를 그대로 보존한다.

회귀 fixture의 PRJ-007은 12 Scene, 32 Segment, screenplay Unit 79, Panel Turn 16, Placement 25와 1,500,000ms를 보존한다. UNIT-045의 회귀 계약은 849,000–851,000ms J-cut, PCM16 mono 48,000Hz 2초다. 실제 로컬 revision 283에는 기존 850,000–855,000ms, 5초 within-segment SFX가 저장돼 있다. 이 차이는 기존 제작 데이터이며 자동으로 회귀 fixture 값에 맞추지 않았다. Final 판정은 해당 저장본의 현재 시간표·명시적 Cue 관계를 기준으로 한다.

## 12. 테스트 결과

| 명령 | 결과 | 파일 | 개수 | 비고 |
|---|---|---:|---:|---|
| npm run schemas:write | 성공 | - | - | 1.7 JSON Schema |
| npm run typecheck | 성공 | - | - | Domain·Server·Script·Test |
| npm run typecheck:web | 성공 | - | - | Web |
| npm test | 성공 | 39 | 940 | 단위·통합 |
| npm run schemas:check | 성공 | - | - | Schema 일치 |
| npm run build:web | 성공 | - | - | Vite |
| npm run test:e2e | 성공 | 2 | 14 | 전체 Chromium |
| 실제 Audio 반복 | 성공 | 1 | 18 | 6개 × 3회 |
| 주기 Heartbeat 반복 | 성공 | 1 | 15 | 5개 × 3회 |
| npm run smoke | 성공 | - | - | 실제 HTTP·cleanup |
| npm run check | 성공 | 39 | 940 | 타입·이름·Schema·빌드 포함 |
| git diff --check | 성공 | - | - | 공백 오류 0 |

필수 이름 153개: missing 0, duplicates 0, skip 0, only 0. 의도하지 않은 Heartbeat failure log 0. fault injection 테스트의 의도된 오류와 구분한다. 테스트 프로세스가 종료되고 임시 Store·App·Worker·Timer·Listener·Root를 정리했다. E2E의 Text 상태 Header와 Draft 설명 문구를 각각 검사하도록 잘못된 locator 기대값을 수정한 뒤 전체 14개가 통과했다.

## 13. Runtime Smoke

최종 통합 실행의 동적 포트는 50853, 50857, 50862, 50866, 50868이다. 기본 화면·Status·Import·Project·Final Readiness·Visual·Audit·Integrity·Confirm·Draft/Final PDF·CSV·Safe Audio를 실제 HTTP로 확인했다. 정상 200/201/202, revision·Final 불가·Visual Gap 409, Project·Asset·감사 불일치 423, 일시적 Store 503을 검사한다. Black·Hold·안전 원본 없는 Hold·Build·Bundle과 cleanup=true를 확인했다. 테스트용 프로세스만 종료했고 기존 서버 PID는 유지한다.

## 14. GitHub CI

[PR #4 Checks](https://github.com/zzocojoa/storyboard-generator/pull/4/checks)에서 현재 HEAD의 CI를 확인한다. 최초 CI의 MISSING_WEB_BUILD는 HTTP 테스트 fixture가 기존 dist/web에 의존한 문제였으며, fixture 자체의 임시 web root를 생성하도록 수정해 빌드 순서 의존성을 제거했다. Required Checks는 strict check·e2e이며 이전 Commit의 성공을 새 HEAD의 성공으로 대체하지 않는다. Workflow는 Ubuntu·Node 24에서 전체 check 뒤 Chromium E2E를 실행한다. 최종 PR 설명과 작업 완료 보고에 정확한 Head SHA·Run ID·두 Job 결과를 기록한다. PR은 master 대상이며 병합하지 않는다.

## 15. 변경 파일

신규: Output Policy·Final Readiness·Source Anchor·Visual Resolver, Build Schema·Manifest, Review Bundle·CLI, Safe Audio Range, 8개 회귀·fixture 파일과 실제 Audio E2E. 수정: Domain·Proposal·Codex·Store·HTTP·Web·PDF·CSV·Migration·JSON Schema, 기존 회귀 fixture, package scripts·Vitest worker 제한·필수 이름 Registry·Runtime Smoke. 문서: README·AGENTS·workbench skill·Plan·Design·Analysis·Report. 삭제 파일은 없다. 사용자 미추적 파일과 실제 생성 미디어는 Stage·Commit하지 않는다.

## 16. 사람이 확인할 범위

이미지의 간접 반전 암시, 전체 영상의 연출·자막 가독성·실제 음성 호흡·제작 가능성은 사람이 검토한다. 기존 UNIT-045 제작 결정과 회귀 fixture의 차이도 보존한 상태에서 판단한다. 로컬 파일 시스템의 협력 writer 계약이며 SMB·NFS 분산 writer를 보장하지 않는다. 전체 영상 자동 렌더링·업로드는 현재 범위가 아니다.
