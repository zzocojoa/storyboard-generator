import { audioCueSource } from '../../src/domain/audio-source.js';
import { storyboardAudioIssues } from '../../src/domain/audio-storyboard.js';
import { StoryboardAudioNotes } from './StoryboardAudioNotes.js';
import { TextPresentationEditor } from './TextPresentationEditor.js';
import type { TextPresentationValues } from '../../src/domain/text-presentation.js';
import { TextTypographySettings } from './TextTypographySettings.js';
import type { TextTypography } from '../../src/domain/text-typography.js';
import { SpeechRetakePanel } from './SpeechRetakePanel.js';
import { ReviewPlaybackControl } from './ReviewPlaybackControl.js';
import { useReviewPlayback } from './useReviewPlayback.js';
import type { ReviewPlaybackPreference } from './useReviewPlayback.js';
import { reviewPlayhead } from './review-playback.js';
import type { ReviewPlaybackRate } from './review-playback.js';
import { ReferenceImageForm } from './ReferenceImageForm.js';
import { ProductionReferenceReview } from './ProductionReferenceReview.js';
import type { ReferenceDraft } from './ReferenceImageForm.js';
import { SourceUpdateForm } from './SourceUpdateForm.js';
import { z } from 'zod';
import { useBrowserDraft } from './useBrowserDraft.js';
import { readWorkspacePosition, workspacePositionKey } from './workspace-position.js';
import type { WorkspacePosition } from './workspace-position.js';
import { TextMappingDecisionInputSchema } from '../../src/domain/mapping.js';
import { ProfileSchema, ShotContentSchema } from '../../src/domain/schema.js';
import { StoryboardFrameInputSchema } from '../../src/domain/frame.js';
import { AudioCueTimingInputSchema, TextCueTimingInputSchema } from '../../src/domain/tracks.js';
import { ShotVisualPlanInputSchema } from '../../src/domain/edit.js';
import { AudioInstructionReview } from './AudioInstructionReview.js';
import type { AudioInstructionInput } from '../../src/domain/audio-instructions.js';
import { AudioMixEditor } from './AudioMixEditor.js';
import type { AudioMixInput } from '../../src/domain/audio-mix.js';
import { StoryboardTextOverlay } from './StoryboardTextOverlay.js';
import { TextLayoutSettings } from './TextLayoutSettings.js';
import { TextReadabilitySettings } from './TextReadabilitySettings.js';
import type { TextReadabilityPolicy } from '../../src/domain/text-readability.js';
import type { TextLayoutPreset } from '../../src/domain/text-layout-settings.js';
import type { TextLayoutControl } from '../../src/domain/text-layout-control.js';
import { textPresetReview } from '../../src/automation/text-preset-review.js';
import { GenerationGuide, InspectorNavigation, ProductionOverview, ProductionReview, WorkspaceNavigation } from './WorkspaceViews.js';
import { BrowserDraftArchive } from './BrowserDraftArchive.js';
import { ProjectBackupPanel } from './ProjectBackupPanel.js';
import { AutomaticProductionPanel } from './AutomaticProductionPanel.js';
import { AudioReviewPreview } from './AudioReviewPreview.js';
import { ProducerVisualImage } from './ProducerVisualImage.js';
import { reviewProducerVisualAt, reviewProducerTransitionAt } from '../../src/domain/producer-playback.js';
import type { ProducerVisualDecision } from '../../src/domain/producer-playback.js';
import { productionLocations } from '../../src/domain/production-resources.js';
import { inspectorPages, segmentModeLabel } from './workspace-navigation.js';
import type { EditDestination, InspectorPage, WorkspacePage } from './workspace-navigation.js';
import { DocumentImportPanel } from './DocumentImportPanel.js';
import { IndependentStoryboardDialog } from './IndependentStoryboardDialog.js';
import type { IndependentStoryboardInput } from '../../src/domain/storyboard-creation.js';
import { intrinsicIncomingExposure } from '../../src/domain/transition.js';
import { visualCompositionAt, VisualCompositionStage } from './VisualComposition.js';
import { reviewShotVisualPlanChange } from '../../src/domain/edit.js';
import type { ShotVisualPlanInput, VisualPlanChangeReview } from '../../src/domain/edit.js';
import { sourceRevealEvidenceMs } from '../../src/domain/source-anchor.js';
import type { FinalReadinessReport } from '../../src/domain/final-readiness.js';
import type { OutputMaturity } from '../../src/domain/output-policy.js';
import { reviewVisualOutputAt } from '../../src/domain/visual-output.js';
import type { VisualOutputAtDecision } from '../../src/domain/visual-output.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { audioOverhangAfterMs, audioOverhangBeforeMs } from '../../src/domain/audio.js';
import { reviewIssuesForTextCue, textCueInformationIds } from '../../src/domain/emission.js';
import { reviewFrameOutput } from '../../src/domain/frame-output.js';
import type { FrameOutputDecision } from '../../src/domain/frame-output.js';
import { activeStoryboardFrame, playableAudioCuesAt, reviewAudioPlaybackAt, reviewTextPlaybackWithPolicy } from '../../src/domain/playback.js';
import type { BlockedCue } from '../../src/domain/playback.js';
import type { StoryboardFrameInput } from '../../src/domain/frame.js';
import { approvalIssuesForShot, effectiveInformationGate, sourceAnchorRange, textMappingReviewIssues } from '../../src/domain/mapping.js';
import type { EffectiveInformationGate, TextMappingDecisionInput } from '../../src/domain/mapping.js';
import type { TextPlacementInformationInput } from '../../src/domain/placement-information.js';
import type { Asset, AudioCue, Issue, LockedField, Profile, Project, Segment, Shot, ShotContent, ShotSourceLink, SourceTemporalAnchor, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement, TextPlacementInformationDecision } from '../../src/domain/schema.js';
import type { AudioCueTimingInput, TextCueTimingInput } from '../../src/domain/tracks.js';
import type { TextCueAuthorityResolutionInput } from '../../src/domain/text.js';
import { formatProjectDurationTimecode, formatProjectTimecode, frameDisplayAbsoluteMs, frameEvaluationAbsoluteMs } from '../../src/domain/time.js';
import { ApiError, apiErrorMessage, fetchAssetIntegrity, fetchFinalReadiness, fetchProject, fetchStatus, importIndependentStoryboard, importProject, listProjects, mutateProject, normalizeAudioAsset, previewSourceUpdate, prepareExternalAudio, queueCodexRequest, updateProjectSource, uploadAudioAsset } from './api.js';
import type { AppStatus, CodexRequest, ProjectSummary, ReviewedSourceImpact } from './api.js';
import { BrowserAudioController, createBrowserAudio } from './audio-lifecycle.js';
import { emptyRecoveryUiState, importButtonState, mutationControlsDisabled, projectAssetIntegrityIssues, projectRecoveryBlocked, reconcileAssetIntegrityIssues, reconcileBlockedProjects, recordRecoveryUiError } from './ui-policy.js';
import type { AssetIntegrityUiIssue, RecoveryUiState } from './ui-policy.js';

type Notice = { tone: 'info' | 'error'; text: string };
type SourceGateComparison = { informationId: string; gateMs: number | null; result: 'allowed' | 'blocked' | 'review-required' | 'rule-missing' };

const allLockedFields: LockedField[] = ['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'transition', 'frames'];
const selectedProjectStorageKey: string = 'cutroom:selected-project:1';

function contentFromShot(shot: Shot): ShotContent {
  return { visualMode: shot.visualMode, action: shot.action, camera: { ...shot.camera }, visualLocationId: shot.visualLocationId, presence: [...shot.presence],
    propIds: [...shot.propIds], continuityBefore: [...shot.continuityBefore], continuityAfter: [...shot.continuityAfter],
    cameraAxis: shot.cameraAxis, screenDirection: shot.screenDirection, informationIds: [...shot.informationIds], transitionOut: { ...shot.transitionOut } };
}

function readableError(error: unknown): string {
  return apiErrorMessage(error);
}

function percent(value: number, total: number): number {
  return total <= 0 ? 0 : Math.max(0, Math.min(100, value * 100 / total));
}

function elapsed(milliseconds: number | null): string {
  if (milliseconds === null) return '미측정';
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}초`;
  return `${Math.floor(milliseconds / 60000)}분 ${Math.round(milliseconds % 60000 / 1000)}초`;
}

function aspectRatio(project: Project): string {
  return `${project.profile.aspectWidth} / ${project.profile.aspectHeight}`;
}

function isSpeechCue(cue: AudioCue): boolean {
  return ['dialogue', 'voiceover', 'panel'].includes(cue.kind);
}

function updateContinuityState(states: ShotContent['continuityBefore'], assetId: string, state: string): ShotContent['continuityBefore'] {
  if (state.trim() === '') return states.filter((entry): boolean => entry.assetId !== assetId);
  return states.some((entry): boolean => entry.assetId === assetId)
    ? states.map((entry) => entry.assetId === assetId ? { ...entry, state } : entry)
    : [...states, { assetId, state }];
}

function continuityNotices(left: ShotContent['continuityAfter'], right: ShotContent['continuityBefore'], assets: readonly Asset[]): string[] {
  const ids: string[] = [...new Set([...left.map((entry): string => entry.assetId), ...right.map((entry): string => entry.assetId)])];
  return ids.flatMap((id: string): string[] => {
    const before: string | undefined = left.find((entry): boolean => entry.assetId === id)?.state;
    const after: string | undefined = right.find((entry): boolean => entry.assetId === id)?.state;
    const label: string = assets.find((asset: Asset): boolean => asset.id === id)?.description ?? id;
    if (before === after) return [];
    return [`${label}: ${before ?? '앞 컷 미기록'} → ${after ?? '뒤 컷 미기록'}`];
  });
}

function sourceGateComparisons(project: Project, shot: Shot, link: ShotSourceLink, unit: SourceUnit): SourceGateComparison[] {
  const revealMs: number | null = sourceAnchorRange(project, shot, link)?.startMs ?? null;
  return unit.informationIds.map((informationId: string): SourceGateComparison => {
    if (!project.dataset.informationRules.some((rule): boolean => rule.id === informationId)) return { informationId, gateMs: null, result: 'rule-missing' };
    const gate: EffectiveInformationGate = effectiveInformationGate(project, informationId);
    if (revealMs === null || gate.reviewRequired) return { informationId, gateMs: gate.effectiveNotBeforeMs, result: 'review-required' };
    return { informationId, gateMs: gate.effectiveNotBeforeMs, result: revealMs < gate.effectiveNotBeforeMs ? 'blocked' : 'allowed' };
  });
}

async function fileBase64(file: File): Promise<string> {
  const bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const chunkSize: number = 32768;
  let binary: string = '';
  for (let offset: number = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function safeFrameUrl(projectId: string, frameId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/output/frame/${encodeURIComponent(frameId)}`;
}

