# 범용 콘티 도구 — 1.2.0 보고서

## 완료 범위

구조화 제작 자료를 프로젝트별로 가져와 컷·다중 프레임·오디오·글자·전환·연속성 상태를 편집하고, Codex App에서 컷 제안·이미지·가이드 음성을 생성한 뒤 시간순으로 검토하는 로컬 웹 도구다. 이번 1.2.0에서는 축약 자막과 Canonical 원문의 충돌, Shot–Source 시간 Mapping, 같은 Segment 안의 순차 정보 공개를 하나의 검토·승인 계약으로 해결했다.

특정 작품 값은 `production-v1` fixture와 Golden Test에만 있다. 공통 모델과 UI는 프로젝트 ID, 인물, 장면 수, 모드, 분량에 따라 분기하지 않는다.

## 해결 결과

| 영역 | 구현 결과 |
|---|---|
| Text Mapping | Placement마다 exact·abbreviation·separate-element·replacement 관계와 unresolved·confirmed 상태를 저장한다. 축약 Cue가 있으면 Canonical 문구를 Segment 시작에 자동 생성하지 않는다. |
| Source Mapping | Shot의 권한 원문 연결을 용도·상태가 있는 `sourceLinks`로 통일했다. 분할·병합·재정렬과 모델 제안에서 시간 근거와 Unit 순서를 검증한다. |
| Information Gate | Segment·최초 Unit·Unit 순서·시각·정밀도를 저장하고 확정 Text, 측정 Audio, Unit 순서, Segment 시작의 우선순위를 적용한다. Frame 절대 시각에서 미래 정보를 거부한다. |
| 승인·생성 | unresolved Text Mapping, mapping-required Source Link, 조기 정보 공개의 ID와 이유를 표시하고 컷 승인·이미지 생성·구간 제안 적용을 차단한다. |
| 편집·API | Inspector에 TEXT MAPPING REVIEW와 SOURCE MAPPING을 추가하고 모든 Mapping 변경에 `expectedRevision`을 적용한다. |
| 저장·출력 | 프로젝트 Schema 1.2.0, 1.0.0→1.1.0→1.2.0 Migration, JSON·PDF·CSV의 Source Link 역할·상태 보존을 지원한다. |

## 품질 결과

| 기준 | 결과 |
|---|---|
| Plan 필수 기능 | FR-01~FR-10 10/10 |
| 정적 검사 | 서버·도메인 TypeScript와 Web TypeScript 통과 |
| 자동 테스트 | 18개 파일, 65개 테스트 통과 |
| Schema·빌드 | JSON Schema drift 검사와 운영 Web build 통과 |
| 브라우저 | 이전 저장본의 1.2.0 Migration, Mapping Inspector, 승인 차단 사유, 미해결 이미지 요청 거부 확인 |
| 저장소 Codex 스킬 | `quick_validate.py` 통과 |
| PRJ-007 Golden | 12 Scene, 32 Segment, 79 screenplay Unit, 16 Panel Turn, 1,500,000ms와 원문·시간·참조 보존 |
| SEG-024 | 1,088,000ms·1,108,000ms·1,148,000ms 공개 순서, Canonical 조기 Cue 0건, 미래 정보 조기 전달 0건 |

GitHub Actions workflow는 현재 없으므로 품질 결과는 로컬 실행 기준이다. 세부 대응과 검증 근거는 [구현 일치 분석](../03-analysis/storyboard-generator.analysis.md)에 있다.

## 운영 방식

웹 서버는 생성 요청을 `.local/codex-requests`에 저장한다. 같은 저장소의 Codex App 작업이 `$storyboard-workbench` 스킬로 요청을 읽어 현재 Codex 모델, 내장 `image_gen`, 설정된 macOS 음성을 사용하고 검증된 결과를 프로젝트 revision에 반영한다. `OPENAI_API_KEY`와 OpenAI SDK는 필요하지 않다. Mapping이나 Information Gate 검토가 남은 요청은 생성하지 않고 구체적인 실패 코드로 기록한다.

## 현재 경계

- 지원 입력은 계약이 명시된 `native-v1`과 `production-v1`이다.
- 이전 저장본의 불확실한 Source Link와 자막 관계는 자동 확정되지 않으며 사람이 검토해야 한다.
- 자동 검사는 문자열·시간·참조·상태 무결성을 판정한다. 그림의 연출, 반전 표현, 낭독 자연스러움은 사람이 승인한다.
- PRJ-007 전체 32개 구간의 이미지 생성과 구조가 다른 실제 두 번째 작품의 제작 품질 검토는 남아 있다.
- 임의 문서 가져오기, 편집기 프로젝트 파일, 전체 영상 렌더링, 클라우드 협업은 현재 범위가 아니다.
