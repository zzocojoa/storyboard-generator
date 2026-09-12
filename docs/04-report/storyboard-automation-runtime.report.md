# 자동 제작 실행·제작 기준·구간 계획 검증

## 현재 통합 상태

Codex 응답에 전달하는 음향 발생 원문 Schema는 서로 다른 `kind`를 갖는 엄격한 두 객체의 `anyOf`를 사용한다. 설치된 Zod의 판별 Union 변환은 Codex가 거부하는 `oneOf`를 생성하므로 모델 응답 경계에서만 지원 형식으로 구성하며 저장·서버 검증은 유지한다. 해당 회귀 검사에서 수정 전 실패를 확인했고 수정 후 관련 3개 파일·15개 검사(4.30초), 서버 타입·Schema 일치를 통과했다. 근거는 `audio-occurrences-schema-{before,tests,types}.log`다. 앞선 `ac2a38a`의 [CI 34690232423](https://github.com/zzocojoa/storyboard-generator/actions/runs/34690232423)는 `check`·`e2e`를 통과했지만 이 외부 응답 형식 오류까지 검증한 것은 아니다.

Project 1.23은 한 음향 지시의 서로 다른 발생을 원문 인용·트랙·정보 공개 조건별로 나누고 실제 WAV 없이 시각을 제안한다. 같은 발생을 지문과 효과음이 함께 설명하면 보충 원문을 연결해 기존 트랙을 재사용한다. 기존 컷에도 미확인 발생의 시간 배치 작업을 등록하며 컷·확정 Source 범위·원문·보호된 음원·과거 생성 기록을 보존한다. 여러 원문을 한 자동 전용 트랙에 합친 이전 제안은 검토 대상으로 남기며 사람 확인을 자동 변경하지 않는다. 1.22 파일은 메모리에서 버전만 이관한다.

검증 가능한 범위는 공개 합성 자료의 독립된 두 소리·잘못된 인용/정보/트랙 거부·기존 효과음 재사용·편집된 컷 안의 배치·이전 파일/Source Update 보존·PDF 본문/시각이다. 브라우저에서 시각 수정·명시적인 판정 확인·빈 입력의 재열기, 원문 변경으로 사라진 연결과 작성 중 인용 보존을 확인했다. 원본 변경 뒤 작업 위치를 다시 선택·기억하는 기존 절차를 테스트에 반영했으며 시간 제한이나 재시도 횟수를 늘리지 않았다. 새 발생 계약의 실제 모델 결과 및 작품 전체 그림·연출·Final 품질은 아직 검증 완료로 주장하지 않는다.

현재 로컬 `npm run check`는 116개 파일·1,539개 검사(556.57초), 서버/Web 타입·필수 이름 724개(누락·중복·skip·only 0)·Schema 일치·웹 빌드를 통과했다. 전체 E2E 73개(4.8분)도 통과했다. 이후 추가한 사라진 음향 연결의 입력 보존은 타입 검사와 해당 E2E(9.8초), 모델 응답 필수 키는 관련 3개 검사로 확인했다. 첫 전체 검사 실패는 새 이관 단계 수 기대값과 샌드박스의 로컬 포트 제한이었으며, 각각 수정·포트 허용 실행으로 확인했다. 증거는 `.local/validation/automation-runtime/`의 `audio-occurrences-check-verified.log`, `audio-occurrences-all-e2e.log`, `audio-occurrences-draft-recovery-final.log`, `audio-occurrences-model-schema.log`, `audio-occurrences-final-types.log`, `audio-occurrences-draft-types.log`다.

기본 완료 조건은 그림·연출·시간·대사·음향 지시이며 가이드 음성은 선택이다. 사용자가 승인한 원격 `codex/document-handoff` 브랜치의 [초안 PR #8](https://github.com/zzocojoa/storyboard-generator/pull/8)이 열려 있다. `master`의 PR 필수·strict `check`/`e2e`·관리자 적용·강제 푸시/삭제 금지는 유지한다. 실제 제작 원문·생성 미디어·로컬 실행 기록은 전송하지 않는다. 전체 자동 제작과 작품 품질 검증이 남아 있어 초안 상태이며 최종 머지는 하지 않았다.

선택 재생의 실제 Audio 3회 반복도 21개 모두 통과했다(45.6초). 근거는 `audio-occurrences-real-audio-repeat.log`다. 실제 음원 생성·재생을 기본 콘티 완료 조건에 추가하지 않았다.

커밋 `ca9867c5e0079bdd6cb00ecb45f45155c17aff0e`의 [CI 34687161467](https://github.com/zzocojoa/storyboard-generator/actions/runs/34687161467)는 `check`와 `e2e`를 모두 통과했다. 전체 115개 파일·1,530개 검사, 필수 이름 714개(누락·중복·skip·only 0), 전체 E2E 72개와 실제 Audio 3회 반복 21개가 통과했다. 정상 해제된 잠금을 읽는 경쟁은 수정 전 실패를 재현해 수정했고, 남아 있는 파일 오류·복구 차단을 보존한다. 백업의 게시·바이트 복원·복원본 검토/편집은 독립된 검사와 각각 5초 한도를 사용한다. 재시도·시간 제한을 늘리지 않았다. 증거는 `.local/validation/automation-runtime/backup-ci-complete.log`와 `released-lock-{red,storage,e2e-fixed}.log`다.

추가 PDF 보완은 같은 원문의 반복 표시만으로 실제 음향 배치 지시를 오해하지 않도록 현재 구간의 적용/제외 결론, 전체 적용 구간과 이유를 출력한다. 미판정·오래된 원문·잘못된 공통 범위를 검토 완료로 표시하지 않으며 외부 검토의 이유 문장도 비식별화한다. 관련 6개 파일·44개 검사와 타입·필수 이름 717개를 통과했다. 실제 revision 126의 두 구간에서 음향 지시 4개를 발췌한 PDF 4페이지를 생성해 원문·판단 문장 보존, 페이지 경계와 실제 렌더링을 확인했다. 원본 Version 바이트와 사람 승인 상태는 그대로다. 검증용 발췌이며 전체 콘티 출력이 아니다. 증거는 `shared-audio-pdf-{final-focused,types,registry}.log`, 실제 작업 폴더의 `shared-audio-pdf-final-verification.json`·`output/pdf/shared-audio-scope-review-final.pdf`다. 커밋 `66ffcd8`의 [CI 34687806911](https://github.com/zzocojoa/storyboard-generator/actions/runs/34687806911)에서 이 PDF 보완의 전체 `check`·`e2e`와 Audio 반복 검사가 통과했다.

실제 PRJ-008은 25분·24구간의 제작 기준 66개와 현재 기준 그림 66장을 준비했다. 이전 버전까지 이미지 69개의 실제 해시·디코딩·원문 보존을 검사했다. 같은 장소의 앞선 기본 이미지를 참조하지 않던 문제를 수정하고 공간 변형 3장을 선택 재생성하여 구조를 직접 비교했다. 현재 기준 66장의 시각 검토 누락은 0건이며, 봉투 2장은 요청한 면과 덮개 모양이 달라 검토 대상으로 남는다. 명시적 공통 대상 ID가 없는 소품 관계나 사람 승인을 자동 확정하지 않았다. 근거는 `.local/validation/automation-runtime/prj008-whole-story-20260912/`의 `reference-stage-complete-verification.json`, `reference-stage-complete-visual-coverage.json`, `reference-stage-remaining-props-visual-review.json`, `location-repair-verification.json`, `location-repair-evening-verification.json`, `location-repair-night-verification.json`이다.

첫 아홉 구간은 revision 127까지 총 480초·78컷·135프레임으로 저장됐다. 원문·출처·전체 시간표, 다른 구간, 기존 자산·생성 기록 보존 및 구조 오류 0건을 각 저장 전후로 검사했다. 같은 원문의 그림·발화 공유는 실제 내레이션과 패널 구간에서 저장까지 확인했다. 프레임 그림과 가이드 음원은 아직 생성하지 않았으며 사람 승인 전이는 0회다. 긴 자막 3개는 필요한 읽기 시간과 최대 8초 설정이 충돌한다. 아홉 번째는 15초·2컷이며 전날 저녁 식탁·복장·이미 든 숟가락의 상태를 이어가고, 105개 표시 문자에 필요한 8,750ms와 최대 8,000ms의 충돌을 검토로 보존했다. 실제 낭독 호흡·그림 연속성은 미검증이다. 근거는 `first-eight-segments-verification.json`과 각 구간의 `*-segment-plan-verification.json`·`*-segment-editorial-review.json`이며 최신 증거는 `ninth-segment-plan-verification.json`이다.

세 번째 내레이션 구간에서 같은 Unit을 그림과 발화에 함께 쓰는데도 음성 전용 Link를 요구하는 계약 충돌을 발견했다. 컷 안의 같은 Unit 중복은 금지되어 있으므로 유효한 단일 연결을 실패시키던 문제다. 음성 전용 Anchor가 있으면 기존 일치 검사를 유지하고, 직접 시각 Link만 공유할 때는 확정된 최초 공개 이후의 독립 Cue 시작을 허용하도록 수정했다. 미확정·누락·문맥 전용 근거, 조기 발화, 정보 하한, 중복 연결 차단을 유지한다. 실패 실행은 revision 105의 프로젝트를 전혀 변경하지 않았음을 확인한 뒤 기록 보존 취소했다. 사용량을 차감한 Run `b50f131d-d0f5-4cc3-bd17-c12297df39d3`은 앞선 두 구간을 건너뛰고 여덟 번째까지 저장한 뒤 공통 음향 범위 오류 수정과 검증을 위해 일시 중지하고 기록 보존 취소했다. `shared-audio-scope-pause.json`은 Worker 종료·revision 111 보존을 기록한다. 남은 승인 한도는 실행 시간 4,393,890ms·그림 186회이며 추가 예산은 승인 전이다. 일시 중지한 실행은 Source Build `e65332abd98d70e582b5f8f42efc5aacf86db7e79c63a761b98615592ab707e1`을 사용한다. 재시작 당시 HEAD는 `feeae65`이고 미커밋 변경을 포함한 Build로 정확히 기록했다. `third-segment-failure-verification.json`, `continuation-visual-speech-request.json`, `continuation-visual-speech-start.json`, `visual-speech-server-status.json`이 근거다.

원문 공유 보완은 수정 전 실패를 재현했고 관련 3개 파일·44개 검사, 서버/Web 타입·Schema·필수 이름 703개(누락·중복·skip·only 0), 별도 웹 빌드를 통과했다. 전체 114개 파일·1,520개 중 1,519개가 통과했으며 남은 1개는 샌드박스의 localhost listen EPERM이다. 해당 Audio 계약 파일을 포트 허용 환경에서 동일 조건으로 실행하여 12개 모두 통과했다. 검사 시간·재시도 한도는 늘리지 않았다. 원격 전체 검사와 실제 내레이션 결과 적용은 위 범위로 확인했다. 증거는 `visual-speech-contract-{red,focused,full-tests,audio-recheck,typecheck,web-typecheck,required-tests,schemas,web-build}.log`다. 이전 웹 출력은 `reference-retake-web-before-visual-speech`에 보존하며 배포 기록은 `visual-speech-web-publication.json`이다.

실제 긴 구간 처리 중 `activeMs`는 다음 상태 전이 때 정산되는 기록값임을 확인했다. 화면의 ‘누적 실행’을 ‘기록된 실행 시간’으로 바꾸고 현재 작업 시간의 합산 시점을 안내한다. 실행 예산·Worker·계산식은 변경하지 않았다. Web 타입·분리 웹 빌드와 기존 자동 제작 시작 입력 복원·선택 음성 E2E 2개(14.1초)를 통과했고, 살아 있는 PRJ-008 작업을 재시작하지 않고 실제 화면의 안내를 확인했다. 근거는 `recorded-execution-time-{web-types,web-build,e2e}.log`, `recorded-execution-time-publication.json`, `recorded-execution-time-validation.json`이다. 이 안내 변경 커밋 `05b93bc`의 [CI 34683131950](https://github.com/zzocojoa/storyboard-generator/actions/runs/34683131950)는 check·e2e 모두 통과했다. 실제 실행 수는 1,520개·E2E 71개·Audio 반복 21개이며 필수 이름 703개를 확인했다.

공통 음향 범위 검토: 장면의 같은 파일/행 지시가 여러 방송 구간에 보존되는데 모델이 현재 구간만 읽어 같은 발생음을 내레이션·재연·패널에 독립 추가하는 오류를 확인했다. 일시 중지한 실제 저장본에는 재검토 대상 17개가 있다. Project 1.22는 공통 구간 전체의 원문을 함께 보고 적용 구간·정확한 인용·판단 근거를 기록하며 후속 구간이 이를 이어받는다. 현재 구간의 소리 인용만 트랙 본문·정보 공개에 연결하고 기존 효과음 연결에도 출력·선택 재생 검사를 적용한다. 수동/확정/실제 음원은 자동 교체하지 않는다. 다른 적용 구간의 원문 변경은 공통 판단만 재검토로 남기고 기존 연결·미디어·이력을 보존한다. 새 스키마로 실제 revision 111을 읽어 버전 외 데이터 변경 0건을 확인했다. 새 Run `36533367-ce38-4a6d-92d9-2b132e2bb589`은 승인된 잔여 한도 안에서 `f26fb8a` Build로 15개 구간의 17개 판정을 모두 재검토했다. revision 111→126에서 원문·시간표·92컷·149프레임·글자·기존 자산 69개·이전 생성 기록 111개를 보존하고 새 판정 기록 15개만 추가했다. 기존 음향/발화 157개는 그대로 유지하고 잘못 반복 배치한 미측정 자동 효과음·음악 초안 6개만 제거했다. 공동 알림·발걸음·문/컵 소리는 실제 발생 구간에 한정하고 마지막 짧은 화음은 마지막 내레이션에 배정했다. 공통 범위 이슈와 구조 오류는 0건이며 사람 검토 전 상태다. 최신 브라우저에서 적용 구간·선택 트랙·정확한 원문 근거를 확인했다. 실제 음원 생성은 수행하지 않았으며 작업은 자동으로 SEG-009 컷 계획을 완료하고 SEG-010으로 이어졌다. 검증 근거는 `shared-audio-scope-stage-verification.json`이며 컷별 상세 발생 시점과 전체 작품 검토는 후속 계획에서 확인한다. 수정 전 실패를 재현했고, 최신 코드의 관련 7개 파일·35개 검사와 타입/Web 타입·Schema·필수 이름 711개·웹 빌드를 통과했다. 전체 로컬 1,527개 중 2개 실패는 새 변환 단계의 기대 횟수와 실행 도중 추가한 재생 검사였으며, 갱신된 기대와 최신 재생 코드로 해당 파일을 재실행해 통과했다. 새 공통 음향 UI를 포함한 전체 로컬 E2E 72개와 선택 실제 Audio 3회 반복 21개도 통과했다. 원격 E2E의 저장 읽기 경쟁은 위 범위로 별도 수정·검증했다. 근거는 `shared-audio-scope-{red,check,final-focused,playback,e2e}.log`와 `shared-audio-scope-target-observation.json`이다.

작품 전체 컷·그림·가독성·연속성, 남은 운영·복원 범위와 사용자 최종 검토를 완료로 판정하지 않는다. 실제 생성 성공·검토 가능·Final Ready는 별개다. 현재 HEAD 이력의 Git bundle·전송은 검증됐지만 과거 dataless 객체 9개는 원위치에 보존 중이며 저장소 전체 복구 완료로 해석하지 않는다. 세부 증거는 `pr-git-{object-read,repair-sources,repair-identity}.json`과 `git-object-recovery-20260912/`에 있다.

## 글자 자동 배치와 사용자 검토 검증

Project 1.19의 선택적 Cue 표현을 자동 계획·원문 업데이트·수동 편집·화면/PDF에 연결했다. 프로젝트별 글꼴·언어와 별도로 문구마다 위치·영역 폭·크기·정렬·레이어·대비 배경을 저장한다. Codex는 모든 실제 Cue에 공통/개별 배치 결론을 반환하고 직접 지정한 배치·원문·시각·승인을 보존한다. 미리보기·저장·공통 배치 복귀와 미저장 입력 복원을 제공한다. 큰 검토 창은 미저장 글자를 실제 콘티 그림 위에 합성하고 문구 표시 구간 안에서 시점을 이동한다. 기존 시간순 재생과 전환 합성을 공유하며 입력·시점이 다른 응답을 숨기고 Esc/닫기 뒤 원래 버튼으로 돌아간다. 넘침·겹침·미지원 글꼴은 Final 차단을 유지하고, 본문 근거가 미확정이면 미리보기에 차단 이유를 표시한다. 계약은 Design과 실제 코드가 기준이다.

- 큰 합성 검토 창: 관련 단위/HTTP 검사 **6개 파일·34개**, 타입·웹 타입·Required Registry **683개**(누락/중복/skip/only 0)·Schema·빌드를 통과했다. 전체 브라우저 E2E **66개**, 필수 실제 Audio 반복 **21개**도 통과했다. 작은 입력창→큰 합성 검토→Cue 내부 Seek→그림 변경→늦은 응답 취소→잘못된 revision 거부→모바일→Esc 포커스 복귀→저장/초기화를 검증하고 저장 파일을 대조했다. 증거: `text-composition-{static,unit,full-e2e,audio-repeat}.log`, `text-composition-final-results`의 desktop/mobile 스크린샷. 첫 시도의 타임코드·가로형 가정은 합성 입력의 실제 세로형/타임코드 기준으로 수정했고, 실제 포커스 복귀 실패는 dialog를 제거하기 전에 닫도록 수정했다. 실패 로그도 보존한다. 전체 검사 시간 제한·재시도 횟수는 바꾸지 않았다.
- 기존 격리 PRJ-007 revision 35의 실제 1672×941 그림과 첫 고지 문구를 같은 창에서 확인했다. 전체 원본 저장 바이트를 보존하며 생성·사람 승인 0회다. 저장 배열 순서를 구간 순서로 가정했던 로컬 점검 스크립트는 실제 첫 구간/그림 연결로 수정했다. 증거: `text-composition-real-review.json`, `text-composition-real-review.png`. 합성 세로형 입력과 실제 가로형 입력의 UI 확인이며 작품 전체 시각 품질 승인으로 해석하지 않는다. 이번 검사의 파일 해시와 완료 범위는 `text-composition-validation.json`에 있다.
- Project 1.19 도입의 전체 `npm run check`: **109개 파일·1,488개 검사 통과**. 타입·웹 타입·Required Registry **683개**(누락/중복/skip/only 0)·Schema·빌드 통과. 새 검사는 모든 Cue의 배치 결론·수동 보호·잘못된 기록 ID·좌표/대비/레이어·Mapping/Source Update 보존·이전 파일 무변경 이관·PDF/화면 동일 조판·읽기 전용 HTTP·revision 충돌·Final 차단을 확인한다. 증거: `text-presentation-complete-check.log`, `text-presentation-final-diagnostics/vitest-results.json`.
- 전체 E2E **66개**, 필수 실제 Audio 검사 7개×3회 **21개** 통과. 새 브라우저 검사는 배치 입력→재열기 복원→미리보기→저장→재열기→공통 배치 복귀를 수행하고 원문·시각·미디어를 대조했다. 미리보기 입력이 바뀌면 이전 이미지를 숨긴다. 증거: `text-presentation-full-e2e.log`, `text-presentation-audio-repeat.log`, `text-presentation-full-e2e-results/text-presentation-e2e-text-e26a8-nd-resets-only-selected-cue/text-presentation-workspace.png`.
- 실제 Codex App의 **gpt-6-astra 1회·54,229ms**가 합성 화분 관리의 두 문구에 각각 수동 배치 보존/공통 프리셋 사용 결론을 반환했다. 조판 문제 0건, 원문·시각·그림 보존, ProjectStore 쓰기와 사람 승인 0회다. 이 파일럿의 신규 개별 위치 선택은 0건이며 자동 개별 위치의 좌표·보존 계약은 별도 코드 검사에서 확인했다. `text-presentation-actual/{inputs,outputs,result,project}.json`과 같은 폴더의 `cue-1/2.png`를 보존하고 실제 그려진 글자도 확인했다. 등록 글꼴 선택의 별도 실제 파일럿은 `typography-actual/result.json`(1회·47,386ms)에 있다. 두 파일럿은 개인 PRJ-007/008 원문을 보내지 않았다.
- 메인 **4317**·격리 **55873**은 Schema **1.19.0**, 소스 Build `56c3aad4484e9cf972784ea1ddb51441025e525b49b3973baadbf87d4c3e29b1`로 실행 중이다. 새 미리보기 API·HTML/JS/CSS와 기존 메인 콘티 3개(revision 0·11·9)·격리 콘티(revision 35)의 원래 SHA-256 보존을 검증했다. 대기/반영 0건, 기존 실행 상태·메인의 복구 차단 1건도 유지한다. 증거: `text-composition-runtime.json`.
- 검사 중 음성 재개 테스트가 한 차례 5초 제한에 걸렸다. 같은 한도의 단독 실행 4,181ms와 최종 전체 실행 3,907ms는 통과했으나 간헐 지연 원인은 확정하지 않았다. 타임아웃·재시도·작업자 수를 변경하지 않았다. 초기 실행의 로컬 포트 권한, 필수 자막 연결을 끊은 새 테스트 자료, 상대 경로로 지정한 진단 저장소 오류를 각각 수정한 기록도 보존한다. 증거: `text-presentation-full-check.log`, `text-presentation-final-check.log`, `text-presentation-voice-diagnostic.log`, `text-presentation-verified-check.log`.
- 원격 master의 PR 필수·strict check/e2e·관리자 적용·강제 푸시/삭제 금지는 유지되고 있다. 원격 `0d0525ab1c8a6cedaf79d599068314329bdcbb3a`의 check/e2e는 성공이다. 해당 검증 시점에는 구현 PR이 없었다. 현재 PR과 최신 커밋의 CI 상태는 이 문서의 현재 통합 상태를 따른다. 증거: `text-presentation-remote-audit.json`, `text-presentation-master-checks.json`.

전체 증거 요약은 `text-presentation-validation.json`이며 경로는 `.local/validation/automation-runtime/` 기준이다. 작품 전체의 가독성·피사체 가림·청취·연속성, 남은 B11/B14 운영·복원 범위, 독립 작품 전체 자동 생성과 사람 검토·Final 출력 및 현재 변경의 PR/원격 CI 검증은 남아 있다. 전체 A01–A10/B01–B14를 완료로 판정하지 않았다.

## 선택 발화의 발음 보완 검증

발음 보완 UI와 선택 발화 재생성 Run을 연결했다. 원문 표현의 정확한 등장 회차를 선택해 낭독 표기만 바꾸고, 원문과 전체 낭독문을 확인한 뒤 실행한다. 기존 대본·자막·음원·컷·승인은 보존한다. 보완 목록·원문/낭독 hash·실제 WAV를 생성 기록과 실행 캐시에 결속한다. 보완이 다른 캐시는 별개이며 같은 Run 재개는 보존한 결과를 사용한다. 일반 자동 제작은 원문대로 읽는다.

- 엔진·재생성·캐시·미등록 음성의 관련 검사 24개가 통과했고, 추가 캐시 범위 7개도 통과했다(중복 포함, 합산한 고유 테스트 수가 아님). 실제 합성 입력, 반복 표현 중 선택한 등장만 대체, 누락/겹침/제어 구문 차단, 잘못된 결과 근거 거부, 중단 후 보완 캐시 재사용·한 번만 Commit을 검사했다. 증거: `pronunciation-unit.log`, `pronunciation-cache.log`.
- 실제 HTTP 브라우저 검사 1개는 보완 입력·오류 시 시작 차단·전체 낭독문 표시·새로고침 복원·서버 전달·새 음원/이전 음원 비교를 확인했다. 실제 모델 호출은 없고 테스트 WAV를 사용했다. 증거: `pronunciation-e2e.log`, `pronunciation-ui.png`.
- 합성 검증 자료의 원문 「물을 주기 전에 흙이 말랐는지 확인하세요.」에서 「물을」을 발음 표기 「무를」로 지정해 로컬 macOS Yuna 180으로 처리했다. 실제 실행 약 3.4초, 48kHz mono PCM16 WAV 2,901ms, 비무음·최대 진폭 표본 0, 기존 자산 v1과 새 v2 및 원문·자막·컷·그림을 보존했다. 외부 모델 호출 0회. 증거: `pronunciation-phonetic-actual.json`, `pronunciation-phonetic-actual-project.json`, `pronunciation-phonetic-actual-180.wav`.

- 원문 변경 이후 과거 보완을 삭제하지 않고 현재 원문에서 다시 확인하거나 제거해 계속 진행하는 UI도 검증했다. 별도 브라우저 검사 1개 통과: `pronunciation-reading-final-e2e.log`. 실제 원문 변경 API를 시험한 것은 아니며, 변경된 프로젝트 응답에서 UI의 재검토·생성 차단·명시적 해제를 확인했다.
- 누적 구현의 전체 검사에서 1.13→1.17 이관 해시가 5개인데 4개를 기대하던 검사를 수정했다. 자동 음성 배정이 권장 실행에 추가된 뒤 설치 목록/배정 응답이 빠져 있던 브라우저 모의 실행기 3곳도 최신 계약으로 수정했다. 자동 배정을 끄거나 실행 단계를 줄이지 않았으며 세 검사 모두 재실행 통과했다(`pronunciation-e2e-repairs.log`).
- 해당 단계의 전체 `npm run check`는 **107개 파일·1,475개 검사 통과**였다(`process-fixture-full-check.log`, 약 268초). 이전 모의 엔진 실패는 새 shebang 스크립트의 기동 지연을 별도 측정해 조사했다. Vitest 안에서 같은 본문을 새 실행 파일로 시작하면 460~1,809ms, Node로 직접 시작하면 34~35ms였고, 실패한 1초 실행은 본문 시작 기록도 없었다(`process-start-diagnostic.log`, `process-launch-diagnostic.log`). OS 내부 지연 원인까지 확정한 것은 아니다. 공용 Node Fixture 런처의 기동을 준비 단계에서 확인한 뒤 실제 프로토콜·음성 본문을 실행하도록 바꿨다. 제품의 제한 시간과 일반 테스트 한도·재시도는 변경하지 않았다. 초기 initialize에 응답하지 않는 경우도 실제 자식 프로세스로 별도 검증하며 시간 초과·진단·생성 미시작을 확인한다.
- 현재 전체 E2E는 **64개 통과**다(`process-fixture-full-e2e.log`, 약 3분). 문서 자동 검토의 입력 채우기·사용자 수정 보존·잘못된 JSON 처리·패키지 생성·취소를 포함한다. 기존 실패 trace는 원래 `test-results`에 보존하고 이번 결과는 `process-fixture-e2e-results`로 분리했다. CI가 요구하는 실제 브라우저 오디오 3회 반복도 **21개 통과**했다(`process-fixture-audio-repeat.log`, 약 42초). 디코딩·실제 길이·시크·Cue 종료·화면/프로젝트 전환 정리·초기 재생 시각을 검사한다. 이는 로컬 검증이며 원격 CI 또는 작품 전체 청취 품질의 완료 증거가 아니다.
- 타입 검사 2종·Schema 일치·Required Registry **668개**(누락/중복/skip/only 0)·웹 빌드는 전체 check에서 통과했다. 서버 4317/55873의 Source Build는 `3af257d6170747026e7b01366bff47258a0a77993b7ea77e2e3733dec26529c2`, 생성 계약은 `88ea28c0c7ced35c84ff131953e7a9f68208b32438a4792fe7f412274f15ae0a`와 일치한다. 이번 수정은 테스트 실행 경로이며 제품 생성 계약은 변경하지 않았다. 원본 3개와 격리 revision 35의 파일 해시가 같고, 대기/적용/실행 중 자동 작업은 모두 0건이며 기존 복구 차단 1건은 유지된다(`process-fixture-original-preservation.json`, `process-fixture-live-status.json`). 이전 페이지가 사용하던 정적 자산 URL도 보존했다.

이 검증은 선택 발화의 보완·생성 경로 증거이며 작품 전체 연기·발음·청취 품질 또는 Final 승인 증거가 아니다. 전체 A01~A10과 P0/P1 B01~B14의 남은 범위를 유지한다.

## 저장된 콘티의 선택 백업·복원 검증

제작 현황의 「저장된 콘티 백업」에서 현재본·전체 Version·등록 자산 파일을 별도 폴더로 보관한다. 저장 위치/현재 원본 확인→생성→전체 파일 검증을 연결하고 응답 유실 뒤에도 같은 위치를 검증한다. CLI는 검증한 Manifest 해시를 받은 뒤 원래 ID·revision의 콘티를 새 dataRoot로 복원한다. 기존 폴더 병합·원본 바이트 재작성·생성 재개·승인은 하지 않는다. 앱 설정 자동 교체와 브라우저 복원 UI는 제공하지 않는다. 외부 원본 문서·미저장 브라우저 입력·Run/캐시는 이 백업의 범위가 아니다.

- 백업·복원 9개와 기존 읽기 전용 저장 감사·검토 패키지 회귀를 합쳐 **42개 검사**가 통과했다. 전체 Version과 미디어·생성 기록·승인 보존, 실제 ProjectStore 재열기/후속 편집, 다른 구성의 두 입력, 오래된 스키마 원래 바이트, 변조/누락/중복/추가 파일/symlink 거부, 미리보기 후 변경, 동시 게시/기존 복원 경로 보호, JSON 근거 읽기 한도를 검증했다. 손상된 미디어는 원래 바이트로 복원하되 기존 무결성 오류와 Final 차단을 유지했다. 증거: `project-backup-scope-final.log`.
- 실제 HTTP 저장소의 브라우저 **1개 검사**가 통과했다. 미리보기와 위치 입력 보관→페이지 재로딩→생성 응답 유실→보관한 경로 복원→파일 검증을 확인했다. 생성 POST는 1회이며 자동 재전송/승인은 없다. 최초 검사에서 macOS 정규 경로와 결과 영역 접근성 역할을 바로잡았다. 증거: `project-backup-e2e-complete.log`, `project-backup-browser.png`.
- 기존 격리 PRJ-007 작업본 **revision 35, Version 36개, 자산 31개, 파일 68개, 87,161,289바이트**를 실제 백업·복원했다. 약 **14.7초**에 전체 원래 파일 해시 일치와 ProjectStore 재열기를 확인했다. CLI의 별도 검증·복원도 약 **4.3초**에 끝났다. 원본의 현재본 SHA-256은 `203ab4dc7b82bef4a3490b93af9876b17bf20d28487c5adf53f430b1fbe27fae`로 유지됐고 모델 호출은 0회다. 증거: `project-backup-actual/result.json`, `project-backup-actual/cli-result.json`, `project-backup-cli.log`. 이는 전체 작품 Final 제작 완료 증명이 아니다.
- 메인 저장소에서 다른 폴더의 `unknown:<directoryName>` 복구 표시가 모든 콘티의 백업을 차단하는 범위 문제가 발견됐다. 스키마·파일명·directoryName·unknown:key가 모두 같은 다른 폴더를 가리킬 때만 분리하도록 공통 읽기 전용 저장 판정을 수정했다. 현재 대상의 표시, 불명/격리 표시는 계속 차단하며 원래 복구 표시를 지우거나 정상 처리하지 않는다. 실제 메인 콘티의 백업 미리보기 HTTP 200과 별도 백업 검증 HTTP 200을 확인했다.
- TypeScript/Web 타입·Schema 일치·Required Registry **663개**(누락/중복/skip/only 0)·diff 검사가 통과했다. 전체 `npm run check`와 전체 E2E는 아직 실행 범위가 남아 있다. 기존 Vite 큰 청크 경고는 유지된다. 서버 4317과 55873의 Build는 `19aa3f6c86db42703c2aac0f33390ddff77b3c7b70042b681a3b7ecc03eb0b0f`, Project Schema는 1.17.0이다. 실제 HTML/JS 파일 일치, 기존 프로젝트 3개의 revision/해시, 격리 작업본 revision 35와 중단/검토 상태를 보존했다. 자동 생성 재개 0건이며 기존 복구 차단 1건도 유지했다. 증거: `project-backup-runtime.json`, `project-backup-post-restart-preservation.json`, `project-backup-isolated-after.json`.

증거 경로는 `.local/validation/automation-runtime/` 기준이다. 선택 백업과 독립 저장소 복원은 위 범위로 검증했으며 전체 A01~A10/B01~B14 완료를 뜻하지 않는다. 전체 작품 제작·가독성/청취/연속성·Final 출력, 남은 설정과 임시 자원 수명 검증을 계속한다.

## 선택 발화 자동 재생성 검증

음성 탭의 「발화 선택 생성·비교」는 선택한 Cue의 목소리·속도·종료 허용 시각을 고정한 Run을 시작한다. 서버가 로컬 합성·실측·후보 검사·원자 적용을 진행하고 청취 검토 대기로 종료한다. 모델·그림·다른 발화 계획으로 확장하지 않는다. 기존 시작 시각·원문·컷·그림·이전 WAV·기록을 보존하며 새 WAV만 버전으로 추가한다. 그림 승인은 보존하고 컷 확정·잠금, 같은 화자의 겹침 확대, 정보 공개, 파일 무결성을 검사한다. 이전 버전은 원본 음량으로 비교할 수 있다.

- 관련 7개 파일 **43개 검사**가 통과했다. 선택 범위·기존 음원 보존·실행 재개·자동 배정·구간 보완의 회귀 범위다. 이후 Project ID의 입력 해시 결속과 미설치 음성 HTTP 400을 보완한 최종 **6개 재생성 검사**도 통과했다. 증거: `speech-retake-integration.log`, `speech-retake-final-unit.log`.
- 실제 HTTP 저장소를 사용한 브라우저 **4개 검사**가 통과했다. 기존 화자 선택·자동 배정 3개와 새 입력 복원→자동 생성→새 결과 읽기→이전 WAV 비교 1개다. 새 검사는 합성 속도 160을 전달하고 현재 2.6초/이전 2.3초 WAV를 브라우저에서 디코딩했으며 새로고침으로 재실행하지 않음을 확인했다. 증거: `speech-retake-e2e-final.log`, `speech-retake-browser-final.png`.
- 실제 로컬 macOS Yuna로 합성 화분 안내를 180·160 단어/분으로 처리했다. 두 실행은 약 **8.2초**, WAV 길이는 각각 **2,901ms·3,444ms**였다. 둘 다 48kHz mono PCM16이며 무음 아님, 최대 진폭 표본 0이었다. 기존 합성 테스트 자산 v1과 실제 생성 v2·v3, 원문·컷·그림을 보존했다. 클라우드 모델·이미지 호출과 실제 작품 원문 전송은 없다. 증거: `speech-retake-actual.json`, `speech-retake-actual-project.json`, `speech-retake-actual-180.wav`, `speech-retake-actual-160.wav`. 최초 분석 스크립트의 AbortSignal 누락 실패는 `speech-retake-actual-first-attempt.log`에 보존했다. 연기·발음 품질이나 작품 전체 청취 검증으로 해석하지 않는다.
- 타입 검사 2종·JSON Schema 일치·Required Registry **653개**(누락/중복/skip/only 0)·diff 검사가 통과했다. 증거: `speech-retake-types.log`, `speech-retake-diff-check.log`. 전체 `npm run check`와 전체 E2E·병렬 안정성 검증은 완료하지 않았다.
- 서버 4317과 격리 검토 서버 55873에 Build `752f865e4feaf990f99dd744be5b2562893516284f7824ba9b487e50ab8e7dbb`를 반영했다. 새 경로의 빈 요청은 HTTP 400이고 작업을 만들지 않는다. 정적 JS·CSS 실제 바이트, 기존 프로젝트 3개의 revision/해시와 격리 프로젝트 revision 35를 보존했으며 새 생성 자동 재개 0건이다. 기존 복구 차단 1건도 그대로다. 증거: `speech-retake-runtime-verification.json`, `speech-retake-route-verification.json`, `speech-retake-post-restart-preservation.json`, `speech-retake-isolated-after.json`.

증거는 `.local/validation/automation-runtime/`에 있다. 선택 발화의 목소리·속도·발음 보완 재생성은 구현했으며 작품 전체 제작·청취, 전체 Final 출력과 나머지 A01~A10/B01~B14의 검증은 계속 진행해야 한다. 실제 작품을 외부 Codex 모델로 보내는 검증은 앞서 요청한 원문 전송 승인 대기 상태다.

## 화자 음성 자동 배정 검증

선택 구간의 미등록·비보호 발화는 `voice-casting` 작업에서 설치된 음성·원문 언어·역할을 Codex로 검토한 뒤 합성한다. 현재 원문의 배정과 이유를 Project 1.17 및 생성 기록에 보관하고 직접 지정한 음성을 우선한다. 원문 변경, 미설치 이름, 언어 불일치, 누락·중복 화자와 중단 후 재개를 검사한다. UI는 자동/직접 방식과 저장된 배정을 보여 주며 실행 중·일시 중지 후에도 별도 결과 영역을 열 수 있다. 이전 파일의 원문·WAV·시각·승인·Version 바이트는 보존한다.

- 음성·실행 6개 파일의 **35개 검사**, 저장 이관·출력·Build 11개 파일의 **170개 검사**가 통과했다. 증거: `voice-casting-integration-serial.log`, `voice-casting-migration-regression.log`.
- 브라우저 **3개 검사**가 통과했다. 직접 음성 설정 보존·전송, 잘못된 선택 차단, 자동 배정 시작→저장→일시 중지→배정 이름·이유 표시를 확인했다. 증거: `voice-casting-e2e-final.log`, `voice-casting-browser.png`.
- 타입 검사 2종, 스키마 산출물, Required Registry **646개**(누락/중복/skip/only 0), diff 검사가 통과했다. 전체 `npm run check`/전체 E2E를 완료한 주장은 아니다. 파일 병렬 실행에서는 기존 화자 재개 검사와 신규 배정 재개 검사가 각각 5초 제한을 넘었다. 시간 제한을 늘리지 않았고 신규 검사는 배정 재사용·음성 staging 인계에 범위를 맞춰 불필요한 후속 그림 생성을 제외했다. 두 파일을 포함한 위 35개 검사는 파일 순차 실행으로 확인했으며 전체 병렬 안정성은 남은 검증 항목이다. 초기 실패 로그도 보존한다.
- 실제 `gpt-6-astra`가 합성 화분 안내의 한국어 화자에 Yuna/180 단어·분을 제안했다. 설치 음성 177개에서 선택했고 보정 없이 약 **24초**에 배정·실제 합성을 마쳤다. WAV는 **2,901ms, 48kHz mono PCM16**, 무음 아님, 최대 진폭 표본 0이었다. 원문·입력 Project를 보존했다. 증거: `voice-casting-synthetic-actual.json`, `voice-casting-synthetic-actual-candidate.json`, `voice-casting-synthetic-actual.wav`. 연기 품질·작품 전체 청취 검증은 아니다.
- 실제 PRJ-007 원문을 Codex 모델에 전달하는 검증은 자동 승인 검토에서 외부 전송 승인 근거 부족으로 거부됐다. 해당 실행은 시작되지 않았으며 합성 자료로만 실제 엔진을 검증했다. 실제 작품 화자 배정·전체 분량 검증에는 전송 범위 승인이 필요하다.
- 서버 4317과 격리 검토 서버 55873에 같은 Build `d9c393b084ae4375b0ba0e40dd192d5f673e70cca3b684d810601d058927b1fd`를 반영했다. 기존 프로젝트 3개의 revision/바이트와 격리 프로젝트 revision 35를 보존했다. 새 생성 자동 재개 0, 기존 복구 차단 1건은 유지했다. 증거: `voice-casting-runtime-verification.json`, `voice-casting-post-restart-preservation.json`, `voice-casting-isolated-after.json`.

위 증거 파일은 `.local/validation/automation-runtime/` 아래에 있다. 자동 배정과 위 절의 선택 음성 재생성은 구현했으며 발음 보완·작품 전체 청취와 A01~A10/B01~B14의 나머지 검증 범위는 계속 진행해야 한다.

## 현재 결과

자동 제작의 모델·그림·가이드 음성 실행 연결과 구간 후보 계획·검증을 구현했다. 설치된 Codex App의 ChatGPT 로그인을 사용하며 API 키를 요구하지 않는다. 미정 원문 연결에서 시작해 음성을 먼저 측정하고 컷·글자·음향 배치를 함께 검증할 수 있다. 제작 프로필·시각 자원·연속성 계획과 기준 이미지 생성 후보도 구현했다. 실행 이벤트·설정 Snapshot·시도/이미지/시간/바이트 한도와 적용 복구 저장소를 추가했다. 현재 Frame 그림 생성과 작업 순서 확장·실제 엔진 호출·적용 정산을 연결했다. **서버 자동 실행 서비스·시작/중지/재개/취소 API·자동 제작 버튼과 미승인 그림 검토 화면을 연결했다. 중간 음성의 영속 재사용과 개별 음원 검토도 연결했다. 구간 계획 안에서 기존 WAV 시각 재검증도 연결했다. 보존된 편집 구간의 미정 연결·기존 음원 재검증 전용 작업과 미승인 그림의 시간순 검토·탐색·현재 그림 편집도 연결했다. 수동 컷의 미등록 발화 준비·실측 배치도 연결했다. 외부 효과음·음악 준비와 자동 배치도 연결했다. 상세 검토·전체 분량 검증은 남아 있다.** [자동 제작 Design](../02-design/features/storyboard-automation.design.md)의 실행 기반이며 전체 완료 보고가 아니다.

| 실제 실행 | 확인 결과 | 증거 |
|---|---|---|
| 설치된 App Server | Codex Desktop 0.153.4, ChatGPT 인증, image_generation 활성 | [기능 점검](../../.local/validation/automation-runtime/probe-result.json) |
| 구조화 모델 | 실제 `gpt-6-astra` 응답 `{"status":"ok"}`, Turn ID 수집 | [모델 결과](../../.local/validation/automation-runtime/model-probe-result.json) |
| 내장 이미지 | 합성 참조 1장 전달, 결과 PNG 1672×941, 1,752,713 bytes, 실제 디코딩·SHA-256·16:9 반올림 오차 검사 | [이미지 결과](../../.local/validation/automation-runtime/image-engine-pilot.json), [합성 이미지](../../.local/validation/automation-runtime/image-engine-pilot.png) |
| 로컬 가이드 음성 | Yuna, 180 WPM, 48kHz mono PCM16, 실제 길이 2,289ms | [음성 결과](../../.local/validation/automation-runtime/speech-engine-pilot.json), [합성 WAV](../../.local/validation/automation-runtime/speech-engine-pilot.wav) |
| 실측 음성 + 자동 구간 계획 | 합성 화분 안내의 미정 구간 8.5초에서 실제 Codex가 3개 컷·5개 Frame을 계획. Yuna 2,901ms를 배치하고 첫 모델 응답의 후보 검증 통과. 약 147초. 물소리 SFX 파일 1개는 외부 자산 요구로 유지 | [계획 실행 결과](../../.local/validation/automation-runtime/automatic-plan-pilot.json), [검토 후보](../../.local/validation/automation-runtime/automatic-plan-candidate.json), [실측 가이드 WAV](../../.local/validation/automation-runtime/automatic-plan-guide.wav) |
| 제작 기준 + 기준 이미지 | 합성 화분 안내 3구간·4개 자원 계획. 원본에 없는 요약 카드 세트를 제작 제안으로 분리하고 음성 전용 안내자의 화면 자원은 생략. 기준 이미지 1장 941×1672 생성·실제 시각 확인. 약 199초, 첫 계획 검증 통과 | [실행 결과](../../.local/validation/automation-runtime/production-plan-pilot.json), [기준 이미지](../../.local/validation/automation-runtime/production-reference-pilot.png) |
| 현재 프레임 그림 | 실제 기준 이미지를 참고해 물줄기가 화분 흙에 닿는 현재 시점의 PNG 941×1672 생성. 약 47초, 실제 시각 확인, pending 유지 | [실행 결과](../../.local/validation/automation-runtime/frame-image-pilot.json), [그림](../../.local/validation/automation-runtime/frame-image-pilot.png) |
| 편집 컷의 미정 연결 보완 | 합성 화분 안내에서 실제 `gpt-6-astra`가 기존 2,901ms WAV·수동 연출을 유지한 링크 2개를 약 34초에 보완. 모델 1회, 보완 중 음성 재합성 0회. 현재 컴파일러로 입력 해시와 결과를 재검증하고 잔여 Final 차단을 확인 | [실제 실행](../../.local/validation/automation-runtime/source-repair-pilot/result.json), [현재 검증](../../.local/validation/automation-runtime/source-repair-pilot/current-verification.json) |
| 편집 컷의 미등록 발화 자동 배치 | 합성 화분 안내의 수동 컷에서 실제 `gpt-6-astra`와 Yuna로 2,901ms 음성을 생성해 5,000~7,901ms에 배치. 모델·음성 각 1회, 약 41초. 컷·연출·원문·Text·효과음 시각 보존. 이미지·효과음과 사람 검토는 미완료 유지 | [실제 실행](../../.local/validation/automation-runtime/missing-speech-pilot/result.json), [검토 후보](../../.local/validation/automation-runtime/missing-speech-pilot/candidate.json), [실측 WAV](../../.local/validation/automation-runtime/missing-speech-pilot/measured-guide.wav) |
| 준비 음향의 실제 Codex 배치 | 합성 화분 안내의 PCM 1,200ms를 실제 Codex가 5,000~6,200ms에 배치. 모델 1회·약 30초, 음성 합성 0회·신규 미디어 쓰기 0회. 기존 컷·자막·음원·Asset 보존. 합성 PCM의 기술 검증이며 실제 효과음 품질 검증은 아님 | [실제 실행](../../.local/validation/automation-runtime/prepared-audio-pilot/result.json), [검토 후보](../../.local/validation/automation-runtime/prepared-audio-pilot/candidate.json) |
| 기존 콘티 보존 | 대상 콘티 revision 0, 조사 시점 SHA-256과 일치 | [보존 확인](../../.local/validation/automation-runtime/project-preservation.json) |

모델 이름은 응답에서 읽은 값이며 제품 기본 모델을 고정하지 않았다. 합성 화분 그림과 짧은 합성 발화로 실행 가능성을 확인했다. 실제 작품 전체의 연출·음성·그림 품질을 검증한 것은 아니다. Run은 이력 기반 누적 시간·이미지 시도·게시 바이트를 유지한다. Codex App이 요청별 비용을 제공하지 않아 비용은 미측정이다.

구간 계획 파일럿의 최초 스크립트는 BuildManifest의 저장소 부가 필드를 Generation Provenance에 잘못 전달하여 후보 생성에 실패했다. 해당 실행의 Codex 자식 프로세스만 중단하고 공통 Provenance 변환 함수를 적용한 뒤 위 성공 결과를 얻었다. 제품 계획 실행기는 같은 오류가 모델 재시도로 넘어가지 않도록 합성 시작 전에 Provenance를 검사한다. 기존 제작 콘티의 revision 0과 SHA-256 `6ccb08d35c3f45db53140d1fc75a4a52b81d62b192223c81c3e3464447406dce`는 유지됐다.

## 구현 경계

- [stdio 연결](../../src/codex/app-server-transport.ts)은 응답 ID 대응, UTF-8 분할 수신, 입출력 바이트 한도, 요청 시간 초과, 프로세스 종료, 인증값 제거 진단을 담당한다.
- [실행 세션](../../src/codex/app-server-session.ts)은 임시 작업 영역, ChatGPT 인증, 실제 모델과 제공자, 권한 정책, 종료 정리를 확인한다. 기존 ProjectStore에는 접근하지 않는다.
- [구조화 엔진](../../src/codex/structured-engine.ts)은 선택 스냅샷과 출력 Schema로 JSON 제안을 받는다. 도메인 참조·근거 검증과 저장은 후속 후보 적용 단계의 책임이다.
- [이미지 엔진](../../src/codex/image-engine.ts)은 검증한 참조 바이트와 설명을 전달하고 동일 Turn의 이미지 바이트를 검사한다. 모델의 `savedPath` 또는 다운로드 링크를 읽지 않는다. 결과는 미승인 자산 후보이며 기준 이미지 후보 컴파일러는 신규 Asset·Record와 구간별 참조를 연결한다. [프레임 생성](../../src/automation/frame-image.ts)은 현재 원문·기준 버전과 결과를 결속하고 이전 자산을 보존한 pending 그림을 만든다.
- [음성 엔진](../../src/codex/speech-engine.ts)은 발화 원문만 파일로 전달하고 설치된 지정 음성을 합성한다. 미정 Gate 때문에 합성 자체를 차단하지 않고 임시 WAV를 먼저 측정한다. 파일을 자동으로 콘티에 등록하거나 Gate·승인을 변경하지 않는다. 종료·취소된 자식 프로세스가 닫힌 뒤 임시 파일을 정리한다.
- [구간 계획 실행](../../src/automation/plan-segment.ts)은 음성을 한 번 준비하고 명시한 횟수 안에서 계획을 보정한다. 취소·로그인·무결성 오류를 모델 보정으로 반복하지 않는다. 실행 중 진행·음성 준비 콜백을 제공하며 브라우저나 저장소 수명 관리는 아직 담당하지 않는다.
- [후보 컴파일](../../src/automation/plan-compiler.ts)은 실제 원문·확정 시각·잠금·기존 측정 음성·생성 이력을 보존한다. Source·Text·Audio를 함께 조립한 후 중앙 Gate·Coverage·전환과 모든 채널의 원문 공개 순서를 검사한다. 파생 Frame도 생성 한도에 포함한다. 기존 ProjectStore에 계획·새 WAV·각 생성 Record를 한 revision으로 저장하고 이전 버전을 보존하는 테스트를 통과했다.

이미지 응답은 실제 Base64 PNG를 포함했고, 런타임이 별도로 Codex 캐시에 저장한 경로도 반환했다. 제품 엔진은 Base64를 사용해 외부 캐시 경로 읽기에 의존하지 않는다. 세션의 쓰기 권한은 실행 임시 폴더로 제한하고 공용 임시 폴더 추가 권한을 제외한다.

- [실행 이력 저장소](../../src/automation/run-store.ts)와 [상태 전이](../../src/automation/run-state.ts)는 시작 Snapshot·설정·Build를 보존하고 작업 의존 순서와 유한 한도를 검사한다. HEAD 게시 중단, 이벤트 변조·삭제, 같은 Project/순번 경쟁을 검사했다. [순차 실행기](../../src/automation/run-executor.ts)는 작업 확장·실제 엔진 호출·준비 후보 재사용·Commit 정산·유한 재시도와 Worker 소유권을 담당한다. 서버 서비스와 Web/API에서 같은 실행기를 사용한다.
- [미정 연결 보완](../../src/automation/plan-repair.ts)은 기존 편집 컷에 별도 작업으로 실행한다. 미정 Link·파일이 있는 미측정 Audio Cue·보호되지 않은 미등록 발화를 선택하고, 사용자가 확정한 용도·모든 컷 내용·시각·기존 프레임·Text를 유지한다. 새 발화만 현재 시작/종료 범위 안에서 실측 길이로 배치하며 등록 음원과 효과음 시각은 유지한다. [후보 검사](../../src/automation/repair-compiler.ts)는 현재 Source·Coverage·정보 공개·전체 파생 출력의 새 충돌을 검사하고 필요한 공개 키 프레임만 추가한다. 자동 기준·빈 그림 생성으로 이어지며, 원문/음원 검증 근거와 당시의 잔여 Final 검토를 Record에 저장한다.
- [적용 저장소](../../src/automation/application-store.ts)는 새 결과·미디어를 준비하고 Intent를 먼저 기록한 뒤 ProjectStore에 반영한다. 반영 직후 중단·후속 사용자 편집·임시 파일 부재에서도 최초 도입 Version을 검증해 정산한다. 실제 결과를 재생성하거나 현재 revision으로 완료 번호를 바꾸지 않는다.

## 음성 저장·재개와 개별 검토

`AutomaticSpeechCache`는 원문과 음성 설정을 결속한 WAV를 실행별로 보존한다. 재개 시 원문·설정·실제 파일을 다시 확인하며 최초 생성 시각을 Generation Record에 남긴다. 실행·프로젝트·원문·음성·속도·샘플레이트·Build가 다르면 별도 결과를 준비한다. 저장 파일은 전체 해시와 WAV 해시를 검사하며 완성된 중단 파일만 복구한다. 음성 보존 파일과 적용 후보 미디어가 준비 파일 한도를 함께 사용한다.

실제 macOS Yuna 음성 2,582ms, 48kHz mono PCM16을 한 번 합성한 뒤 새 저장소 객체에서 같은 바이트와 최초 생성 시각으로 재사용했다. [실행 근거](../../.local/validation/automation-runtime/speech-cache-pilot/verification.json), [검증 음성](../../.local/validation/automation-runtime/speech-cache-pilot/verified-guide.wav). 실제 작품 전체의 음성 검토를 끝냈다는 의미는 아니다.

음성 편집 탭은 등록한 실제 파일을 개별 재생한다. 화면을 떠나거나 시간순 미리보기를 열면 개별 재생을 멈추며, 다른 미디어가 시작될 때도 중복 재생을 막는다. 이 검토가 사람 승인이나 Final 검사 결과를 바꾸지는 않는다.

기존 음원이 있는 구간 계획은 파일 해시·실제 길이·PCM 형식·큐 연결을 대조한다. 사용자가 이동한 시간과 음원은 보존하고 기술적인 측정 상태만 복원한다. 모델의 시간 변경·중복 합성은 보정 오류이며, 계획 이후 파일 변조는 적용 전에 차단한다. 기존 Asset·Generation Record는 유지하며 검증한 파일 근거를 새 계획 Record에 기록한다.

편집 컷의 미등록 발화는 `stageMissingSpeech`로 계획 호출 전에 한 번 준비하고 기존 실행 캐시에 보존한다. `repair`의 1.1.0 결과는 지정한 미등록 발화별 배치를 요구하며 이전 1.0.0 결과는 음성 없는 계약으로 유지한다. 원문·Cue의 발화 종류와 실제 PCM WAV·길이·시각 범위·관계를 검사한 뒤 Source Anchor와 함께 후보를 검증한다. 보호 컷의 원문을 공유하거나 시간상 겹치는 발화는 제외한다. 잘못된 파일·한도·취소는 모델 보정으로 재시도하지 않고, 배치 오류는 명시된 횟수만 보정한다. 창보다 긴 발화를 자르거나 반복해 맞추지 않는다.

## 외부 음향의 준비·배치

효과음·음악의 실제 PCM WAV를 준비한 뒤 자동 계획에 연결한다. `prepareAudioAsset`는 원본 구간 또는 명시 J/L컷의 허용 범위를 기록하고 Worker로 파일을 정규화해 새 Asset으로 보존한다. 이 준비는 원문 공개나 타임라인 재생을 확정하지 않는다. prepared 음원은 같은 파일의 실제 길이·원문·범위·정보 공개를 구간 계획/편집 보완 후보에서 함께 검사한 뒤 measured가 된다. 기존에 배치한 음원의 시간·파일·과거 Record는 그대로다. 파일 길이가 범위를 넘으면 자르거나 반복하지 않고 명시적 오류를 반환한다.

웹의 음성·음향 탭에서 WAV를 선택해 준비하면 제작 현황의 자동 제작으로 이동한다. 같은 실행 관리와 후보 적용 저장소가 실제 배치를 이어간다. 파일 준비만으로 안전 재생·Final을 허용하지 않으며 별도 WAV 검토 플레이어로 파일 자체는 들을 수 있다. 잘못된 파일과 동시 revision 충돌은 이전 Project와 파일을 보존한다. 정상 준비 음향은 타임라인 길이가 미정이라는 이유로 정규화 복구 대상으로 분류하지 않는다.

## 제작자 시간순 검토

자동 제작의 결과 버튼은 미승인 그림을 포함한 초안 재생 화면을 연다. 시작·키·끝 프레임과 이전 컷 유지, 전환의 실제 노출 시각을 공통 도메인에서 판단한다. 재생·일시 정지·탐색 뒤 현재 그림 편집으로 이동하며 사람 승인 상태는 바꾸지 않는다. 실제 파일과 revision을 확인하는 별도 검토 API를 사용하고 Final·PDF·CSV의 기존 차단을 유지한다.

합성 세로형 프로젝트에서 실제 PNG·PCM WAV를 저장하고 브라우저의 프레임 전환, 같은 그림 구간의 재요청 방지, 화면비와 편집 이동을 검사했다. 잘못된 자산 대상·파일 손상·Source 공백·공개 시점 위반·동시 편집·이전 revision은 검토 경로에서도 차단한다. 이 검증에서는 새 Codex 모델·이미지·음성 생성을 호출하지 않았다. [검토 화면](../../.local/validation/automation-runtime/producer-review-ui.png).

## 긴 제작 내용의 PDF 검토

[PDF 렌더러](../../src/exporters/pdf-renderer.ts)는 고정 높이 말줄임을 제거하고 프레임별 시작 페이지와 본문 후속 페이지를 제공한다. 한글 장문·긴 ID·검토 사유를 실제 글꼴 폭으로 나누며, 페이지 경계에 항목명과 계속 표시를 남긴다. 컷별 글자·음향의 본문과 정확한 시각을 기존 출력 정책으로 선별한다. External의 새 설명·큐 필드에도 같은 비식별화 정책이 적용된다.

기존 32프레임 콘티를 읽기 전용으로 상세 Draft PDF 69쪽으로 만들고 원본 바이트·revision을 보존했다. 별도 세로형 조판 샘플은 기존 검증 그림과 합성 장문으로 4쪽을 만들었다. 두 PDF의 73쪽 전체 텍스트 경계 검사에서 위반은 없었고, 전체 페이지 썸네일과 장문 연결·세로 이미지·마지막 페이지를 시각 확인했다. 이 출력은 원본 초안의 차단 상태를 유지한 레이아웃 검증이며 실제 작품의 최종 콘티가 아니다. [검증 결과](../../.local/validation/automation-runtime/pdf-pagination/verification.json), [페이지 1~24](../../.local/validation/automation-runtime/pdf-pagination/contact-1.png), [페이지 25~48](../../.local/validation/automation-runtime/pdf-pagination/contact-2.png), [페이지 49~69](../../.local/validation/automation-runtime/pdf-pagination/contact-3.png), [세로형 시작](../../.local/validation/automation-runtime/pdf-pagination/portrait-1.png), [장문 계속](../../.local/validation/automation-runtime/pdf-pagination/portrait-2.png), [글자·음향 목록](../../.local/validation/automation-runtime/pdf-pagination/portrait-3.png).

상세 출력은 아래 출력 선택 계약으로 A4/A3·가로/세로와 대표 프레임을 지원한다. 기존 기술 CSV 열 구조를 유지하며 별도 제작용 표를 제공한다.

## 제작용 출력 선택과 프로젝트 복원

`StoryboardOutputOptions` 1.0.0은 전체/선택 구간, 모든/대표 프레임, A4/A3·가로/세로, 상세 PDF/2·4·6개 그림 목록, 포함 본문, 기술/제작용 CSV와 파일 이름을 받는다. 선택 구간은 원래 시간순이며 대표 그림은 첫 키 프레임, 시작 프레임 순서로 선택한다. 승인된 그림만 골라 차단을 숨기지 않는다. 그림 목록은 번호·시간·검토 상태를 담는 비교 요약이고 상세 제작 내용은 상세 PDF·제작용 CSV에 남긴다. 긴 본문은 후속 페이지를 사용하며 과도한 목록 캡션은 잘라내지 않고 명시적으로 거부한다.

웹 검토·출력 화면은 프로젝트별 설정을 브라우저에 명시적으로 저장하고 마지막 선택 콘티를 다시 연다. 없는 콘티나 읽을 수 없는 저장 설정은 사용자에게 원인을 표시한다. 마지막 선택 콘티 복원은 미저장 컷 편집·탭·재생 위치 복원과 별개다. 모든 다운로드는 요청 revision을 검사하며 HTTP 오류·잘못된 MIME을 화면 안에 표시한다. 프로젝트 원문·승인·revision은 변경하지 않는다. 구간을 줄여도 Final은 작품 전체의 실제 자산·글자 조판·공통 차단을 검사한다.

`출력 선택 기록` JSON은 ID·revision·원본 모델 해시·선택 범위를 기록한다. 편집용 Project나 승인 증명은 아니다. CLI의 `--output-selection`은 같은 ID·revision에서 이 구성을 PDF·CSV에 적용한다. Review Bundle의 Project JSON·감사·선택한 미디어는 작품 전체 범위를 유지하며, Manifest에 `archiveScope: whole-project`와 실제 선택 Shot/Frame을 명시한다. External은 새 선택 기록에도 기존 비식별화를 적용하고 원본 이미지 포함을 거부한다. 수신자·미디어 포함·비식별화·Bundle 출력 폴더를 웹에서 설정하는 B13 작업은 남아 있다.

기존 초안의 첫 두 구간을 상세 PDF로, 합성 세로형 그림 7개를 목록 PDF로 출력했다. 네 PDF의 13쪽은 텍스트 경계 위반 0건이며 전체 페이지를 시각 확인했다. A3 가로 6개는 3열·2행, A4 세로 4개는 2열·2행이며 원본 그림 비율을 유지한다. 기존 콘티 revision 0·파일 바이트를 보존했다. 실제 원문의 미해결 상태를 유지한 조판 검증이고 작품의 최종 콘티가 아니다. [출력 검증](../../.local/validation/automation-runtime/output-options/verification.json).

## 글자 배치와 공통 출력

Project 1.15.0의 버전 고정 배치 프리셋·읽기 기준·배치 제어과 설정 저장을 연결했다. 기본 고지/소품/자막 위치를 바꾸고 크기·여백·줄 수를 조정할 수 있다. 실제 글꼴의 Glyph 경로를 검토 화면 SVG와 PDF에서 공유한다. 원문·시각·승인·자산을 보존하며 현재 글자 집합의 변화에서만 브라우저 요청을 교체한다. 안내 배지는 실제 프레임 밖에 표시한다.

전체 Cue 경계의 조판 문제를 Final HTTP·목록·PDF/CSV·Review Bundle에서 검사한다. 프레임 사이에만 나타나는 긴 자막도 검출한다. 설정 저장은 한 revision이며 오래된 요청과 잘못된 설정은 이전 상태를 보존한다. 기본 프리셋의 자동 적용은 작품별 Codex 가독성 판단과 구별한다. Cue별 스타일과 글꼴 선택은 남아 있다. 작품별 프리셋 자동 선택은 별도 전역 계획 작업으로 연결했다.

자동 구간 계획은 실제 글꼴로 겹침·넘침을 검사하고 시각으로 해결 가능한 미확정 항목에만 한도 내 모델 보정을 요청한다. 본문·종류·권한·대상 밖의 시각·사용자 설정을 보존하며, 정상 표시 길이를 겹침 해소만을 위해 줄이지 않는다. 해결되지 않은 문제는 사람의 시각 확정 전부터 검토 화면에 표시한다. 사용 글꼴 해시와 검사 근거는 새 생성 기록에만 추가한다. 편집 컷 보완은 기존 Text 시각을 유지한다. 글꼴이 계획 중 바뀌거나 없으면 성공 후보로 내보내지 않는다.

읽기 기준은 공백을 제외한 표시 문자 묶음 수·초당 읽기 속도·최소/최대 표시 시간을 사용한다. 초기 12문자/초·최소 1초·최대 8초는 수정 가능한 제품의 초안 값이며 업계 기준이나 원본 확정 지시가 아니다. 고정 Placement의 시작과 확정 종료는 유지하고 미정 종료만 보정한다. 최대 기준보다 긴 초안은 필요한 읽기 시간까지 확보하면서 줄일 수 있다. 짧거나 지나치게 긴 표시, 허용 창에 들어가지 않는 문구는 각각 구체적인 검토 항목을 남긴다. 설정 저장만으로 기존 시각을 바꾸지 않으며 다음 자동 구간 계획에 전달한다. 사용자의 명시적인 시각 확정은 읽기 초안 기준보다 우선하지만 원문·정보 공개·조판·실제 미디어·Final 검사는 계속 적용한다.

실제 `gpt-6-astra`에 합성 고지와 8문자/초·최소 2,500ms 기준을 전달했다. 약 76초·모델 1회로 원래 0ms 시작을 유지하고 미정 종료를 5,000ms로 계획했으며 읽기·조판 문제는 0건이었다. 원문·설정·원래 프로젝트를 보존하고 새 이미지·음성 생성이나 사람 승인은 하지 않았다. 실제 두 번째 보정 호출이나 작품 전체 가독성까지 검증한 결과는 아니다. [실제 읽기 계획](../../.local/validation/automation-runtime/text-reading-pilot/result.json), [생성 후보](../../.local/validation/automation-runtime/text-reading-pilot/project.json).

실제 `gpt-6-astra`는 합성 원문의 두 메모를 0~2,400ms와 2,400~5,000ms에 배치했고 첫 후보의 실제 글꼴 검사는 문제 0건이었다. 약 105초, 모델 1회였으며 본문·프리셋을 보존하고 새 미디어 생성과 사람 승인은 하지 않았다. 모델 보정의 두 번째 호출 경로는 별도 모의 응답 시험으로 검증한다. 이 실행은 전체 작품이나 적절한 읽기 속도의 품질 검증이 아니다. [실제 실행 근거](../../.local/validation/automation-runtime/automatic-text-pilot/result.json), [생성 후보](../../.local/validation/automation-runtime/automatic-text-pilot/project.json).

한글 고지·소품 글자·자막을 함께 넣은 가로/세로 PDF 두 쪽을 렌더링하여 위치·여백·줄바꿈·Glyph와 잘림 여부를 확인했다. 원문 탭은 보존하고 표시할 때만 네 칸 공백으로 조판한다. 이 자료는 합성 레이아웃 검사이며 작품의 최종 검토 결과가 아니다. [검증 데이터](../../.local/validation/automation-runtime/text-layout/verification.json), [가로 PDF](../../.local/validation/automation-runtime/text-layout/landscape.pdf), [세로 PDF](../../.local/validation/automation-runtime/text-layout/portrait.pdf).

## 작품별 글자 프리셋 자동 계획

새 콘티는 자동 배치 대상으로 시작하며, 이전 저장본은 기존 배치를 보존하는 수동 상태로 메모리에서 읽는다. 실행 설정과 프로젝트 설정이 모두 자동일 때 Codex가 전체 문구·종류·화면비·실제 글꼴을 보고 초기 배치를 계획한다. 직접 수치를 수정하면 수동으로 전환되며, 자동 계획은 확정/잠금 컷·승인 그림의 전역 배치를 유지한다. 확정된 글자 시각은 그대로 보존하며 시각 확정만으로 배치까지 승인했다고 추측하지 않는다.

실제 글꼴의 단독 넘침과 허용된 동시 표시의 겹침을 검사하고 기존 보정 횟수 안에서 수정한다. 남은 문제는 신규 생성 기록과 설정 화면에 표시한다. 최근 제안 이유·실제 모델·당시 문제와 현재 저장한 배치의 일치 여부를 확인할 수 있다. 과거 제안 뒤 수동으로 변경한 배치를 자동 제안 결과로 표시하지 않는다. 전체 설정 후보는 기존 실행 Snapshot과 ProjectStore 적용/복구를 사용하며 원문·시각·승인·자산을 바꾸지 않는다.

이전 Run 설정은 새 필드를 추가하지 않고 그대로 읽어 과거 이벤트·해시를 유지한다. 이전 Project의 원본 Current·Version 바이트도 읽기에서 보존한다. 배치 프리셋 변경은 글꼴 선택·Cue별 스타일·사람의 실제 가독성 검토를 대신하지 않는다.

실제 `gpt-6-astra`는 세로형 합성 문구에 글자 크기 0.07·줄 간격 1.3·최대 4줄을 제안했다. 약 70초·모델 1회였으며 실제 글꼴 검사 결과 0건, 원문·시각·승인·기존 기록 보존을 확인했다. 같은 두 문구를 실제 Glyph로 렌더링한 별도 조판 샘플도 잘림·겹침이 없었다. 샘플은 원문 권한과 시각 확정을 거친 프로그램 출력이 아니며, 2초 초안의 읽기 충분성이나 작품 전체 가독성 검증을 뜻하지 않는다. 모델도 해당 한계를 제안 이유에 남겼다. [실제 자동 배치](../../.local/validation/automation-runtime/text-preset-pilot/result.json), [별도 조판 샘플](../../.local/validation/automation-runtime/text-preset-pilot/raw-layout-sample.png), [검사 근거](../../.local/validation/automation-runtime/text-preset-pilot/raw-layout-sample.json).

## 컷·프레임 표현 수준

자동 실행에 원문에 맞춤·간략·상세 선호와 긴 그림 표시 검토 기준을 연결했다. 설정은 모델 입력·실행 Snapshot·신규 생성 기록에 보존한다. 구간 계획은 원문 공개에 필요한 파생 프레임까지 실제 개수를 세고, 긴 표시는 기존 보정 횟수 안에서 다시 검토한다. 의도된 정적 장면을 개수만 늘려 바꾸거나 사람 승인으로 처리하지 않는다. 이전 실행의 미지정 상세도와 설정 해시는 그대로 읽는다.

제작 현황의 ‘제작 범위와 실행 설정’에서 선택하며, 결과를 불러오면 현재 컷·프레임·그림 대상 수와 긴 표시 구간을 확인할 수 있다. ‘이 컷 검토’는 해당 컷의 그림 편집으로 이동한다. 이미지 대상 수는 현재 sourced 프레임 수이며 신규 이미지 요청 수나 서로 다른 비트맵 수와 구별한다. 잠금·확정·기존 편집 컷을 상세도 변경만으로 재분할하지 않는다. [설정 화면](../../.local/validation/automation-runtime/storyboard-density-browser.png).

실제 Codex 파일럿은 합성 5초 구간·상세 선호·2,500ms 검토 기준으로 실행했으나 최초 호출과 별도 재시도 모두 `CODEX_EXECUTION_TIMEOUT`으로 종료됐다(각 약 120초). 모델 결과와 프로젝트 반영은 0건이며 실제 생성 품질은 미검증이다. 제한 시간이나 재시도 횟수는 늘리지 않았고 두 실패를 보존했다. [최초 실패](../../.local/validation/automation-runtime/storyboard-density-pilot/failure.json), [재시도 실패](../../.local/validation/automation-runtime/storyboard-density-pilot-retry/failure.json). 선택 설정 전달·유한 보정·실제 개수·이전 기록 보존은 모의 모델과 브라우저 통합 검사에서 검증했다.

## 실제 음원 음량·페이드 자동 계획

자동 제작은 선택 구간의 배치된 WAV를 분석하고 구간·그림 작업 뒤 음량 계획을 수행한다. 발화·음향의 상대 음량, 음향 페이드와 이유를 저장하며 개별 검토와 시간순 재생에서 같은 값으로 듣는다. 수동 음량과 확정/잠금 컷에 공유·겹치는 음원은 보존한다. 과거 파일에는 믹싱 설정을 추정해 추가하지 않으며 기존 Run 해시를 유지한다. JSON·CSV·PDF에는 설정·지시를 보존하고 WAV 파일은 변경하지 않는다.

원본의 표본 피크·RMS, 무음과 최대 진폭 표본을 실제 PCM에서 분석한다. 겹치는 표본 피크 합은 보수적 검토 기준이며 실제 혼합 출력의 클리핑·LUFS 측정이 아니다. 제한된 모델 보정 뒤 남은 문제를 기록과 음성 탭에 표시한다. 원문·자산·배치·사용자 승인은 변경하지 않는다. 모델 전후 실제 음원과 최신 Project를 재검증하며 결과는 기존 원자 적용 경로로 반영한다.

실제 `gpt-6-astra` 파일럿은 2,901ms Yuna 발화와 1,000ms 합성 440Hz 음향을 사용했다. 모델 1회·43.5초에 발화 0dB/페이드 0ms, 음향 −20dB/페이드 10·100ms를 제안했다. 잔여 표본 검토 0건이며 기존 원문·시각·자산·승인·기록과 입력 Project를 보존했다. ProjectStore 쓰기는 0건이다. 실제 제작 효과음이나 작품 전체 청취 품질을 검증했다는 의미는 아니다. [실제 계획](../../.local/validation/automation-runtime/audio-mix-pilot/result.json), [모델 입력·응답](../../.local/validation/automation-runtime/audio-mix-pilot/generation.json).

## 검토·전달 패키지

검토·출력 화면에서 사용 목적·수신자·내부/외부·초안/최종·이름·버전과 포함 내용을 정하고, 실제 폴더·범위를 확인한 뒤 생성할 수 있다. 기존 상위 폴더 안에 새 버전 폴더를 만들며 기존 출력은 보존한다. PDF/CSV 선택과 전체 JSON·참조·감사·미디어 범위를 명시하고, 내부용 전문·프롬프트 제외와 외부용 비식별화를 지원한다. 같은 Origin·서버당 단일 I/O·미디어 256 MiB와 미리보기 입력/원본/글꼴/Build/폴더 결속을 적용했다. 실제 외부 전송이나 편집기 프로젝트·영상 출력은 실행하지 않는다. [설정 화면](../../.local/validation/automation-runtime/review-delivery-settings-browser.png), [생성 결과 화면](../../.local/validation/automation-runtime/review-delivery-browser.png).

실제 `의부증의 늪 — draft-01` revision 0에서 내부용·외부용을 각 11개 파일로 생성했다. 선택 PDF/CSV는 2컷, Project JSON·감사는 전체 32컷이다. 서버의 두 생성 응답은 201이며 게시 파일의 모든 크기·해시, 전문 제외, 추가 문구 비식별화, 기존 폴더 재사용 거부를 확인했다. HTTP 검증 스크립트의 첫 실행은 오류 응답의 중첩 `error.code`를 최상위에서 찾던 검사 코드 때문에 마지막 단계에서 실패했다. 생성된 패키지는 재생성하지 않고 실제 서버 영수증·Manifest·파일을 다시 읽어 확인했다. Final은 기존 494개 차단과 비정상 저장 상태를 유지하며 `REVIEW_DELIVERY_BLOCKED` 400이다. 기존 콘티 3개의 revision·원본 바이트는 모두 일치했다. [실제 생성·파일 검사](../../.local/validation/automation-runtime/review-delivery-runtime-verification.json).

두 PDF는 A3 세로형의 표지+그림 비교 목록 각 2쪽이며, 네 쪽을 렌더링해 잘림·비식별화·검토 표시를 확인했다. 텍스트의 페이지 밖 배치는 0건이다. 대상 초안에는 승인 그림이 없으므로 그림은 검토 자리 표시자다. 이 출력 검증을 실제 생성 그림이나 작품 전체 완성으로 해석하지 않는다. [PDF 검사](../../.local/validation/automation-runtime/review-delivery-pdf-verification.json).

4317 서버는 Project Schema 1.16.0, 소스 SHA-256 `417f902cd49945126eca4b6a41ad807bc1c425ef813fc8114a0eb28510a422ab`로 실행 중이다. 자동 제작 configured=true·활성 작업 0건이며, 기존 복구 표시 1개를 보존했다. JS/CSS 실제 바이트·MIME도 현재 Build와 일치한다. [서버 상태](../../.local/validation/automation-runtime/review-delivery-post-restart-status.json), [원본 보존](../../.local/validation/automation-runtime/review-delivery-post-restart-preservation.json), [정적 파일](../../.local/validation/automation-runtime/review-delivery-static-verification.json).

## 실행한 검사

- B13 관련 7개 파일·74개 검사가 통과했다. 이후 전체 `npm run check`는 로컬 포트 샌드박스 제한으로 1개가 실패했고, 같은 명령을 로컬 HTTP 실행 권한으로 다시 수행해 95개 파일·1,410개가 모두 통과했다(309.09초). 두 Typecheck·필수 이름 584개·Schema 일치·Web Build도 통과했다. [관련 검사](../../.local/validation/automation-runtime/review-delivery-check.log), [첫 전체 검사](../../.local/validation/automation-runtime/review-delivery-full-check.log), [전체 통과](../../.local/validation/automation-runtime/review-delivery-full-check-verified.log).
- B13 전체 E2E는 45개가 통과했다(2.1분). 첫 실행의 44개 통과/1개 실패는 macOS `/var`와 `/private/var`의 실제 경로를 다르게 비교한 테스트 오류였고, 실제 경로 비교로 수정했다. 내부용·외부용 생성, 설정 변경 후 재확인, 기존 출력 충돌과 원본 보존을 확인했다. 마지막 버튼 표시 보완 뒤 Web Build와 해당 E2E 1개를 다시 통과하고 화면을 확인했다. [첫 전체 E2E](../../.local/validation/automation-runtime/review-delivery-e2e.log), [전체 통과](../../.local/validation/automation-runtime/review-delivery-e2e-verified.log), [최종 화면 검사](../../.local/validation/automation-runtime/review-delivery-final-ui.log).

- 출력 구성 반영 후 `npm run check` 전체가 통과했다. 94개 파일·1,404개 테스트(246.84초), 서버/웹 Typecheck, 필수 이름 578개(누락·중복·skip·only 0개), Schema 일치와 Web Build를 확인했다. 기존 번들 크기 경고는 유지했다. [전체 검사](../../.local/validation/automation-runtime/output-options-check.log).
- 전체 E2E 44개가 통과했다(약 1.9분). 선택 구간·대표 프레임·A3/세로/6개 목록·제작용 CSV·파일 이름 저장과 실제 다운로드, 새로고침 후 같은 콘티/설정 복원, 다른 프로젝트와 분리, 없는 콘티 안내, 선택 구간 0개 차단과 revision 충돌 표시를 확인했다. 원본 Project·승인 상태는 보존했다. [전체 E2E](../../.local/validation/automation-runtime/output-options-all-e2e.log), [설정 화면](../../.local/validation/automation-runtime/output-options-browser.png).
- 새 출력 검사 7개는 긴 본문 전체 보존·4개 용지/방향·목록 2/4/6개·CSV 본문 권한/수식 이스케이프·실제 HTTP·선택 밖 미승인 그림의 전체 Final 차단·Bundle 비식별화와 파일 해시를 검사한다. 최초 집중 실행 45개 중 2개는 PDF 후속 머리글이 본문 추출에 섞인 비교와 불변 Placement를 바꾼 Fixture 때문에 실패했으며 Fixture를 고친 45개 재검사와 후속 전체 검사는 통과했다. 초기 E2E의 잘못된 독립 콘티 입력/라벨 조회를 바로잡고, 실제 새로고침이 다른 프로젝트를 여는 문제는 마지막 선택 콘티 복원으로 수정했다. 마지막 없는 콘티 안내 검사는 버튼이 아닌 안내 요소를 조회하도록 수정했다. 제한 시간·재시도·제품의 원본 보호를 완화하지 않았다. [집중 통과](../../.local/validation/automation-runtime/output-options-focused-verified.log), [Final 범위 검사](../../.local/validation/automation-runtime/output-options-scope-final.log), [복원 문제](../../.local/validation/automation-runtime/output-options-e2e-final.log), [안내 조회 검사](../../.local/validation/automation-runtime/output-options-e2e-restoration.log).
- 4317 서버를 Project Schema 1.16.0·소스 SHA-256 `22c52b6ae714367cd70a199b102bdeb39bdc952a8eb82e27f1b042581f7c3f65`로 반영했다. 활성 작업 0건·자동 제작 configured=true, 기존 콘티 3개의 revision/파일 SHA-256과 기존 복구 표시 1개를 보존했다. 실제 초안의 2구간/2프레임 선택 PDF·CSV는 200, 오래된 revision과 미완료 Final은 409이며 JS·CSS가 Build 바이트/MIME과 일치했다. [서버 상태](../../.local/validation/automation-runtime/output-options-post-restart-status.json), [원본 보존](../../.local/validation/automation-runtime/output-options-post-restart-preservation.json), [실제 HTTP](../../.local/validation/automation-runtime/output-options-runtime-verification.json).
- 실제 다운로드한 출력 선택 기록을 CLI에 전달해 11개 파일의 Draft Review Bundle을 만들었다. PDF·CSV는 2개 컷 선택, Project JSON은 전체 32개 컷, Manifest의 모든 파일 해시·크기가 일치했다. 기존 저장소는 읽기 전용으로 사용했다. [CLI 검증](../../.local/validation/automation-runtime/output-options-cli-verification.json).

- 음량·페이드 추가 뒤 전체 93개 파일·1,397개 검사, 두 Typecheck, 필수 이름 571개(누락·중복·skip·only 0개), Schema 일치와 Web Build가 통과했다(전체 테스트 약 245초). [전체 검사](../../.local/validation/automation-runtime/audio-mix-full-check.log).
- 음량 계획을 포함한 전체 E2E 43개가 통과했다(약 2분). 자동 제작의 6개 작업 반영, 실제 재생 음량 −3dB와 원본 0dB 비교, 수동 −9dB 저장·재열기, 탭 이동 시 재생 종료를 확인했다. 원문·글자 시각·그림 검토 대기와 Final 차단은 유지했다. 화면 캡처 위치를 보완한 관련 E2E 1개도 통과했다(12.5초). 브라우저 검사는 합성 엔진과 임시 프로젝트를 사용했으며 실제 모델 검증은 위 파일럿과 구별한다. [전체 E2E](../../.local/validation/automation-runtime/audio-mix-e2e.log), [화면 확인 검사](../../.local/validation/automation-runtime/audio-mix-ui-final.log), [음량 설정 화면](../../.local/validation/automation-runtime/audio-mix-settings-ui.png), [개별 청취 화면](../../.local/validation/automation-runtime/audio-mix-review-ui.png).
- 4317 서버를 Project Schema 1.16.0·소스 SHA-256 `d6267b09fc9e43dbaed04d7696c318754f7fc5d431d8331ba35211d588ad2a8c`로 재시작했다. 활성 작업 0건·자동 제작 configured=true이며 기존 콘티 3개의 revision·원본 파일 SHA-256과 기존 복구 표시 1개를 보존했다. 실제 JS·CSS는 200 응답의 MIME·바이트가 Build와 일치한다. 미정 원문 연결·그림이 없는 기존 초안의 검토 API는 `PRODUCER_PREVIEW_BLOCKED`를 유지하며 기존 작품을 자동 완성으로 표시하지 않았다. [서버 상태](../../.local/validation/automation-runtime/audio-mix-post-restart-status.json), [원본 보존](../../.local/validation/automation-runtime/audio-mix-post-restart-preservation.json), [실제 응답 확인](../../.local/validation/automation-runtime/audio-mix-runtime-verification.json).
- 음량 관련 9개 검사는 PCM16/24·mono/stereo·무음·취소·손상, 실제 겹침 보정과 유한 호출, 보호/수동 설정 보존, 모델 뒤 WAV 변경 거부, Source/Asset/승인 보존, 오래된 revision·동시 사용자 편집, 이전 파일 바이트 보존, 반열린 재생 범위와 페이드·seek를 확인했다. 최초 검사는 동일 PCM 참조 해시 중복과 Fixture의 Asset 대상 오류로 4개 실패했다. Record에는 중복 없는 해시 집합과 개별 Cue 증거를 보존하도록 수정했고 Fixture의 Asset 대상은 Cue ID로 바로잡았다. 동시 편집 검사는 모델 보정마다 편집을 반복하던 Fixture를 단일 호출로 명시한 뒤 통과했다. [최초 검사](../../.local/validation/automation-runtime/audio-mix-focused.log), [관련 9개 통과](../../.local/validation/automation-runtime/audio-mix-focused-final.log).
- 자동 글자 프리셋 관련 7개 파일·60개 검사가 통과했다. 실제 Glyph 피드백·유한 보정·취소·글꼴 변경 거부·잔여 문제·사용자 설정/승인 보호·이전 Run 호환·원본 파일 해시 보존을 확인했다. 최초 전체 실행은 91개 파일·1,388개 중 1,385개 통과·이전 저장본 비교 3개 실패였다. 모두 새 `manual` 배치 제어 대신 신규 `automatic`을 기대하던 검증 값 차이였으며, 해당 기대값을 수정한 3개 파일·16개 재검사는 통과했다. 제품의 이관·보호 규칙은 변경하지 않았다. 후속 두 Typecheck·필수 이름 562개·Schema 일치·Web Build도 통과했다. 최초 전체 명령의 실패를 성공으로 기록하지 않는다. [관련 60개](../../.local/validation/automation-runtime/text-preset-final-focused.log), [최초 전체 실행](../../.local/validation/automation-runtime/text-preset-full-check.log), [이전 저장본 재검사](../../.local/validation/automation-runtime/text-preset-migration-verified.log).
- 전체 E2E 43개가 통과했다(약 1.9분). 자동 배치 → 제작 기준/음성/그림의 5개 작업 반영 → 제안 이유 확인 → 수동 수정 → 새로고침 후 수동 설정 보존을 확인했다. Source·Text 시각·pending 그림·Final 차단을 유지했다. 선택 항목 간격과 제안 영역의 표시 보완 뒤 관련 E2E 1개와 Web Typecheck/Build가 다시 통과했다. [전체 브라우저 검사](../../.local/validation/automation-runtime/text-preset-e2e.log), [표시 보완 검사](../../.local/validation/automation-runtime/text-preset-ui-verified.log), [자동 배치 설정](../../.local/validation/automation-runtime/text-preset-browser.png), [제안 이유](../../.local/validation/automation-runtime/text-preset-review-browser.png).
- 4317 서버를 Project Schema 1.15.0·소스 SHA-256 `8d08dfab7baf8864b731ba64d1174889bd82a6258b8ee4a65450612c4ea416bf`로 재시작했다. 활성 작업 0건·자동 제작 configured=true이며 기존 콘티 3개의 revision/원본 파일 바이트와 기존 복구 표시 1개를 보존했다. 이전 콘티는 `manual` 배치로 메모리에서 읽고 기존 Draft Glyph·Final 본문 제외·Final PDF 409/494개 차단을 유지한다. [현재 서버](../../.local/validation/automation-runtime/text-preset-post-restart-status.json), [원본 보존](../../.local/validation/automation-runtime/text-preset-post-restart-preservation.json), [실제 응답](../../.local/validation/automation-runtime/text-preset-http-verification.json).
- 재시작 직후 `dist/web/assets`가 `assets 2`로 바뀌어 JS 경로에서 HTML이 반환되는 문제가 다시 관측됐다. 이름을 바꾼 주체는 확인되지 않았다. 경로·inode·바이트 해시와 HTTP 응답을 보존한 뒤 같은 소스로 별도 Build한 518개 파일 및 index의 바이트가 모두 일치함을 확인하고 디렉터리를 정상 이름으로 복구했다. 이후 실제 JS/CSS는 올바른 MIME과 Build 바이트로 응답한다. 이 복구를 이름 변경 원인의 해결로 보고하지 않는다. [수정 전 증거](../../.local/validation/automation-runtime/text-preset-assets-path/before.json), [동일 Build 대조·복구](../../.local/validation/automation-runtime/text-preset-assets-path/restored.json), [복구 후 실제 파일](../../.local/validation/automation-runtime/text-preset-runtime-verification.json).
- 전체 회귀 검사 90개 파일·1,383개 테스트와 두 Typecheck가 통과했다(약 243초). `npm run check`는 이후 필수 이름 목록에 들어간 테스트가 아닌 문자열 2개 때문에 실패했다. 해당 문자열만 제거한 `npm run test:names && npm run schemas:check && npm run build:web`는 통과했다. 필수 이름은 557개이며 누락·중복·skip·only는 모두 0개다. 전체 명령의 최초 종료 코드를 성공으로 바꾸어 보고하지 않는다. 전역 timeout·retry는 바꾸지 않았고 기존 Web 번들 크기 경고는 남아 있다. [전체 실행 기록](../../.local/validation/automation-runtime/storyboard-density-full-check.log).
- 상세도·계획·HTTP 관련 5개 파일·26개 검사가 통과했다. 실제 파생 프레임 포함 한도, 긴 표시의 유한 보정과 의도된 유지, 과거 설정 이벤트·해시 및 생성 기록 보존, 잘못된 새 설정 거부를 검사했다. 최초 새 테스트의 재열기 Store 초기화 누락은 Fixture에서 수정했으며 저장 계약은 유지했다. [관련 검사](../../.local/validation/automation-runtime/storyboard-density-focused-verified.log).
- 읽기 기준 검사는 Unicode 표시 문자, 고정 시작/확정 종료 보호, 미정 종료 연장, 최대 기준 초과 초안 축소, 불가능한 시간 창, 한도 내 모델 보정, 잔여 검토, 이전 저장본의 메모리 이관·원본 바이트 보존을 포함한다. API 검사는 저장·오래된 revision·잘못된 기준 거부와 명시적 시각 확정 뒤 공통 Final 판정을 확인했다. 최초 테스트의 배열 순서와 8문자 경계값 가정을 수정한 뒤 관련 15개와 전체 검사가 통과했다. 제품의 보호 규칙은 완화하지 않았다. [관련 통과](../../.local/validation/automation-runtime/text-reading-contract-verified.log), [최초 경계값 검사](../../.local/validation/automation-runtime/text-reading-focused-verified.log).
- 자동 글자 검토 5개 검사는 겹침 보정·유한 호출·표시 길이/본문/대상 밖 시각 보존·확정 글자 보호·글꼴 변경/부재 거부·잔여 검토를 확인했다. 최초 전체 실행의 새 테스트는 보호할 글자를 확정 상태로 구성하지 않아 실패했다. Fixture를 수정한 별도 5개 검사와 후속 전체 검사에서 통과했으며 제품의 보호 규칙을 완화하지 않았다. [글자 보정 검사](../../.local/validation/automation-runtime/automatic-text-focused-verified.log), [최초 검사](../../.local/validation/automation-runtime/automatic-text-full-check.log).
- 글자 배치·이전 스키마 관련 83개 회귀 검사가 통과했다. 최초 전체 실행의 이전 버전 Fixture가 새 필드를 포함하던 오류는 Fixture를 해당 버전 형식으로 고쳐 해결했으며, 실제 이관의 알 수 없는 필드 거부는 유지했다. 탭 표시 보완은 안정된 코드의 새 실행에서 다시 검증했다. [관련 검사](../../.local/validation/automation-runtime/text-layout-regression-verified.log), [최초 실패 근거](../../.local/validation/automation-runtime/text-layout-full-check.log).
- PDF 관련 69개 검사가 통과했고 후속 페이지의 항목명 보완 뒤 전체 검사도 통과했다. 장문 전체 보존·페이지 경계·가로/세로 이미지의 실제 PDF 변환 비율·동일 입력의 결정적 바이트·미확정 본문/Final 차단·새 필드 비식별화를 포함한다. [관련 검사](../../.local/validation/automation-runtime/pdf-pagination-focused.log), [조판 보완 검사](../../.local/validation/automation-runtime/pdf-pagination-layout.log).
- 전체 E2E 재검사 43개 통과(브라우저 36개 + 실행·저장 통합 7개, 약 1.8분). 상세도 선택·저장·재열기, 실제 컷/프레임 집계, 긴 그림 구간에서 해당 컷 그림 편집으로 이동을 확인했다. 글자 배치·읽기 기준 저장·재열기, 활성 Cue 안의 SVG 재사용과 경계에서 교체·제거를 실제 브라우저에서 확인했다. 미해결 항목에서 해당 설정으로 이동하고 저장한 기준으로 검토를 다시 계산하며 본문·시각·기록·미확정 상태·Final 차단을 보존한다. 읽기 기준 설정 화면의 실제 배치와 문구도 확인했다. 설정→기준 그림→음성·컷→프레임 반영, 중단 후 음성 재사용, 개별 음성 재생과 화면 이동 시 종료, 사용자 수정·기존 미디어·Final 차단을 검사했다. WAV 준비→자동 배치→결과 불러오기→실제 파일 재생을 확인했고, 잘못된 파일·동시 revision 충돌·배치 전 안전 재생을 거부했다. 생성 엔진은 통합 검사용 구현이며 실제 장시간 Codex 실행 품질과 구분한다. [전체 E2E 재검사](../../.local/validation/automation-runtime/storyboard-density-e2e-recheck.log), [읽기 기준 화면](../../.local/validation/automation-runtime/text-reading-browser.png), [글자 배치 검토 화면](../../.local/validation/automation-runtime/text-layout-browser.png), [자동 후보 검토 화면](../../.local/validation/automation-runtime/automatic-text-review-browser.png), [배치 후 검토 화면](../../.local/validation/automation-runtime/prepared-audio-ui.png).
- 최초 상세도 E2E 실행은 42개 통과·인물 보충 연결 1개 시간 초과였다. Trace의 API 응답은 테스트용 Codex 검토 3,000ms 시간 초과를 기록했다. 동일 제한의 단독 검사와 전체 재검사에서 통과했으나 최초 지연의 근본 원인은 확인되지 않았다. 제품 코드·제한 시간·재시도 횟수는 바꾸지 않았다. [최초 전체 기록](../../.local/validation/automation-runtime/storyboard-density-e2e.log), [실패 Trace](../../.local/validation/automation-runtime/storyboard-density-identity-failure/trace.zip), [단독 재검사](../../.local/validation/automation-runtime/storyboard-density-identity-recheck.log).
- 최초 새 E2E의 마지막 검사는 다른 구간까지 모두 proposed라고 가정해 실패했다. 기존 전체 Text 보존 비교는 통과했으며, 새 보정 대상 두 항목의 상태를 별도로 확인하도록 Fixture 검사를 수정한 뒤 전체 42개가 통과했다. [최초 E2E](../../.local/validation/automation-runtime/automatic-text-e2e.log), [실패 Trace](../../.local/validation/automation-runtime/automatic-text-initial-e2e-failure/trace.zip).
- 실제 Codex는 준비한 1,200ms 합성 PCM을 약 30초에 배치했다. 모델 1회, 음성 합성·신규 미디어 쓰기 0회이며 기존 컷·Text·음원·Asset을 보존했다. 실제 제작 효과음의 연출 품질을 뜻하지 않는다. [실제 실행 근거](../../.local/validation/automation-runtime/prepared-audio-pilot/result.json).
- 스키마 이관 회귀 검사에서는 1.10 원본을 1.11 모델로 읽어 생성했던 완료 이력을 1.12에서 정산하고, 임시 후보가 없어도 최초 revision과 이후 사용자 편집을 보존했다. 시작 Snapshot 변조·과거 Version 변조는 거부한다. 이전 형식의 미게시 후보는 새 실행이 필요하다. 기존 저장본의 첫 수정·게시 전 실패·원본 바이트 rollback·성공 후 과거 Version 보존도 검사했다. 현재 모델을 재직렬화한 해시를 원본 파일 해시와 비교하던 저장 오류를 실제 바이트 증명으로 수정했다. [원인 확인](../../.local/validation/automation-runtime/prepared-audio-migration-focused.log), [관련 통과](../../.local/validation/automation-runtime/prepared-audio-migration-focused-verified.log), [rollback 포함 전체 통과](../../.local/validation/automation-runtime/prepared-audio-final-check.log).
- 준비 음향의 첫 전체 검사에서 1,350개 중 HTTP 바인딩 테스트 1개가 sandbox `listen EPERM`으로 실패했다. localhost 바인딩을 허용한 동일 검사에서 1,350개가 통과했고, 이후 이관 보완을 포함한 최종 1,354개도 통과했다. [최초 검사](../../.local/validation/automation-runtime/prepared-audio-full-check.log), [바인딩 허용 검사](../../.local/validation/automation-runtime/prepared-audio-full-check-verified.log).
- 앞선 E2E에서 `dist/web/assets`가 `assets 2`로 바뀌어 JS·CSS 대신 HTML이 반환된 기록이 있다. 이름 변경의 실행 주체는 확인하지 못했다. 이번 전체 E2E에서는 재현되지 않았으며, 원인이 해결됐다는 의미로 해석하지 않는다. 이전 실패 Trace와 경로 증거를 보존한다. [경로·Trace 증거](../../.local/validation/automation-runtime/missing-speech-interrupted-e2e/path-evidence.json), [이전 실패 실행](../../.local/validation/automation-runtime/missing-speech-interrupted-e2e/run.log).
- 활성 제작·문서 검토·저장 요청 0건을 확인하고 4317 서버를 재시작했다. Project Schema는 1.14.0, 실행 소스 SHA-256은 `24219de8578cad765844c70e6a6e6dcc4e0e8a84ac9ece710db1dcbdbcf0902d`이며 자동 제작 configured=true다. 실제 JS·CSS는 Build 파일과 바이트·MIME이 일치한다. 기존 콘티 3개의 revision·원본 파일 SHA-256과 기존 저장 복구 표시 1개를 보존했다. [서버 상태](../../.local/validation/automation-runtime/storyboard-density-post-restart-status.json), [원본 보존](../../.local/validation/automation-runtime/storyboard-density-post-restart-preservation.json), [실제 응답 확인](../../.local/validation/automation-runtime/storyboard-density-runtime-verification.json).
- 실행 중인 서버에서 실제 Draft PDF가 200·application/pdf로 반환됐고, 전체 32프레임과 새 큐 목록·계속 표시는 70쪽에서 확인했다. 실제 Frame 차단 사유가 포함돼 조판용 텍스트 Projection 샘플보다 1쪽이 많다. Final 요청은 파일 대신 기존 `FINAL_OUTPUT_NOT_READY` 409를 유지했다. [HTTP 확인](../../.local/validation/automation-runtime/pdf-pagination-http-verification.json).
- 실제 서버의 글자 배치 API는 0ms·8000ms에서 Draft 본문과 Glyph 배치를 반환하고, 미확정 Final 본문을 제외했다. 기존 초안 revision 0과 파일을 그대로 읽어 새 읽기 기준까지 평가한 Final 차단은 494개이며 Final PDF 409를 유지했다. 기존 콘티를 수정하거나 완성 상태로 전환하지 않았다. [읽기 전용 HTTP 검증](../../.local/validation/automation-runtime/storyboard-density-http-verification.json).
- `git --no-pager diff --check`: 통과.

## 실제 디스크 공간과 재개 — B14

`AutomationDiskSpace`는 실제 가용 블록을 읽고 같은 장치의 예상 쓰기를 합산한다. 서버 예비 공간을 명시하며 생성·수신 결과 보존·적용의 검사를 구별한다. 새 생성 전 부족은 호출·시도 횟수를 소모하지 않는다. 음성 보존 파일과 준비 후보를 유지하고, 재개에서 같은 결과를 검증해 이어 쓰며 실제 Commit을 먼저 정산한다. 웹은 현재 사용 가능/예상 필요 용량과 검사 시점을 표시하고 다시 확인할 수 있다. 선택 백업·독립 저장소 복원은 위 별도 검증을 따른다. B14 전체 완료를 의미하지 않는다.

- 관련 3개 파일·23개 테스트가 통과했다(28.33초). 같은 장치 합산·BigInt 정밀도·실제 파일시스템·누락 경로 오류, 시작 전 중단·반복 저용량 재개, 후보 보존·중간 WAV 재사용, 공간 부족 뒤 실제 Commit 정산, HTTP 범위와 기존 revision 보존을 확인했다. [관련 검사](../../.local/validation/automation-runtime/disk-space-focused.log).
- 최초 전체 검사에서는 1,417개 중 1,415개가 통과하고 새 재개 검사 2개가 5초 제한을 넘었다. 두 검사는 재사용·반영 확인 뒤에도 무관한 후속 생성까지 실행하고 있었다. 후보 반영 또는 재사용 WAV의 구간 반영 시점에서 멈추도록 검증 범위를 정리했고, 같은 제한의 7개 집중 재검사가 통과했다(11.29초). 실제 전체 흐름은 E2E에서 검증한다. 제품 코드·시간 제한·재시도 수를 바꾸지 않았다. [최초 전체 검사](../../.local/validation/automation-runtime/disk-space-full-check.log), [집중 재검사](../../.local/validation/automation-runtime/disk-space-focused-revised.log).
- 두 번째 전체 검사는 1,416개 통과·나머지 새 시작 전 중단 검사의 시간 초과 1개였다. 이 검사도 전체 생성 대신 공간 확보 후 첫 결과 반영에서 멈추도록 정리했다. 초기 Run Snapshot을 저장할 최소 공간도 없을 때 새 기록을 만들지 않는 검사를 추가했다. 제한 시간은 5초로 유지한다. [두 번째 전체 기록](../../.local/validation/automation-runtime/disk-space-full-check-verified.log).
- 임시 서버·합성 생성 엔진의 브라우저 검사는 1개 통과했다(13.5초). 공간 부족 안내, 생성 시도 0회, 실제 공간 재조회, 같은 실행 ID로 재개, 검토 대기와 사람 승인 보존을 확인했다. 디스크 부족은 주입한 통계로 모의하며 사용자 디스크를 채우지 않았다. [집중 E2E](../../.local/validation/automation-runtime/disk-space-e2e-focused.log).

- 최종 `npm run check`가 통과했다. 96개 파일·1,418개 테스트(261.09초), 서버/웹 Typecheck, 필수 이름 593개(누락·중복·skip·only 0개), Schema 일치와 Web Build를 확인했다. 초기 실패 기록은 위에 별도로 보존한다. 초기 Run 기록 보호를 포함한 관련 15개 검사도 통과했다(14.17초). [최종 전체 검사](../../.local/validation/automation-runtime/disk-space-final-check.log), [관련 최종 검사](../../.local/validation/automation-runtime/disk-space-focused-final.log).

- 최종 Web Build의 전체 E2E 46개가 통과했다(2.2분). 저장 공간 안내와 재조회, 같은 실행 ID의 중단/재개, 최종 검토 대기 및 기존 가져오기·출력·편집 흐름을 확인했다. [전체 E2E](../../.local/validation/automation-runtime/disk-space-e2e-final.log), [공간 부족 화면](../../.local/validation/automation-runtime/disk-space-paused-browser.png), [재개 후 화면](../../.local/validation/automation-runtime/disk-space-resumed-browser.png). 초기 Snapshot 최소 공간 보호의 직접 증거는 위 단위/서비스 검사이며 E2E에서는 기록 저장이 가능한 저용량 상태로 중단·재개한다.
- 4317 서버를 Project Schema 1.16.0·소스 SHA-256 `294d905dc8838c43b80d72ebd2cda954b87d5941e5fa2f2805c538ea4072c06c`로 반영했다. 실제 3개 프로젝트의 용량 조회는 200이며 동일 장치 3개 경로의 가용 공간 약 344.70GB·운영 필요 예상 6.04GB(파일 한도 1GiB·예비 2GiB 포함)를 확인했다. 잘못된 한도·외부 Origin은 400, JS/CSS 2개의 MIME·바이트는 Build와 일치한다. 활성 작업 0개·기존 세 콘티 revision/파일 SHA-256·기존 복구 표시 1개를 보존했다. [실제 HTTP·정적 파일 검사](../../.local/validation/automation-runtime/disk-space-runtime-verification.json), [재시작 상태](../../.local/validation/automation-runtime/disk-space-post-restart-status.json), [기존 파일 보존](../../.local/validation/automation-runtime/disk-space-post-restart-preservation.json).

## 미저장 편집과 작업 위치 — B11 진행 상태

컷 연출, Visual Plan, 프레임 위치/설명, 음성 시각/음량, 글자 시각/Canonical 연결, 제작 프로필, 글자 배치/읽기 기준에 브라우저 임시 입력을 연결했다. 화면별 writer와 sequence를 사용해 다른 탭의 이후 수정을 덮지 않으며, 서버 revision이 바뀌면 두 값을 비교한 뒤 해당 폼의 저장을 허용한다. 새로고침·컷 전환·새 탭에서 복원하되 서버 저장·생성·승인을 실행하지 않는다. 프로젝트별 작업 공간·선택 구간/컷·편집 탭·정지 재생 위치도 복원한다. 상세 보존·충돌·오류 계약과 미연결 폼 목록은 자동 제작 Design의 B11 절을 기준으로 한다.

- 저장소 검사는 writer 간 수정/선택, 다른 프로젝트 scope 분리, 명시적 폐기, 오래된 sequence 거부, 손상 기록·저장 거부 시 원본 보존의 3개 테스트를 통과했다. 전체 `npm run check`는 97개 파일·1,421개 테스트(258.63초), 서버/웹 Typecheck, 필수 이름 598개(누락·중복·skip·only 0개), Schema 일치·Web Build를 통과했다. [전체 검사](../../.local/validation/automation-runtime/browser-drafts-full-check.log).
- 초기 E2E 2개는 textarea의 실제 접근성 이름과 테스트의 label 검색 차이로 실패했다. 실제 textbox 이름으로 변경한 다음 1개가 통과했고, 다른 1개는 두 번째 탭의 초기 조회가 끝나기 전에 첫 입력을 작성해 단일 초안 자동 복원 흐름이 된 것이 원인이었다. 두 탭의 초기 서버 값을 확인한 뒤 독립 수정을 시작하도록 테스트를 고쳐 2개 모두 통과했다. 이후 설정의 수정 중 음수 보존·컷 전환을 추가 확인했다. [초기 기록](../../.local/validation/automation-runtime/browser-drafts-focused-e2e.log), [두 번째 기록](../../.local/validation/automation-runtime/browser-drafts-focused-e2e-v2.log), [집중 검사](../../.local/validation/automation-runtime/browser-drafts-focused-e2e-v3.log).
- 첫 전체 E2E 48개가 통과했다(2.3분). 추가 코드 검토에서 글자 시각 저장/권한 확정 버튼에도 복원 충돌 상태를 연결했다. 이 마지막 Web 변경은 웹 Typecheck·Build와 전체 E2E 48개(2.3분)를 다시 통과했다. 서버/도메인 코드는 이후 변경하지 않았다. 비교 선택만으로 서버 mutation이 생기지 않음, 여러 탭을 닫고 새 페이지에서 두 후보를 골라 다시 복원함을 검사했다. [최종 Web Build](../../.local/validation/automation-runtime/browser-drafts-final-web-build.log), [최종 전체 E2E](../../.local/validation/automation-runtime/browser-drafts-final-e2e.log), [비교 화면](../../.local/validation/automation-runtime/browser-drafts-conflict.png).
- 4317 서버는 Schema 1.16.0·소스 SHA-256 `220b03d0a520ec67c701c1386bc388a9f041dbc83d0e8a596d33363eb38e2052`다. 재시작 전후 활성 작업 0개, 원래 세 프로젝트 revision/파일 SHA와 기존 복구 표시 1개를 보존했다. 실제 JS/CSS MIME·바이트와 복원 기능 문구가 최종 Build와 일치한다. [실행 검사](../../.local/validation/automation-runtime/browser-drafts-runtime-verification.json), [원본 보존](../../.local/validation/automation-runtime/browser-drafts-post-restart-preservation.json). 별도 브라우저에서 실제 `의부증의 늪 — draft-01` 편집 화면과 작업 위치 보관을 확인했으며 Page 오류는 0개다. 편집·생성 동작은 요청하지 않았다. [실제 브라우저](../../.local/validation/automation-runtime/browser-drafts-production-browser.json).
- 실제 반영 검사 중 `dist/web/assets`가 `assets 2`로 바뀐 상태를 발견했다. 저장소의 관련 생성/이름 변경 코드에서 이 동작을 찾지 못했고 작업 중인 하위 에이전트도 없었다. 별도 폴더의 새 Vite Build와 전체 518개 파일의 크기·SHA를 대조한 뒤, 같은 폴더 identity를 유지하며 원래 경로로 복구했다. 현재 HTTP 검증은 통과하지만 변경 주체와 재발 원인은 확인하지 못했다. 자동 대체 경로나 승인 우회를 추가하지 않았다. [복구 전후 파일 증거](../../.local/validation/automation-runtime/browser-drafts-assets-restoration.json). 이 항목은 B14 운영 조사로 계속 남긴다.

## 가져오기 입력·생성 응답 복구 — B11 진행 상태

문서 가져오기 3단계의 입력·연결·제작 설정·검토 근거·생성 결과와 독립 콘티 시작 폼을 보관한다. 복원된 문서 검토는 현재 원본을 다시 확인하기 전까지 생성·불러오기에 사용하지 않는다. 같은 입력의 독립 콘티 요청 ID를 브라우저에 먼저 저장하여 응답 유실 뒤 재시도에서도 기존 콘티와 후속 편집을 보존한다. 패키지 생성 결과는 원본·설정·전체 파일 바이트를 대조해 명시적으로 복구한다. 누락·변경 파일을 덮어쓰지 않으며 복원만으로 생성이나 승인을 실행하지 않는다. 세부 계약과 남은 폼은 자동 제작 Design의 B11 절을 따른다.

- 전체 검사 98개 파일·1,423개 테스트, 타입·필수 이름 602개·스키마·빌드가 통과했다. 이 실행 뒤 복원된 근거 JSON의 키 순서 때문에 동일 패키지를 변경된 입력으로 표시하던 문제를 정규 JSON 비교로 수정했다. 문서 재검토 예약의 busy 해제 후 실행과 복원된 화면의 E2E 기대 동작도 조정했다. 최종 소규모 서버 보완 뒤 타입 검사와 관련 4개 파일·18개 테스트, 필수 이름 602개(누락·중복·skip·only 0), 스키마 검사가 통과했다. [전체 검사](../../.local/validation/automation-runtime/import-drafts-full-check.log), [최종 관련 검사](../../.local/validation/automation-runtime/import-drafts-current-focused.log).
- 관련 브라우저 검사 5개가 통과했다(13.4초). 보충 인물 연결·사용자 선택 보존, 문서/독립 생성 폼 복원, 실제 생성 응답 유실 뒤 동일 ID 재사용, 생성 이후 서버 편집 보존, 완성 패키지의 읽기 전용 복구, 원본 변경 시 입력 유지와 생성 차단을 확인했다. [관련 E2E](../../.local/validation/automation-runtime/import-drafts-recovery-verified-e2e.log).
- 이전 전체 E2E는 각각 49개 통과·1개 실패였다. 첫 실행은 복원된 단계와 과거 빈 폼을 기대한 검사의 불일치, 두 번째는 문서 검토 엔진의 3초 제한 초과였다. 제한 시간과 재시도 횟수는 늘리지 않았다. 엔진 진단에 통신 단계·수신 바이트·대기 RPC를, 검증용 자식 프로세스에 본문 없는 이벤트 시각을 추가했다. 이후 5회 진단 실행은 화면 파일 부재로 검토 엔진 호출 전 모두 실패했으므로 엔진 반복 검증 성공으로 계산하지 않는다. [첫 전체 E2E](../../.local/validation/automation-runtime/import-drafts-final-e2e.log), [두 번째 전체 E2E](../../.local/validation/automation-runtime/import-drafts-final-e2e-v2.log), [시작 실패 기록](../../.local/validation/automation-runtime/import-drafts-diagnostic-repeats.log).
- `dist/web/assets` 부재와 번호가 붙은 폴더·파일을 다시 관측했다. 이 파일들은 보존하고 `emptyOutDir=false`로 현재 Vite 결과 518개 파일을 정상 경로에 새로 만들었다. 누락된 `/assets/` 요청에 HTML 성공 응답을 보내던 서버 동작은 JSON 404로 수정했다. 이름 변경 주체는 여전히 확인되지 않았으며 이를 외부 간섭 원인 해결로 보고하지 않는다. [보존·현재 파일 목록](../../.local/validation/automation-runtime/import-drafts-preserved-static-inventory.json), [보존 빌드](../../.local/validation/automation-runtime/import-drafts-preserving-build.log).

- 현재 Web Build의 전체 E2E 50개가 통과했다(2.3분). 이후 실제 4317 API 검증에서 변경된 패키지가 500으로 잘못 분류되는 누락을 찾았다. `DOCUMENT_OUTPUT_MISMATCH`는 입력 오류 400, 확인 중 폴더 변경은 충돌 409, 화면 파일 부재는 not-found 404로 명시했다. 서버 타입 검사와 관련 2개 파일·11개 검사, 필수 이름 603개가 통과했다. 이 마지막 변경은 HTTP 오류 정책과 회귀 검사이며 Web 내용은 변경하지 않았다. [전체 E2E](../../.local/validation/automation-runtime/import-drafts-current-e2e.log), [최초 실제 API 실패](../../.local/validation/automation-runtime/import-drafts-first-runtime-api.json), [오류 분류 최종 검사](../../.local/validation/automation-runtime/import-drafts-http-final-tests.log).
- 4317 서버에 Schema 1.16.0·소스 SHA-256 `27a990f58995e6de6a461270a376d91ad20ed4de93689c87df1180d272b5d7f1`을 반영했다. 활성 작업 0건, 기존 3개 콘티의 revision·원본 SHA와 기존 복구 표시 1개가 보존됐다. 실제 패키지 검증 API의 200/400, 누락 JS의 404, 실제 JS/CSS MIME·Build 바이트를 확인했다. 별도 브라우저에서 편집 화면·독립 콘티 폼의 새로고침 복원과 Page 오류 0개·서버 mutation 0개를 확인했다. [최종 실행 파일/원본 검증](../../.local/validation/automation-runtime/import-drafts-runtime-verification.json), [실제 패키지 API](../../.local/validation/automation-runtime/import-drafts-verify-api.json), [브라우저 복원](../../.local/validation/automation-runtime/import-drafts-production-browser.json), [서버 보존](../../.local/validation/automation-runtime/import-drafts-post-restart-preservation.json).

## 자동 제작 시작 설정 복원 — B11 진행 상태

자동 제작 시작 입력을 현재 Run 표시와 분리했다. 프로젝트별 구간 선택·모델·음성/속도·상세도·글자/음량 계획·생성 한도를 브라우저 초안으로 보관한다. 범위 밖 숫자와 빈 음성 이름도 복원하되 공통 실행 검증을 통과하기 전에는 시작할 수 없다. 다른 탭의 입력·Project revision·시작 기준이 바뀌면 비교·선택을 요구하며, 현재 원본에 없는 구간은 재선택해야 한다. 복원만으로 실행·재개·취소·Project 저장을 호출하지 않는다. 이미 진행 중인 작업의 중지/재개와 서버 Snapshot은 그대로 유지한다.

- 서버/웹 타입 검사, 필수 이름 604개(누락·중복·skip·only 0), Web Build를 통과했다. 도메인·서버 실행 로직과 스키마는 변경하지 않았으므로 이전 전체 단위 검사 수치를 이번 새 실행으로 기록하지 않는다.
- 집중 E2E 3개가 통과했다(27.2초). 새로고침 후 선택한 구간·상세도로 실제 임시 실행을 시작해 그림·가이드 음성·글자/음량 계획과 사람 검토 대기에 도달했다. 두 탭의 서로 다른 모델 입력, 잘못된 숫자·빈 음성 보존, 서버 revision 변경 시 시작 차단, 비교만으로 실행되지 않음, 공간 부족 중단/재개를 확인했다. 생성 엔진은 검증용 합성 결과이며 이 검사를 실제 작품 생성 품질 검증으로 해석하지 않는다. [집중 E2E](../../.local/validation/automation-runtime/automation-start-focused-e2e.log).
- 전체 브라우저 회귀 51개가 통과했다(2.4분). [전체 E2E](../../.local/validation/automation-runtime/automation-start-all-e2e.log).
- 4317 서버는 Schema 1.16.0·소스 SHA-256 `bad75e45daebe56e4f9b89f25611a5146d7ab6265883d1806a7e9bb0468395c8`로 반영했다. 재시작 전후 활성 작업 0건, 기존 세 콘티 revision·원본 SHA·복구 표시 1개를 보존했다. 실제 JS/CSS MIME·바이트와 누락 JS의 JSON 404가 일치한다. 별도 브라우저의 실제 `의부증의 늪 — draft-01` 화면에서 모델·한도·31개 구간 선택 복원을 확인했고 Page 오류 0개·제작/저장 mutation 0개였다. 점검용 브라우저 입력은 편집 전 값으로 돌리고 해당 별도 Context를 닫았다. [서버 검증](../../.local/validation/automation-runtime/automation-start-runtime-verification.json), [원본 보존](../../.local/validation/automation-runtime/automation-start-post-restart-preservation.json), [실제 브라우저](../../.local/validation/automation-runtime/automation-start-production-browser.json), [복원 화면](../../.local/validation/automation-runtime/automation-start-production.png).

## 기준 이미지·원본 업데이트 입력 복원 — B11 진행 상태

기준 이미지의 종류·대상·설명과 원본 업데이트 경로·임시 글자 유지 시간을 프로젝트별로 보관한다. 원본 업데이트는 복원된 입력과 과거 검토 결과를 구별하며 검토한 패키지 내용·경로·설정·revision을 적용 직전에 재검증한다. 기준 이미지 File은 복원하거나 다른 대상/버전에 재사용하지 않는다. 현재 원본에 없는 대상과 다른 탭·revision 변경은 다시 검토한다. 복원은 서버 등록·교체·승인을 실행하지 않는다. 화면에 각 입력의 이름과 단위를 표시한다. B11 전체 완료를 의미하지 않는다.

- 관련 서버·원본 변경·HTTP 계약 3개 파일의 109개 검사가 통과했다(22.14초). 검토 후 같은 경로의 원본 내용·경로·유지 시간 변경, 누락/오래된 검토 근거, revision 재사용 거부 및 거부 시 Current·Version 보존을 확인했다. 기존 직접 교체 API도 유지한다. [관련 검사](../../.local/validation/automation-runtime/source-reference-server-final.log).
- 추가 보호 검사에서 승인된 컷의 영향 거부가 500으로 잘못 분류되는 것을 찾았다. `SOURCE_UPDATE_LOCKED_IMPACT`와 다른 이야기의 `PROJECT_MISMATCH`를 입력 오류 400으로 분류했다. 보호 규칙은 유지하며 서버 검사 10개가 다시 통과했다(10.00초). [최초 보호 검사 실패](../../.local/validation/automation-runtime/source-reference-protected-apply.log), [HTTP 최종 검사](../../.local/validation/automation-runtime/source-reference-http-policy-final.log).
- 집중 브라우저 검사는 복원 후 등록/적용 미실행, 잘못된 숫자 보존, 파일 재선택, 경로/설정/원본/revision 변경 뒤 재검토, 실제 적용과 등록을 확인했다. 첫 실행은 기존 이미지 설명에 실제 해상도가 붙는 계약을 테스트 기대값이 빠뜨려 실패했다. 제품 등록 로직은 바꾸지 않고 기대값을 수정한 뒤 1개가 통과했다(4.6초). [첫 실행](../../.local/validation/automation-runtime/source-reference-focused-e2e.log), [집중 재검사](../../.local/validation/automation-runtime/source-reference-focused-e2e-final.log).
- 전체 E2E 52개가 통과했다(2.4분). HTTP 오류 분류의 마지막 검증은 위 서버 검사, 이후 입력란 이름 표시의 검증은 별도 집중 브라우저 검사로 구별한다. 서버/웹 타입, 필수 이름 606개(누락·중복·skip·only 0), Schema 일치와 Web Build를 확인했다. 전체 단위 검사를 이번에 재실행한 것으로 보고하지 않는다. [전체 E2E](../../.local/validation/automation-runtime/source-reference-all-e2e.log).

- 입력란 이름·단위를 표시한 최종 Web Build의 집중 E2E 1개가 통과했다(8.6초). [최종 화면 검사](../../.local/validation/automation-runtime/source-reference-label-e2e.log).
- 4317 서버에 Schema 1.16.0·소스 SHA-256 `f9d0c2f17d581aa99782e01cc1dd61cda313be1231cf305b30e488f49e2cc75c`를 반영했다. 실제 JS/CSS MIME·바이트가 Build와 일치하고 활성 작업은 0건이다. 기존 세 콘티 revision·원본 SHA·복구 표시 1개를 보존했다. 별도 브라우저의 실제 `의부증의 늪 — draft-01`에서 경로·유지 시간·소품 설명 복원, File 미복원과 적용 재검토 요구를 확인했다. Page 오류 0개·서버 mutation 0개이며 점검용 입력은 편집 전 값으로 돌린 뒤 별도 Context를 닫았다. [실행 검증](../../.local/validation/automation-runtime/source-reference-runtime-verification.json), [원본 보존](../../.local/validation/automation-runtime/source-reference-post-restart-preservation.json), [실제 브라우저](../../.local/validation/automation-runtime/source-reference-production-browser.json), [최종 화면](../../.local/validation/automation-runtime/source-reference-production.png).

## Codex 실행 시간 초과 진단

동일한 120초 제한의 합성 상세도 파일럿을 다시 실행하고, 본문 없는 이벤트 시각을 보관했다. 연결은 248ms에 준비됐고 실제 모델은 `gpt-6-astra`, 추론 수준은 `xhigh`였다. 최종 메시지는 98.382초부터 시작됐으며 119.573초까지 701개 메시지 조각을 받았다. 265,655바이트를 수신했지만 `turn/completed` 없이 제한 시간으로 종료했다. 이 실행은 연결 정체가 아니라 응답 생성 중 제한 초과였다. 성공한 상세 콘티로 계산하지 않으며 다른 과거 실패의 원인을 일괄 판정하지 않는다. [진단 요약](../../.local/validation/automation-runtime/storyboard-density-diagnostic-20260911/diagnostic-summary.json), [본문 없는 이벤트](../../.local/validation/automation-runtime/storyboard-density-diagnostic-20260911/events.jsonl).

공통 실행 연결의 시간 초과 오류에 실제 단계·수신량·대기 RPC와 모델 메타데이터를 추가했다. 원문·프롬프트·모델 사고 본문·인증값 제외와 진단 복사본의 독립성, 기존 취소·자식 종료를 검사했다. 관련 3개 파일 16개 테스트가 통과했다(6.43초). 실행 제한이나 재시도 횟수는 늘리지 않았다. [실행 연결 검사](../../.local/validation/automation-runtime/codex-execution-diagnostics-tests.log).

## 글자 정보·본문 근거 입력 복원 — B11 진행 상태

독립 글자의 정보 ID·검토 메모와 미해결 글자 Cue의 근거 종류·대상을 복원한다. revision 변경 뒤 비교·선택 전까지 확정을 차단하고, 사라진 근거를 첫 후보로 바꾸지 않는다. 근거 종류를 바꿔도 대상을 명시적으로 다시 고른다. 실제 Source Update로 컷 ID·원문 근거가 바뀐 뒤 새 컷을 선택하여 같은 Placement/Cue의 입력을 다시 검토했다.

- 최종 관련 E2E 3개가 통과했다(7.5초). 새로고침·컷 이동·서버 변경·원본 교체·누락 대상 보존과 선택 해제, 기존 두 탭의 입력 보존을 확인했다. 검토 및 복원 동안 POST/PATCH/DELETE 0건이며 미확정 권한·정보성 상태가 유지됐다. [최종 E2E](../../.local/validation/automation-runtime/text-review-drafts-final-e2e.log).
- 앞선 검증 자료의 원본 계약 불일치와 원본 교체 후 새 컷 선택·사라지는 체크박스 검사 방식을 수정했다. 제품의 원본 검증·테스트 제한 시간을 완화하지 않았다.
- 서버·웹 타입 검사, Required Registry 608개 누락/중복/skip/only 0개를 확인했다. B11 전체 복원 및 A10 전체 작품 완료로 판정하지 않는다.
- 4317 사용자 서버에 소스 SHA-256 `ff92260dc83f75820abcd57b91e26aa94ff469cca20df5fab22688c96e7bab6a`를 반영했다. JS/CSS 바이트와 MIME, 원본 3개의 SHA/revision 보존, 기존 복구 표시 1개와 활성 작업 0건을 확인했다. 별도 실제 브라우저에서 `의부증의 늪 — draft-01`의 글자 패널 복원과 페이지 오류·서버 mutation 0건을 확인했다. [배포 검증](../../.local/validation/automation-runtime/text-review-runtime-verification.json), [원본 보존](../../.local/validation/automation-runtime/text-review-post-restart-preservation.json), [브라우저](../../.local/validation/automation-runtime/text-review-production-browser.json).

## 검토 패키지 입력·결과 복원 — B11 진행 상태

검토 패키지 입력과 생성 당시 결과를 프로젝트별 브라우저 기록으로 복원한다. 객체 키 순서가 달라져 같은 출력 설정을 변경으로 오인하던 문제를 정규 직렬화로 해결했다. 실제 옵션 변경은 비교를 요구하며 생성 미리보기는 새로고침 뒤 재사용하지 않는다. 완료 경로·파일 해시는 역사적 기록으로 표시하고 현재 파일 확인·Final 승인으로 사용하지 않는다. 생성 응답 유실 복구는 아래 인증·실제 파일 검사로 연결했다. 삭제된 대상의 임시 기록 열람은 아래 보관함으로 연결했다. B11의 전체 폼·원본 변경 통합 검증과 전체 자동화 완료를 이 검사만으로 판정하지 않는다.

- 실제 브라우저 3개 E2E가 8.2초에 통과했다. 내부·외부 패키지 11개 파일 생성, 입력·결과 복원, 빈 버전 보존, 실제 설정 변경 재검토, 기존 폴더 거부, 복원 시 서버 mutation 없음과 원본 보존을 검사했다. 공통 여러 탭 초안 검증도 포함한다. [실행 로그](../../.local/validation/automation-runtime/review-bundle-drafts-final-e2e.log).
- 웹 타입 검사와 Required Registry 608개 누락/중복/skip/only 0개를 확인했다. [타입 검사](../../.local/validation/automation-runtime/review-bundle-drafts-typecheck.log), [Registry](../../.local/validation/automation-runtime/review-bundle-drafts-registry.log).

4317 서버에도 반영했다. Build `9897441be6c1f3c76760bf29e51abbb3b0b9c92e4e46994e85010af07e7c0424`와 JS/CSS 바이트를 대조했으며 원본 3개의 revision·SHA 및 기존 복구 표시 1개를 보존했다. 별도 브라우저의 실제 화면에서 입력 복원·페이지 오류 0건·서버 mutation 0건을 확인했다. [실행 서버 검증](../../.local/validation/automation-runtime/review-bundle-drafts-runtime-verification.json), [브라우저 검증](../../.local/validation/automation-runtime/review-bundle-drafts-production-browser.json).

## 검토 패키지 생성 응답 유실 복구

생성 POST 전 입력·UUID·무작위 복구 키·basis·출력 경로를 브라우저에 보관하고 모든 시도를 유지한다. 복구는 사용자가 해당 시도의 **파일 확인·기록 복구**를 실행할 때만 진행한다. 생성 manifest의 HMAC-SHA256과 요청·입력 결속, 전체 파일 목록·크기·SHA-256, 폴더 identity를 검사한다. 패키지에 복구 키를 넣지 않는다. 원본 저장소나 현재 Build에 의존하지 않으며 후속 편집을 보존하고 과거 생성 결과만 반환한다. 미게시·누락·변조·다른 요청·추가 파일·symlink를 보존하며 자동 재생성하지 않는다. 이전 미인증 패키지와 브라우저 복구 키 유실은 지원하지 않는다.

- 패키지·비식별화·출력 Claim·읽기 전용 원본 보존 회귀 검사 **6개 파일 70개 테스트, 14.02초 통과**. 내부/외부, 미디어 포함, 생성 뒤 원본 변경, 다른 입력/요청/키, 파일과 manifest 해시 동시 변조, 누락·추가·symlink, 이전 패키지 거부, Origin·404·Busy 해제를 포함한다. [회귀 검사](../../.local/validation/automation-runtime/review-delivery-recovery-regression.log).
- 실제 브라우저 **2개 E2E, 8.1초 통과**. 저장 공간 오류 시 POST 0회, 요청 전 기록 보관, 서버가 실제 게시한 뒤 응답 중단, 사용자 revision 변경 후 새로고침·명시적 검증·과거 결과 복원, 생성 POST 총 1회, 원본 후속 편집 보존을 확인했다. [E2E](../../.local/validation/automation-runtime/review-delivery-recovery-e2e.log), [복구 화면](../../.local/validation/automation-runtime/review-delivery-recovery-browser.png). 첫 실행의 임시 Web Build 경로 오류를 확인해 Vite 출력 경로를 저장소 기준 절대경로로 바로잡았다. 제품 동작 실패를 재시도나 Timeout 확대로 숨기지 않았다.
- 서버·웹 타입 검사 통과, Required Registry **619개, 누락/중복/skip/only 0개**. 프로젝트 Schema는 1.16.0을 유지하며 원본 저장 형식은 변경하지 않는다.

4317·55873 서버의 활성 생성/적용 작업 0건을 확인한 뒤 재시작했다. 실행 Build `60b4cbca3d157f04f1a0442f1e06f56bbc8b1017585ddcd16532fd05bd969094`, 실제 JS/CSS 바이트·MIME·복구 API를 대조했다. 사용자 원본 3개와 기존 복구 표시 1개를 보존했고, 격리된 실제 첫 장면 revision 35·SHA-256도 동일하다. [4317 검증](../../.local/validation/automation-runtime/review-delivery-recovery-runtime-verification.json), [격리 검토 서버 보존](../../.local/validation/automation-runtime/review-delivery-recovery-isolated-after.json). 전체 자동화·Final 완료로 판정하지 않는다.

## 문서 검토 요청 재연결 — B11 진행 상태

전송 전에 요청 ID·당시 입력·사용자 수정 기록·폼 반영 여부를 가져오기 flow별 브라우저 기록으로 보관한다. 원본 재확인 후 같은 요청을 읽고, 완료 결과는 실제 서버 입력·현재 파일 검증 뒤 반영한다. 이미 적용한 검토는 근거만 복원하고 현재 값·확인 상태를 유지한다. 첫 응답을 받지 못해도 같은 ID로 접수 여부를 확인하고 명시적으로 재전송한다. 같은 ID·입력의 기존 작업은 다시 실행하지 않는다. B11 전체 복구의 완료를 주장하지 않는다. 상세 계약과 한계는 자동 제작 Design을 따른다.

- 실제 브라우저 8개 검사가 24.6초에 통과했다. 제어한 엔진의 실제 서비스 요청이 실행 중인 상태에서 새로고침·재연결 후 새 요청 0건, 취소 0건, 사용자 수정 후 비운 필드 보호, 반영 결과 재열기, 연결 변경 거부, 원본 해시 변경 거부와 기존 자동 검토·보충 인물 연결·가져오기 복원을 검사했다. [실행 로그](../../.local/validation/automation-runtime/document-review-recovery-suite-e2e.log).
- 서버·웹 타입 검사와 Required Registry 609개 누락/중복/skip/only 0개를 확인했다. [서버 타입](../../.local/validation/automation-runtime/document-review-recovery-typecheck-server.log), [웹 타입](../../.local/validation/automation-runtime/document-review-recovery-typecheck.log), [Registry](../../.local/validation/automation-runtime/document-review-recovery-registry.log).

4317 서버의 Build `895a84b4e31fef730036190c8bb8eb884aba02e92d3b86ac7904dbbf01e59db4`에서 정적 파일·MIME와 원본 3개 SHA/revision 보존을 확인했다. 실제 화면에서 PRJ-007의 문서 검토 후 새로고침·원본 재확인을 수행했고 페이지 오류 0건·모델 시작 0건을 확인했다. 실제 요청 재연결 동작은 위 분리된 서비스/브라우저 E2E 증거로 구분한다. [실행 서버](../../.local/validation/automation-runtime/document-review-recovery-runtime-verification.json), [실제 화면](../../.local/validation/automation-runtime/document-review-recovery-production-browser.json).

요청 접수 전 보관과 동일 ID 재전송 검증:

- 서버 검사 7개(3파일, 3.45초)가 통과했다. 동일 입력의 실행·완료·실패·취소 기록 재사용, 서버 재시작 후 결과 재사용, 기존 기록 바이트 보존, 다른 입력 409, 다른 ID의 실행 경쟁, 불완전 접수 423과 파일 보존, 기존 API 계약을 확인했다. [서버 검사](../../.local/validation/automation-runtime/document-review-identified-unit.log).
- 브라우저 검사 9개가 28.1초에 통과했다. 요청 ID를 실제 POST 전에 보관하고 접수 후 응답 유실 시 새 실행 없이 재연결했다. 서버에 도착하지 않은 요청은 새로고침·원본 재확인 후 같은 ID로 한 번 실행했다. 사용자가 바꾼 화면비와 기존 입력 복원·인물 검토도 보존했다. [브라우저 검사](../../.local/validation/automation-runtime/document-review-identified-e2e.log).
- 서버·웹 타입 검사와 Required Registry 611개 누락/중복/skip/only 0개, diff 공백 검사를 통과했다.

4317 서버에 Build `5aa2f5e7ed1ef2ec49336e6ce6854d572025cd1a6cf90783e82d008b6df2803d`를 반영했다. 신규 ID 지정 시작 경로의 입력 검증, 실제 JS/CSS 바이트·MIME, 기존 3개 Project의 SHA/revision 보존, 활성 작업 0건과 기존 복구 블록 1건 유지까지 확인했다. [서버 반영 검증](../../.local/validation/automation-runtime/document-review-identified-runtime-verification.json).

## 실제 첫 장면 자동 제작 검증 — 그림·음량 생성 후 검토 대기

사용자 `의부증의 늪 — draft-01` revision 0의 원본 스냅샷에서 별도 저장소를 만들고 첫 장면의 SEG-001·SEG-002를 제품의 자동 제작 API로 실행했다. 설정은 현재 Codex 모델, 상세 표현·10초 장기 유지 검토, 기존 12시간 실행 예산이며 모델·재시도·제한 시간을 바꾸어 120초 파일럿을 재시도한 실행이 아니다. 사용자 원본 및 편집 저장소는 변경하지 않는다.

2026-09-11 12:09 UTC에 실제 실행은 `needs-attention`으로 종료됐다. 약 61분 5초 동안 33개 작업 중 29개를 마쳤고 revision 30, 기준 이미지 10개·콘티 그림 16개·가이드 음성 2개를 보존했다. 첫 장면 두 구간은 13컷·19프레임 계획이며, 이후 미작업 구간의 원문 개요도 그대로 남았다. 식탁 와이드 컷의 인물 3명·장소·소품을 포함한 참조 8개가 제품의 5개 한도를 넘어 `CODEX_IMAGE_REFERENCES_LIMIT`로 중단됐다. PID와 해당 HTTP 서버는 종료됐으며 자동 재시작하지 않았다. 원본 3개 Project의 SHA/revision 보존을 확인했다. [종료 결과](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/result.json), [종료 저장본](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/project.json). SEG-001은 revision 13에서 11컷·17프레임 계획, 시간 합계 70,000ms와 인접 컷의 연속성을 확인했다. 단일 그림 표시 10초 초과 항목은 없고 글자 3개의 읽기 시간·배치 검사도 문제 없이 통과했다. 발화 WAV는 47,000~51,630ms에 실측 4,630ms로 배치됐다. 효과음은 파일이 없는 55,000~62,000ms 제안이며 완료 음원으로 취급하지 않는다. 관련 구조·원문 순서·정보 공개 검사에서 오류는 없고 처음 등장한 자산의 이전 상태 미기록에 따른 연속성 경고 7개가 남았다. 모든 프레임은 pending이며 콘티 그림 생성·사람 검토·Final 완료는 아직 아니다. [첫 구간 저장본](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/segment-one-snapshot.json), [첫 구간 검증](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/segment-one-validation.json). [실행 입력과 주소](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/execution.json), [검증한 진행 상태](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/verified-progress.json), [실행 로그](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911.log).

실제 생성 중간 저장본 revision 20에서 첫 장면의 두 구간은 13컷·19프레임 계획이며 6개 콘티 그림 파일이 반영됐다. 실제 그림 3개를 열어 회청색 소매·좌측 영수증·우측 카드 내역과 인물 외형을 확인했다. 정확한 문구는 별도 합성 전이므로 이 원본 그림만으로 글자 표현 완료를 판정하지 않는다. SEG-002는 실측 내레이션 9,182ms 뒤 같은 손·문 상태를 유지하는 26,700ms 그림 구간이 있고 모델도 편집 리듬 검토가 필요하다고 명시했다. 긴 정적 구간·배경 채광과 시간대, 최종 합성 문구 가독성은 사람의 추가 검토 대상이다. [중간 저장본](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/generated-progress-snapshot.json), [내레이션 계획 검토](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/segment-two-plan-review.json).

기준 이미지 중 윤서진의 정면·측면 외형과 빈 아파트 거실/현관을 열어 확인했다. 의상 색과 장소 구조의 기본 참조는 나타나며 실제 연속 컷의 일관성과 연출 검토는 아직 남아 있다. 모델 검토를 사용자 이미지 승인으로 기록하지 않았다. 이 대표 장면 실행과 중간 결과는 전체 작품 자동 제작·Final 출력의 완료 증거가 아니다.

현재 후속 실행은 `review-ready`로 완료됐다. 원본 참조 8개를 4장 보드로 전달해 마지막 식탁 와이드를 생성하고 내레이션 그림 2개·음량 계획 2개까지 자동 적용했다. 기존 실행은 정식 취소 API로 마감하고 수정 Build의 새 실행을 revision 30에서 시작했다. 5개 작업을 약 5분 4초에 끝내 revision 35, 자산 31개·기록 37개가 됐다. 기존 자산 28개의 metadata/실제 바이트, 이미지 연결 16개, 기록 32개와 원본 사용자 프로젝트 3개의 SHA/revision을 보존했다. [후속 실행 결과](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-continuation/result.json).

참조 보드 단위·엔진·프레임 적용 관련 41개 검사(6파일, 17.57초), 서버·웹 타입, Required Registry 615개 누락/중복/skip/only 0개를 확인했다. 8개와 최대 20개 원본의 전체 표시·순서·해시, 5개 이하의 원본 바이트 유지, 준비 취소·손상·용량 제한·위조 배치 거부를 검사했다. 실제 8개 참조의 원본 합계는 13,884,850바이트이며 보드 합계는 7,582,826바이트다. 4장을 각각 열어 원본이 잘리지 않는 것을 확인하고 실제 모델이 사용한 첨부 해시·원본별 위치가 준비 결과와 동일함을 검사했다. [관련 검사](../../.local/validation/automation-runtime/image-reference-boards-unit.log), [실제 참조 배치](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-v1/presentation.json).

첫 장면의 두 구간 13컷·19프레임 전체에 그림이 있다. 0~100,000ms 연속 시간표, Source/Frame/Text 경계를 포함한 36개 시점의 제작자 그림 표시, 실제 자산 31개와 원문·컷·글자 보존을 검사했다. 해당 범위의 구조·공개 검사 차단 0개, 글자 배치·읽기 검사 0개이며 처음 등장한 기준의 연속성 경고는 남는다. 식탁 와이드의 인물 3명·의자 4개·노트북/서류 위치와 보드 번호·격자가 결과에 나타나지 않음을 직접 확인했다. 모든 그림은 pending이며 효과음 WAV 부재·사람 승인·글자 시각 확정 때문에 Final은 false다. [완료 결과 검증과 시각 검토](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-continuation/verification.json).

실제 브라우저 합성 검토에서 `.monitor-frame img`의 공통 불투명 배경이 SVG 글자 뒤의 그림을 가리는 문제를 발견했다. 배경은 그림 레이어에만 적용하도록 범위를 수정했다. 기존 글자 배치 E2E에 실제 합성 픽셀 검사를 추가하여 수정 전 검은 픽셀 `[17,18,15]` 실패, 수정 후 원본 그림 `[32,64,96]` 통과를 확인했다. 관련 브라우저 4개 검사(8.8초), 서버·웹 타입·Registry·diff 공백 검사도 통과했다. [재현 검사](../../.local/validation/automation-runtime/text-overlay-background-before.log), [수정 후 검사](../../.local/validation/automation-runtime/text-overlay-background-e2e.log).

실제 결과 화면의 검토 대기 13컷·19프레임, 13초/65초/73.3초의 실제 그림 로딩, 글자 투명 배경, 그림 편집 이동을 확인했다. 브라우저 오류 0건, 변경 요청 0건이며 디스크 공간 조회 POST는 읽기 전용으로 별도 기록했다. Project revision 35의 바이트를 보존했다. [브라우저 확인](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-continuation/browser-review-fixed.json), [그림·글자 합성](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-continuation/review-fixed-13000.png), [식탁 와이드 검토](../../.local/validation/automation-runtime/prj007-first-scene-automation-20260911/reference-boards-continuation/review-fixed-65000.png). 일반 4317 서버의 최신 Build는 `50ae8c83850ebf9a8a93296e7cc563482567ed5eaa6b8fc63c8f6bdb64348e74`이며 정적 파일·기존 프로젝트 보존과 활성 작업 0건을 재확인했다. 별도 첫 장면 검토 서버는 55873이다. [서버 반영](../../.local/validation/automation-runtime/text-overlay-background-runtime-verification.json). 전체 작품 자동 제작·청취/연출 검토·Final 출력은 여전히 남은 범위다.

## 사라진 편집 대상의 임시 기록 보관함 — B11

제작 현황에서 현재 프로젝트의 컷·프레임·음성·글자·제작 프로필 임시 기록을 열람한다. 현재 엔티티 종류와 ID로 소속을 찾고, 남아 있는 대상은 기존 편집기로 이동한다. 삭제·재구성된 대상은 과거 작성 내용·기준을 보존해 보여 주며 내용 복사·기록 JSON 보관을 제공한다. 기록 JSON은 원본 프로젝트나 미디어를 복원하는 백업으로 사용하지 않는다. 다른 프로젝트·전역 가져오기·생성 영수증과 복구 키는 이 보관함에서 읽지 않는다. 동시 writer는 공통 supersession 계약을 사용하고 손상된 scope는 오류로 분리한다. 기록 조회·복사·다운로드가 서버 저장·승인·새 대상 배정을 실행하지 않는다.

- **2개 파일 7개 테스트, 635ms 통과**. 사라진 대상, 이전 알 수 없는 항목, 다른 프로젝트·복구 키 제외, 엔티티 종류가 다른 동일 ID, 여러 writer와 명시적 대체·후속 수정, 손상된 JSON·기준·과도한 중첩, 읽기 전후 브라우저 원본 보존을 확인했다. [기능 검사](../../.local/validation/automation-runtime/browser-draft-archive-unit.log).
- **3개 E2E, 7.6초 통과**. 실제 편집 화면에서 미저장 연출·프레임을 작성한 뒤 서버의 컷·프레임 ID를 재구성했다. 새로고침 후 과거 기록 2개 열람, 원문 기준 비교, 실제 클립보드 복사·JSON 다운로드, 다른 탭의 동시 기록 반영, 다른 프로젝트 제외, 남아 있는 프레임 편집기 이동, 서버 mutation 0건·최신 프로젝트 보존을 확인했다. 390px 화면의 가로 넘침 0건·페이지 오류 0건을 확인했다. [E2E](../../.local/validation/automation-runtime/browser-draft-archive-e2e.log), [모바일](../../.local/validation/automation-runtime/browser-draft-archive-mobile.png), [데스크톱](../../.local/validation/automation-runtime/browser-draft-archive-desktop.png).
- 서버·웹 타입 검사 통과. Required Registry **624개, 누락/중복/skip/only 0개**. 기존 저장·승인 API 및 Project Schema 1.16.0은 유지한다.

4317·55873 서버의 활성 작업 0건을 확인하고 Build `23656f8bc400b917704926703bc08a4ef49dffe96efe036c69e9dd745b27a4d5`로 재시작했다. 실제 JS/CSS 바이트·MIME와 보관함 문구를 확인했으며 사용자 원본 3개·기존 복구 표시 1개와 실제 첫 장면 revision 35·SHA-256을 보존했다. [4317 검증](../../.local/validation/automation-runtime/browser-draft-archive-runtime-verification.json), [첫 장면 보존](../../.local/validation/automation-runtime/browser-draft-archive-isolated-after.json). 전체 자동화 및 실제 작품 전체 검증의 완료 근거로 확대하지 않는다.

## 검토 재생 속도 — B05

시간순 재생과 개별 음원 청취에 프로젝트별 검토 속도를 연결했다. 원본 시간표·WAV·Project revision·사람 승인·Final 검사는 유지한다. 지연 로딩 음원을 원본 playhead에 맞추며 속도 변경에서 이전 timer와 Audio 수명을 종료하고 현재 위치에서 이어간다. 저장값 복원은 재생을 시작하지 않는다. 손상 기록의 재선택과 브라우저 저장 실패의 현재 화면 한정 적용을 명시한다. 구체적인 지원 값·계산·보존 범위는 Design을 따른다.

- 기능 및 기존 음량·수명 검사 3개 파일 51개 통과(11.02초). 음량·페이드가 원본 시각을 따르는지, 배속별 종료 deadline과 로딩 지연 보정·프로젝트별 저장/손상 거부를 확인했다.
- 신규 브라우저 검사 2개 통과(9.5초). 실제 PCM의 로딩을 지연한 상태에서 0.5→2배 변경, 오디오 위치 오차 200ms 미만, 벽시계 대비 재생 위치, Cue 종료, 그림 전환·글자 시점을 검사했다. 속도 복원·프로젝트 분리·개별 청취·손상 기록 재선택·저장 오류를 확인했다. 서버 mutation 0건과 원본 Project 바이트 보존을 검사했다.
- 기존 실제 Audio 7개를 3회 반복하여 21개 통과(48.6초). 실제 WAV metadata·디코딩·탐색·Cue 종료·Project 전환·Monitor 종료·첫 RAF 시각 계약을 유지했다. 기존 제작자 그림 검토/Final 차단 1개 통과(4.0초).
- 서버/Web 타입 검사, Required Registry 629개(누락·중복·skip·only 0), diff 형식 검사 통과. 격리 Web 빌드 통과; 기존 500kB 번들 경고는 유지된다.
- 증거: `.local/validation/automation-runtime/review-speed-{unit,e2e,audio-regression,producer-regression,types,web-types,registry,web-build}.log`, `review-speed-desktop.png`, `review-speed-mobile.png`. 390px 화면에서 Monitor 가로 넘침 0px와 조작 영역을 확인했다. 최초 E2E의 정확한 label 탐색 실패를 select의 명시적 접근성 이름으로 수정하고 대상 프로젝트를 명시 선택해 재검증했다.

- 4317과 별도 검토 55873 서버를 Build `e035f7293301f2d512ea63f974e9fc0ec59b6c70909ac9967285726452c78405`로 반영했다. 실제 JS/CSS 바이트·MIME, 필수 경로와 원본 프로젝트 3개 SHA/revision을 대조했다. 기존 복구 차단 1건을 유지하며 활성 생성 0건이다. 첫 장면은 revision 35, SHA `203ab4dc7b82bef4a3490b93af9876b17bf20d28487c5adf53f430b1fbe27fae`, review-ready를 유지한다. 증거: `review-speed-{pre-restart,post-restart}-*.json`, `review-speed-runtime-verification.json`, `review-speed-isolated-{before,after}.json`.
- 실제 첫 장면의 47초 발화를 2배속으로 재생했다. 기록 시점 원본 playhead 47,899ms, 미디어 770.982ms와 예상 offset 899ms의 차이 128.018ms, pitch 유지·PCM decoder 준비 완료를 확인했다. 그림 표시와 정지 뒤 Audio 제거, page error 0·Project mutation 0·바이트 보존을 검사했다. 자동 제작의 읽기 전용 공간 조회 POST 1건은 변경 작업과 별도로 집계했다. `review-speed-actual.{json,log,png}`에 기록했고 실제 그림 화면을 확인했다.

이 검증은 재생 속도·동기화의 기술 검증이다. 실제 작품 전체의 낭독·호흡·음질 검토나 B05 전체 완료로 해석하지 않는다. 개별 음색·발음과 전체 청취 범위는 남아 있다.

## 화자별 합성 음성 설정 — B05

실제 발화 ID별 음성 이름·말하기 속도를 시작 초안과 실행 Snapshot에 연결했다. 구간 생성·수동 컷 보완·캐시 재개가 같은 선택을 사용하며, 실제 생성 기록과 자산 설명에 목소리를 남긴다. 기존 음원·시간표·원문·사람 승인은 보존한다. 공통 음성과 화자 미지정 발화, 사용하지 않는 음성, 보호된 발화의 범위는 Design의 계약을 따른다. 자동 음색 배정·발음 보완·선택 음성 재생성과 전체 청취는 아직 남아 있으며 B05 전체 완료가 아니다.

- 관련 7개 파일의 서로 다른 단위·실행 검사 39개를 확인했다. 선택 구간·화자·설치 목록·중복/없는 ID·잘못된 결과 음성·이전 Run 보존·캐시 재개·수동 컷 보존을 검사했다. 실행 통합 23개(20.71초), 기존 엔진·캐시·미등록 발화 15개(4.97초), 추가 선택 범위를 포함한 새 계약 8개(7.39초, 앞 검사와 7개 중복)다. 증거는 `speaker-voices-{integration,regression,scope-validation}.log`다.
- 배포 웹 빌드의 브라우저 검사 3개 통과(9.2초): 언어별 실제 후보·인물별 입력·새로고침 복원·실행 payload·설치되지 않은 이름·현재 원문에 없는 보관 화자 선택과 명시 제거·기존 탭 충돌 보존. `speaker-voices-e2e-final.log`, `speaker-voices-{desktop,mobile}.png`에 기록했다. 390px에서 음성 설정 영역의 가로 넘침이 없으며 두 화면을 시각 확인했다.
- 초기 엔진 동시 검사에서 1.5초 제한 시간 초과 2개를 관측했다. 제한 시간을 늘리지 않고 동일 엔진 단독 4개 및 이후 기존 엔진·캐시·미등록 발화 묶음 15개 통과를 확인했다. 최초 E2E의 원본 Dataset 직접 변경은 기존 보존 검사에 거부돼, 없는 화자가 남은 브라우저 초안 사례로 수정했다. 현재 기준으로 직접 편집하면 별도 기준 선택이 사라지는 동작에 맞춰 테스트 순서를 고쳤다. 실패 로그를 삭제하지 않았다.
- 실제 macOS 목록 177개/한국어 9개를 읽고 같은 한국어 원문으로 Yuna 180 WPM, Eddy 160 WPM을 합성했다. 원문 해시가 같고 WAV는 서로 다른 해시이며 각각 4,056ms/4,807ms, 48kHz mono PCM16, 비무음·full-scale sample 0을 확인했다. 합성·검사 경과는 965ms/731ms다. `speaker-voices-actual.{json,log,mjs}`와 `speaker-voices-actual-{0,1}.wav`에 보존했다. 이것은 음색 연기·언어 적합성에 대한 청취 품질 판정이 아니다.
- 서버/Web 타입·Schema 일치·Required Registry 639개(누락·중복·skip·only 0)·diff 검사 및 웹 빌드 통과. `speaker-voices-{types,web-types,schemas,registry,diff-check,production-build}.log`에 보존했다.
- 4317 및 독립 검토 55873을 Build `5813eafb28017d9ecfefc7c5cf3ca3a897b7ae96151c37f00058d58a94327c39`로 반영했다. 음성 API·실제 JS/CSS·MIME와 원본 3개 SHA/revision 보존, 활성 생성 0건을 확인했다. 기존 복구 차단 1건과 첫 장면 revision 35/SHA `203ab4dc7b82bef4a3490b93af9876b17bf20d28487c5adf53f430b1fbe27fae`를 유지한다. `speaker-voices-{pre-restart,post-restart}-*.json`, `speaker-voices-runtime-verification.json`, `speaker-voices-isolated-{before,after}.json`이 근거다.
- 실제 4317의 `의부증의 늪 — draft-01`에서 발화 화자 8명/60개 발화와 한국어 후보 9개를 확인했다. page error 0, 원본 변경 0, 읽기 전용 공간 조회 POST 1개다. `speaker-voices-live-ui.{json,log,png}`와 실제 화면을 확인했다. 모든 음성을 Yuna로 단정하던 안내도 자동 실행 설정과 개별 대기 요청의 공통 음성을 구분하도록 수정했다.

## 독립 8문서 전체 실행과 실제 자산 선택 검증

`tests/fixtures/documents`의 공개용 합성 스토리 전체(20초·2장면·2구간·원문 4개)를 설치된 Codex App 모델·이미지 생성과 macOS 가이드 음성으로 실행했다. 인물 연결·25fps·44.1kHz·9:16·시작 타임코드 01:00:00:00은 fixture의 명시적 제작 설정을 사용하고, 제작 방식과 그림 스타일은 미정에서 자동 계획했다. 자막·내레이션·패널이 없는 입력을 유지했다. 원본 제작 프로젝트를 외부 모델에 전달하지 않았다.

- 실행 `f099d2b3-acd8-4757-bf20-c4d96596dc88`은 실제 29분 7초 동안 16개 작업을 끝내 `review-ready`가 됐다. 저장 revision 16에는 3컷·그림 프레임 4개·기준 이미지 6개·실측 가이드 음성 2개가 있다. 모델은 `gpt-6-astra`다. 모델 보정은 첫 계획에서 각 구간 1회였고 이미지 생성 시도는 10회다. 비용은 측정하지 않았다.
- Dataset·Source·handoff를 최초 저장본과 대조했고, 고정 구간의 컷 합계·원문 연결·모든 이미지/WAV의 실제 파일 해시와 디코딩·Asset Integrity를 확인했다. Draft CSV/PDF는 생성됐고 사람의 컷·그림 승인이 없어 Final CSV/PDF는 거부됐다. 실제 브라우저에서 프레임 4개를 각각 해당 시각에 표시하고 화면을 확인했다. 새로 생성한 결과에 사람 승인을 기록하지 않았으며 실제 청취 검토는 수행하지 않았다.
- 실행 과정에서 모델이 제작 자원 ID를 `propIds`·연속성 `assetId`에 사용하는 오류를 확인했다. 현재 출력 Schema는 선택 구간의 실제 자산 ID만 열거하며 소품과 인물·장소의 종류도 구분한다. 입력에 제작 자원→실제 자산 대응을 명시하고, 오류는 받은 ID와 허용 자산을 함께 표시한다. 서버의 별도 참조 검사는 유지한다. 같은 실제 입력과 측정 음성을 이용한 후속 모델 검증에서 두 구간 모두 첫 응답이 Schema와 후보 컴파일을 통과했다(각 1회 호출·추가 보정 0회, 약 90초/161초). 응답은 별도 검증 후보로 보존하고 저장 콘티를 다시 생성하거나 덮어쓰지 않았다.
- 회귀 검증은 단위 검사 2개 파일·16개 및 자동 실행 E2E 7개가 통과했다. 실제 Audio E2E 7종×3회도 21개 전부 통과했다(50.7초). 서버·웹 타입, Schema 일치와 Required Registry 683개(누락·중복·skip·only 0)도 통과했다. 실제 모델 검증의 최초 로컬 스크립트는 BuildManifest를 Provenance로 변환하지 않아 컴파일 인자 오류가 났다. 이 스크립트를 바로잡은 뒤 원래 모델 응답을 재호출 없이 컴파일했고 두 구간 모두 통과했다.
- 4317 및 기존 첫 장면 검토용 55873 서버를 대기·적용·실행 중 작업이 없는 상태에서 재시작했다. 두 서버의 실제 Build는 source `248e8a21df23213f5c79d68ec58b4b579f989923938e2553c90c38ea7173ecb8`, contract `a7197c53c29b04fe7a58aa9028b94a7082b2142a73857a19ab9b3833fefed0b3`, Project Schema 1.19.0으로 일치한다. 기존 실제 저장본 4개는 revision과 파일 SHA-256이 전부 유지됐으며 기존 복구 차단 1건도 변경하지 않았다. 합성 결과를 보존한 52029 검토 서버는 별도로 유지했다. 이 변경을 원격 PR·CI·최종 머지 완료로 보고하지 않는다.

이 실행 당시 문서의 ‘물 따르는 소리’·‘물 흐르는 소리’는 환경 음향 Instruction으로만 보존되고 Audio Cue와 Final 검사에 연결되지 않는 누락이 드러났다. 따라서 이 실행은 2개 발화의 자동화 및 시각 초안 검증이며, 원문 음향 전체를 포함한 완성 콘티나 Final 검증이 아니다. 이 누락의 보완과 실제 검증 범위는 다음 B07 절을 따른다.

증거는 `.local/validation/automation-runtime/document-whole-story-20260912/`의 실행·관측·최초/최종 Project·`verification.json`·`ui-verification.json`·프레임 화면 4개·Draft CSV/PDF, `reference-scope-real-20260912/`의 실제 입력/응답/컴파일 후보·`verification.json`, `reference-scope-{tests,e2e,audio,typecheck,web-types,registry,schemas}.log`와 `reference-scope-runtime.json`에 보존했다. 기존 실제 프로젝트 4개의 저장본과 이 합성 콘티를 수정하지 않았다.

## 음악·환경 음향 지시의 자동 판정 — B07

원문의 음악·환경 음향을 미판정 상태로 빠뜨리던 경로에 자동 작업과 Final 검사를 연결했다. 모델은 지시마다 명시적 부재, 기존 음향 연결 또는 별도 준비 트랙이라는 결론과 근거를 남긴다. 대본 Unit을 추가하거나 음향 설명을 낭독하지 않는다. 다음 구간 계획·편집 보완 요청에도 판정, 트랙별 실제 원문과 정보 ID를 전달한다. 상세 계약은 Project 1.20.0 Design을 따른다.

- 기능/API/실행 검사 2개 파일의 13개 테스트에서 원문 보존, 기존 Cue 재사용·발화 대체 거부, 별도 트랙 생성, 실제 PCM 준비·배치·재생·출력, 원본 변경, 1.19 읽기, 수동/보호 입력 보존과 별도 확인을 검증했다. 후속 모델 입력 보완 뒤 해당 자동 계획 검사 6개를 다시 통과했다. 근거는 `audio-instructions-{boundaries,executor,context-tests}.log`다.
- 실제 UI 검사 1개가 통과했다(8.1초). 제안 근거·음향 없음/필요 표시·별도 확인·WAV 준비·재열기·미저장 근거 보존·Final 차단을 확인했다. 기존 자동 실행 E2E 7개(24.2초)와 실제 Audio 7종×3회 21개(1.1분)도 통과했다. `audio-instructions-{e2e,execution-e2e,real-audio}.log`가 근거다. 테스트 음원은 기술 검증용 PCM이며 실제 물소리의 청취 품질 증거가 아니다.
- 공개용 합성 8문서 스토리의 두 구간을 실제 `gpt-6-astra`로 검토했다. 각각 23.2초/28.4초, 추가 보정 0회이며 4개 지시를 음악 없음 2개·별도 WAV 필요 2개로 판정했다. 결과는 별도 검증 후보로 보관하고 기존 합성 콘티를 변경하지 않았다. 원문 바이트 보존과 1.20 재읽기를 확인했다. `audio-instructions-real-20260912/{verification,opening,finish,project}.json`이 근거다. 이 모델 검증은 후속 입력 전달 보완 이전 Build의 기록이며 사람 확인·음원 생성·Final 완료가 아니다.
- 전체 검사에서 기능 회귀를 수정한 뒤에도 화자 음성 재개 검사의 5초 초과가 남았다. 실제 동일 저장 흐름은 단독 4.6초, 동시 2개 실행에서는 각각 약 6.0초로 재현됐다. CPU 프로파일의 대부분은 I/O 대기였다. 테스트 파일 Worker를 1개로 제한하고 기존 5초 제한·재시도 횟수·fsync·전체 검사를 유지했다. `speaker-restart-{profile,concurrent-a,concurrent-b}.log`와 `speaker-restart.cpuprofile`에 측정을 보존했다. 최신 전체 검사 결과는 `audio-instructions-check.log`에 기록한다.
- `npm run check`에서 111개 파일·1,503개 검사(454.59초), 서버/Web 타입·Schema 일치·Required Registry 690개(누락·중복·skip·only 0)·웹 빌드가 통과했다. 전체 E2E 67개도 통과했다(3.4분). 이 통합 검사는 다음 실제 모델 배치에서 발견한 공통 출력 관계 수정 이전의 증거다. 해당 수정 이후 검증은 아래 기록과 구분한다.
- 실제 모델로 준비된 음향을 배치하면서, 대본 Unit만 인정하는 공통 출력 관계 검사 때문에 정보 ID가 있는 Instruction 음향을 거부하는 오류를 발견했다. 재생·내보내기도 같은 `AudioSource`를 사용하도록 수정했다. 관련 4개 파일·149개 검사를 통과했고, 연결하지 않은 정보와 공개 하한 이전의 출력은 계속 거부됨을 확인했다. `audio-instructions-emission-{before,after,verified}.log`는 최초 재현·검토 중간값·검증 결과다.
- 수정 후 두 구간의 실제 Codex 배치를 다시 수행했다. 각각 35.3초/21.8초, 추가 보정 0회이며 준비한 1초 PCM을 0~1초와 9.2~10.2초에 배치했다. 두 번째 음향은 `document-information:document-unit-26`의 공개 조건을 따랐다. 기존 컷·그림·발화·글자·모든 자산·음향 판정은 그대로였고 새 파일 쓰기 0건이었다. 모델 응답·입력·후보·검증은 `audio-instructions-placement-real-fixed-20260912/`에 보존했다. 이전 실패 결과도 `audio-instructions-placement-real-20260912/`에 남겼다. 이 검증 후보는 원래 콘티에 적용하지 않았으며 검사 PCM을 실제 물소리의 품질 증거로 취급하지 않는다.
- 공통 출력 관계 수정 후 전체 111개 파일·1,503개 검사(443.52초), 서버/Web 타입·Schema·Required Registry 690개와 빌드가 통과했다. 음향 지시/자동 실행 E2E 8개(30.6초), 실제 Audio 7종×3회 21개(47.2초)도 통과했다. Audio 첫 실행은 샌드박스의 Chromium 시작 거부로 종료되어 로컬 브라우저 실행 권한으로 같은 명령을 다시 검증했다. `audio-instructions-final-{suite,e2e,audio,audio-verified,types,web-types,build}.log`가 근거다.
- 서버 4317·55873·52029를 같은 Source Build `b3bc36ad144fa659434df8f3a8375b65bf288ce11081ef69a826fee3fd5df9e2`, Schema 1.20.0으로 재시작했다. 저장본 4개의 실제 바이트·revision은 유지됐으며 자동 제작을 재개하지 않았다. 기존 음악·환경 음향 지시는 미판정 검토 항목으로 표시된다. 실제 4317 화면의 음성 탭에서 지시·출처·판정 입력을 확인했고 페이지 오류는 0건, 응답 HTML은 배포 파일과 일치했다. `audio-instructions-runtime-post.json`, `audio-instructions-live-ui.json`, `audio-instructions-live-desktop.png`가 근거다.

검증 증거는 `.local/validation/automation-runtime/` 기준이다. 효과음·음악 생성 제공자는 추가하지 않았다. 필요한 실제 WAV는 제작자가 준비하며 자동화는 준비한 파일의 배치와 검토를 이어간다. 이 기능으로 전체 작품의 음향·연출·Final 검증을 완료했다고 판정하지 않는다.

## 기본 콘티 완료와 선택 음성

사용자가 확정한 완료 범위는 그림·연출·시간·대사·음향 지시다. 신규 자동 실행은 `instructions-only`를 추천하며 음성 설치·배정·합성·음량 계획을 요구하지 않는다. `guide-voice`를 선택하면 기존 가이드 음성 생성과 실측 배치·재생을 사용한다. 이전 실행은 저장한 설정과 해시를 보존하며 기존 음성 제작 계약으로 재개한다.

- 음원 없는 Cue는 제안 시각으로 남는다. 원문·시간·Source Anchor·정보 공개·최초 공개 순서를 검사하고, 실제 음원 없이도 검토를 마친 그림 콘티를 Final PDF·CSV로 출력한다. 파일·실측·재생 문제는 `optionalAudioIssues`로 분리하며 재생 가능한 음원 수를 부풀리지 않는다. J-cut의 인접 구간 관계와 기존 공개 하한은 유지한다.
- PDF·CSV에는 정확한 대사와 효과음·음악 지시를 넣고 제안 시각과 실측 시각을 구분한다. 컷·그림·글자 및 음향 지시를 자동으로 사람 승인 상태로 바꾸지 않는다. 설정 화면의 ‘음성 제작’ 선택과 검토 화면의 ‘선택 음성 재생 점검’으로 두 흐름을 구분한다. 콘티 전용 실행에서 미완성 음성 입력을 보존하되 가이드 음성으로 전환하면 해당 입력을 검사한다.
- 음성 엔진을 호출하면 실패하도록 만든 합성 프로젝트에서 컷 계획·실제 PNG 검사·검토·Final PDF 생성과 CSV 원문 보존을 확인했다. 파일 없는 재생은 계속 차단되고, 발화 순서 역전·공개 하한 위반·Source Anchor 불일치도 차단했다. 이 검사는 자동화 연결과 출력 계약 검증이며 새 실제 모델의 작품 전체 품질 검증이 아니다.
- 전체 검사 중 파일을 수정한 실행에서는 새 순서 검사가 이전 모듈에 대해 실행돼 1건 실패했다. 현재 파일을 고정한 후 관련 검사를 다시 통과했고 전체 검사를 재실행했다. 상세 증거는 `optional-audio-check.log`, `optional-audio-final-order.log`, `optional-audio-boundaries-verified.log`에 보존한다. 이전 B07 절의 실제 WAV 필수 표현은 이 완료 범위로 대체한다.

검증 결과와 실행 반영:

- 전체 `npm run check`: 112개 파일·1,507개 검사 통과(424.60초), 서버/Web 타입·Required Registry 690개(누락/중복/skip/only 0)·JSON Schema·웹 빌드 통과. 마지막 목록의 차단 수와 안내 문구 수정 뒤 타입 검사를 다시 통과하고 전체 브라우저 검사에서 확인했다. 근거는 `optional-audio-check-verified.log`다.
- 전체 브라우저 68개 중 67개가 첫 실행에서 통과했다(3.6분). 나머지는 선택 음성 설정이 기본값과 달라진 상태에서 원본 revision 변경 후 재검토를 생략한 테스트였다. 원본 변경 보호를 유지하고 ‘작성한 값을 현재 기준으로 검토’를 거치는 테스트로 수정한 뒤 가이드 음성 3개 검사가 모두 통과했다(9.7초). 기본 콘티의 실제 HTTP 실행·그림 생성·음성 호출 0건·원문 시각 검토·목록 차단 수, 빈 음성 입력을 유지한 모드 전환, 선택 음성 생성·배치·WAV·재생 흐름을 확인했다. `optional-audio-all-e2e.log`, `optional-audio-speaker-verified.log`에 결과를 보존했다.
- 서버 4317·55873·52029는 Source Build `50eaa7478f34e41f1dab61d04b79fa5b6f648e9c888c6f2353afc422591b070a`, Schema 1.20.0이다. 진행 작업이 없음을 확인한 뒤 정상 종료·재시작했으며 새 자동 실행을 만들지 않았다. 저장본 4개는 실제 바이트 SHA-256과 revision을 유지했다. 세 서버 모두 신규 추천은 `instructions-only`다. `optional-audio-runtime-{pre,post}.json`이 근거다.
- 실제 52029 화면의 기본 선택과 숨겨진 음성 입력, 4317 화면의 별도 재생 점검을 읽기 전용으로 확인했다. 페이지 오류와 자동 실행 요청은 0건이며 HTML은 배포 파일과 일치했다. `optional-audio-live-ui.json`과 `optional-audio-live-{start,review}.png`에 보존했다. 최초 검증 스크립트는 재생 문제가 0건인 52029에서도 점검 목록을 기대했고, 다음 실행은 페이지 이동 후 첫 응답 본문을 읽으려다 실패했다. 대상 화면과 응답 읽기 시점을 수정한 최종 검증은 통과했다.

선택 음성 안내까지 적용한 현재 상태:

- 음향 지시 검토 화면의 ‘WAV 필요’와 필수 등록 안내를 수정했다. 음향 지시의 필요 여부·원문·시각 검토는 유지하고, 실제 음원은 듣고 싶을 때만 등록하도록 표시한다. 모델의 음향 판정 프롬프트도 `required`가 콘티 지시의 필요 여부임을 명시한다. AGENTS·Design·README의 이전 음원 필수 설명을 현재 완료 기준에 맞췄다.
- 서버/Web 타입, 관련 단위 검사 3개 파일·17개, 웹 빌드를 통과했다. 기본 콘티 자동 제작 E2E와 선택 음원 등록·검토·새로고침 E2E를 확인했다. 후자는 첫 실행에서 저장 응답 전에 직접 Store를 읽어 `PROJECT_BUSY`가 발생했다. 업로드의 201 응답 후 revision과 원본 보존을 확인하도록 테스트 경합을 수정한 뒤 통과했다. 오류를 숨기는 재시도나 저장 잠금 정책 변경은 하지 않았다. 증거는 `optional-audio-guidance-e2e.log`와 `optional-audio-guidance-e2e-verified.log`다.
- Source Build는 `ac6ff33fc2a543fe949b763da2ea9b66517e2ffa2beaeaa419936a220282d3b5`, 생성 계약은 `9a373f0be8f2ae9aa3b28f23667c6f46be36de772c30884a40029f60966233aa`다. 새 생성 실행 없이 세 검토 서버를 정상 재시작했다. 실제 서버와 저장본 보존 검사는 같은 `optional-audio-runtime-{pre,post}.json`의 현재 값으로 확인한다. 전체 실제 모델의 새로운 작품 생성 품질을 이 안내·경계 검사로 대신하지 않는다.

## 실제 기본 콘티 자동 제작 검증

공개용 합성 8문서 스토리 `plant-doc-demo`의 전체 20초를 `instructions-only`로 새로 실행했다. 원문·제작 설정·기준 그림·구간 계획·콘티 그림을 실제 Codex App으로 처리했다. 실행 `929e9992-d8c7-44a6-80c0-0348950fc653`은 17분 12.5초에 16개 작업을 마쳐 검토 대기로 종료했다. 생성 당시 Source Build는 위 안내 수정의 `ac6ff33f…`이며 이후 세션 정리·미리보기 변경을 이 실행의 생성 Build로 주장하지 않는다.

- 결과 revision 16: 2구간·3컷·5프레임, 기준 그림 6개를 포함한 이미지 자산 11개다. 실제 음성 자산·음성 생성 Record는 0개이며 대사 2개와 원문 환경 음향 지시 2개를 계획 시각으로 배치했다. 배경 음악 없음 2개도 명시적으로 판정했다. 원문 Dataset·Source Snapshot·Handoff를 보존하고 컷 시간의 공백·겹침과 Source 미확정이 없음을 검사했다.
- 모든 실제 이미지의 해시·디코딩과 저장 감사, Draft PDF·CSV 응답 200을 확인했다. Final은 미승인 컷 3개·그림 5개·음향 지시 판정 4개 때문에 409다. `AUDIO_NOT_MEASURED`는 선택 재생 점검에만 남고 필수 차단 목록에는 없다. 사람 승인을 자동 변경하지 않았다.
- 최초 검증 스크립트는 음향 지시를 새 트랙으로 계획하는 계약을 누락해 Cue 수를 기존 대사 2개로만 기대했다. 기존 대사 ID·Unit·종류 보존과 새 환경 음향 Cue 2개의 실제 원문·판정 결속을 각각 확인하도록 수정한 뒤 통과했다. 최초 실패 로그도 보존했다.
- 브라우저에서 5개 프레임을 실제 시각으로 탐색하고 이미지 디코딩·표시·원본 보존·페이지 오류 0건을 확인했다. 이 과정에서 선택 음원 부재를 미리보기의 전체 `OUTPUT BLOCKED`로 표시하는 문제를 발견했다. 현재는 그림 아래에 공개 가능한 대사·음향 지시를 표시하고, 음원 부재는 접힌 선택 재생 안내로 구분한다. 연결·시각·공개 조건 위반 내용은 표시하지 않는다. 같은 5프레임 UI 검증을 다시 통과했다.
- 그림의 손·받침·물 비우기 단계는 확인했으나 세부 물 양 변화와 전체 연출 승인은 제작자 검토 대상이다. 이 짧은 합성 사례를 실제 작품 전체 품질·Final 승인으로 해석하지 않는다. 기존 저장본 4개의 바이트와 revision도 그대로다.

증거: `.local/validation/automation-runtime/document-instructions-only-20260912/{verification,ui-verification}.json`, 같은 폴더의 `frame-*.png`와 `before-monitor-guidance/`, `document-instructions-only-{verify,verify-fixed,ui-fixed}.log`, `optional-audio-monitor-preservation.json`.

## 실행 세션 정리와 선택 재생 회귀 검증

- 실제 PRJ-008 자동 제작의 기준 이미지 작업 `bd24eb3e-b6d3-438e-8c62-214a6cd6d994`를 읽기 전용으로 관찰했다. 서버의 직접 자식인 설치 Codex 프로세스와 그 임시 폴더의 dev/ino·정규 경로를 확인한 뒤 약 39초 후 자식 종료·해당 폴더 소실을 확인했다. 같은 Job의 완료 기록을 추가 대조했고 전체 Worker는 계속 실행됐다. 관찰자가 실행·종료·삭제·승인을 수행한 횟수는 0이다. 이는 정상 생성 한 건의 실제 자원 정리 증거이며 비정상 종료·외부 폴더 교체와 전체 작품의 수명 검증을 대신하지 않는다. 근거는 `.local/validation/automation-runtime/prj008-whole-story-20260912/session-lifecycle-verification.json`과 `prj008-session-lifecycle.log`다.
- 세션 임시 폴더가 다른 폴더·심볼릭 링크로 교체되거나 사라지면 기존 경로를 재귀 삭제하지 않고 `CODEX_WORKSPACE_CHANGED`를 반환하도록 수정했다. 변경 전 재현은 교체된 폴더를 지우고 성공으로 끝났다. 수정 후 폴더 identity·정규 경로·존재 검사를 통과한 자기 폴더만 정리한다. 관련 3파일·19개 검사가 통과했다. 이 검사는 실제 생성 자산의 보관·삭제 정책과 구분한다. `workspace-ownership-{before,verified}.log`가 근거다.
- `npm run check`는 112파일·1,508개 검사(426.75초), 서버/Web 타입·Required Registry 691개(누락·중복·skip·only 0)·Schema 일치·웹 빌드가 통과했다. 이 결과는 미리보기의 선택 재생 안내와 아래 배속 수정 이전이다. 증거는 `workspace-ownership-check.log`다.
- 전체 E2E 68개 중 67개가 통과했고, 나머지에서 재생 중 배속 변경이 실제 Audio 객체에 반영되지 않는 오류를 발견했다. 타임라인은 빨라져도 기존 Audio는 이전 속도를 유지했다. 현재는 재생 중인 동일 Audio의 속도와 종료 타이머를 함께 갱신하며, 취소된 이전 타이머는 새 재생을 끊지 못한다. 오류를 테스트 재시도로 숨기지 않았다.
- 수정 후 관련 단위 3파일·51개(13.79초), 기본 콘티 미리보기·실제 지연 음원의 배속 전환·개별 재생·기존 그림 검토 E2E 4개(19.2초)가 통과했다. 서버/Web 타입·빌드도 통과했다. 미리보기는 대사·음향 지시를 제 시각에 표시하고 Cue 종료 시 제거하며 원본을 변경하지 않는다. 증거는 `optional-audio-current-e2e.log`, `optional-audio-monitor-{tests,e2e,root-types,types,build}.log`다.

## 다음 통합 작업

실제 PRJ-008의 25분·24구간·208개 원문·155개 글자에 기본 콘티 자동 제작을 실행하고 있다. 최초 실행은 음향 검토 23개 작업 뒤, 빈 환경 음향 표시가 그대로 트랙 본문이 되는 문제를 발견해 중지했다. 모델이 찾은 실제 소리를 생략하지 않고 같은 구간 지문의 정확한 인용·정보 공개 조건을 연결하는 Project 1.21 `sourceEvidence`를 추가했다. 수정 직후 실모델 응답 Schema가 선택 필드를 거절한 오류는 저장본의 선택 필드와 모델 응답의 필수 필드를 분리해 해결했다. 두 중지 실행과 원본 파일·생성 이력은 보존한다.

현재 실행 `cb97bf3b-ad21-4d9b-806f-0ef6d12f44fd`은 revision 23에서 이어져 음향 검토 4개 작업을 마쳤다. revision 27에서 문제의 3개 연결에 실제 출입문·공동 알림·문 두드림/복도 소리의 대본 인용이 저장됐고, 기존 판정 43개·이전 생성 기록 23개·Dataset·Source·Handoff 보존을 대조했다. 전체 음향 판정 48개는 사람 검토 전 상태이며 음성 자산은 0개다. 글자·제작 기준·컷·그림 작업과 작품 전체 검토는 아직 진행 중이다. 이 상태를 전체 콘티 완료나 Final 승인으로 보고하지 않는다.

근거는 `.local/validation/automation-runtime/prj008-whole-story-20260912/source-evidence-correction-verification.json`과 실행별 요청·응답·취소 기록, `prj008-whole-story-{evidence,model}-monitor.log`에 있다. 현재 실행 화면의 진척·선택 음성 안내도 브라우저에서 확인했으며 페이지 오류·변경 요청은 0건이다. 이전 이관 수를 기대한 테스트 1개와 브라우저 테스트의 저장 응답 대기 문제는 각각 원인을 수정했다. 모델 응답의 필수 키·원문 인용·허위/다른 구간 연결 거부·이관·기존 값 보존 관련 14개 검사와 음향 검토 브라우저 2개가 통과했다.

최종 `npm run check`는 113파일·1,512개 검사(437.62초), 서버/Web 타입, Required Registry 695개(누락·중복·skip·only 0), Schema와 웹 빌드를 통과했다. 전체 E2E 69개도 통과했다(3.7분). 증거는 `audio-evidence-model-full-check.log`, `audio-evidence-model-all-e2e.log`다. 검토 서버 4317·55873·52029는 Source Build `b7433cc93069bf34a79a05cc9b0ed76f61514de6196b2d3fa837803d02710695`·Schema 1.21.0으로 갱신했고 저장본 4개의 바이트·revision을 유지했다. `audio-evidence-runtime-{pre,post}.json`, `audio-evidence-live-ui.json`으로 기존 실제 화면의 콘티 전용 기본값·선택 재생 안내·정적 HTML 일치·페이지 오류 0·새 실행 요청 0을 확인했다. PRJ-008의 전체 자동 제작 실행은 별도 57847 서버에서 글자 배치 후보까지 저장하고 제작 기준 계획을 계속한다.

세로형·긴 본문의 출력 계약은 Project 1.21 합성 프로젝트로 추가 확인했다. Projection의 화면비만 바꾸는 방식이 아니라 9:16 입력 → 원문 개요 → 원자 구간 계획 컴파일 → 시험 객체의 검토 → 실제 Final PDF·CSV 경로를 사용했다. 음원 0개에서 Final Ready이며 계획 시각의 대사 28문단·음향 지시 24문단을 두 출력에 빠짐없이 보존했다. PDF 5페이지 전체를 렌더링하여 그림 모서리·9:16 배율·이어지는 제목·페이지 번호·줄바꿈을 확인했고 모든 글자 좌표가 페이지 여백 안에 있다. 사용자 저장본과 승인 상태는 접근·변경하지 않았다. 시험 승인·검증 도형·긴 반복 본문을 사용한 출력 계약 증거이므로 실제 모델의 긴 작품 연출 품질 또는 사용자 Final 승인으로 해석하지 않는다. 근거는 [출력 검증](../../.local/validation/automation-runtime/optional-audio-portrait-output/verification.json)과 같은 폴더의 PDF·CSV·5개 렌더링이다. 첫 검사 스크립트의 CSV JSON 이중 인코딩 비교 오류는 실제 `audio_events` 셀을 역직렬화하여 원문과 직접 대조하도록 수정했다. 제품 CSV 변경은 없으며 실패 로그도 보존한다.

앞서 완료한 실제 모델 세로형 합성 사례의 Draft PDF도 내부를 검사했다. 10페이지이며 미승인 그림은 0개 삽입되고 placeholder로 표시된다. 따라서 그 사례의 `Draft PDF 200`은 파일 생성·검토 상태 표시의 증거이며 미승인 그림을 포함한 PDF 전달의 증거가 아니다. 실제 그림 5개의 검토는 제작자 웹 미리보기에서 수행했다. 기존 안전 출력 계약과 사람 승인 조건은 유지한다.

Source Update와 미저장 입력 복원은 실제 웹 변경 영향 검토·적용 API를 사용해 추가 검증했다. 대사 원문 변경으로 교체된 Audio Cue의 이전 목소리·발음 보완과 컷 연출 입력은 보관함에 남고 새 대상에 자동 적용되지 않는다. 영향 없는 컷·기존 PCM WAV 바이트·Asset catalog·Generation Record·이전 Version을 보존하며 모델·그림·음성 실행은 0건이다. 이 검증에서 `speech-retake` 임시 입력이 알 수 없는 종류로 분류되던 누락을 수정했다. 현재 대상이 있으면 음성 편집으로 이동하고, 교체돼 없으면 원래 대상이 없다는 안내와 작성 내용을 보존한다. 관련 단위 4개, 실제 Source Update·보관함 E2E 2개(8.4초), 서버/Web 타입·분리된 웹 빌드·Required Registry 696개·diff 형식 검사가 통과했다. 전체 1,512개·E2E 69개의 앞선 검사와 이번 추가 검사의 범위를 구분한다. 근거는 `source-update-draft-fixed-{unit,e2e,types,registry}.log`, `source-update-draft-web-types.log`와 `source-update-draft-fixed-results/`다.

검토 서버 4317·55873·52029는 Source Build `4f4e30e9e94ccd4be6cd6252feac532d0838093be72e96ca83b4d62cbd9aa40f`의 별도 웹 빌드로 갱신했다. 기존 저장본 4개의 바이트·revision은 유지되며 실제 화면의 기본 `instructions-only`·선택 재생 분리·페이지 오류 0·자동 실행 요청 0을 확인했다. 설정 파일은 `.local/validation/automation-runtime/source-update-draft-server-<port>.json`, 검증은 `source-update-draft-runtime-{pre,post}.json`과 `source-update-draft-live-ui.json`에 있다. 진행 중인 PRJ-008의 57847 서버와 `dist/web`는 실행 당시 Build `b7433cc93069bf34a79a05cc9b0ed76f61514de6196b2d3fa837803d02710695` 그대로 유지했다. 해당 실행은 사람 승인 없이 제작 기준 계획을 계속하며, 검토 서버 갱신을 전체 실행의 코드 교체로 보고하지 않는다.

1. A01~A10·P0/P1 B01~B14의 전체 범위를 유지한다. B02 상세도의 120초 파일럿 진단은 위 범위로 확인했으며 실제 작품의 생성 결과 표현 수준을 검증한다. B04의 글꼴 선택·Cue별 표현, B05 개별 음색·발음 및 전체 청취 검증, B11의 위 편집 폼·작업 위치 복원은 연결했으며 문서 가져오기·독립 콘티 생성 입력/결과 복원은 위 범위로 연결했다. 자동 제작 시작 설정도 위 범위로 연결했다. Source Update·기준 이미지 입력 복원은 위 검증 범위로 연결했다. Placement 정보/권한 복원은 위 범위로 연결했다. 검토 전달 패키지 입력/응답 결과 기록 복원은 위 범위로 연결했다. 문서 모델 검토는 접수 전 ID 보관과 동일 요청 재연결·명시적 재전송까지 위 범위로 연결했다. 검토 패키지 생성 응답 유실 복구도 아래 범위로 검증했다. 삭제된 대상의 임시 기록 열람도 아래 보관함으로 연결했다. 전체 폼·원본 변경 통합 검증은 계속한다. 실제 첫 장면의 8개 기준 이미지 처리는 보드 전달과 후속 자동 생성·브라우저 합성 검토로 확인했다. 전체 작품의 표현 밀도·음향·연속성 검토로 확대해야 한다. B12 출력 선택과 B13 웹 전달 패키지는 위 계약으로 연결했으며 실제 전체 작품의 최종 출력 검증은 남아 있다.
2. B07의 환경 음향·음악 Instruction 판정·누락 차단은 위 범위로 연결했다. 기본 콘티에서는 지시·계획 시각·제작자 검토를 작품 전체로 확대한다. 실제 음향 배치는 선택 기능으로 검증한다. 지원하는 음원은 제작자가 선택한 WAV이며 효과음·음악 생성 제공자는 추가하지 않았다. 현재 범위로 해결할 수 없는 발화·음향 충돌은 명시적으로 남긴다.
3. 제작자 시간순 검토를 바탕으로 시간별 Frame 표현 밀도, 긴 글자 가독성·배치·겹침, 여러 발화와 선택 재생성의 전체 검토 경험을 검증한다. 현재 세로형 합성 자료의 재생 검증을 실제 작품 전체의 연출·가독성 검토로 해석하지 않는다.
4. A10을 위해 다른 구성과 길이의 실제 문서 프로젝트 전체 분량을 확인한다. 합성 세로형의 Final PDF·CSV 출력 계약은 위 범위로 통과했으며 실제 작품 전체의 그림·연출 검토와 승인 후 최종 출력 검증은 남아 있다.
5. B14의 실제 디스크 여유 공간 검사와 공간 부족 중단·재개는 아래 계약과 증거로 연결했다. 선택 백업·독립 dataRoot 복원은 위 계약과 검증으로 연결했다. 임시 자원 수명과 전체 운영 통합 검증은 계속한다. 검토 패키지의 보관 용도를 원본 저장소 전체의 복원 가능한 백업으로 주장하지 않는다. Build 뒤 정적 파일 폴더 이름이 변경되는 외부 간섭 가능성도 조사한다. 현재 관측은 경로 변경과 복구까지이며 실행 주체·재발 원인은 미확인이다.

자동 생성 완료는 검토 가능한 후보의 반영 완료이며 사람 승인이나 Final Ready를 뜻하지 않는다.
