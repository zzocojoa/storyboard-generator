import { SpeakerVoiceFields } from './SpeakerVoiceFields.js';
import { assertSpeakerVoices } from '../../src/domain/speech-voice.js';
import { automationSpeakerVoices, automationAudioProduction } from '../../src/automation/run-schema.js';
import type { ReactElement } from 'react';
import { AutomationSettingsSchema } from '../../src/automation/run-schema.js';
import type { AutomationSettings } from '../../src/automation/run-schema.js';
import type { Project } from '../../src/domain/schema.js';
import { AutomationStoragePanel } from './AutomationStoragePanel.js';
import { StoryboardDensityFields } from './StoryboardDensityFields.js';
import { AutomationStartDraftSchema } from './automation-start-draft.js';
import type { AutomationStartDraft } from './automation-start-draft.js';
import { apiErrorMessage } from './api.js';
import { useBrowserDraft } from './useBrowserDraft.js';

const numericSettings: readonly { key: Exclude<keyof AutomationSettings, 'model' | 'voice'>; label: string; min: number; max: number }[] = [
  { key: 'productionBatchSize', label: '한 번에 계획할 구간 수', min: 1, max: 256 },
  { key: 'maxFramesPerSegment', label: '구간별 최대 그림 수', min: 1, max: 2048 },
  { key: 'maxModelCorrections', label: '계획 보정 횟수', min: 0, max: 3 },
  { key: 'maxAttemptsPerJob', label: '작업별 최대 시도', min: 1, max: 4 },
  { key: 'maxImageAttempts', label: '전체 그림 생성 시도 한도', min: 1, max: 8192 },
  { key: 'maxJobs', label: '전체 작업 수 한도', min: 1, max: 8192 },
  { key: 'maxStagedBytes', label: '결과 저장 한도 (bytes)', min: 1, max: 1073741824 },
  { key: 'maxActiveMs', label: '실행 시간 한도 (ms)', min: 1000, max: 86400000 },
];

