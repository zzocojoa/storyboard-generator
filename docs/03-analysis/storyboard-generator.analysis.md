# 범용 콘티 도구 — 구현 일치 분석

분석 기준은 [Plan](../01-plan/features/storyboard-generator.plan.md)의 FR-01~FR-10, [Design](../02-design/features/storyboard-generator.design.md), 1.5.0의 Text Mapping·Placement Information·Source Temporal Anchor·Information Gate·실제 미디어 안전 출력 계약이다. 완료 판단은 현재 코드, 생성 Schema, fixture와 자동 검사 결과를 따른다.

## 요구사항 일치

| 요구사항 | 판정 | 구현 근거 |
|---|---|---|
| FR-01 입력 패키지 | 일치 | `native-v1`, `production-v1`, 경로·버전·해시·권한 검사 |
| FR-02 차이·누락·미정 | 일치 | 불변 `importIssues`, Text/Source Mapping 검토 상태 |
| FR-03 제작 프로필·시각 기준 | 일치 | 프로젝트별 profile과 인물·장소·소품 기준 자산 |
| FR-04 컷 생성·편집 | 일치 | Source 사용·순서 정책, 분할·병합·재정렬·Link 이동 |
| FR-05 독립 트랙 | 일치 | 컷 연출·전환과 Audio/Text Cue의 독립 시간, 명시적 J/L 관계 |
| FR-06 그림 콘티 생성 | 일치 | Codex App 큐, 내장 `image_gen`, 프레임 단위 공개 검사 |
| FR-07 시간순 재생 | 일치 | End Frame 평가 경계, 안전한 글자·음성 선택자, Cue 종료·탐색·프로젝트 변경 Audio 정리 |
| FR-08 자동·사람 검토 | 일치 | 프로젝트·구간·컷·프레임 공통 Review 함수와 시각 승인 |
| FR-09 잠금·revision·영향 | 일치 | `expectedRevision`, 변경 시 승인 무효화, journal 기반 원자 저장과 시작 복구 |
| FR-10 JSON·PDF·CSV | 일치 | 기준 Gate와 재계산 입력 보존, 안전 상태·차단 코드와 원문 차폐 |

## 정보 공개 안전장치

`InformationRule.baseNotBeforeMs`는 입력 원본에서 온 권한 하한이다. `effectiveInformationGate`는 현재 Text Mapping, Source Temporal Anchor, 검증된 측정 Audio Cue와 Unit 순서 근거를 읽어 유효 시각을 동적으로 계산한다. 유도 시각은 기준 규칙으로 저장하지 않으며 어떤 근거도 기준 하한보다 이른 공개를 허용하지 않는다.

Unit 순서만으로 계산한 시각은 확인 근거가 생길 때까지 review-required다. 확정 Source Anchor나 같은 Segment의 유효한 `within-segment` 측정 Audio Cue가 유도 시각 이후에 있어야 검토가 해소된다. 더 앞선 Source·Audio 근거는 Gate를 앞당기지 않으며 `EVIDENCE_PRECEDES_UNIT_ORDER` 충돌을 만든다. 오디오 자산은 cue ID, 종류, 길이와 Segment 범위를 모두 만족해야 시간 근거가 된다. J/L-cut은 경계 재생에는 유효하지만 Gate 증거에서는 제외한다. 오디오 이동·길이·관계 변경은 관련 Anchor, Gate 관련 컷 승인과 프레임 검토를 무효화한다.

직접 시각 Source Link는 `shot-offset` 또는 `frame` Anchor가 확정돼야 한다. 프레임 생성은 반열린 Anchor 구간 안에서 해당 프레임 시각에 활성화된 직접 Link와 그 시점의 Text Mapping만 문맥에 넣고, Text Mapping·Source 정책·정보 Gate 충돌을 모두 검사한다. Anchor가 가리키는 프레임의 offset을 바꾸면 Link는 `unresolved/frame-change`가 된다. `SOUND`와 `MUSIC`은 직접 시각 Link가 될 수 없고, 모든 Link를 `audio-only`나 `context-only`로 돌려 검사를 우회하는 제안은 거부한다.

## 최종 출력 경계

