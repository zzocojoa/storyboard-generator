# CUTROOM 작업 공간 UI 검증

## 적용 범위

설치된 OpenDesign `redesign-existing-projects`와 `impeccable-design-polish`를 적용했다. 작업 공간·컴포넌트·반응형 계약은 `DESIGN.md`, 사용 순서는 README를 기준으로 한다. 도메인 스키마·원본 시간·검증 조건·Final 승인·생성 엔진을 변경하지 않았다. 코드 커밋·원격 게시·PR 검증은 수행하지 않았다.

기존 스킬 3개(`design-brief` 포함)는 `.local/validation/open-design-skills-install.json`의 설치 기록과 대조했다. 현재 SKILL.md의 Git blob SHA-1이 검토 기록의 커밋 `81044a03ca717f77a5bde38947903a8ef222da8c` 값과 모두 일치한다. 기존 문서 가져오기 개편 커밋 `226fc15`도 확인했다. 이번 작업에서 추가했던 중복 스킬은 제거했고 기존 설치는 보존했다.

## 검증 결과

- TypeScript 앱·웹 검사 통과. 필수 테스트 이름 428개 누락·중복·skip·only 없음. JSON Schema와 소스 일치. 웹 빌드 성공. 기존 큰 번들 크기 경고는 남는다.
- 전체 단위·통합 검사 1,232개 중 1,231개가 첫 실행에 통과했다. `audio_diagnostics_do_not_log_media_bytes` 1개는 sandbox의 localhost listen EPERM으로 실행하지 못했다. 로컬 서버 실행 권한으로 해당 파일의 12개 검사를 다시 실행해 모두 통과했다. 첫 `npm run check` 자체를 성공 종료로 기록하지 않는다.
- 최종 전체 E2E 30개 통과, retries 0. 문서 검토·인물 근거·단계 이동·독립 콘티 생성, 실제 Chromium WAV 재생·시킹·종료·프로젝트 전환 정리, 텍스트 확정·Visual Plan 원자 저장·후반 키 프레임·저장소 장애 격리·Black/Hold 출력을 검증했다.
- 추가 E2E는 작업 공간·패널 탭 이동 중 저장 전 연출·프로필 값 보존, 모바일 프로젝트 목록, 실제 컷 저장, 검토 항목에서 그림 편집으로 이동, 프로젝트 범위의 생성 안내, Final 버튼과 서버의 출력 차단을 확인한다.
- 실제 프로젝트 화면을 1600×1000 및 390×844에서 검사했다. 모바일 body clientWidth와 scrollWidth가 모두 390이다. 작업 현황·설정·편집·검토 화면 스크린샷을 `.local/validation/studio/`에 저장했다.
- 실제 저장본의 Current·Version·Asset 파일 31개가 작업 전후 바이트 SHA-256까지 일치한다. 추가·변경 파일 없음. 비교 결과는 `.local/validation/studio/data-preservation.json`이다.

검증 로그: `.local/validation/studio/check.log`, `recheck.log`, `e2e-final.log`, `final-build.log`. 최초 E2E의 이전 모바일 진입 선택자와 새 테스트의 textarea/숨긴 패널 선택자를 바로잡고, 중복 생성 안내 컴포넌트를 공통 위치로 모은 뒤 전체 E2E를 재실행했다.

## 범위의 한계

UI 개편은 생성 완료를 의미하지 않는다. 실제 `의부증의 늪 — draft-01`은 원문 초안 32컷이며 미확정 연결·그림·음성·글자 등 Final 차단 항목을 유지한다. 생성 버튼은 요청 등록이고, Codex App에서 대기 요청을 처리해야 한다. 이번 검증은 생성 요청을 실행하거나 이미지를 자동 승인하거나 기존 콘티를 변경하지 않았다.