export function AutomationStartForm(props: {
  project: Project; baseline: AutomationSettings; busy: boolean; disabled: boolean; configured: boolean;
  onStart: (segments: string[], settings: AutomationSettings) => Promise<void>;
}): ReactElement {
  const baseline: AutomationStartDraft = { settings: props.baseline, segments: props.project.dataset.segments.map((segment): string => segment.id) };
  const draft = useBrowserDraft(`automation-start:${props.project.projectId}`, baseline, String(props.project.revision), AutomationStartDraftSchema);
  const { settings, segments } = draft.value;
  const setSettings = (next: AutomationStartDraft['settings']): void => { draft.setValue((previous): AutomationStartDraft => ({ ...previous, settings: next })); };
  const setSegments = (next: string[]): void => { draft.setValue((previous): AutomationStartDraft => ({ ...previous, segments: next })); };
  const parsed = AutomationSettingsSchema.safeParse({ ...settings, audioProduction: settings.audioProduction ?? 'instructions-only' });
  let voiceIssue: string | null = null;
  if (parsed.success && automationAudioProduction(parsed.data) === 'guide-voice') { try { assertSpeakerVoices(props.project, automationSpeakerVoices(parsed.data)); } catch (error: unknown) { voiceIssue = apiErrorMessage(error); } }
  const missingSegments: string[] = segments.filter((id): boolean => !props.project.dataset.segments.some((segment): boolean => segment.id === id));
  const blocked: boolean = props.busy || props.disabled || draft.blocked;
  const begin = async (): Promise<void> => {
    if (blocked || !props.configured || !parsed.success || segments.length === 0 || missingSegments.length > 0 || voiceIssue !== null) return;
    await props.onStart(segments, parsed.data);
  };
  return <section aria-label="자동 제작 시작 설정">
    {draft.notice !== null && <fieldset className="automation-start-fields" disabled={props.busy}>{draft.notice}</fieldset>}
    {voiceIssue !== null && <p role="alert">{voiceIssue}</p>}
    {!parsed.success && <p role="alert">실행 설정을 확인하세요. {parsed.error.issues.map((issue): string => `${issue.path.join('.')}: ${issue.message}`).join(' · ')}</p>}
    {missingSegments.length > 0 && <p role="alert">현재 콘티에 없는 구간이 선택돼 있습니다: {missingSegments.join(', ')}. 현재 대상 구간을 다시 선택하세요.</p>}
    {props.configured && Number.isInteger(settings.maxStagedBytes) && settings.maxStagedBytes > 0 && settings.maxStagedBytes <= 1073741824 && <AutomationStoragePanel projectId={props.project.projectId} maxStagedBytes={settings.maxStagedBytes} />}
      <fieldset disabled={props.busy || props.disabled} className="automation-start-fields">
      <label className="text-layout-choice">음성 제작<select aria-label="음성 제작" value={settings.audioProduction ?? 'instructions-only'} onChange={(event): void => { setSettings({ ...settings, audioProduction: event.target.value as 'instructions-only' | 'guide-voice' }); }}>
        <option value="instructions-only">콘티만 제작 (추천)</option><option value="guide-voice">가이드 음성도 생성</option></select><span>기본 완료 기준은 그림·연출·시간·대사·음향 지시입니다. 실제 음원은 필수가 아닙니다.</span></label>
      <details><summary>제작 범위와 실행 설정 · {segments.length}개 구간</summary>
        {settings.density !== undefined && <StoryboardDensityFields value={settings.density} onChange={(density): void => { setSettings({ ...settings, density }); }} />}
        {settings.audioProduction === 'guide-voice' && settings.audioMixPlanning !== undefined && <label className="text-layout-choice">음량·페이드 계획<select value={settings.audioMixPlanning} onChange={(event): void => { setSettings({ ...settings, audioMixPlanning: event.target.value as 'automatic' | 'preserve' }); }}>
          <option value="automatic">실제 음원으로 자동 조정</option><option value="preserve">현재 음량 유지</option></select><span>수동 음량과 확정·잠금 컷은 보존합니다. 음량 조정 뒤 함께 들어 검토하세요.</span></label>}
        {settings.textLayoutPlanning !== undefined && <label className="text-layout-choice">글자 배치 계획<select value={settings.textLayoutPlanning} onChange={(event): void => { setSettings({ ...settings, textLayoutPlanning: event.target.value as 'automatic' | 'preserve' }); }}>
          <option value="automatic">자동 설정 대상의 배치 계획</option><option value="preserve">현재 배치 유지</option></select><span>콘티 전체에 적용됩니다. 직접 저장한 설정과 승인된 출력은 유지합니다.</span></label>}
        <fieldset><legend>대상 구간</legend><button type="button" onClick={(): void => { setSegments(props.project.dataset.segments.map((segment): string => segment.id)); }}>전체 선택</button>
          {props.project.dataset.segments.map((segment): ReactElement => <label className="automatic-segment" key={segment.id}><input type="checkbox" checked={segments.includes(segment.id)} onChange={(event): void => { setSegments(event.target.checked ? [...segments, segment.id] : segments.filter((id): boolean => id !== segment.id)); }} />{props.project.dataset.scenes.find((scene): boolean => scene.id === segment.sceneId)?.title} · {segment.id} · {segment.mode}</label>)}</fieldset>
        {settings.audioProduction === 'guide-voice' && <SpeakerVoiceFields project={props.project} settings={settings} onChange={setSettings} />}
        <div className="automatic-fields"><label>Codex 모델<input aria-label="자동 제작 모델" value={settings.model ?? ''} placeholder="앱의 기본 모델" onChange={(event): void => { setSettings({ ...settings, model: event.target.value.trim() || null }); }} /></label>
          {numericSettings.map((field): ReactElement => <label key={field.key}>{field.label}<input type="number" min={field.min} max={field.max} value={settings[field.key]} onChange={(event): void => { setSettings({ ...settings, [field.key]: Number(event.target.value) }); }} /></label>)}</div>
      </details>
      </fieldset>
      <p className="automatic-scope">원문과 제작 기준으로 컷·그림·대사·음향 지시 및 표시 시각을 계획합니다. 수동 편집·확정·잠금 컷·승인 그림은 보존합니다. 생성한 그림과 제안 시각을 검토한 뒤 확정하세요. 가이드 음성을 선택했을 때만 음원을 생성하고 실측 길이로 배치합니다.</p>
      <button className="studio-primary" disabled={blocked || !parsed.success || segments.length === 0 || missingSegments.length > 0 || voiceIssue !== null || !props.configured} onClick={(): void => { void begin(); }}>{props.busy ? '시작하는 중…' : `${segments.length}개 구간 자동 제작 시작`}</button>
      <p>브라우저를 닫아도 서버가 켜져 있으면 계속됩니다. 서버 재시작 후에는 ‘이어 만들기’로 재개합니다. 가이드 음성을 선택한 실행은 저장된 음원을 재검증해 이어 씁니다.</p>
  </section>;
}