Text Cue는 `placement`, `mapping-decision`, `source-unit`, `review-required` 권한과 필요한 연결 ID를 가진다. Placement Cue는 Mapping Decision이 없거나 중복되거나 미해결이면 정보 ID가 비어 있어도 출력되지 않는다. exact·abbreviation·replacement만 Canonical 정보 ID를 상속하며 separate-element와 standalone Placement는 상속하지 않는다. 별도 Canonical Cue는 Mapping Decision ID로 구별한다. 검토 필요 Cue는 API와 Inspector에서 권한 Source로 재구성하거나 커버리지를 확인해 삭제한다. Program Monitor는 `playableTextCuesAt`만 사용한다.

`separate-element`와 `standalone-placement`는 정보 ID가 없다는 이유만으로 비정보성으로 간주하지 않는다. 별도 `TextPlacementInformationDecision`이 `unresolved`이면 Placement 본문을 차단한다. 사용자가 `non-informational`로 확인했거나 `informational`과 유효한 Information ID를 지정한 경우에만 각 Gate를 검사해 출력한다. Mapping 관계 변경, Source Update, JSON 재열기에서도 판정의 생성·제거·보존 규칙을 적용한다.

Audio Cue는 `within-segment`, `j-cut`, `l-cut` 관계를 명시한다. proposed 상태, 대상·길이가 맞지 않는 Asset, 관계 범위 위반, 미해결 정보 규칙, Gate 조기 재생은 실제 `Audio.play()` 경로에서 제외된다. 음성 요청 문맥에는 관계와 경계 초과량, 정보 ID, Segment 범위가 포함되고, 생성 WAV의 측정 길이로 만든 후보 Cue가 같은 검사를 통과해야 Asset을 등록한다.

SFX·Music과 외부 녹음 Dialogue·Voiceover·Panel은 같은 multipart 등록 경로를 사용한다. mono/stereo 16/24-bit PCM WAV를 파싱해 실제 길이를 적용하고, 입력 sample rate·chunk 수·예상 출력 크기를 제한한 뒤 프로젝트 샘플레이트의 PCM16 WAV로 정규화한 결과를 다시 검사한다. AIFF·MP3는 지원하지 않는다. 서버는 저장과 읽기 모두에서 파일 존재·경로·SHA-256·MIME·구조와 실제 WAV의 duration·sample rate·channel·codec을 Asset metadata에 대조하고 Program Monitor에는 Cue 길이까지 맞는 `no-store` 안전 Audio URL만 제공한다. 유효한 이전 24kHz 또는 PCM24 WAV는 손상과 구분해 새 Asset 버전으로 복구할 수 있다.

ProjectStore는 변경에 필요한 이전/다음 Project, revision과 Asset을 journal transaction으로 staging하고 Asset → revision → 현재본 순서로 게시한다. 시작 시 현재 revision과 journal을 비교해 게시 전 중단을 제거하거나 완전한 commit을 유지하고, 게시 결과가 불완전하면 이전 revision을 복원한다. 복구용 Asset 경로가 프로젝트의 `assets` 밖으로 나가면 복구를 중단하고 오류를 노출한다. Browser Audio controller는 Cue 종료와 playhead 범위를 모두 적용하며 프로젝트·revision 전환과 이전 비동기 완료가 새 재생을 오염시키지 않게 한다.

End Frame은 `endMs`에 표시하고 `endMs - 1`에서 평가한다. `reviewFrameOutput`은 이미지 자산의 종류와 대상, accepted 상태, 활성 Source·Text Mapping과 Gate를 Program Monitor·전환·PDF·CSV에 공통 적용한다. 변경으로 pending 또는 rejected가 된 bitmap은 JSON과 검토 화면에 남고 안전 출력에서는 placeholder와 Issue code로 대체된다.

PNG·JPEG·WebP는 `sharp`로 전체 디코딩하고 픽셀 상한을 적용한다. 저장 파일 해시나 구조가 달라진 경우 Raw Asset fetch도 거부한다. 안전 Frame URL은 현재 출력 판정과 실제 파일 검사를 모두 통과해야 bytes를 반환하며, PDF는 손상 자산 하나 때문에 전체 내보내기를 중단하지 않고 식별자와 오류 코드가 있는 placeholder를 만든다. Ready 지표는 Asset 존재, 검토 완료, 안전 출력 가능을 별도로 계산한다.