function safeAudioUrl(projectId: string, cueId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/output/audio/${encodeURIComponent(cueId)}`;
}

export function ImportPanel(props: { working: boolean; onImport: (path: string, holdMs: number) => Promise<void> }): ReactElement {
  const [path, setPath] = useState<string>('');
  const [hold, setHold] = useState<string>('2000');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const submittingRef = useRef<boolean>(false);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (props.working || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    void props.onImport(path, Number(hold)).finally((): void => { submittingRef.current = false; setSubmitting(false); });
  };
  const button = importButtonState(props.working, submitting);
  return <div><form className="import-panel" onSubmit={submit}>
    <div className="eyebrow">INPUT CONTRACT</div>
    <h2>새 콘티 시작</h2>
    <p>handoff JSON을 선택하면 원본을 검증하고 편집용 컷 초안을 만듭니다.</p>
    <label>handoff 파일 경로<input value={path} onChange={(event): void => { setPath(event.target.value); }} placeholder="/project/storyboard_handoff.json" required /></label>
    <label>임시 화면 글자 유지 시간<input type="number" min="1" value={hold} onChange={(event): void => { setHold(event.target.value); }} required /><span className="unit">ms</span></label>
    <button className="primary" disabled={button.disabled}>{button.label}</button>
  </form></div>;
}

function ProjectRail(props: { summaries: ProjectSummary[]; currentId: string | null; working: boolean;
  onSelect: (projectId: string) => Promise<void>; onImport: (path: string, holdMs: number) => Promise<void>; onDocuments: () => void; onIndependent: () => void }): ReactElement {
  const [query, setQuery] = useState<string>('');
  const filtered: ProjectSummary[] = props.summaries.filter((value: ProjectSummary): boolean => value.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <aside className="project-rail" aria-label="프로젝트 목록">
    <div className="brand"><span className="brand-mark">C</span><div><strong>CUTROOM</strong><small>이야기를 장면으로</small></div></div>
    <button className="rail-storyboard-entry" type="button" disabled={props.working} onClick={props.onIndependent}>＋ 새 콘티 시작</button>
    <div className="rail-label">PROJECTS · {String(props.summaries.length).padStart(2, '0')}</div>
    <label className="project-search">내 콘티 찾기<input type="search" placeholder="프로젝트 검색" value={query} onChange={(event): void => { setQuery(event.target.value); }} /></label><div className="project-list">{filtered.length === 0 && <p className="empty-note">{query === '' ? '첫 콘티를 시작하세요.' : '검색 결과가 없습니다.'}</p>}{filtered.map((summary: ProjectSummary): ReactElement =>
      <button key={summary.projectId} className={summary.projectId === props.currentId ? 'project-tile active' : 'project-tile'} aria-current={summary.projectId === props.currentId ? 'page' : undefined} disabled={props.working} onClick={(): void => { void props.onSelect(summary.projectId); }}>
        <span className="project-index">{formatProjectDurationTimecode(summary.durationMs, { fpsNumerator: summary.frameRateNumerator,
          fpsDenominator: summary.frameRateDenominator, dropFrame: summary.dropFrame, startTimecode: summary.startTimecode,
          sampleRate: summary.sampleRate })}</span><strong>{summary.title}</strong>
        <span>{summary.shots}컷 · 그림 {summary.framesWithAsset}개 · {summary.finalOutputReady ? '최종 출력 가능' : '작업 중'}</span>
        {summary.audioRepairRequired > 0 && <span className="project-warning">음성 파일 복구 필요 {summary.audioRepairRequired}건</span>}
      </button>)}</div>
    <button className="rail-document-entry" type="button" disabled={props.working} onClick={props.onDocuments}>제작 문서 8개로 새 패키지 만들기 <span aria-hidden="true">↗</span></button>
    <details className="rail-import"><summary>＋ 프로젝트 불러오기</summary><ImportPanel working={props.working} onImport={props.onImport} /></details>
  </aside>;
}

function SceneRail(props: { project: Project; segmentId: string; onSelect: (segmentId: string) => void }): ReactElement {
  return <aside className="scene-rail"><div className="column-head"><span>장면 목록</span><b>{props.project.dataset.scenes.length}</b></div>
    <div className="scene-list">{props.project.dataset.scenes.map((scene, sceneIndex: number): ReactElement => {
      const segments: Segment[] = props.project.dataset.segments.filter((segment: Segment): boolean => segment.sceneId === scene.id);
      return <section className="scene-group" key={scene.id}><header><span>{String(sceneIndex + 1).padStart(2, '0')}</span><div><strong>{scene.title}</strong><small>{segments.length}개 구간</small></div></header>
        {segments.map((segment: Segment): ReactElement => <button key={segment.id} className={segment.id === props.segmentId ? 'segment-row active' : 'segment-row'} onClick={(): void => { props.onSelect(segment.id); }}>
          <span>{segmentModeLabel(segment.mode)}</span><time>{formatProjectTimecode(segment.startMs, props.project.handoff.timebase)}</time>
        </button>)}</section>;
    })}</div></aside>;
}

function SafeFrameImage(props: { project: Project; frame: StoryboardFrame | null; decision: FrameOutputDecision | null; alt: string }): ReactElement {
  if (props.frame !== null && props.decision !== null && props.decision.renderMode !== 'blocked') {
    return <img src={safeFrameUrl(props.project.projectId, props.frame.id)} alt={props.alt} />;
  }
  return <div className="frame-placeholder" title={props.decision?.issues.map((item: Issue): string => `${item.code}: ${item.message}`).join(' · ')}><span className="empty-frame-mark" aria-hidden="true">▧</span><strong>{props.frame?.imageAssetId ? '이미지 검토가 필요합니다' : '아직 그림이 없습니다'}</strong><p>{props.frame?.imageAssetId ? '원문 연결과 이미지 검토 상태를 확인하세요.' : '컷 연출을 정한 뒤 그림을 생성하세요.'}</p></div>;
}

function VerifiedVisualBitmap(props: { project: Project; decision: VisualOutputAtDecision; alt: string }): ReactElement {
  const [failed, setFailed] = useState<boolean>(false);
  const [url] = useState<string>(`/api/projects/${encodeURIComponent(props.project.projectId)}/output/visual?atMs=${props.decision.playheadMs}&channel=${props.decision.channel}`);
  return failed ? <div className="frame-placeholder" role="alert">OUTPUT BLOCKED · ASSET INTEGRITY</div>
    : <img src={url} alt={props.alt} onError={(): void => { setFailed(true); }} />;
}

function SafeVisualImage(props: { project: Project; decision: VisualOutputAtDecision; alt: string }): ReactElement {
  const key: string = JSON.stringify([props.project.projectId, props.project.revision, props.decision.shotId,
    props.decision.frameId, props.decision.sourceFrameId, props.decision.imageAssetId, props.decision.renderMode, props.decision.activeSourceUnitIds]);
  if (props.decision.renderMode === 'blocked') return <div className="frame-placeholder"><span>OUTPUT BLOCKED</span><p>{props.decision.issues.map((value: Issue): string => value.code).join(', ')}</p></div>;
  return <VerifiedVisualBitmap key={key} {...props} />;
}

function reviewFrameLabel(project: Project, frame: StoryboardFrame): string {
  const output: FrameOutputDecision = reviewFrameOutput(project, frame.id, 'program-monitor');
  if (output.renderMode === 'black') return 'BLACK · OUTPUT SAFE';
  if (output.renderMode === 'hold-previous') return `HOLD · ${output.sourceFrameId ?? 'SOURCE'} · OUTPUT SAFE`;
  if (output.renderBitmap) return 'CURRENT';
  if (frame.visualReview === 'rejected') return '재생성 필요';
  if (frame.imageAssetId !== null) return '출력 전 재검토';
  return '그림 검토 대기';
}

function ShotBoard(props: { project: Project; shot: Shot; selected: boolean; onSelect: (shotId: string) => void; onGenerate: (frameId: string) => Promise<void>; busy: boolean }): ReactElement {
  const frame: StoryboardFrame | null = props.project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === props.shot.id).sort((left, right): number => left.offsetMs - right.offsetMs)[0] ?? null;
  const decision: FrameOutputDecision | null = frame === null ? null : reviewFrameOutput(props.project, frame.id, 'program-monitor');
  return <article className={props.selected ? 'shot-card selected' : 'shot-card'} tabIndex={0} aria-label={`${props.shot.id} 컷 선택`} onKeyDown={(event): void => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); props.onSelect(props.shot.id); } }} onClick={(): void => { props.onSelect(props.shot.id); }}>
    <div className="shot-frame" data-visual-mode={props.shot.visualMode} style={{ aspectRatio: aspectRatio(props.project) }}><SafeFrameImage project={props.project} frame={frame} decision={decision} alt={`${props.shot.id} 콘티 프레임`} />
      <span className="frame-time">{formatProjectTimecode(props.shot.startMs, props.project.handoff.timebase)}</span><span className={`review-dot ${frame?.visualReview ?? 'pending'}`}></span>
      {frame !== null && <span className="frame-output-state">{reviewFrameLabel(props.project, frame)}</span>}
      {frame !== null && <button className="frame-generate" disabled={props.busy || props.shot.visualMode !== 'sourced'} onClick={(event): void => { event.stopPropagation(); void props.onGenerate(frame.id); }}>{props.shot.visualMode === 'sourced' ? frame.imageAssetId === null ? '그림 요청' : '다시 생성' : props.shot.visualMode.toUpperCase()}</button>}
    </div>
    <div className="shot-meta"><div><span>{props.shot.camera.size || '구도 미정'}</span><span>{props.shot.camera.angle || '앵글 미정'}</span></div><time>{((props.shot.endMs - props.shot.startMs) / 1000).toFixed(1)}s</time></div>
    <h3>{props.shot.action || '동작을 입력하세요'}</h3>
    <footer><span>원문 {props.shot.sourceLinks.length}개</span><span>{props.shot.approvalStatus === 'approved' ? '확정' : props.shot.proposalOrigin === 'source-outline' ? '원문 초안' : '연출 초안'}</span></footer>
  </article>;
}

function Timeline(props: { reviewPlayback: ReviewPlaybackPreference; project: Project; playhead: number; playing: boolean; onChange: (value: number) => void; onToggle: () => void }): ReactElement {
  const total: number = props.project.dataset.segments.at(-1)?.endMs ?? 1;
  return <section className="timeline"><header><button className={props.playing ? 'transport active' : 'transport'} disabled={props.reviewPlayback.rate === null} onClick={props.onToggle} aria-label={props.playing ? '재생 일시 정지' : '시간순 재생'}>{props.playing ? 'Ⅱ' : '▶'}</button>
    <time>{formatProjectTimecode(props.playhead, props.project.handoff.timebase)}</time><ReviewPlaybackControl preference={props.reviewPlayback} /><span className="timeline-title">MASTER TIMELINE</span><span>{formatProjectDurationTimecode(total, props.project.handoff.timebase)}</span></header>
    <div className="timeline-canvas">
      <div className="track-label">CUT</div><div className="track cut-track">{props.project.shots.map((shot: Shot): ReactElement => <span key={shot.id} style={{ left: `${percent(shot.startMs, total)}%`, width: `${percent(shot.endMs - shot.startMs, total)}%` }} title={shot.id}></span>)}</div>
      <div className="track-label">TXT</div><div className="track text-track">{props.project.textCues.map((cue: TextCue): ReactElement => <span key={cue.id} style={{ left: `${percent(cue.startMs, total)}%`, width: `${percent(cue.endMs - cue.startMs, total)}%` }} title={cue.text}></span>)}</div>
      <div className="track-label">AUD</div><div className="track audio-track">{props.project.audioCues.map((cue: AudioCue): ReactElement => <span key={cue.id} className={playableAudioCuesAt(props.project, cue.startMs).some((candidate: AudioCue): boolean => candidate.id === cue.id) ? 'ready' : ''} style={{ left: `${percent(cue.startMs, total)}%`, width: `${percent(cue.endMs - cue.startMs, total)}%` }} title={`${cue.kind} · ${cue.timingRelation}`}></span>)}</div>
      <div className="playhead" style={{ left: `calc(52px + (100% - 52px) * ${props.playhead / total})` }}></div>
    </div>
    <input className="scrubber" aria-label="재생 위치" type="range" min="0" max={total} step="1" value={props.playhead} onChange={(event): void => { props.onChange(Number(event.target.value)); }} />
  </section>;
}

function PlaybackVisualImage(props: { project: Project; decision: VisualOutputAtDecision | ProducerVisualDecision; alt: string }): ReactElement {
  return props.decision.channel === 'producer-review'
    ? <ProducerVisualImage projectId={props.project.projectId} revision={props.project.revision} decision={props.decision} alt={props.alt} />
    : <SafeVisualImage project={props.project} decision={props.decision} alt={props.alt} />;
}

function PlaybackMonitor(props: { reviewPlayback: ReviewPlaybackPreference; project: Project; playhead: number; maturity: OutputMaturity; playing: boolean;
  onToggle: () => void; onSeek: (value: number) => void; onInspect: (frameId: string) => void; onClose: () => void }): ReactElement {
  const [textNotice, setTextNotice] = useState<string>('');
  const composition = visualCompositionAt(props.project, props.playhead);
  const { shot, transitionPolicy, transitionActive, incomingActive, transitionProgress } = composition;
  const frame: StoryboardFrame | null = shot === null ? null : activeStoryboardFrame(props.project, shot.id, props.playhead);
  const nextFrameDecision: VisualOutputAtDecision | ProducerVisualDecision = props.maturity === 'draft'
    ? reviewProducerTransitionAt(props.project, props.playhead) : reviewVisualOutputAt(props.project, props.playhead, 'transition-preview');
  const nextFrameSafe: boolean = nextFrameDecision !== null && nextFrameDecision.renderMode !== 'blocked';
  const textPlayback = reviewTextPlaybackWithPolicy(props.project, props.playhead, { maturity: props.maturity, channel: 'program-monitor' });
  const blocked: BlockedCue[] = textPlayback.blocked;
  const frameDecision: VisualOutputAtDecision | ProducerVisualDecision = props.maturity === 'draft'
    ? reviewProducerVisualAt(props.project, props.playhead) : reviewVisualOutputAt(props.project, props.playhead, 'program-monitor');
  const frameIssues: Issue[] = [...frameDecision.issues, ...(incomingActive ? nextFrameDecision.issues : []), ...(transitionActive ? transitionPolicy?.issues ?? [] : [])];
  return <div className="monitor" role="dialog" aria-label="콘티 시간순 재생"><div className="monitor-bar"><span>{props.maturity === 'draft' ? '제작자 검토 · 미승인 결과 포함' : 'FINAL PREVIEW · PROGRAM MONITOR'}</span><span>{transitionActive ? `${shot?.transitionOut.kind.toUpperCase()} · ${Math.round(transitionProgress * 100)}%` : ''}</span><time>{formatProjectTimecode(props.playhead, props.project.handoff.timebase)}</time><button onClick={props.onClose}>CLOSE</button></div>
    <VisualCompositionStage aspectWidth={props.project.profile.aspectWidth} aspectHeight={props.project.profile.aspectHeight} composition={composition}
      current={<PlaybackVisualImage project={props.project} decision={frameDecision} alt="현재 재생 프레임" />}
      incoming={nextFrameSafe ? <PlaybackVisualImage project={props.project} decision={nextFrameDecision} alt="다음 재생 프레임" /> : null}>
      <StoryboardTextOverlay project={props.project} atMs={props.playhead} maturity={props.maturity} onNotice={setTextNotice} />
    </VisualCompositionStage>
    {textNotice !== '' && <p className="text-layout-notice" role="status">{textNotice} · 제작 설정 → 글자 배치에서 조정하세요.</p>}
    {(blocked.length > 0 || frameIssues.length > 0) && <div className="output-blocked"><b>OUTPUT BLOCKED</b>{frameIssues.length > 0 && <p>{frame?.id} · {frameIssues.map((item: Issue): string => item.code).join(', ')} · NOW {props.playhead}ms</p>}{blocked.map((entry: BlockedCue): ReactElement => <p key={`${entry.channel}:${entry.cueId}`}>{entry.cueId} · {entry.issues.map((item: Issue): string => item.code).join(', ')} · INFORMATION {entry.informationIds.join(', ') || 'NONE'} · NOW {entry.atMs}ms · ALLOWED {entry.issues.map((item: Issue): string | null => item.expected).filter((value: string | null): value is string => value !== null).join(', ') || 'REVIEW'}</p>)}</div>}
    <StoryboardAudioNotes project={props.project} atMs={props.playhead} />
    <div className="monitor-controls"><button disabled={props.reviewPlayback.rate === null} onClick={props.onToggle}>{props.playing ? '검토 일시 정지' : '검토 재생'}</button><ReviewPlaybackControl preference={props.reviewPlayback} />
      <input type="range" aria-label="검토 재생 위치" min="0" max={props.project.dataset.segments.at(-1)?.endMs ?? 0} step="1" value={props.playhead} onChange={(event): void => { props.onSeek(Number(event.target.value)); }} />
      <button disabled={frameDecision.sourceFrameId === null} onClick={(): void => { if (frameDecision.sourceFrameId !== null) props.onInspect(frameDecision.sourceFrameId); }}>이 그림 편집</button></div>
    <p className="review-speed-note">검토 속도만 바뀝니다. 원본 음성과 제작 시간표는 유지됩니다.</p><div className="monitor-caption"><b>{shot?.id ?? 'END'}</b><span>{shot?.action ?? '재생 종료'}</span><em>{shot === null ? '' : `${shot.transitionOut.kind.toUpperCase()} ${shot.transitionOut.durationMs}ms`}</em></div></div>;
}

function FrameEditor(props: { project: Project; shot: Shot; frame: StoryboardFrame; working: boolean;
  onEdit: (frameId: string, input: StoryboardFrameInput) => Promise<void>; onReview: (frameId: string, review: StoryboardFrame['visualReview']) => Promise<void>;
  onGenerate: (frameId: string) => Promise<void>; }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, ...['frame', props.frame.id]]), { offsetMs: props.frame.offsetMs, role: props.frame.role, description: props.frame.description }, String(props.project.revision), StoryboardFrameInputSchema.extend({ offsetMs: z.number() }));
  const draft: StoryboardFrameInput = recovery.value; const setDraft = recovery.setValue;
  const [previewFailed, setPreviewFailed] = useState<boolean>(false);
  useEffect((): void => { setPreviewFailed(false); }, [props.frame.imageAssetId]);

  const outputState: string = reviewFrameLabel(props.project, props.frame);
  return <article className="frame-editor" id={`frame-editor-${props.frame.id}`} tabIndex={-1}>{recovery.notice}
    <header><b>{props.frame.role.toUpperCase()}</b><span>+{props.frame.offsetMs}ms · {outputState}</span></header>
    {props.frame.imageAssetId !== null && <figure className="frame-review-preview">{previewFailed ? <p role="alert">그림 파일을 확인하지 못했습니다. 자산 무결성 상태를 확인하세요.</p> : <img src={`/api/projects/${encodeURIComponent(props.project.projectId)}/assets/${encodeURIComponent(props.frame.imageAssetId)}`} alt={`${props.frame.role} 프레임 생성 결과 검토`} onError={(): void => { setPreviewFailed(true); }} />}<figcaption>그림 검토용 원본 · {props.frame.visualReview === 'accepted' ? '승인된 그림' : '미승인 그림'} · 최종 재생·출력은 별도 검사합니다.</figcaption></figure>}
    <p>STORED {props.frame.offsetMs}ms · DISPLAY {frameDisplayAbsoluteMs(props.shot, props.frame)}ms · EVALUATION {frameEvaluationAbsoluteMs(props.shot, props.frame)}ms</p>
    <div className="pair"><label className="field">프레임 역할<select disabled={props.frame.role === 'start'} value={draft.role} onChange={(event): void => { setDraft({ ...draft, role: event.target.value as StoryboardFrame['role'] }); }}><option value="start">시작</option><option value="key">키</option><option value="end">끝</option></select></label>
      <label className="field">컷 안의 위치 (ms)<input type="number" min="0" value={draft.offsetMs} onChange={(event): void => { setDraft({ ...draft, offsetMs: Number(event.target.value) }); }} /></label></div>
    <label className="field wide">프레임 설명<textarea value={draft.description} onChange={(event): void => { setDraft({ ...draft, description: event.target.value }); }} /></label>
    <div className="frame-actions"><button disabled={props.working || recovery.blocked} onClick={(): void => { void props.onEdit(props.frame.id, draft); }}>프레임 저장</button><button disabled={props.working || props.shot.visualMode !== 'sourced'} onClick={(): void => { void props.onGenerate(props.frame.id); }}>{props.shot.visualMode === 'sourced' ? props.frame.imageAssetId === null ? '그림 요청' : '다시 생성' : props.shot.visualMode.toUpperCase()}</button><button disabled={props.working || props.frame.imageAssetId === null} onClick={(): void => { void props.onReview(props.frame.id, 'accepted'); }}>이미지 승인</button><button disabled={props.working || props.frame.imageAssetId === null} onClick={(): void => { void props.onReview(props.frame.id, 'rejected'); }}>재생성 표시</button></div>
  </article>;
}

function AudioCueEditor(props: { reviewPlayback: ReviewPlaybackPreference; project: Project; cue: AudioCue; text: string; working: boolean; disclosure: string; reviewEnabled: boolean; onReviewPlayback: () => void; onRefresh: () => Promise<void>;
  onMix: (cueId: string, mix: AudioMixInput) => Promise<void>;
  onTiming: (cueId: string, input: AudioCueTimingInput) => Promise<void>; onSpeech: (cueId: string) => Promise<void>;
  onPrepare: (cueId: string, file: File) => Promise<void>; onAsset: (cueId: string, file: File) => Promise<void>; onNormalize: (cueId: string) => Promise<void>; }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, ...['audio-timing', props.cue.id]]), { startMs: props.cue.startMs, endMs: props.cue.endMs, timingRelation: props.cue.timingRelation }, String(props.project.revision), AudioCueTimingInputSchema.extend({ startMs: z.number(), endMs: z.number() }));
  const draft: AudioCueTimingInput = recovery.value; const setDraft = recovery.setValue;
  const [file, setFile] = useState<File | null>(null);
  const [retakeOpen, setRetakeOpen] = useState<boolean>(false);

  const unit = audioCueSource(props.project, props.cue);
  const sourceSegment = props.project.dataset.segments.find((candidate): boolean => candidate.id === unit?.segmentId);
  const playback = reviewAudioPlaybackAt(props.project, props.cue.startMs);
  const blocked = playback.blocked.find((entry: BlockedCue): boolean => entry.cueId === props.cue.id);
  const storyboardIssues: Issue[] = storyboardAudioIssues(props.project, props.cue);
  const asset: Asset | undefined = props.cue.assetId === null ? undefined : props.project.assets.find((candidate: Asset): boolean => candidate.id === props.cue.assetId);
  const needsNormalization: boolean = asset !== undefined && (asset.audioMetadata === undefined || asset.audioMetadata === null
    || asset.audioMetadata.sampleRate !== props.project.handoff.timebase.sampleRate || asset.audioMetadata.codec !== 'pcm_s16le'
    || props.cue.timingStatus !== 'prepared' && asset.durationMs !== props.cue.endMs - props.cue.startMs);
  return <article className="track-editor">{recovery.notice}<header><b>{props.cue.kind.toUpperCase()}</b><span>{props.cue.timingStatus.toUpperCase()}</span></header><p>{props.text}</p>
    {props.reviewEnabled && asset !== undefined && <AudioReviewPreview reviewPlayback={props.reviewPlayback} key={asset.id} projectId={props.project.projectId} cue={props.cue} asset={asset} onPlay={props.onReviewPlayback} />}
    {props.reviewEnabled && isSpeechCue(props.cue) && <details onToggle={(event): void => { setRetakeOpen(event.currentTarget.open); }}><summary>발화 선택 생성·비교</summary>{retakeOpen && <SpeechRetakePanel project={props.project} cue={props.cue} disabled={props.working} reviewPlayback={props.reviewPlayback} onPlay={props.onReviewPlayback} onRefresh={props.onRefresh} />}</details>}
    <AudioMixEditor project={props.project} cue={props.cue} working={props.working} onSave={props.onMix} />
    <p>SOURCE {sourceSegment?.id ?? 'UNKNOWN'} · RELATION {props.cue.timingRelation} · BEFORE {audioOverhangBeforeMs(props.project, props.cue)}ms · AFTER {audioOverhangAfterMs(props.project, props.cue)}ms</p>
    <p>{storyboardIssues.length === 0 ? '콘티 지시 · 원문·계획 시각 검사 통과' : `콘티 지시 검토 필요 · ${storyboardIssues.map((item: Issue): string => item.code).join(', ')}`}</p>
    <p>{blocked === undefined ? '선택 음성 · 재생 가능' : `선택 음성 · 재생 미준비 · ${blocked.issues.map((item: Issue): string => item.code).join(', ')}`}</p>
    <label className="field">TIMING RELATION<select value={draft.timingRelation} onChange={(event): void => { setDraft({ ...draft, timingRelation: event.target.value as AudioCue['timingRelation'] }); }}><option value="within-segment">WITHIN SEGMENT</option><option value="j-cut">J-CUT</option><option value="l-cut">L-CUT</option></select></label>
    <div className="pair"><label className="field">START MS<input type="number" min="0" value={draft.startMs} onChange={(event): void => { setDraft({ ...draft, startMs: Number(event.target.value) }); }} /></label><label className="field">END MS<input type="number" min="0" value={draft.endMs} onChange={(event): void => { setDraft({ ...draft, endMs: Number(event.target.value) }); }} /></label></div>
    {asset?.audioMetadata !== undefined && asset.audioMetadata !== null && <p>ASSET {asset.durationMs}ms · {asset.audioMetadata.sampleRate}Hz · {asset.audioMetadata.channels}ch · {asset.audioMetadata.codec} · v{asset.version}</p>}
    <input type="file" accept="audio/wav,audio/x-wav,.wav" onChange={(event: ChangeEvent<HTMLInputElement>): void => { setFile(event.target.files?.[0] ?? null); }} />
    {!isSpeechCue(props.cue) && (props.cue.assetId === null || props.cue.timingStatus === 'prepared') && <div className="external-audio-preparation">
      <p>{props.cue.timingStatus === 'prepared' ? '파일 준비 완료 · 아직 배치 대기입니다. 아래 시각은 자동 배치 허용 범위입니다.' : '효과음·음악 WAV를 준비하면 Codex가 해당 구간 안에서 실제 길이와 원문 공개 시점에 맞춰 배치합니다. J/L컷은 저장한 범위를 사용합니다.'}</p>
      <button disabled={props.working || file === null} onClick={(): void => { if (file !== null) void props.onPrepare(props.cue.id, file); }}>WAV 준비 · 자동 제작으로 이동</button>
    </div>}
    <div className="track-actions"><button disabled={props.working || recovery.blocked} onClick={(): void => { if (!recovery.blocked) void props.onTiming(props.cue.id, draft); }}>타이밍 저장</button>{(isSpeechCue(props.cue) || props.cue.assetId !== null && props.cue.timingStatus !== 'prepared') && <button disabled={props.working || file === null} onClick={(): void => { if (file !== null) void props.onAsset(props.cue.id, file); }}>WAV 등록</button>}{needsNormalization && <button disabled={props.working} onClick={(): void => { void props.onNormalize(props.cue.id); }}>WAV 정규화 복구</button>}{isSpeechCue(props.cue) && <button disabled={props.working} title={props.disclosure} onClick={(): void => { void props.onSpeech(props.cue.id); }}>{props.cue.assetId === null ? '수동 대기 요청 · CODEX VOICE' : '수동 대기 요청 · RETAKE'}</button>}</div>
  </article>;
}

const TextAuthorityDraftSchema = z.strictObject({ authority: z.enum(['source-unit', 'placement', 'mapping-decision']), target: z.string() });
const PlacementInformationDraftSchema = z.strictObject({ informationIds: z.array(z.string()), note: z.string() });

function TextCueEditor(props: { project: Project; cue: TextCue; working: boolean;
  onPresentation: (cueId: string, input: TextPresentationValues) => Promise<void>; onPresentationReset: (cueId: string) => Promise<void>;
  onTiming: (cueId: string, input: TextCueTimingInput) => Promise<void>;
  onConfirm: (cueId: string) => Promise<void>;
  onResolve: (cueId: string, input: TextCueAuthorityResolutionInput) => Promise<void>; onDelete: (cueId: string) => Promise<void>; }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'text-timing', props.cue.id]), { startMs: props.cue.startMs, endMs: props.cue.endMs, kind: props.cue.kind }, String(props.project.revision), TextCueTimingInputSchema.extend({ startMs: z.number(), endMs: z.number() }));
  const draft: TextCueTimingInput = recovery.value; const setDraft = recovery.setValue;
  const authorityDraft = useBrowserDraft(JSON.stringify([props.project.projectId, 'text-authority', props.cue.id]),
    { authority: 'source-unit' as const, target: '' }, String(props.project.revision), TextAuthorityDraftSchema);
  const resolutionAuthority: TextCueAuthorityResolutionInput['authority'] = authorityDraft.value.authority;
  const resolutionTarget: string = authorityDraft.value.target;

  const informationIds: string[] = textCueInformationIds(props.project, props.cue);
  const cueIssues: Issue[] = reviewIssuesForTextCue(props.project, props.cue.id);
  const gates: EffectiveInformationGate[] = informationIds.map((id: string): EffectiveInformationGate => effectiveInformationGate(props.project, id));
  const derived: boolean = props.cue.authority === 'mapping-decision';
  const placement: TextPlacement | undefined = props.cue.placementId === null ? undefined
    : props.project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === props.cue.placementId);
  const fixedPlacementEnd: boolean = props.cue.placementId !== null && placement?.endMs !== null;
  const draftDirty: boolean = draft.startMs !== props.cue.startMs || draft.endMs !== props.cue.endMs || draft.kind !== props.cue.kind;
  const resolutionTargets: string[] = resolutionAuthority === 'placement'
    ? props.project.dataset.textPlacements.filter((placement: TextPlacement): boolean => placement.segmentId === props.cue.segmentId).map((placement: TextPlacement): string => placement.id)
    : resolutionAuthority === 'mapping-decision' ? props.project.textMappingDecisions.filter((decision: TextMappingDecision): boolean => {
      const placement: TextPlacement | undefined = props.project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === decision.placementId);
      return placement?.segmentId === props.cue.segmentId;
    }).map((decision: TextMappingDecision): string => decision.id)
      : props.project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === props.cue.segmentId
        && ['SCREEN_TEXT', 'CHAT', 'NOTE', 'DIALOGUE', 'NARRATION', 'PANEL'].includes(unit.kind)).map((unit: SourceUnit): string => unit.id);
  const missingTarget: boolean = resolutionTarget !== '' && !resolutionTargets.includes(resolutionTarget);
  const resolutionBlocked: boolean = props.working || recovery.blocked || authorityDraft.blocked || resolutionTarget === '' || missingTarget;
  const resolve = (): void => {
    if (resolutionBlocked) return;
    const input: TextCueAuthorityResolutionInput = resolutionAuthority === 'placement' ? { authority: 'placement', placementId: resolutionTarget }
      : resolutionAuthority === 'mapping-decision' ? { authority: 'mapping-decision', mappingDecisionId: resolutionTarget }
        : { authority: 'source-unit', unitId: resolutionTarget, startMs: draft.startMs, endMs: draft.endMs, kind: draft.kind };
    void props.onResolve(props.cue.id, input);
  };
  return <article className="track-editor">{recovery.notice}<header><b>{props.cue.kind.toUpperCase()}</b><span>{props.cue.timingStatus.toUpperCase()}</span></header><p>{props.cue.text}</p>
    <p>AUTHORITY {props.cue.authority} · MAPPING {props.cue.mappingDecisionId ?? 'NONE'} · UNIT {props.cue.unitId ?? 'NONE'}</p>
    <p>INFORMATION {informationIds.join(', ') || 'NONE'} · GATE {gates.map((gate: EffectiveInformationGate): string => `${gate.id}:${gate.effectiveNotBeforeMs}`).join(', ') || 'NONE'} · {cueIssues.length === 0 ? props.cue.timingStatus === 'confirmed' ? 'TEXT CONFIRMED' : 'DRAFT · TIMING UNCONFIRMED' : `OUTPUT BLOCKED ${cueIssues.map((item: Issue): string => item.code).join(', ')}`}</p>
    <label className="field">TYPE<select disabled={props.cue.placementId !== null || derived} value={draft.kind} onChange={(event): void => { setDraft({ ...draft, kind: event.target.value as TextCue['kind'] }); }}><option value="overlay">오버레이</option><option value="prop-text">화면 속 글자</option><option value="dialogue-subtitle">대사 자막</option></select></label>
    <div className="pair"><label className="field">START MS<input disabled={props.cue.placementId !== null || derived} type="number" min="0" value={draft.startMs} onChange={(event): void => { setDraft({ ...draft, startMs: Number(event.target.value) }); }} /></label><label className="field">END MS<input disabled={fixedPlacementEnd || derived} type="number" min="0" value={draft.endMs} onChange={(event): void => { setDraft({ ...draft, endMs: Number(event.target.value) }); }} /></label></div>
    <div className="track-actions"><button disabled={props.working || recovery.blocked || fixedPlacementEnd || derived} onClick={(): void => { if (!recovery.blocked) void props.onTiming(props.cue.id, draft); }}>{derived ? 'MAPPING에서 수정' : fixedPlacementEnd ? 'PLACEMENT 시각 읽기 전용' : props.cue.placementId !== null ? '종료 시각 저장' : '글자 트랙 저장'}</button><button disabled={props.working || draftDirty || props.cue.timingStatus === 'confirmed' || cueIssues.length > 0} onClick={(): void => { void props.onConfirm(props.cue.id); }}>{props.cue.timingStatus === 'confirmed' ? '시각 확정됨' : draftDirty ? '변경 저장 후 확정' : '시각 확정'}</button></div>
    <TextPresentationEditor project={props.project} cue={props.cue} working={props.working} onSave={props.onPresentation} onReset={props.onPresentationReset} />
    {props.cue.authority === 'review-required' && <section className="authority-resolution" aria-label="글자 본문 근거 연결">{authorityDraft.notice}
      <label className="field">본문 근거 종류<select disabled={props.working} value={resolutionAuthority} onChange={(event): void => { authorityDraft.setValue({ authority: TextAuthorityDraftSchema.shape.authority.parse(event.target.value), target: '' }); }}><option value="source-unit">원문 단위</option><option value="placement">자막 위치</option><option value="mapping-decision">문구 연결 결정</option></select></label>
      <label className="field">연결할 근거<select disabled={props.working} value={resolutionTarget} onChange={(event): void => { authorityDraft.setValue({ ...authorityDraft.value, target: event.target.value }); }}><option value="">근거 선택</option>{missingTarget && <option value={resolutionTarget}>현재 원본에 없는 근거 · {resolutionTarget}</option>}{resolutionTargets.map((id: string): ReactElement => <option key={id} value={id}>{id}</option>)}</select></label>
      {missingTarget && <p role="alert">복원한 근거가 현재 구간에 없습니다. 연결 대상을 다시 선택하세요.</p>}
      <div className="track-actions"><button disabled={resolutionBlocked} onClick={resolve}>권한 확정</button><button disabled={props.working} onClick={(): void => { void props.onDelete(props.cue.id); }}>검토 Cue 삭제</button></div></section>}
  </article>;
}

function mappingInput(decision: TextMappingDecision): TextMappingDecisionInput {
  return {
    canonicalUnitId: decision.canonicalUnitId, relation: decision.relation, status: decision.status,
    renderCanonicalSeparately: decision.renderCanonicalSeparately, canonicalStartMs: decision.canonicalStartMs,
    canonicalEndMs: decision.canonicalEndMs, note: decision.note,
  };
}

function optionalMilliseconds(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

function sourceTemporalAnchor(kind: SourceTemporalAnchor['kind'], current: SourceTemporalAnchor, frames: readonly StoryboardFrame[], shotDurationMs: number): SourceTemporalAnchor {
  if (kind === 'unresolved') return { kind: 'unresolved', basis: 'estimated', status: 'review-required' };
  if (kind === 'shot-offset') {
    return current.kind === 'shot-offset'
      ? current
      : { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: shotDurationMs, basis: 'manual', status: 'confirmed' };
  }
  const frame: StoryboardFrame | undefined = current.kind === 'frame' || current.kind === 'frame-range'
    ? frames.find((candidate: StoryboardFrame): boolean => candidate.id === current.frameId)
    : frames[0];
  if (frame === undefined) throw new Error('프레임 Anchor를 지정하려면 컷에 프레임을 먼저 추가하세요.');
  return kind === 'frame-range' ? { kind, frameId: frame.id, endOffsetMs: current.kind === 'frame-range' ? current.endOffsetMs : shotDurationMs, basis: 'manual', status: 'confirmed' }
    : { kind: 'frame', frameId: frame.id, basis: 'manual', status: 'confirmed' };
}

function TextMappingEditor(props: { project: Project; decision: TextMappingDecision; placement: TextPlacement; units: SourceUnit[]; issues: Issue[]; working: boolean;
  onSave: (decisionId: string, input: TextMappingDecisionInput) => Promise<void>; }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'text-mapping', props.decision.id]), mappingInput(props.decision), String(props.project.revision), TextMappingDecisionInputSchema.extend({ canonicalStartMs: z.number().nullable(), canonicalEndMs: z.number().nullable() }));
  const draft: TextMappingDecisionInput = recovery.value; const setDraft = recovery.setValue;
  const canonical: SourceUnit | undefined = props.units.find((unit: SourceUnit): boolean => unit.id === draft.canonicalUnitId);
  const refs: string = [...props.placement.sourceRefs, ...(canonical?.sourceRefs ?? [])].map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ');
  return <article className={draft.status === 'unresolved' ? 'mapping-editor unresolved' : 'mapping-editor'}>{recovery.notice}
    <header><b>{draft.status.toUpperCase()}</b><span>{props.placement.startMs}ms</span></header>
    <label className="field">PLACEMENT<textarea readOnly value={props.placement.text} /></label>
    <label className="field">CANONICAL UNIT<select disabled={draft.relation === 'standalone-placement'} value={draft.canonicalUnitId ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalUnitId: event.target.value || null, status: 'unresolved' }); }}><option value="">미지정</option>{props.units.filter((unit: SourceUnit): boolean => ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind)).map((unit: SourceUnit): ReactElement => <option key={unit.id} value={unit.id}>{unit.order}. {unit.id} · {unit.kind}</option>)}</select></label>
    <p className="canonical-text">{canonical?.text ?? '연결할 Canonical 원문을 선택하세요.'}</p>
    <div className="pair"><label className="field">RELATION<select value={draft.relation} onChange={(event): void => { const relation = event.target.value as TextMappingDecision['relation']; setDraft({ ...draft, relation, canonicalUnitId: relation === 'standalone-placement' ? null : draft.canonicalUnitId, renderCanonicalSeparately: relation === 'separate-element', canonicalStartMs: null, canonicalEndMs: null, status: 'unresolved' }); }}><option value="exact">exact</option><option value="abbreviation">abbreviation</option><option value="replacement">replacement</option><option value="separate-element">separate-element</option><option value="standalone-placement">standalone-placement</option></select></label><label className="field">STATUS<select value={draft.status} onChange={(event): void => { setDraft({ ...draft, status: event.target.value as TextMappingDecision['status'] }); }}><option value="unresolved">unresolved</option><option value="confirmed">confirmed</option></select></label></div>
    <label className="check-row"><input disabled={draft.relation === 'exact' || draft.relation === 'standalone-placement' || draft.relation === 'separate-element'} type="checkbox" checked={draft.renderCanonicalSeparately} onChange={(event): void => { setDraft({ ...draft, renderCanonicalSeparately: event.target.checked, canonicalStartMs: null, canonicalEndMs: null, status: 'unresolved' }); }} />Canonical 원문 별도 렌더링</label>
    {draft.renderCanonicalSeparately && <div className="pair"><label className="field">CANONICAL START<input type="number" min="0" value={draft.canonicalStartMs ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalStartMs: optionalMilliseconds(event.target.value), status: 'unresolved' }); }} /></label><label className="field">CANONICAL END<input type="number" min="0" value={draft.canonicalEndMs ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalEndMs: optionalMilliseconds(event.target.value), status: 'unresolved' }); }} /></label></div>}
    <label className="field">NOTE<input value={draft.note ?? ''} onChange={(event): void => { setDraft({ ...draft, note: event.target.value || null }); }} /></label>
    {props.issues.map((item: Issue, index: number): ReactElement => <p className="mapping-issue" key={`${item.code}:${item.entityId}:${index}`}>{item.code} · {item.message}</p>)}
    <small className="source-ref">{refs}</small><button disabled={props.working || recovery.blocked} onClick={(): void => { void props.onSave(props.decision.id, draft); }}>Mapping 저장</button>
  </article>;
}

function PlacementInformationEditor(props: { project: Project; mapping: TextMappingDecision; placement: TextPlacement; working: boolean;
  onSave: (placementId: string, input: TextPlacementInformationInput) => Promise<void>; }): ReactElement | null {
  const decision: TextPlacementInformationDecision | undefined = props.project.textPlacementInformationDecisions
    .find((candidate: TextPlacementInformationDecision): boolean => candidate.placementId === props.placement.id);
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'placement-information', props.placement.id]),
    { informationIds: decision?.informationIds ?? [], note: decision?.note ?? '' }, String(props.project.revision), PlacementInformationDraftSchema);
  const { informationIds: selectedIds, note } = recovery.value;
  const missingIds: string[] = selectedIds.filter((id: string): boolean => !props.project.dataset.informationRules.some((rule): boolean => rule.id === id));
  const blocked: boolean = props.working || recovery.blocked;
  const save = (input: TextPlacementInformationInput): void => { if (!blocked && (input.status !== 'informational' || missingIds.length === 0)) void props.onSave(props.placement.id, input); };
  if (!['separate-element', 'standalone-placement'].includes(props.mapping.relation)) return null;
  const cue: TextCue | undefined = props.project.textCues.find((candidate: TextCue): boolean => candidate.placementId === props.placement.id);
  const issues: Issue[] = cue === undefined ? [] : reviewIssuesForTextCue(props.project, cue.id);
  return <article aria-label={`독립 글자 정보 검토 · ${props.placement.id}`} className={decision?.status === 'unresolved' ? 'mapping-editor unresolved' : 'mapping-editor'}>{recovery.notice}
    <header><b>PLACEMENT INFORMATION</b><span>{decision?.status.toUpperCase() ?? 'MISSING'}</span></header>
    <p>{props.placement.id} · {props.mapping.relation} · START {props.placement.startMs}ms</p>
    <p className="canonical-text">{props.placement.text}</p>
    {props.project.dataset.informationRules.map((rule): ReactElement => {
      const gate: EffectiveInformationGate = effectiveInformationGate(props.project, rule.id);
      const checked: boolean = selectedIds.includes(rule.id);
      return <label className="check-row" key={rule.id}><input type="checkbox" disabled={props.working} checked={checked} onChange={(event): void => {
        recovery.setValue({ ...recovery.value, informationIds: event.target.checked ? [...selectedIds, rule.id] : selectedIds.filter((id: string): boolean => id !== rule.id) });
      }} /><span>{rule.id} · BASE {gate.baseNotBeforeMs} · EFFECTIVE {gate.effectiveNotBeforeMs} · {rule.segmentId}</span></label>;
    })}
    {missingIds.map((id: string): ReactElement => <label className="check-row" key={id}><input type="checkbox" disabled={props.working} checked onChange={(): void => { recovery.setValue({ ...recovery.value, informationIds: selectedIds.filter((selected: string): boolean => selected !== id) }); }} /><span>현재 원본에 없는 정보 · {id}</span></label>)}
    {missingIds.length > 0 && <p role="alert">복원한 정보 ID가 현재 원본에 없습니다. 선택을 해제하고 연결을 다시 검토하세요.</p>}
    <label className="field">정보 연결 검토 메모<input disabled={props.working} value={note} onChange={(event): void => { recovery.setValue({ ...recovery.value, note: event.target.value }); }} /></label>
    <p>{issues.length === 0 && decision?.status !== 'unresolved' ? 'OUTPUT ALLOWED' : `OUTPUT BLOCKED · ${issues.map((item: Issue): string => item.code).join(', ') || 'PLACEMENT_INFORMATION_REVIEW_REQUIRED'}`}</p>
    <div className="mapping-actions"><button disabled={blocked} onClick={(): void => { save({ status: 'non-informational', informationIds: [], note: note || null }); }}>Non-informational</button>
      <button disabled={blocked || selectedIds.length === 0 || missingIds.length > 0} onClick={(): void => { save({ status: 'informational', informationIds: selectedIds, note: note || null }); }}>Information 연결</button>
      <button disabled={blocked} onClick={(): void => { save({ status: 'unresolved', informationIds: [], note: note || null }); }}>Unresolved로 재설정</button></div>
  </article>;
}

function SourceMappingEditor(props: { link: ShotSourceLink; unit: SourceUnit; frames: StoryboardFrame[]; shotDurationMs: number; absoluteRevealMs: number | null; gateComparisons: SourceGateComparison[]; working: boolean; moveBlocked: boolean; previousShotId: string | null; nextShotId: string | null;
  onChange: (link: ShotSourceLink) => void; onRemove: () => void; onMove: (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']) => Promise<void>; }): ReactElement {
  const draft: ShotSourceLink = props.link;
  const setDraft: (link: ShotSourceLink) => void = props.onChange;
  return <article className={draft.status === 'mapping-required' || draft.temporalAnchor.status === 'review-required' ? 'mapping-editor unresolved' : 'mapping-editor'}>
    <header><b>{draft.status.toUpperCase()}</b><span>{props.unit.order} · {props.unit.kind}</span></header><strong>{props.unit.id}</strong><p>{props.unit.text}</p>
    <div className="pair"><label className="field">USAGE<select aria-label="USAGE" value={draft.usage} onChange={(event): void => { setDraft({ ...draft, usage: event.target.value as ShotSourceLink['usage'] }); }}><option value="primary-visual">primary-visual</option><option value="continued-visual">continued-visual</option><option value="audio-only">audio-only</option><option value="context-only">context-only</option></select></label><label className="field">STATUS<select value={draft.status} onChange={(event): void => { setDraft({ ...draft, status: event.target.value as ShotSourceLink['status'] }); }}><option value="confirmed">confirmed</option><option value="mapping-required">mapping-required</option></select></label></div>
    <label className="field">TEMPORAL ANCHOR<select value={draft.temporalAnchor.kind} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: sourceTemporalAnchor(event.target.value as SourceTemporalAnchor['kind'], draft.temporalAnchor, props.frames, props.shotDurationMs) }); }}><option value="shot-offset">shot-offset</option><option value="frame" disabled={props.frames.length === 0}>frame · 공개 점만</option><option value="frame-range" disabled={props.frames.length === 0}>frame-range · 표시 구간</option><option value="unresolved">unresolved</option></select></label>
    {draft.temporalAnchor.kind === 'shot-offset' && <div className="pair"><label className="field">ANCHOR START<input type="number" min="0" max={props.shotDurationMs} value={draft.temporalAnchor.startOffsetMs} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'shot-offset' }>, startOffsetMs: Number(event.target.value), basis: 'manual' } }); }} /></label><label className="field">ANCHOR END<input type="number" min="1" max={props.shotDurationMs} value={draft.temporalAnchor.endOffsetMs} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'shot-offset' }>, endOffsetMs: Number(event.target.value), basis: 'manual' } }); }} /></label></div>}
    {(draft.temporalAnchor.kind === 'frame' || draft.temporalAnchor.kind === 'frame-range') && <label className="field">ANCHOR FRAME<select value={draft.temporalAnchor.frameId} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'frame' | 'frame-range' }>, frameId: event.target.value, basis: 'manual', status: 'confirmed' } }); }}>{props.frames.map((frame: StoryboardFrame): ReactElement => <option key={frame.id} value={frame.id}>{frame.role} · +{frame.offsetMs}ms</option>)}</select></label>}
    {draft.temporalAnchor.kind === 'frame-range' && <label className="field">VISUAL END OFFSET MS<input type="number" min="1" max={props.shotDurationMs} value={draft.temporalAnchor.endOffsetMs} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'frame-range' }>, endOffsetMs: Number(event.target.value), basis: 'manual' } }); }} /></label>}
    {draft.temporalAnchor.kind === 'frame' && <p className="mapping-issue">SOURCE_VISUAL_INTERVAL_REQUIRED · 공개 점은 표시 구간이 아닙니다. frame-range의 종료 시각을 검토한 뒤 저장하세요.</p>}
    <p className="canonical-text">{draft.temporalAnchor.status.toUpperCase()} · {draft.temporalAnchor.basis}</p>
    <p className="canonical-text">ABSOLUTE REVEAL · {props.absoluteRevealMs === null ? 'REVIEW REQUIRED' : `${props.absoluteRevealMs}ms`}</p>
    {props.gateComparisons.map((comparison: SourceGateComparison): ReactElement => <p className={`mapping-issue ${comparison.result}`} key={comparison.informationId}>GATE · {comparison.informationId} · {comparison.gateMs === null ? 'RULE MISSING' : `${comparison.gateMs}ms`} · {comparison.result.toUpperCase()}</p>)}
    <small className="source-ref">{props.unit.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}</small>
    <div className="mapping-actions"><button disabled={props.working} onClick={props.onRemove}>Source 제거</button>{props.previousShotId !== null && <button disabled={props.working || props.moveBlocked} onClick={(): void => { void props.onMove(props.unit.id, props.previousShotId as string, draft.usage); }}>← 앞 컷으로 이동</button>}{props.nextShotId !== null && <button disabled={props.working || props.moveBlocked} onClick={(): void => { void props.onMove(props.unit.id, props.nextShotId as string, draft.usage); }}>뒤 컷으로 이동 →</button>}</div>
  </article>;
}

function VisualPlanEditor(props: { project: Project; shot: Shot; working: boolean; onSave: (input: ShotVisualPlanInput) => Promise<void>;
  onMove: (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']) => Promise<void>; }): ReactElement {
  const recovery = useBrowserDraft(JSON.stringify([props.project.projectId, ...['visual-plan', props.shot.id]]), { visualMode: props.shot.visualMode, sourceLinks: props.shot.sourceLinks }, String(props.project.revision), ShotVisualPlanInputSchema);
  const draft: ShotVisualPlanInput = recovery.value; const setDraft = recovery.setValue;

  const nextShot: Shot = { ...props.shot, ...draft };
  const nextProject: Project = { ...props.project, shots: props.project.shots.map((shot: Shot): Shot => shot.id === nextShot.id ? nextShot : shot) };
  const review: VisualPlanChangeReview = reviewShotVisualPlanChange(props.project, props.shot.id, draft);
  const issues: Issue[] = review.blockingIssues;
  const coverageIssues: Issue[] = issues.filter((value: Issue): boolean => value.code === 'SHOT_VISUAL_COVERAGE_GAP');
  const frames: StoryboardFrame[] = props.project.frames.filter((frame: StoryboardFrame): boolean => frame.shotId === props.shot.id);
  const units: SourceUnit[] = props.project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === props.shot.segmentId);
  const available: SourceUnit[] = units.filter((unit: SourceUnit): boolean => !draft.sourceLinks.some((link: ShotSourceLink): boolean => link.unitId === unit.id));
  const index: number = props.project.shots.findIndex((shot: Shot): boolean => shot.id === props.shot.id);
  const previous: Shot | undefined = props.project.shots[index - 1];
  const following: Shot | undefined = props.project.shots[index + 1];
  const dirty: boolean = JSON.stringify(draft) !== JSON.stringify({ visualMode: props.shot.visualMode, sourceLinks: props.shot.sourceLinks });
  const updateLink = (next: ShotSourceLink): void => { setDraft({ ...draft, sourceLinks: draft.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === next.unitId ? next : link) }); };
  return <section className="inspector-section source-block visual-plan-editor"><header>VISUAL PLAN <span>{draft.sourceLinks.length} SOURCE</span></header>{recovery.notice}
    <label className="field wide">VISUAL MODE<select aria-label="VISUAL MODE" value={draft.visualMode} onChange={(event): void => { setDraft({ ...draft, visualMode: event.target.value as ShotVisualPlanInput['visualMode'] }); }}><option value="sourced">SOURCED</option><option value="black">BLACK</option><option value="hold-previous">HOLD PREVIOUS</option></select></label>
    <p>{draft.visualMode === 'sourced' ? coverageIssues.length === 0 ? 'COVERAGE COMPLETE' : `COVERAGE GAP · ${coverageIssues.length}` : draft.visualMode.toUpperCase()}</p>
    <p>{props.shot.startMs}–{props.shot.endMs}ms · {dirty ? 'UNSAVED VISUAL PLAN' : 'SAVED VISUAL PLAN'}</p>
    {draft.sourceLinks.map((link: ShotSourceLink): ReactElement => {
      const unit: SourceUnit | undefined = units.find((value: SourceUnit): boolean => value.id === link.unitId);
      if (unit === undefined) return <p key={link.unitId}>UNKNOWN_SOURCE_UNIT · {link.unitId}</p>;
      return <SourceMappingEditor key={link.unitId} link={link} unit={unit} frames={frames} shotDurationMs={props.shot.endMs - props.shot.startMs}
        absoluteRevealMs={sourceRevealEvidenceMs(nextProject, nextShot, link)} gateComparisons={sourceGateComparisons(nextProject, nextShot, link, unit)}
        working={props.working} moveBlocked={dirty} previousShotId={previous?.segmentId === props.shot.segmentId ? previous.id : null}
        nextShotId={following?.segmentId === props.shot.segmentId ? following.id : null} onChange={updateLink} onMove={props.onMove}
        onRemove={(): void => { setDraft({ ...draft, sourceLinks: draft.sourceLinks.filter((value: ShotSourceLink): boolean => value.unitId !== link.unitId) }); }} />;
    })}
    {available.length > 0 && <label className="field">SOURCE 추가<select value="" disabled={props.working} onChange={(event): void => {
      if (event.target.value !== '') setDraft({ ...draft, sourceLinks: [...draft.sourceLinks, { unitId: event.target.value, usage: 'context-only', status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'estimated', status: 'review-required' } }] });
    }}><option value="">원문 선택</option>{available.map((unit: SourceUnit): ReactElement => <option key={unit.id} value={unit.id}>{unit.order} · {unit.id} · {unit.kind}</option>)}</select></label>}
    {issues.length > 0 && <div className="approval-review" aria-live="polite">{issues.map((value: Issue, issueIndex: number): ReactElement => <p key={`${value.code}:${issueIndex}`}>{value.code} · {value.entityId} · {value.message}</p>)}</div>}
    {review.existingUnrelatedIssues.length > 0 && <div className="existing-segment-review" aria-live="polite"><p>기존 구간 검토 항목 · 이번 수정은 저장 가능하며 승인·Final 검사는 유지됩니다.</p>
      {review.existingUnrelatedIssues.map((value: Issue, issueIndex: number): ReactElement => <p key={`${value.code}:${issueIndex}`}>{value.code} · {value.entityId} · {value.message}</p>)}</div>}
    <button className="primary" disabled={props.working || recovery.blocked || !dirty || issues.length > 0} onClick={(): void => { void props.onSave(draft); }}>Visual Plan 저장</button>
  </section>;
}

function Inspector(props: { reviewPlayback: ReviewPlaybackPreference; page: InspectorPage; workspacePage: WorkspacePage; onPage: (page: InspectorPage) => void; project: Project; segment: Segment; shot: Shot | null; draft: ShotContent | null; draftNotice: ReactElement | null; draftBlocked: boolean; working: boolean; status: AppStatus | null; reviewEnabled: boolean; onReviewPlayback: () => void; onRefresh: () => Promise<void>;
  onDraft: (draft: ShotContent) => void; onSave: () => Promise<void>; onSplit: () => Promise<void>; onMerge: () => Promise<void>;
  onMove: (direction: -1 | 1) => Promise<void>; onLocks: (fields: LockedField[]) => Promise<void>; onApprove: () => Promise<void>;
  onSpeech: (cueId: string) => Promise<void>; onAudioPrepare: (cueId: string, file: File) => Promise<void>; onAudioAsset: (cueId: string, file: File) => Promise<void>; onAudioNormalize: (cueId: string) => Promise<void>; onReference: (draft: ReferenceDraft) => Promise<void>;
  onFrameEdit: (frameId: string, input: StoryboardFrameInput) => Promise<void>; onFrameAdd: (shotId: string, input: StoryboardFrameInput) => Promise<void>;
  onFrameGenerate: (frameId: string) => Promise<void>; onFrameReview: (frameId: string, review: StoryboardFrame['visualReview']) => Promise<void>;
  onAudioInstruction: (input: AudioInstructionInput) => Promise<void>; onAudioInstructionConfirm: (id: string) => Promise<void>;
  onAudioMix: (cueId: string, mix: AudioMixInput) => Promise<void>;
  onAudioTiming: (cueId: string, input: AudioCueTimingInput) => Promise<void>; onTextTiming: (cueId: string, input: TextCueTimingInput) => Promise<void>;
  onTextConfirm: (cueId: string) => Promise<void>;
  onTextResolve: (cueId: string, input: TextCueAuthorityResolutionInput) => Promise<void>; onTextDelete: (cueId: string) => Promise<void>;
  onTextMapping: (decisionId: string, input: TextMappingDecisionInput) => Promise<void>;
  onPlacementInformation: (placementId: string, input: TextPlacementInformationInput) => Promise<void>;
  onVisualPlan: (input: ShotVisualPlanInput) => Promise<void>;
  onSourceMove: (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']) => Promise<void>;
  onTextTypography: (value: TextTypography) => Promise<void>;
  onTextPresentation: (cueId: string, value: TextPresentationValues) => Promise<void>; onTextPresentationReset: (cueId: string) => Promise<void>;
  onTextLayout: (value: TextLayoutPreset, mode: TextLayoutControl['mode']) => Promise<void>;
  onTextReadability: (value: TextReadabilityPolicy) => Promise<void>;
  onProfile: (profile: Profile) => Promise<void>;
  onSourcePreview: (path: string, holdMs: number) => Promise<ReviewedSourceImpact | null>; onSourceApply: (path: string, holdMs: number, basisSha256: string) => Promise<void>; }): ReactElement {
  const profileRecovery = useBrowserDraft(JSON.stringify([props.project.projectId, 'profile']), props.project.profile, String(props.project.revision), ProfileSchema.extend({ aspectWidth: z.number(), aspectHeight: z.number() }));
  const profileDraft: Profile = profileRecovery.value; const setProfileDraft = profileRecovery.setValue;
  const shot: Shot | null = props.shot;
  const frames: StoryboardFrame[] = shot === null ? [] : props.project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id).sort((left, right): number => left.offsetMs - right.offsetMs);
  const audio: AudioCue[] = props.project.audioCues.filter((cue: AudioCue): boolean => {
    const unit = audioCueSource(props.project, cue);
    return unit?.segmentId === props.segment.id;
  });
  const text: TextCue[] = props.project.textCues.filter((cue: TextCue): boolean => cue.segmentId === props.segment.id);
  const textMappings: { decision: TextMappingDecision; placement: TextPlacement }[] = props.project.textMappingDecisions.flatMap((decision: TextMappingDecision) => {
    const placement: TextPlacement | undefined = props.project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId && value.segmentId === props.segment.id);
    return placement === undefined ? [] : [{ decision, placement }];
  });
  const duration: number = shot === null ? 0 : shot.endMs - shot.startMs;
  const frameOffsets: Set<number> = new Set(frames.map((frame: StoryboardFrame): number => frame.offsetMs));
  const keyOffset: number = Math.floor(duration / 2);
  const continuityAssets: Asset[] = props.project.assets.filter((asset: Asset): boolean => ['character', 'location', 'prop'].includes(asset.kind));
  const shotIndex: number = shot === null ? -1 : props.project.shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
  const previousShot: Shot | undefined = shotIndex <= 0 ? undefined : props.project.shots[shotIndex - 1];
  const nextShot: Shot | undefined = shotIndex < 0 ? undefined : props.project.shots[shotIndex + 1];
  const approvalIssues: Issue[] = shot === null ? [] : approvalIssuesForShot(props.project, shot.id);
  const textMappingIssues: Issue[] = textMappingReviewIssues(props.project, props.segment.id);
  const informationGates: EffectiveInformationGate[] = props.project.dataset.informationRules
    .filter((rule): boolean => rule.segmentId === props.segment.id)
    .map((rule): EffectiveInformationGate => effectiveInformationGate(props.project, rule.id));
  const continuityReview: string[] = props.draft === null ? [] : [
    ...(previousShot === undefined ? [] : continuityNotices(previousShot.continuityAfter, props.draft.continuityBefore, continuityAssets)),
    ...(nextShot === undefined ? [] : continuityNotices(props.draft.continuityAfter, nextShot.continuityBefore, continuityAssets)),
  ];

  return <aside className="inspector" aria-label="콘티 편집 패널" data-inspector-page={props.page}><div className="column-head"><span>{props.workspacePage === 'settings' ? '프로젝트 제작 기준' : '선택 컷 편집'}</span><b>{shot === null ? '—' : shot.approvalStatus.toUpperCase()}</b></div>
    <div hidden={props.workspacePage === 'settings'}><InspectorNavigation page={props.page} onChange={props.onPage} /></div>
    <div className="inspector-scroll">
    <section hidden={props.workspacePage === 'settings'}>
    {shot === null && <p className="empty-note">이 구간에는 컷이 없습니다. 컷 제안을 요청하세요.</p>}
    {shot !== null && props.draft !== null && <>
      <div hidden={props.page !== 'frames' && props.page !== 'audio'}><GenerationGuide projectId={props.project.projectId} /></div>
      <p className="inspector-hint">{inspectorPages.find((page): boolean => page.id === props.page)?.hint}</p>
      <div className="inspector-title"><span>{shot.id}</span><time>{formatProjectTimecode(shot.startMs, props.project.handoff.timebase)} — {formatProjectTimecode(shot.endMs, props.project.handoff.timebase)}</time></div>

      <section hidden={props.page !== 'direction'}>{props.draftNotice}<label className="field wide">행동·연출<textarea value={props.draft.action} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, action: event.target.value }); }} /></label>
      <div className="field-grid">
        <label className="field">구도<input value={props.draft.camera.size} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, size: event.target.value } }); }} /></label>
        <label className="field">앵글<input value={props.draft.camera.angle} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, angle: event.target.value } }); }} /></label>
        <label className="field wide">카메라 움직임<input value={props.draft.camera.move} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, move: event.target.value } }); }} /></label>
      </div>
      <label className="field wide">화면 장소<select value={props.draft.visualLocationId ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, visualLocationId: event.target.value || null }); }}><option value="">미정</option>{productionLocations(props.project).map((location): ReactElement => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
      </section><section hidden={props.page !== 'frames'}><section className="inspector-section frame-list"><header>스토리보드 프레임 <span>{frames.length}</span></header>{frames.map((frame: StoryboardFrame): ReactElement => <FrameEditor key={frame.id} project={props.project} shot={shot} frame={frame} working={props.working} onEdit={props.onFrameEdit} onReview={props.onFrameReview} onGenerate={props.onFrameGenerate} />)}
        <div className="frame-add-actions">{keyOffset > 0 && keyOffset < duration && !frameOffsets.has(keyOffset) && <button disabled={props.working} onClick={(): void => { void props.onFrameAdd(shot.id, { offsetMs: keyOffset, role: 'key', description: `${shot.action} 중간 동작` }); }}>＋ 키 프레임</button>}{!frames.some((frame: StoryboardFrame): boolean => frame.role === 'end') && !frameOffsets.has(duration) && <button disabled={props.working} onClick={(): void => { void props.onFrameAdd(shot.id, { offsetMs: duration, role: 'end', description: `${shot.action} 종료 상태` }); }}>＋ 끝 프레임</button>}</div>
      </section>
      </section><section hidden={props.page !== 'direction'}><div className="pair"><label className="field">카메라 축<input value={props.draft.cameraAxis ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, cameraAxis: event.target.value || null }); }} /></label><label className="field">화면 방향<input value={props.draft.screenDirection ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, screenDirection: event.target.value || null }); }} /></label></div>
      <section className="inspector-section transition-edit"><header>다음 컷 전환 <span>{props.draft.transitionOut.kind.toUpperCase()}</span></header><div className="pair"><label className="field">TYPE<select value={props.draft.transitionOut.kind} onChange={(event): void => { const kind = event.target.value as ShotContent['transitionOut']['kind']; const currentDuration: number = (props.draft as ShotContent).transitionOut.durationMs; props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, kind, incomingExposure: intrinsicIncomingExposure(kind), durationMs: kind === 'cut' ? 0 : currentDuration > 0 ? currentDuration : Math.min(500, duration) } }); }}><option value="cut">CUT</option><option value="dissolve">DISSOLVE</option><option value="fade">FADE</option><option value="wipe">WIPE</option><option value="match-cut">MATCH CUT</option><option value="custom">CUSTOM</option></select></label><label className="field">DURATION MS<input disabled={props.draft.transitionOut.kind === 'cut'} type="number" min="0" value={props.draft.transitionOut.durationMs} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, durationMs: Number(event.target.value) } }); }} /></label></div><label className="field">INCOMING EXPOSURE<select aria-label="INCOMING EXPOSURE" value={props.draft.transitionOut.incomingExposure ?? intrinsicIncomingExposure(props.draft.transitionOut.kind)} disabled={props.draft.transitionOut.kind !== 'custom' && props.draft.transitionOut.kind !== 'fade'} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, incomingExposure: event.target.value as NonNullable<ShotContent['transitionOut']['incomingExposure']> } }); }}>{(props.draft.transitionOut.kind === 'custom' ? ['review-required', 'none', 'from-transition-start', 'after-black-midpoint'] : props.draft.transitionOut.kind === 'fade' ? ['none', 'after-black-midpoint'] : [intrinsicIncomingExposure(props.draft.transitionOut.kind)]).map((policy: string): ReactElement => <option key={policy} value={policy}>{policy}</option>)}</select></label><label className="field wide">NOTE<input value={props.draft.transitionOut.note} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, note: event.target.value } }); }} /></label></section>
      <section className="inspector-section"><header>화면 등장 <span>{props.draft.presence.length}</span></header>{props.project.dataset.people.map((person): ReactElement => {
        const current = props.draft?.presence.find((presence): boolean => presence.personId === person.id);
        return <div className="presence-row" key={person.id}><label><input type="checkbox" checked={current !== undefined} onChange={(event): void => { const next = event.target.checked ? [...(props.draft as ShotContent).presence, { personId: person.id, mode: 'VISIBLE' as const }] : (props.draft as ShotContent).presence.filter((presence): boolean => presence.personId !== person.id); props.onDraft({ ...props.draft as ShotContent, presence: next }); }} />{person.name}</label>
          {current !== undefined && <select value={current.mode} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, presence: (props.draft as ShotContent).presence.map((presence) => presence.personId === person.id ? { ...presence, mode: event.target.value as typeof presence.mode } : presence) }); }}>{['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'OFFSCREEN_VOICE', 'VOICE_OVER', 'IMPLIED', 'ARCHIVE_IMAGE'].map((mode: string): ReactElement => <option key={mode}>{mode}</option>)}</select>}</div>;
      })}</section>
      <section className="inspector-section"><header>소품 참조</header>{props.project.assets.filter((asset: Asset): boolean => asset.kind === 'prop').map((asset: Asset): ReactElement => <label className="check-row" key={asset.id}><input type="checkbox" checked={props.draft?.propIds.includes(asset.id) ?? false} onChange={(event): void => { const propIds: string[] = event.target.checked ? [...(props.draft as ShotContent).propIds, asset.id] : (props.draft as ShotContent).propIds.filter((id: string): boolean => id !== asset.id); props.onDraft({ ...props.draft as ShotContent, propIds }); }} />{asset.description} <small>v{asset.version}</small></label>)}</section>
      <section className="inspector-section continuity-block"><header>전후 상태 <span>{continuityReview.length} REVIEW</span></header>{continuityAssets.length === 0 && <p className="empty-note">인물·장소·소품 기준 자산을 등록하면 전후 상태를 기록할 수 있습니다.</p>}{continuityAssets.map((asset: Asset): ReactElement => <article key={asset.id}><b>{asset.description}</b><div className="pair"><label className="field">BEFORE<input value={props.draft?.continuityBefore.find((entry): boolean => entry.assetId === asset.id)?.state ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, continuityBefore: updateContinuityState((props.draft as ShotContent).continuityBefore, asset.id, event.target.value) }); }} /></label><label className="field">AFTER<input value={props.draft?.continuityAfter.find((entry): boolean => entry.assetId === asset.id)?.state ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, continuityAfter: updateContinuityState((props.draft as ShotContent).continuityAfter, asset.id, event.target.value) }); }} /></label></div></article>)}{continuityReview.length > 0 && <div className="continuity-review">{continuityReview.map((message: string): ReactElement => <p key={message}>{message}</p>)}</div>}</section>
      <div className="edit-actions"><button className="primary" disabled={props.working || props.draftBlocked} onClick={(): void => { void props.onSave(); }}>컷 저장</button><button disabled={props.working} onClick={(): void => { void props.onSplit(); }}>중간 분할</button><button disabled={props.working} onClick={(): void => { void props.onMerge(); }}>다음 컷과 병합</button><button disabled={props.working} onClick={(): void => { void props.onMove(-1); }}>← 이동</button><button disabled={props.working} onClick={(): void => { void props.onMove(1); }}>이동 →</button></div>
      <div className="approval-actions"><button disabled={props.working} onClick={(): void => { void props.onLocks(shot.lockedFields.length === 0 ? allLockedFields : []); }}>{shot.lockedFields.length === 0 ? '전체 잠금' : '잠금 해제'}</button><button className="approve" disabled={props.working} onClick={(): void => { void props.onApprove(); }}>컷 확정</button></div>
      {approvalIssues.length > 0 && <details className="approval-review"><summary>컷 확정 전 확인 · {approvalIssues.length}개</summary>{approvalIssues.map((item: Issue, index: number): ReactElement => <p key={`${item.code}:${item.entityId}:${index}`}>{item.code} · ENTITY {item.entityId} · FIELD {item.field} · {item.message}{item.expected === null ? '' : ` · 기대 ${item.expected}`}{item.actual === null ? '' : ` · 현재 ${item.actual}`}{item.sourceRefs.length === 0 ? '' : ` · ${item.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(', ')}`}</p>)}</details>}
      </section><section hidden={props.page !== 'sources'}><VisualPlanEditor project={props.project} shot={shot} working={props.working} onSave={props.onVisualPlan} onMove={props.onSourceMove} />
      <section className="inspector-section information-gate-block"><header>정보 공개 시점 <span>{informationGates.filter((gate: EffectiveInformationGate): boolean => gate.reviewRequired).length} REVIEW</span></header>{informationGates.length === 0 && <p className="empty-note">이 구간에는 정보 공개 규칙이 없습니다.</p>}{informationGates.map((gate: EffectiveInformationGate): ReactElement => <article className={gate.reviewRequired ? 'mapping-editor unresolved' : 'mapping-editor'} key={gate.id}><header><b>{gate.id}</b><span>{gate.precision}</span></header><p>BASE {gate.baseNotBeforeMs}ms · EFFECTIVE {gate.effectiveNotBeforeMs}ms</p><p className="canonical-text">{gate.evidenceType} · {gate.evidenceId ?? 'authoritative base'}</p>{gate.reviewReasons.map((reason: string): ReactElement => <p className="mapping-issue" key={reason}>{reason}</p>)}<small className="source-ref">{gate.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}</small></article>)}</section>
      </section><section hidden={props.page !== 'audio'}><AudioInstructionReview project={props.project} segmentId={props.segment.id} working={props.working} onSave={props.onAudioInstruction} onConfirm={props.onAudioInstructionConfirm} /><section className="inspector-section audio-block"><header>음성·음향 트랙 <span>{audio.filter((cue: AudioCue): boolean => playableAudioCuesAt(props.project, cue.startMs).some((candidate: AudioCue): boolean => candidate.id === cue.id)).length}/{audio.length} PLAYABLE</span></header><p className="disclosure">{props.status?.aiVoiceDisclosure ?? '가이드 음성은 Codex App 작업에서 생성합니다.'}</p>{audio.map((cue: AudioCue): ReactElement => <AudioCueEditor reviewPlayback={props.reviewPlayback} key={cue.id} reviewEnabled={props.reviewEnabled && props.workspacePage === 'editor' && props.page === 'audio'} onReviewPlayback={props.onReviewPlayback} onRefresh={props.onRefresh} project={props.project} cue={cue} text={audioCueSource(props.project, cue)?.text ?? cue.instructionId ?? cue.unitId ?? '원문 연결 없음'} working={props.working} disclosure={props.status?.aiVoiceDisclosure ?? 'Codex App 가이드 음성'} onMix={props.onAudioMix} onTiming={props.onAudioTiming} onSpeech={props.onSpeech} onPrepare={props.onAudioPrepare} onAsset={props.onAudioAsset} onNormalize={props.onAudioNormalize} />)}</section>
      </section><section hidden={props.page !== 'text'}>      <section className="inspector-section text-mapping-block"><header>문구 연결 검토 <span>{textMappingIssues.length} REVIEW</span></header>{textMappings.map((mapping): ReactElement => <div key={mapping.decision.id}><TextMappingEditor project={props.project} decision={mapping.decision} placement={mapping.placement} units={props.project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === props.segment.id)} issues={textMappingIssues.filter((item: Issue): boolean => item.entityId === mapping.decision.id)} working={props.working} onSave={props.onTextMapping} /><PlacementInformationEditor project={props.project} mapping={mapping.decision} placement={mapping.placement} working={props.working} onSave={props.onPlacementInformation} /></div>)}</section>
      <section className="inspector-section text-block"><header>화면 글자 트랙 <span>{text.length}</span></header>{text.map((cue: TextCue): ReactElement => <TextCueEditor key={cue.id} project={props.project} cue={cue} working={props.working} onTiming={props.onTextTiming} onPresentation={props.onTextPresentation} onPresentationReset={props.onTextPresentationReset} onConfirm={props.onTextConfirm} onResolve={props.onTextResolve} onDelete={props.onTextDelete} />)}</section>
      </section></>}
    </section>
    <section className="project-settings" hidden={props.workspacePage !== 'settings'}>
      <div className="settings-lead"><span className="eyebrow">PRODUCTION SETUP</span><h2>화면의 기준을 정하세요.</h2><p>제작 방식과 그림 스타일을 정하고, 인물·장소·소품의 기준 이미지를 등록합니다. 이 설정은 현재 프로젝트에 적용됩니다.</p></div>
      <section className="profile-form"><header>제작 프로필</header>{profileRecovery.notice}<div><label>제작 방식<select value={profileDraft.medium} onChange={(event): void => { setProfileDraft({ ...profileDraft, medium: event.target.value as Profile['medium'] }); }}><option value="unspecified">미정</option><option value="live-action">실사</option><option value="ai">AI</option><option value="hybrid">혼합</option></select></label><label>화면비 가로<input type="number" min="1" value={profileDraft.aspectWidth} onChange={(event): void => { setProfileDraft({ ...profileDraft, aspectWidth: Number(event.target.value) }); }} /></label><label>화면비 세로<input type="number" min="1" value={profileDraft.aspectHeight} onChange={(event): void => { setProfileDraft({ ...profileDraft, aspectHeight: Number(event.target.value) }); }} /></label></div><label>그림 스타일<input value={profileDraft.visualStyle ?? ''} onChange={(event): void => { setProfileDraft({ ...profileDraft, visualStyle: event.target.value || null }); }} /></label><button disabled={props.working || profileRecovery.blocked} onClick={(): void => { void props.onProfile(profileDraft); }}>프로필 저장 · 전체 프레임 재검토</button></section>
      <TextTypographySettings projectId={props.project.projectId} revision={props.project.revision} value={props.project.textTypography} atMs={props.project.textCues.length === 0 ? 0 : Math.min(...props.project.textCues.map((cue): number => cue.startMs))} working={props.working} onSave={props.onTextTypography} />
      <TextLayoutSettings projectId={props.project.projectId} revision={props.project.revision} value={props.project.textLayout} mode={props.project.textLayoutControl.mode} review={textPresetReview(props.project)} working={props.working} onSave={props.onTextLayout} />
      <TextReadabilitySettings projectId={props.project.projectId} revision={props.project.revision} value={props.project.textReadability} working={props.working} onSave={props.onTextReadability} />
      <ReferenceImageForm project={props.project} working={props.working} onRegister={props.onReference} />
      <ProductionReferenceReview key={props.project.projectId} project={props.project} disabled={props.working} visible={props.workspacePage === 'settings'} onRefresh={props.onRefresh} />
      <SourceUpdateForm project={props.project} working={props.working} onPreview={props.onSourcePreview} onApply={props.onSourceApply} />
    </section></div>
  </aside>;
}

export default function App(): ReactElement {
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage>('editor');
  const [inspectorPage, setInspectorPage] = useState<InspectorPage>('direction');
  const [projectsVisible, setProjectsVisible] = useState<boolean>(false);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [documentImportOpen, setDocumentImportOpen] = useState<boolean>(false);
  const [independentOpen, setIndependentOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [segmentId, setSegmentId] = useState<string>('');
  const [shotId, setShotId] = useState<string>('');

  const [working, setWorking] = useState<boolean>(false);
  const [recoveryUi, setRecoveryUi] = useState<RecoveryUiState>(emptyRecoveryUiState());
  const [queuedRequest, setQueuedRequest] = useState<CodexRequest | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const showError = (error: unknown): void => {
    if (error instanceof ApiError) setRecoveryUi((current: RecoveryUiState): RecoveryUiState => recordRecoveryUiError(current, error));
    setNotice({ tone: 'error', text: readableError(error) });
  };
  const [playhead, setPlayhead] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [monitorOpen, setMonitorOpen] = useState<boolean>(false);
  const [outputMaturity, setOutputMaturity] = useState<OutputMaturity>('draft');
  const [finalReadiness, setFinalReadiness] = useState<FinalReadinessReport | null>(null);
  const audioController: BrowserAudioController = useMemo((): BrowserAudioController => new BrowserAudioController(
    createBrowserAudio,
    { schedule: (callback: () => void, delayMs: number): number => window.setTimeout(callback, delayMs),
      cancel: (timerId: number): void => { window.clearTimeout(timerId); } },
  ), []);

  const playbackPreference = useReviewPlayback(project?.projectId ?? null);
  const playbackRate: ReviewPlaybackRate | null = playbackPreference.rate;
  const reviewPlayback: ReviewPlaybackPreference = { ...playbackPreference, setRate: (rate: ReviewPlaybackRate): void => {
    audioController.reset(); playbackPreference.setRate(rate);
  } };

  const segment: Segment | null = project?.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId) ?? null;
  const shots: Shot[] = useMemo((): Shot[] => project?.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId) ?? [], [project, segmentId]);
  const shot: Shot | null = shots.find((candidate: Shot): boolean => candidate.id === shotId) ?? shots[0] ?? null;
  const directionDraft = useBrowserDraft(JSON.stringify([project?.projectId, 'direction', shot?.id]), shot === null ? null : contentFromShot(shot), String(project?.revision), ShotContentSchema.nullable());
  const draft: ShotContent | null = directionDraft.value;
  const setDraft = directionDraft.setValue;
  const [positionProjectId, setPositionProjectId] = useState<string | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const positionWriteAt = useRef<number>(0);

  useEffect((): (() => void) => {
    let active: boolean = true;
    setFinalReadiness(null);
    if (project !== null) void fetchFinalReadiness(project.projectId).then((report: FinalReadinessReport): void => {
      if (active && report.projectId === project.projectId && report.revision === project.revision) setFinalReadiness(report);
    }).catch((error: unknown): void => { if (active) showError(error); });
    return (): void => { active = false; };
  }, [project]);

  const refreshSummaries = async (): Promise<void> => { setSummaries(await listProjects()); };
  const reconcileProjectAssets = async (projectId: string): Promise<void> => {
    const issues = await fetchAssetIntegrity(projectId);
    setRecoveryUi((current: RecoveryUiState): RecoveryUiState => reconcileAssetIntegrityIssues(current, projectId, issues));
  };
  const openProject = async (projectId: string): Promise<void> => {
    setWorking(true); setNotice(null);
    try {
      const [nextProject] = await Promise.all([fetchProject(projectId), reconcileProjectAssets(projectId)]);
      setProject(nextProject); setProjectsVisible(false);
    }
    catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  useEffect((): void => {
    void Promise.all([fetchStatus(), listProjects()]).then(async ([nextStatus, nextSummaries]): Promise<void> => {
      setStatus(nextStatus); setSummaries(nextSummaries);
      setRecoveryUi((current: RecoveryUiState): RecoveryUiState => reconcileBlockedProjects(current,
        nextStatus.storageRecoveryBlocks.map((block): string => block.projectId)));
      const savedProjectId: string | null = window.localStorage.getItem(selectedProjectStorageKey);
      const selected: ProjectSummary | undefined = savedProjectId === null ? nextSummaries[0]
        : nextSummaries.find((summary: ProjectSummary): boolean => summary.projectId === savedProjectId);
      if (savedProjectId !== null && selected === undefined) {
        setProjectsVisible(true);
        throw new Error('이전에 선택한 콘티를 현재 목록에서 찾을 수 없습니다. 프로젝트 목록에서 작업할 콘티를 선택하세요.');
      }
      if (selected !== undefined) {
        const [nextProject] = await Promise.all([fetchProject(selected.projectId), reconcileProjectAssets(selected.projectId)]);
        setProject(nextProject);
      }
    }).catch((error: unknown): void => { setProjectsVisible(true); showError(error); }).finally((): void => { setInitialLoading(false); });
  }, []);

  useEffect((): void => {
    if (project === null) return;
    try { window.localStorage.setItem(selectedProjectStorageKey, project.projectId); }
    catch (error: unknown) { setNotice({ tone: 'error', text: `선택한 콘티를 이 브라우저에 기억하지 못했습니다. 브라우저 저장 권한을 확인하세요. ${readableError(error)}` }); }
  }, [project?.projectId]);

  useEffect((): void => {
    if (project === null) return;
    if (positionProjectId !== project.projectId) {
      try {
        const saved: WorkspacePosition | null = readWorkspacePosition(window.localStorage, project); setPositionError(null);
        setWorkspacePage(saved?.page ?? 'editor'); setInspectorPage(saved?.inspector ?? 'direction');
        setSegmentId(saved?.segmentId ?? project.dataset.segments[0]?.id ?? '');
        setShotId(saved?.shotId ?? project.shots[0]?.id ?? ''); setPlayhead(saved?.playhead ?? 0);
      } catch (error: unknown) { setPositionError(readableError(error)); setSegmentId(''); setShotId(''); setPlayhead(0); }
      setPositionProjectId(project.projectId); return;
    }
    const nextSegment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId) ?? project.dataset.segments[0];
    if (nextSegment === undefined) return;
    setSegmentId(nextSegment.id);
    const nextShot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === shotId && candidate.segmentId === nextSegment.id) ?? project.shots.find((candidate: Shot): boolean => candidate.segmentId === nextSegment.id);
    setShotId(nextShot?.id ?? '');
  }, [project, segmentId, shotId, positionProjectId]);

  useEffect((): void => {
    if (positionError !== null || project === null || positionProjectId !== project.projectId || segment === null || shot === null || shot.id !== shotId) return;
    if (playing && Date.now() - positionWriteAt.current < 1000) return;
    try {
      const position: WorkspacePosition = { version: 1, projectId: project.projectId, page: workspacePage, inspector: inspectorPage, segmentId, shotId, playhead };
      window.localStorage.setItem(workspacePositionKey(project.projectId), JSON.stringify(position)); positionWriteAt.current = Date.now();
    } catch (error: unknown) { setPositionError(`작업 위치를 브라우저에 보관하지 못했습니다. ${readableError(error)}`); }
  }, [project, positionProjectId, positionError, workspacePage, inspectorPage, segmentId, shotId, playhead, playing]);

  useEffect((): void => {
    audioController.reset();
    setPlaying(false);
  }, [audioController, project?.projectId, project?.revision]);

  useEffect((): (() => void) => (): void => { audioController.reset(); }, [audioController]);

  useEffect((): (() => void) | void => {
    if (!playing || project === null || playbackRate === null) return;
    const startedAt: number = performance.now();
    const origin: number = playhead;
    const total: number = project.dataset.segments.at(-1)?.endMs ?? 0;
    let requestId: number = 0;
    const tick = (now: number): void => {
      // 첫 RAF 시각이 effect 시작보다 이르더라도 Cue 시작점 뒤로 이동하지 않는다.
      const next: number = reviewPlayhead(origin, now - startedAt, playbackRate, total);
      setPlayhead(next);
      if (next >= total) { audioController.reset(); setPlaying(false); return; }
      requestId = requestAnimationFrame(tick);
    };
    requestId = requestAnimationFrame(tick);
    return (): void => { cancelAnimationFrame(requestId); };
  }, [audioController, playing, project, playbackRate]);

  useEffect((): void => {
    if (project === null || playbackRate === null) { audioController.reset(); return; }
    audioController.reconcile(project.projectId, playhead, playing, playbackRate);
    if (!playing) return;
    for (const cue of playableAudioCuesAt(project, playhead)) {
      if (cue.assetId === null) continue;
      audioController.start(project.projectId, cue, playhead, safeAudioUrl(project.projectId, cue.id), playbackRate,
        (error: unknown): void => { setNotice({ tone: 'error', text: `오디오 재생 실패: ${readableError(error)}` }); });
    }
  }, [audioController, playing, playhead, project, playbackRate]);

  const importHandoff = async (path: string, holdMs: number): Promise<void> => {
    setWorking(true); setNotice(null);
    try { const next: Project = await importProject(path, holdMs); setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]); setNotice({ tone: 'info', text: `${next.title} 원본을 검증하고 컷 초안을 만들었습니다.` }); }
    catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const importDocuments = async (path: string, holdMs: number): Promise<void> => {
    setWorking(true); setNotice(null);
    try {
      const next: Project = await importProject(path, holdMs);
      setProject(next);
      setNotice({ tone: 'info', text: next.title + ' 문서 패키지에서 컷 초안을 만들었습니다.' });
      // 생성은 완료됐으므로 목록 갱신 실패를 재가져오기 실패로 보고하지 않는다.
      await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]).catch(showError);
    } finally { setWorking(false); }
  };
  const startIndependentStoryboard = async (input: IndependentStoryboardInput): Promise<void> => {
    setWorking(true); setNotice(null);
    try {
      const next: Project = await importIndependentStoryboard(input);
      setProject(next); setPlaying(false); setPlayhead(0); audioController.reset();
      setNotice({ tone: 'info', text: next.title + ' 새 콘티를 생성했습니다. 기존 콘티는 보존했습니다.' });
      // 생성 후 조회 실패는 새 생성으로 재시도하지 않고 갱신 오류로 알린다.
      await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]).catch(showError);
    } finally { setWorking(false); }
  };
  const openIndependent = (): void => {
    audioController.reset(); setPlaying(false); setMonitorOpen(false); setIndependentOpen(true);
  };
  const openDocuments = (): void => {
    audioController.reset(); setPlaying(false); setMonitorOpen(false); setDocumentImportOpen(true);
  };

  const mutate = async (path: string, method: 'DELETE' | 'PATCH' | 'POST', body: object): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try { const next: Project = await mutateProject(project.projectId, path, method, body); setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]); }
    catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const queueGeneration = async (path: string): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const current: CodexRequest = await queueCodexRequest(project.projectId, path, project.revision); setQueuedRequest(current);
      const nextStatus: AppStatus = await fetchStatus(); setStatus(nextStatus);
      setNotice({ tone: 'info', text: `Codex 요청을 저장했습니다. ${nextStatus.generationInstruction} 요청 ID: ${current.id}` });
    } catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const refreshWorkspace = async (): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const [nextProject, nextStatus, nextSummaries] = await Promise.all([
        fetchProject(project.projectId), fetchStatus(), listProjects(), reconcileProjectAssets(project.projectId),
      ]);
      setProject(nextProject); setStatus(nextStatus); setSummaries(nextSummaries);
      setRecoveryUi((current: RecoveryUiState): RecoveryUiState => reconcileBlockedProjects(current,
        nextStatus.storageRecoveryBlocks.map((block): string => block.projectId)));
      setQueuedRequest(null); setNotice({ tone: 'info', text: 'Codex 결과와 프로젝트 상태를 새로 읽었습니다.' });
    } catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const reorder = async (direction: -1 | 1): Promise<void> => {
    if (project === null || segment === null || shot === null) return;
    const index: number = shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
    const destination: number = index + direction;
    if (destination < 0 || destination >= shots.length) { setNotice({ tone: 'info', text: '이 방향으로 더 이동할 수 없습니다.' }); return; }
    const ordered: string[] = shots.map((candidate: Shot): string => candidate.id);
    [ordered[index], ordered[destination]] = [ordered[destination] as string, ordered[index] as string];
    await mutate('/shots/reorder', 'POST', { expectedRevision: project.revision, segmentId: segment.id, orderedShotIds: ordered });
  };

  const merge = async (): Promise<void> => {
    if (project === null || shot === null) return;
    const index: number = shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
    const next: Shot | undefined = shots[index + 1];
    if (next === undefined) { setNotice({ tone: 'info', text: '병합할 다음 컷이 없습니다.' }); return; }
    await mutate(`/shots/${encodeURIComponent(shot.id)}/merge`, 'POST', { expectedRevision: project.revision, secondShotId: next.id });
  };

  const addReference = async (reference: ReferenceDraft): Promise<void> => {
    if (project === null || reference.file === null) { setNotice({ tone: 'error', text: '기준 이미지 파일을 선택하세요.' }); return; }
    const mimeType: string = reference.file.type;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) { setNotice({ tone: 'error', text: 'PNG, JPEG, WebP 기준 이미지만 등록할 수 있습니다.' }); return; }
    await mutate('/references', 'POST', { expectedRevision: project.revision, kind: reference.kind, subjectId: reference.kind === 'prop' ? null : reference.subjectId,
      description: reference.description, mimeType, base64: await fileBase64(reference.file) });
  };

  const uploadAudio = async (cueId: string, file: File): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const next: Project = await uploadAudioAsset(project.projectId, cueId, project.revision, file);
      setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]);
      const asset: Asset | undefined = next.audioCues.find((cue: AudioCue): boolean => cue.id === cueId)?.assetId === null ? undefined
        : next.assets.find((candidate: Asset): boolean => candidate.id === next.audioCues.find((cue: AudioCue): boolean => cue.id === cueId)?.assetId);
      setNotice({ tone: 'info', text: asset?.audioMetadata === undefined || asset.audioMetadata === null ? '오디오 파일을 등록했습니다.'
        : `오디오 등록 완료: ${asset.durationMs}ms · ${asset.audioMetadata.sampleRate}Hz · ${asset.audioMetadata.channels}ch` });
    } catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const prepareAudio = async (cueId: string, file: File): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const next: Project = await prepareExternalAudio(project.projectId, cueId, project.revision, file);
      setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]);
      setWorkspacePage('overview');
      window.requestAnimationFrame((): void => { document.querySelector<HTMLElement>('.automatic-production')?.scrollIntoView({ block: 'start' }); });
      setNotice({ tone: 'info', text: '음향 파일을 측정해 준비했습니다. 제작 범위를 확인하고 자동 제작을 시작하면 Codex가 같은 파일을 배치합니다.' });
    } catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const normalizeAudio = async (cueId: string): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const next: Project = await normalizeAudioAsset(project.projectId, cueId, project.revision);
      setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]);
      setNotice({ tone: 'info', text: '기존 WAV를 프로젝트 형식으로 정규화해 새 Asset 버전으로 복구했습니다.' });
    } catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const inspectSourceUpdate = async (path: string, holdMs: number): Promise<ReviewedSourceImpact | null> => {
    if (project === null) return null;
    setWorking(true); setNotice(null);
    try {
      const review: ReviewedSourceImpact = await previewSourceUpdate(project.projectId, path, holdMs, project.revision);
      setNotice({ tone: 'info', text: `원본 변경이 ${review.impact.impactedShotIds.length}개 컷에 영향을 줍니다.` });
      return review;
    } catch (error: unknown) { showError(error); return null; }
    finally { setWorking(false); }
  };

  const applySource = async (path: string, holdMs: number, basisSha256: string): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try { const next: Project = await updateProjectSource(project.projectId, path, holdMs, project.revision, basisSha256); setProject(next); await Promise.all([refreshSummaries(), reconcileProjectAssets(next.projectId)]); setNotice({ tone: 'info', text: '새 원본을 적용하고 영향 받은 구간만 편집 초안을 교체했습니다.' }); }
    catch (error: unknown) { showError(error); }
    finally { setWorking(false); }
  };

  const togglePlayback = (): void => {
    if (project === null || playbackRate === null) return;
    const total: number = project.dataset.segments.at(-1)?.endMs ?? 0;
    if (playing) { audioController.reset(); setPlaying(false); return; }
    audioController.reset();
    if (playhead >= total) setPlayhead(0);
    setMonitorOpen(true); setPlaying(true);
  };

  const mutationDisabled: boolean = mutationControlsDisabled(working, project?.projectId ?? null, recoveryUi);
  const storageRecoveryRequired: boolean = projectRecoveryBlocked(recoveryUi, project?.projectId ?? null);
  const assetIntegrityIssues: readonly AssetIntegrityUiIssue[] = projectAssetIntegrityIssues(recoveryUi, project?.projectId ?? null);
  const independentDialog: ReactElement = <IndependentStoryboardDialog open={independentOpen} working={working} onClose={(): void => { setIndependentOpen(false); }} onCreate={startIndependentStoryboard} />;
  const documentImport: ReactElement = <DocumentImportPanel open={documentImportOpen} working={working} existingProjectIds={summaries.map((summary: ProjectSummary): string => summary.projectId)}
    onClose={(): void => { setDocumentImportOpen(false); }} onImport={importDocuments} onCreateIndependent={startIndependentStoryboard}
    onOpenProject={async (projectId: string): Promise<void> => { if (projectId !== project?.projectId) await openProject(projectId); }} />;
  if (project === null && initialLoading) return <main className="studio-loading" aria-busy="true"><div className="brand"><span className="brand-mark">C</span><strong>CUTROOM</strong></div><div role="status"><h1>콘티 작업 공간을 엽니다.</h1><p>저장된 프로젝트와 생성 요청 상태를 확인하고 있습니다.</p></div></main>;
  if (project === null) return <>{independentDialog}{documentImport}<main className="empty-shell"><ProjectRail summaries={summaries} currentId={null} working={working} onSelect={openProject} onImport={importHandoff} onDocuments={openDocuments} onIndependent={openIndependent} />
    <div className="welcome"><div className="welcome-number">01</div><div className="eyebrow">SOURCE TO SEQUENCE</div><h1>원문에서<br/><em>촬영 가능한 콘티</em>까지.</h1><p>입력 계약을 검증하고, 컷·그림·가이드 음성·자막을 하나의 시간축에서 편집합니다.</p><button type="button" className="welcome-document-entry" disabled={working} onClick={openDocuments}>제작 문서 8개로 새 패키지 만들기 →</button><button type="button" className="welcome-independent-entry" disabled={working} onClick={openIndependent}>패키지로 별도 콘티 시작 →</button><ImportPanel working={working} onImport={importHandoff} /></div>
    {notice !== null && <div className={`notice ${notice.tone}`}>{notice.text}</div>}</main></>;

  const openEditor = (page: InspectorPage): void => { setInspectorPage(page); setWorkspacePage('editor'); window.requestAnimationFrame((): void => { document.querySelector<HTMLElement>('.inspector-navigation button[aria-current]')?.focus(); }); };
  const openIssue = (destination: EditDestination): void => {
    setSegmentId(destination.segmentId); setShotId(destination.shotId);
    if (destination.settingsSection !== undefined) {
      setWorkspacePage('settings');
      window.requestAnimationFrame((): void => { document.querySelector<HTMLElement>(`.${destination.settingsSection}-settings`)?.scrollIntoView({ block: 'center' }); });
    } else openEditor(destination.page);
  };
  const preview = (maturity: OutputMaturity): void => { audioController.reset(); setPlaying(false); setOutputMaturity(maturity); setMonitorOpen(true); };
  const providerLabel: string = status === null ? 'Codex App 상태를 불러오는 중입니다.' : `Codex App 완료 ${status.completedRequests}건, 대기 ${status.pendingRequests}건, 적용 ${status.applyingRequests}건, 실패 ${status.failedRequests}건, Build 대체 ${status.supersededRequests}건, 평균 처리 ${elapsed(status.averageLatencyMs)}, 반복 생성 ${status.repeatedRequests}건, 저장 복구 ${status.storageRecovery.length}건${status.recentFailures.map((failure): string => `, 최근 실패 ${failure.error?.code ?? 'UNKNOWN'}: ${failure.error?.message ?? '오류 설명이 없습니다.'}`).join('')}`;
  return <>{independentDialog}{documentImport}<main className="app-shell" data-projects-visible={projectsVisible}>
    <a className="skip-link" href="#studio-workspace">편집 작업으로 건너뛰기</a>
    <ProjectRail summaries={summaries} currentId={project.projectId} working={working} onSelect={openProject} onImport={importHandoff} onDocuments={openDocuments} onIndependent={openIndependent} />
    <section className="workspace" id="studio-workspace" tabIndex={-1}><header className="topbar"><button className="projects-toggle" aria-expanded={projectsVisible} onClick={(): void => { setProjectsVisible(!projectsVisible); }}>프로젝트</button><div><span className="eyebrow">CUTROOM / PRODUCTION</span><h1>{project.title}</h1></div><div className="project-facts"><span>REV <b>{project.revision}</b></span><span>{project.profile.aspectWidth}:{project.profile.aspectHeight}</span><span>{project.profile.medium.toUpperCase()}</span></div>
      <div className="top-actions"><button onClick={(): void => { void refreshWorkspace(); }}>새로고침</button><button onClick={(): void => { setWorkspacePage('overview'); }}>자동 제작</button><button className="studio-primary" onClick={(): void => { setWorkspacePage('review'); }}>내보내기 ↗</button><details className={status !== null && status.failedRequests > 0 ? 'provider-status failed' : 'provider-status'}><summary className="provider ready" aria-label={providerLabel}>Codex · 전체 대기 {status?.pendingRequests ?? 0}건</summary>{status !== null && <div className="status-popover"><p>모든 프로젝트의 생성 요청 상태</p><div className="request-metrics"><span><b>{status.completedRequests}</b> 완료</span><span><b>{elapsed(status.averageLatencyMs)}</b> 평균</span><span><b>{elapsed(status.maximumLatencyMs)}</b> 최대</span><span><b>{status.repeatedRequests}</b> 반복 생성</span><span><b>{status.supersededRequests}</b> Build 대체</span><span><b>{status.applyingRequests}</b> 결과 적용</span><span><b>{status.storageRecovery.length}</b> 저장 복구</span><span title={status.costNote}><b>N/A</b> 요청별 비용</span></div>{status.recentFailures.length > 0 && <div className="failure-list">{status.recentFailures.map((failure): ReactElement => <article key={failure.id}><b>{failure.error?.code ?? 'UNKNOWN'}</b><span>{failure.projectId} · {failure.kind} · {failure.targetId}</span><p>{failure.error?.message ?? '오류 설명이 없습니다.'}</p></article>)}</div>}{status.applyRecovery.length > 0 && <div className="recovery-list">{status.applyRecovery.map((apply): ReactElement => <article key={apply.requestId}><b>{apply.state}</b><span>{apply.projectId} · {apply.requestId}</span><p>{apply.committedRevision === null ? apply.code : `적용 Revision ${apply.committedRevision}`}</p></article>)}</div>}{status.storageRecovery.length > 0 && <div className="recovery-list">{status.storageRecovery.map((recovery): ReactElement => <article key={`${recovery.projectId}:${recovery.transactionId}`}><b>{recovery.outcome.toUpperCase()}</b><span>{recovery.projectId} · {recovery.transactionId}</span></article>)}</div>}</div>}</details></div></header>
      {positionError !== null && <aside className="browser-draft-notice" role="alert"><p>{positionError}</p><button onClick={(): void => { setPositionError(null); }}>현재 작업 위치 다시 기억</button></aside>}<WorkspaceNavigation page={workspacePage} onChange={setWorkspacePage} />
      <section className="final-readiness" aria-label="Final Readiness"><strong>{finalReadiness === null ? '최종 출력 검사 중' : finalReadiness.finalReady ? '최종 출력 가능' : '초안 작업 중'}</strong><span>{finalReadiness === null ? '현재 파일을 확인합니다.' : `그림 ${finalReadiness.counts.visualTimelineSafe}/${finalReadiness.counts.shotsTotal}컷 · 글자 ${finalReadiness.counts.textConfirmed}/${finalReadiness.counts.textTotal}개 확정`}</span><button onClick={(): void => { setWorkspacePage('review'); }}>검토할 항목 {finalReadiness?.issues.length ?? '…'}개 →</button><button onClick={(): void => { preview('draft'); }}>초안 미리보기</button></section>
      <div className="workspace-content" data-workspace-page={workspacePage}>
      <div hidden={workspacePage !== 'overview'}><AutomaticProductionPanel key={project.projectId} project={project} disabled={mutationDisabled} onRefresh={refreshWorkspace} onInspectAudio={(id): void => { setSegmentId(id); setShotId(project.shots.find((value): boolean => value.segmentId === id)?.id ?? ''); openEditor('audio'); }} onReview={async (): Promise<void> => { await refreshWorkspace(); preview('draft'); }} onInspectShot={(id): void => { const shot = project.shots.find((value): boolean => value.id === id); if (shot !== undefined) { setSegmentId(shot.segmentId); setShotId(id); openEditor('frames'); } }} /><ProjectBackupPanel key={`backup:${project.projectId}`} project={project} /><BrowserDraftArchive key={project.projectId} project={project} onOpen={(destination): void => { if (destination.kind === 'settings') setWorkspacePage('settings'); else openIssue(destination.editor); }} /><ProductionOverview project={project} report={finalReadiness} onPage={setWorkspacePage} onEditor={openEditor} onScene={(id: string): void => { setSegmentId(id); setShotId(''); setWorkspacePage('editor'); }} /></div>
      <div hidden={workspacePage !== 'review'}><ProductionReview project={project} report={finalReadiness} onIssue={openIssue} onPreview={preview} /></div>
      <div className="edit-grid" hidden={workspacePage !== 'editor' && workspacePage !== 'settings'}>{segment !== null && <SceneRail project={project} segmentId={segment.id} onSelect={(id: string): void => { setSegmentId(id); setShotId(''); }} />}
        <section className="board-area">{segment !== null && <><header className="segment-header"><div><span>{segmentModeLabel(segment.mode)}</span><h2>{project.dataset.scenes.find((scene): boolean => scene.id === segment.sceneId)?.title}</h2><p>{formatProjectTimecode(segment.startMs, project.handoff.timebase)} — {formatProjectTimecode(segment.endMs, project.handoff.timebase)} · {shots.length}컷</p></div><button className="propose" disabled={mutationDisabled} onClick={(): void => { void queueGeneration(`/segments/${encodeURIComponent(segment.id)}/propose`); }}>Codex 컷 제안</button></header>
          <GenerationGuide projectId={project.projectId} /><div className="board-grid">{shots.map((candidate: Shot): ReactElement => <ShotBoard key={candidate.id} project={project} shot={candidate} selected={candidate.id === shot?.id} onSelect={setShotId} busy={mutationDisabled} onGenerate={async (frameId: string): Promise<void> => { await queueGeneration(`/frames/${encodeURIComponent(frameId)}/generate`); }} />)}</div></>}
        </section>
        {segment !== null && <Inspector onRefresh={refreshWorkspace} reviewPlayback={reviewPlayback} key={project.projectId} reviewEnabled={!monitorOpen && !documentImportOpen && !independentOpen} onReviewPlayback={(): void => { audioController.reset(); setPlaying(false); }} page={inspectorPage} workspacePage={workspacePage} onPage={setInspectorPage} project={project} segment={segment} shot={shot} draft={draft} draftNotice={directionDraft.notice} draftBlocked={directionDraft.blocked} working={mutationDisabled} status={status} onDraft={setDraft}
          onSave={async (): Promise<void> => { if (shot !== null && draft !== null && !directionDraft.blocked) await mutate(`/shots/${encodeURIComponent(shot.id)}`, 'PATCH', { expectedRevision: project.revision, content: draft }); }}
          onSplit={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/split`, 'POST', { expectedRevision: project.revision, atMs: Math.floor((shot.startMs + shot.endMs) / 2) }); }}
          onMerge={merge} onMove={reorder} onLocks={async (fields: LockedField[]): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/locks`, 'POST', { expectedRevision: project.revision, fields }); }}
          onApprove={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/approve`, 'POST', { expectedRevision: project.revision }); }}
          onSpeech={async (cueId: string): Promise<void> => { await queueGeneration(`/audio/${encodeURIComponent(cueId)}/generate`); }} onAudioPrepare={prepareAudio} onAudioAsset={uploadAudio} onAudioNormalize={normalizeAudio} onReference={addReference}
          onFrameEdit={async (frameId: string, frame: StoryboardFrameInput): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}`, 'PATCH', { expectedRevision: project.revision, frame }); }}
          onFrameAdd={async (targetShotId: string, frame: StoryboardFrameInput): Promise<void> => { await mutate(`/shots/${encodeURIComponent(targetShotId)}/frames`, 'POST', { expectedRevision: project.revision, frame }); }}
          onFrameGenerate={async (frameId: string): Promise<void> => { await queueGeneration(`/frames/${encodeURIComponent(frameId)}/generate`); }}
          onFrameReview={async (frameId: string, review: StoryboardFrame['visualReview']): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}/review`, 'POST', { expectedRevision: project.revision, review }); }}
          onAudioInstruction={async (input: AudioInstructionInput): Promise<void> => { const { instructionId, ...decision } = input; await mutate(`/audio-instructions/${encodeURIComponent(instructionId)}`, 'PATCH', { expectedRevision: project.revision, decision }); }}
          onAudioInstructionConfirm={async (id: string): Promise<void> => { await mutate(`/audio-instructions/${encodeURIComponent(id)}/confirm`, 'POST', { expectedRevision: project.revision }); }}
          onAudioMix={async (cueId: string, mix: AudioMixInput): Promise<void> => { await mutate(`/audio/${encodeURIComponent(cueId)}/mix`, 'PATCH', { expectedRevision: project.revision, mix }); }}
          onAudioTiming={async (cueId: string, timing: AudioCueTimingInput): Promise<void> => { await mutate(`/audio/${encodeURIComponent(cueId)}`, 'PATCH', { expectedRevision: project.revision, timing }); }}
          onTextTiming={async (cueId: string, timing: TextCueTimingInput): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}`, 'PATCH', { expectedRevision: project.revision, timing }); }}
          onTextConfirm={async (cueId: string): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}/confirm`, 'POST', { expectedRevision: project.revision }); }}
          onTextResolve={async (cueId: string, resolution: TextCueAuthorityResolutionInput): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}/authority`, 'POST', { expectedRevision: project.revision, resolution }); }}
          onTextDelete={async (cueId: string): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}`, 'DELETE', { expectedRevision: project.revision }); }}
          onTextMapping={async (decisionId: string, decision: TextMappingDecisionInput): Promise<void> => { await mutate(`/text-mappings/${encodeURIComponent(decisionId)}`, 'PATCH', { expectedRevision: project.revision, decision }); }}
          onPlacementInformation={async (placementId: string, decision: TextPlacementInformationInput): Promise<void> => { await mutate(`/text-placements/${encodeURIComponent(placementId)}/information`, 'PATCH', { expectedRevision: project.revision, decision }); }}
          onVisualPlan={async (visualPlan: ShotVisualPlanInput): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/visual-plan`, 'PATCH', { expectedRevision: project.revision, visualPlan }); }}
          onSourceMove={async (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/source-links/move`, 'POST', { expectedRevision: project.revision, move: { unitId, targetShotId, usage } }); }}
          onTextPresentation={async (cueId: string, presentation: TextPresentationValues): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}/presentation`, 'PATCH', { expectedRevision: project.revision, presentation }); }}
          onTextPresentationReset={async (cueId: string): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}/presentation`, 'DELETE', { expectedRevision: project.revision }); }}
          onTextTypography={async (textTypography: TextTypography): Promise<void> => { await mutate('/text-typography', 'PATCH', { expectedRevision: project.revision, textTypography }); }}
          onTextLayout={async (textLayout: TextLayoutPreset, mode: TextLayoutControl['mode']): Promise<void> => { await mutate('/text-layout', 'PATCH', { expectedRevision: project.revision, textLayout, mode }); }}
          onTextReadability={async (textReadability: TextReadabilityPolicy): Promise<void> => { await mutate('/text-readability', 'PATCH', { expectedRevision: project.revision, textReadability }); }}
          onProfile={async (profile: Profile): Promise<void> => { await mutate('/profile', 'PATCH', { expectedRevision: project.revision, profile }); }}
          onSourcePreview={inspectSourceUpdate} onSourceApply={applySource} />}
      </div>
      </div><Timeline reviewPlayback={reviewPlayback} project={project} playhead={playhead} playing={playing} onChange={(value: number): void => { audioController.reset(); setPlaying(false); setPlayhead(value); }} onToggle={togglePlayback} />
    </section>
    {monitorOpen && <PlaybackMonitor reviewPlayback={reviewPlayback} project={project} playhead={playhead} maturity={outputMaturity} playing={playing} onToggle={togglePlayback}
      onSeek={(value): void => { audioController.reset(); setPlaying(false); setPlayhead(value); }}
      onInspect={(frameId): void => { const target = project.frames.find((value): boolean => value.id === frameId); const current = project.shots.find((value): boolean => value.id === target?.shotId);
        if (current !== undefined) {
          audioController.reset(); setPlaying(false); setMonitorOpen(false); setSegmentId(current.segmentId); setShotId(current.id); openEditor('frames');
          window.requestAnimationFrame((): void => {
            const editor: HTMLElement | null = document.getElementById(`frame-editor-${frameId}`);
            editor?.focus({ preventScroll: true }); editor?.scrollIntoView({ block: 'start' });
          });
        } }} onClose={(): void => { audioController.reset(); setPlaying(false); setMonitorOpen(false); }} />}
    {storageRecoveryRequired && <div className="storage-recovery-banner" role="alert"><strong>STORAGE RECOVERY REQUIRED</strong><span>해당 Project는 저장소 복구 전 변경할 수 없습니다. 자동 재시도하지 마세요.</span></div>}
    {assetIntegrityIssues.length > 0 && <div className="asset-integrity-banner" role="alert"><strong>ASSET REPAIR REQUIRED</strong><span>{assetIntegrityIssues.map((item: AssetIntegrityUiIssue): string => `${item.assetId} · ${item.code}`).join(' / ')}</span></div>}
    {notice !== null && <button className={`notice ${notice.tone}`} onClick={(): void => { setNotice(null); }}>{notice.text}<span>×</span></button>}
    {queuedRequest !== null && <div className="job-strip"><span></span>CODEX {queuedRequest.kind.toUpperCase()} · {queuedRequest.status.toUpperCase()}</div>}
  </main></>;
}