## Mapping과 편집 의미

Canonical 후보는 `placement.unitId`, 허용 종류의 유일한 정확 일치, 유일한 휴리스틱 후보 순서로 선택한다. 중복 정확 일치는 unresolved로 남는다. `exact`, `abbreviation`, `replacement`, `separate-element`, `standalone-placement`는 Canonical 연결·별도 렌더링·시간 범위 조합을 Schema와 공통 Review 함수에서 검사한다. `separate-element` 분할 근거에는 Placement 시각 대신 Canonical 시각을 사용한다.

컷 분할은 확정된 Source Anchor, Text Mapping, Text Cue 또는 측정 Audio Cue만 시간 근거로 사용한다. 근거가 없거나 경계에 걸친 Link는 자동 복제하지 않고 검토 상태로 남긴다. 병합은 호환 Anchor를 합치고, 재정렬은 수동 컷 상대 Anchor를 보존하되 절대 시각에서 유도된 Text/Audio Anchor를 무효화한다. 다른 컷으로 Link를 옮길 때 기존 Anchor가 새 컷 범위에 안전하게 대응되지 않으면 재확정을 요구한다.

## Migration과 출력

저장본은 `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.5.0` 순서로 변환한다. 1.2 Source Link에는 `unresolved/migration` Anchor를 부여하고 기존 승인 상태를 재검토한다. 정보 규칙은 보관된 handoff와 source snapshot에서 다시 정규화해 권한 `baseNotBeforeMs`를 복원한다. 1.3 Audio Cue에는 `within-segment`를 부여하고 Text Cue 권한은 Placement, exact Mapping, Source Unit 순서로 복원한다. 1.4의 독립 Placement에는 `unresolved` 정보 판정을 만들고 Canonical 관계에는 만들지 않는다. 원문, 컷, 시간, Source Snapshot, 자산, 생성 기록은 보존한다.

JSON은 기준 규칙과 모든 재계산 입력을 보존한다. CSV는 `source_temporal_anchors`, `information_gates`, 출력 안전 상태와 차단 코드를 제공하고 차단된 Text Cue·Source Unit 본문을 생략한다. PDF는 Source Anchor 종류·근거, 기준/유효 Gate, End Frame 표시·평가 시각을 표시하고 차단된 원문을 가린다.

## 검증 범위

기존 정보 공개 회귀를 유지하면서 Placement Mapping, Text 권한 복구·삭제, Canonical Cue identity, Frame 자산 무효화와 네 안전 출력 채널, PRJ-007 Source fidelity 검사를 추가했다.

현재 로컬 자동 검사는 23개 파일의 309개 테스트를 통과한다. 이 중 신규 119개는 실제 미디어와 Placement 정보 경계, WAV 자원 제한, 실제 파일 metadata 결속, 이전 WAV 복구, 중단된 저장 복구, 브라우저 Audio 수명주기를 지정된 테스트 이름으로 검증한다. PRJ-007 Golden은 12 Scene, 32 Segment, screenplay Unit 79개, Panel Turn 16개, 1,500,000ms와 원문·시간·참조 보존을 검사한다. `SEG-024` Text는 1,088,000ms, 1,108,000ms, 1,148,000ms 공개를 검사하고 Audio는 실제 발화 Source가 지원하는 단계만 보고한다. `UNIT-045`는 저장소 fixture의 실제 48,000Hz mono PCM16 2,000ms WAV를 849,000–851,000ms J-cut으로 저장해 849,500ms 선택, 안전 HTTP bytes, JSON 재열기와 Gate 불변성을 검증한다. 메모리에 metadata만 넣는 기존 검사는 도메인 회귀이며 실제 Asset E2E 증거로 계산하지 않는다.

자동 검사는 구조·문자열·시간·참조·상태 무결성을 판정한다. 그림의 연출, 정보의 시각적 암시, 자막 가독성과 낭독 자연스러움은 사람이 실제 결과를 검토해야 한다. 지원 입력은 `native-v1`과 `production-v1`이며 임의 문서 가져오기, 클라우드 협업, 전체 영상 렌더링은 현재 범위가 아니다.
