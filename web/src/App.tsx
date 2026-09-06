import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import { activeStoryboardFrame } from '../../src/domain/playback.js';
import type { StoryboardFrameInput } from '../../src/domain/frame.js';
import { approvalIssuesForShot, effectiveInformationGate, textMappingReviewIssues } from '../../src/domain/mapping.js';
import type { EffectiveInformationGate, ShotSourceLinksInput, TextMappingDecisionInput } from '../../src/domain/mapping.js';
import type { Asset, AudioCue, Issue, LockedField, Profile, Project, Segment, Shot, ShotContent, ShotSourceLink, SourceTemporalAnchor, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement } from '../../src/domain/schema.js';
import type { AudioCueTimingInput, TextCueTimingInput } from '../../src/domain/tracks.js';
import { fetchProject, fetchStatus, importProject, listProjects, mutateProject, previewSourceUpdate, queueCodexRequest, updateProjectSource } from './api.js';
import type { AppStatus, CodexRequest, ProjectSummary, SourceImpact } from './api.js';

type Notice = { tone: 'info' | 'error'; text: string };
type ReferenceDraft = { kind: 'character' | 'location' | 'prop'; subjectId: string; description: string; file: File | null };

const allLockedFields: LockedField[] = ['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'transition', 'frames'];

function contentFromShot(shot: Shot): ShotContent {
  return { action: shot.action, camera: { ...shot.camera }, visualLocationId: shot.visualLocationId, presence: [...shot.presence],
    propIds: [...shot.propIds], continuityBefore: [...shot.continuityBefore], continuityAfter: [...shot.continuityAfter],
    cameraAxis: shot.cameraAxis, screenDirection: shot.screenDirection, informationIds: [...shot.informationIds], transitionOut: { ...shot.transitionOut } };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clock(milliseconds: number): string {
  const totalSeconds: number = Math.floor(milliseconds / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  const frames: number = Math.floor((milliseconds % 1000) * 30 / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
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

async function fileBase64(file: File): Promise<string> {
  const bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const chunkSize: number = 32768;
  let binary: string = '';
  for (let offset: number = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function assetUrl(projectId: string, assetId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`;
}

function ImportPanel(props: { working: boolean; onImport: (path: string, holdMs: number) => Promise<void> }): ReactElement {
  const [path, setPath] = useState<string>('');
  const [hold, setHold] = useState<string>('2000');
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void props.onImport(path, Number(hold));
  };
  return <form className="import-panel" onSubmit={submit}>
    <div className="eyebrow">INPUT CONTRACT</div>
    <h2>새 콘티 시작</h2>
    <p>handoff JSON을 선택하면 원본을 검증하고 편집용 컷 초안을 만듭니다.</p>
    <label>handoff 파일 경로<input value={path} onChange={(event): void => { setPath(event.target.value); }} placeholder="/project/storyboard_handoff.json" required /></label>
    <label>임시 화면 글자 유지 시간<input type="number" min="1" value={hold} onChange={(event): void => { setHold(event.target.value); }} required /><span className="unit">ms</span></label>
    <button className="primary" disabled={props.working}>{props.working ? '검증 중…' : '패키지 불러오기'}</button>
  </form>;
}

function ProjectRail(props: { summaries: ProjectSummary[]; currentId: string | null; working: boolean;
  onSelect: (projectId: string) => Promise<void>; onImport: (path: string, holdMs: number) => Promise<void> }): ReactElement {
  return <aside className="project-rail">
    <div className="brand"><span className="brand-mark">C</span><div><strong>CUTROOM</strong><small>STORYBOARD SYSTEM</small></div></div>
    <div className="rail-label">PROJECTS · {String(props.summaries.length).padStart(2, '0')}</div>
    <div className="project-list">{props.summaries.map((summary: ProjectSummary): ReactElement =>
      <button key={summary.projectId} className={summary.projectId === props.currentId ? 'project-tile active' : 'project-tile'} onClick={(): void => { void props.onSelect(summary.projectId); }}>
        <span className="project-index">{clock(summary.durationMs)}</span><strong>{summary.title}</strong>
        <span>{summary.shots} CUTS · {summary.framesReady}/{summary.framesTotal} FRAMES</span>
      </button>)}</div>
    <details className="rail-import"><summary>＋ 프로젝트 불러오기</summary><ImportPanel working={props.working} onImport={props.onImport} /></details>
  </aside>;
}

function SceneRail(props: { project: Project; segmentId: string; onSelect: (segmentId: string) => void }): ReactElement {
  return <aside className="scene-rail"><div className="column-head"><span>SCENE INDEX</span><b>{props.project.dataset.scenes.length}</b></div>
    <div className="scene-list">{props.project.dataset.scenes.map((scene, sceneIndex: number): ReactElement => {
      const segments: Segment[] = props.project.dataset.segments.filter((segment: Segment): boolean => segment.sceneId === scene.id);
      return <section className="scene-group" key={scene.id}><header><span>{String(sceneIndex + 1).padStart(2, '0')}</span><div><strong>{scene.title}</strong><small>{segments.length} SEGMENTS</small></div></header>
        {segments.map((segment: Segment): ReactElement => <button key={segment.id} className={segment.id === props.segmentId ? 'segment-row active' : 'segment-row'} onClick={(): void => { props.onSelect(segment.id); }}>
          <span>{segment.mode}</span><time>{clock(segment.startMs)}</time>
        </button>)}</section>;
    })}{props.project.importIssues.length > 0 && <section className="issue-stack"><header>INPUT REVIEW · {props.project.importIssues.length}</header>{props.project.importIssues.map((issue, index: number): ReactElement => <article key={`${issue.code}:${issue.entityId}:${index}`}><b>{issue.severity.toUpperCase()}</b><span>{issue.code}</span><p>{issue.message}</p></article>)}</section>}</div></aside>;
}

function FrameImage(props: { project: Project; frame: StoryboardFrame | null; alt: string }): ReactElement {
  if (props.frame?.imageAssetId !== null && props.frame?.imageAssetId !== undefined) {
    return <img src={assetUrl(props.project.projectId, props.frame.imageAssetId)} alt={props.alt} />;
  }
  return <div className="frame-placeholder"><span>FRAME PENDING</span><p>{props.frame?.description || '시각 설명을 준비 중입니다.'}</p></div>;
}

function ShotBoard(props: { project: Project; shot: Shot; selected: boolean; onSelect: (shotId: string) => void; onGenerate: (frameId: string) => Promise<void>; busy: boolean }): ReactElement {
  const frame: StoryboardFrame | null = props.project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === props.shot.id).sort((left, right): number => left.offsetMs - right.offsetMs)[0] ?? null;
  return <article className={props.selected ? 'shot-card selected' : 'shot-card'} onClick={(): void => { props.onSelect(props.shot.id); }}>
    <div className="shot-frame" style={{ aspectRatio: aspectRatio(props.project) }}><FrameImage project={props.project} frame={frame} alt={`${props.shot.id} 콘티 프레임`} />
      <span className="frame-time">{clock(props.shot.startMs)}</span><span className={`review-dot ${frame?.visualReview ?? 'pending'}`}></span>
      {frame !== null && <button className="frame-generate" disabled={props.busy} onClick={(event): void => { event.stopPropagation(); void props.onGenerate(frame.id); }}>{frame.imageAssetId === null ? 'CODEX IMAGE' : 'RETAKE'}</button>}
    </div>
    <div className="shot-meta"><div><span>{props.shot.camera.size || 'SIZE TBD'}</span><span>{props.shot.camera.angle || 'ANGLE TBD'}</span></div><time>{((props.shot.endMs - props.shot.startMs) / 1000).toFixed(1)}s</time></div>
    <h3>{props.shot.action || '동작을 입력하세요'}</h3>
    <footer><span>{props.shot.sourceLinks.length} SOURCES</span><span>{props.shot.approvalStatus === 'approved' ? 'LOCKED' : props.shot.proposalOrigin.toUpperCase()}</span></footer>
  </article>;
}

function Timeline(props: { project: Project; playhead: number; playing: boolean; onChange: (value: number) => void; onToggle: () => void }): ReactElement {
  const total: number = props.project.dataset.segments.at(-1)?.endMs ?? 1;
  return <section className="timeline"><header><button className={props.playing ? 'transport active' : 'transport'} onClick={props.onToggle} aria-label={props.playing ? '재생 일시 정지' : '시간순 재생'}>{props.playing ? 'Ⅱ' : '▶'}</button>
    <time>{clock(props.playhead)}</time><span className="timeline-title">MASTER TIMELINE</span><span>{clock(total)}</span></header>
    <div className="timeline-canvas">
      <div className="track-label">CUT</div><div className="track cut-track">{props.project.shots.map((shot: Shot): ReactElement => <span key={shot.id} style={{ left: `${percent(shot.startMs, total)}%`, width: `${percent(shot.endMs - shot.startMs, total)}%` }} title={shot.id}></span>)}</div>
      <div className="track-label">TXT</div><div className="track text-track">{props.project.textCues.map((cue: TextCue): ReactElement => <span key={cue.id} style={{ left: `${percent(cue.startMs, total)}%`, width: `${percent(cue.endMs - cue.startMs, total)}%` }} title={cue.text}></span>)}</div>
      <div className="track-label">AUD</div><div className="track audio-track">{props.project.audioCues.map((cue: AudioCue): ReactElement => <span key={cue.id} className={cue.assetId === null ? '' : 'ready'} style={{ left: `${percent(cue.startMs, total)}%`, width: `${percent(cue.endMs - cue.startMs, total)}%` }} title={cue.kind}></span>)}</div>
      <div className="playhead" style={{ left: `calc(52px + (100% - 52px) * ${props.playhead / total})` }}></div>
    </div>
    <input className="scrubber" aria-label="재생 위치" type="range" min="0" max={total} step="1" value={props.playhead} onChange={(event): void => { props.onChange(Number(event.target.value)); }} />
  </section>;
}

function PlaybackMonitor(props: { project: Project; playhead: number; onClose: () => void }): ReactElement {
  const shot: Shot | undefined = props.project.shots.find((candidate: Shot): boolean => candidate.startMs <= props.playhead && candidate.endMs > props.playhead) ?? props.project.shots.at(-1);
  const frame: StoryboardFrame | null = shot === undefined ? null : activeStoryboardFrame(props.project, shot.id, props.playhead);
  const shotIndex: number = shot === undefined ? -1 : props.project.shots.findIndex((candidate: Shot): boolean => candidate.id === shot.id);
  const nextShot: Shot | undefined = shotIndex < 0 ? undefined : props.project.shots[shotIndex + 1];
  const transitionStart: number = shot === undefined ? 0 : shot.endMs - shot.transitionOut.durationMs;
  const transitionActive: boolean = shot !== undefined && shot.transitionOut.kind !== 'cut' && shot.transitionOut.durationMs > 0 && props.playhead >= transitionStart && props.playhead < shot.endMs;
  const transitionProgress: number = transitionActive && shot !== undefined ? (props.playhead - transitionStart) / shot.transitionOut.durationMs : 0;
  const nextFrame: StoryboardFrame | null = nextShot === undefined ? null : activeStoryboardFrame(props.project, nextShot.id, nextShot.startMs);
  const currentOpacity: number = transitionActive && shot?.transitionOut.kind !== 'wipe' ? 1 - transitionProgress : 1;
  const nextOpacity: number = shot?.transitionOut.kind === 'match-cut' ? (transitionProgress >= .5 ? 1 : 0) : transitionProgress;
  const nextClip: string = shot?.transitionOut.kind === 'wipe' ? `inset(0 ${100 - transitionProgress * 100}% 0 0)` : 'none';
  const cues: TextCue[] = props.project.textCues.filter((cue: TextCue): boolean => cue.startMs <= props.playhead && cue.endMs > props.playhead);
  return <div className="monitor" role="dialog" aria-label="콘티 시간순 재생"><div className="monitor-bar"><span>PROGRAM MONITOR</span><time>{clock(props.playhead)}</time><button onClick={props.onClose}>CLOSE</button></div>
    <div className="monitor-frame"><div className="monitor-layer" style={{ opacity: currentOpacity }}><FrameImage project={props.project} frame={frame} alt="현재 재생 프레임" /></div>{transitionActive && nextShot !== undefined && shot?.transitionOut.kind !== 'fade' && <div className="monitor-layer next" style={{ opacity: nextOpacity, clipPath: nextClip }}><FrameImage project={props.project} frame={nextFrame} alt="다음 재생 프레임" /></div>}{transitionActive && <span className="transition-indicator">{shot?.transitionOut.kind.toUpperCase()} · {Math.round(transitionProgress * 100)}%</span>}{cues.map((cue: TextCue): ReactElement => <div className="monitor-text" key={cue.id}>{cue.text}</div>)}</div>
    <div className="monitor-caption"><b>{shot?.id ?? 'END'}</b><span>{shot?.action ?? '재생 종료'}</span><em>{shot === undefined ? '' : `${shot.transitionOut.kind.toUpperCase()} ${shot.transitionOut.durationMs}ms`}</em></div></div>;
}

function FrameEditor(props: { frame: StoryboardFrame; working: boolean;
  onEdit: (frameId: string, input: StoryboardFrameInput) => Promise<void>; onReview: (frameId: string, review: StoryboardFrame['visualReview']) => Promise<void>;
  onGenerate: (frameId: string) => Promise<void>; }): ReactElement {
  const [draft, setDraft] = useState<StoryboardFrameInput>({ offsetMs: props.frame.offsetMs, role: props.frame.role, description: props.frame.description });
  useEffect((): void => { setDraft({ offsetMs: props.frame.offsetMs, role: props.frame.role, description: props.frame.description }); }, [props.frame]);
  return <article className="frame-editor">
    <header><b>{props.frame.role.toUpperCase()}</b><span>+{props.frame.offsetMs}ms · {props.frame.visualReview.toUpperCase()}</span></header>
    <div className="pair"><label className="field">ROLE<select disabled={props.frame.role === 'start'} value={draft.role} onChange={(event): void => { setDraft({ ...draft, role: event.target.value as StoryboardFrame['role'] }); }}><option value="start">시작</option><option value="key">키</option><option value="end">끝</option></select></label>
      <label className="field">OFFSET MS<input type="number" min="0" value={draft.offsetMs} onChange={(event): void => { setDraft({ ...draft, offsetMs: Number(event.target.value) }); }} /></label></div>
    <label className="field wide">FRAME DESCRIPTION<textarea value={draft.description} onChange={(event): void => { setDraft({ ...draft, description: event.target.value }); }} /></label>
    <div className="frame-actions"><button disabled={props.working} onClick={(): void => { void props.onEdit(props.frame.id, draft); }}>프레임 저장</button><button disabled={props.working} onClick={(): void => { void props.onGenerate(props.frame.id); }}>{props.frame.imageAssetId === null ? 'CODEX IMAGE' : 'RETAKE'}</button><button disabled={props.working || props.frame.imageAssetId === null} onClick={(): void => { void props.onReview(props.frame.id, 'accepted'); }}>이미지 승인</button><button disabled={props.working || props.frame.imageAssetId === null} onClick={(): void => { void props.onReview(props.frame.id, 'rejected'); }}>재생성 표시</button></div>
  </article>;
}

function AudioCueEditor(props: { cue: AudioCue; text: string; working: boolean; disclosure: string;
  onTiming: (cueId: string, input: AudioCueTimingInput) => Promise<void>; onSpeech: (cueId: string) => Promise<void>; }): ReactElement {
  const [draft, setDraft] = useState<AudioCueTimingInput>({ startMs: props.cue.startMs, endMs: props.cue.endMs });
  useEffect((): void => { setDraft({ startMs: props.cue.startMs, endMs: props.cue.endMs }); }, [props.cue]);
  return <article className="track-editor"><header><b>{props.cue.kind.toUpperCase()}</b><span>{props.cue.timingStatus.toUpperCase()}</span></header><p>{props.text}</p>
    <div className="pair"><label className="field">START MS<input type="number" min="0" value={draft.startMs} onChange={(event): void => { setDraft({ ...draft, startMs: Number(event.target.value) }); }} /></label><label className="field">END MS<input type="number" min="0" value={draft.endMs} onChange={(event): void => { setDraft({ ...draft, endMs: Number(event.target.value) }); }} /></label></div>
    <div className="track-actions"><button disabled={props.working} onClick={(): void => { void props.onTiming(props.cue.id, draft); }}>타이밍 저장</button>{isSpeechCue(props.cue) && <button disabled={props.working} title={props.disclosure} onClick={(): void => { void props.onSpeech(props.cue.id); }}>{props.cue.assetId === null ? 'CODEX VOICE' : 'RETAKE'}</button>}</div>
  </article>;
}

function TextCueEditor(props: { cue: TextCue; working: boolean; placementEndMs: number | null | undefined;
  onTiming: (cueId: string, input: TextCueTimingInput) => Promise<void>; }): ReactElement {
  const [draft, setDraft] = useState<TextCueTimingInput>({ startMs: props.cue.startMs, endMs: props.cue.endMs, kind: props.cue.kind });
  useEffect((): void => { setDraft({ startMs: props.cue.startMs, endMs: props.cue.endMs, kind: props.cue.kind }); }, [props.cue]);
  return <article className="track-editor"><header><b>{props.cue.kind.toUpperCase()}</b><span>{props.cue.timingStatus.toUpperCase()}</span></header><p>{props.cue.text}</p>
    <label className="field">TYPE<select value={draft.kind} onChange={(event): void => { setDraft({ ...draft, kind: event.target.value as TextCue['kind'] }); }}><option value="overlay">오버레이</option><option value="prop-text">화면 속 글자</option><option value="dialogue-subtitle">대사 자막</option></select></label>
    <div className="pair"><label className="field">START MS<input disabled={props.cue.placementId !== null} type="number" min="0" value={draft.startMs} onChange={(event): void => { setDraft({ ...draft, startMs: Number(event.target.value) }); }} /></label><label className="field">END MS<input disabled={props.placementEndMs !== null && props.placementEndMs !== undefined} type="number" min="0" value={draft.endMs} onChange={(event): void => { setDraft({ ...draft, endMs: Number(event.target.value) }); }} /></label></div>
    <div className="track-actions"><button disabled={props.working} onClick={(): void => { void props.onTiming(props.cue.id, draft); }}>글자 트랙 저장</button></div>
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
  const frame: StoryboardFrame | undefined = current.kind === 'frame'
    ? frames.find((candidate: StoryboardFrame): boolean => candidate.id === current.frameId)
    : frames[0];
  if (frame === undefined) throw new Error('프레임 Anchor를 지정하려면 컷에 프레임을 먼저 추가하세요.');
  return { kind: 'frame', frameId: frame.id, basis: 'manual', status: 'confirmed' };
}

function TextMappingEditor(props: { decision: TextMappingDecision; placement: TextPlacement; units: SourceUnit[]; issues: Issue[]; working: boolean;
  onSave: (decisionId: string, input: TextMappingDecisionInput) => Promise<void>; }): ReactElement {
  const [draft, setDraft] = useState<TextMappingDecisionInput>(mappingInput(props.decision));
  useEffect((): void => { setDraft(mappingInput(props.decision)); }, [props.decision]);
  const canonical: SourceUnit | undefined = props.units.find((unit: SourceUnit): boolean => unit.id === draft.canonicalUnitId);
  const refs: string = [...props.placement.sourceRefs, ...(canonical?.sourceRefs ?? [])].map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ');
  return <article className={draft.status === 'unresolved' ? 'mapping-editor unresolved' : 'mapping-editor'}>
    <header><b>{draft.status.toUpperCase()}</b><span>{props.placement.startMs}ms</span></header>
    <label className="field">PLACEMENT<textarea readOnly value={props.placement.text} /></label>
    <label className="field">CANONICAL UNIT<select disabled={draft.relation === 'standalone-placement'} value={draft.canonicalUnitId ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalUnitId: event.target.value || null, status: 'unresolved' }); }}><option value="">미지정</option>{props.units.filter((unit: SourceUnit): boolean => ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind)).map((unit: SourceUnit): ReactElement => <option key={unit.id} value={unit.id}>{unit.order}. {unit.id} · {unit.kind}</option>)}</select></label>
    <p className="canonical-text">{canonical?.text ?? '연결할 Canonical 원문을 선택하세요.'}</p>
    <div className="pair"><label className="field">RELATION<select value={draft.relation} onChange={(event): void => { const relation = event.target.value as TextMappingDecision['relation']; setDraft({ ...draft, relation, canonicalUnitId: relation === 'standalone-placement' ? null : draft.canonicalUnitId, renderCanonicalSeparately: relation === 'separate-element', canonicalStartMs: null, canonicalEndMs: null, status: 'unresolved' }); }}><option value="exact">exact</option><option value="abbreviation">abbreviation</option><option value="replacement">replacement</option><option value="separate-element">separate-element</option><option value="standalone-placement">standalone-placement</option></select></label><label className="field">STATUS<select value={draft.status} onChange={(event): void => { setDraft({ ...draft, status: event.target.value as TextMappingDecision['status'] }); }}><option value="unresolved">unresolved</option><option value="confirmed">confirmed</option></select></label></div>
    <label className="check-row"><input disabled={draft.relation === 'exact' || draft.relation === 'standalone-placement' || draft.relation === 'separate-element'} type="checkbox" checked={draft.renderCanonicalSeparately} onChange={(event): void => { setDraft({ ...draft, renderCanonicalSeparately: event.target.checked, canonicalStartMs: null, canonicalEndMs: null, status: 'unresolved' }); }} />Canonical 원문 별도 렌더링</label>
    {draft.renderCanonicalSeparately && <div className="pair"><label className="field">CANONICAL START<input type="number" min="0" value={draft.canonicalStartMs ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalStartMs: optionalMilliseconds(event.target.value), status: 'unresolved' }); }} /></label><label className="field">CANONICAL END<input type="number" min="0" value={draft.canonicalEndMs ?? ''} onChange={(event): void => { setDraft({ ...draft, canonicalEndMs: optionalMilliseconds(event.target.value), status: 'unresolved' }); }} /></label></div>}
    <label className="field">NOTE<input value={draft.note ?? ''} onChange={(event): void => { setDraft({ ...draft, note: event.target.value || null }); }} /></label>
    {props.issues.map((item: Issue, index: number): ReactElement => <p className="mapping-issue" key={`${item.code}:${item.entityId}:${index}`}>{item.code} · {item.message}</p>)}
    <small className="source-ref">{refs}</small><button disabled={props.working} onClick={(): void => { void props.onSave(props.decision.id, draft); }}>Mapping 저장</button>
  </article>;
}

function SourceMappingEditor(props: { link: ShotSourceLink; unit: SourceUnit; frames: StoryboardFrame[]; shotDurationMs: number; working: boolean; previousShotId: string | null; nextShotId: string | null;
  onChange: (link: ShotSourceLink) => Promise<void>; onMove: (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']) => Promise<void>; }): ReactElement {
  const [draft, setDraft] = useState<ShotSourceLink>(props.link);
  useEffect((): void => { setDraft(props.link); }, [props.link]);
  return <article className={draft.status === 'mapping-required' || draft.temporalAnchor.status === 'review-required' ? 'mapping-editor unresolved' : 'mapping-editor'}>
    <header><b>{draft.status.toUpperCase()}</b><span>{props.unit.order} · {props.unit.kind}</span></header><strong>{props.unit.id}</strong><p>{props.unit.text}</p>
    <div className="pair"><label className="field">USAGE<select value={draft.usage} onChange={(event): void => { setDraft({ ...draft, usage: event.target.value as ShotSourceLink['usage'] }); }}><option value="primary-visual">primary-visual</option><option value="continued-visual">continued-visual</option><option value="audio-only">audio-only</option><option value="context-only">context-only</option></select></label><label className="field">STATUS<select value={draft.status} onChange={(event): void => { setDraft({ ...draft, status: event.target.value as ShotSourceLink['status'] }); }}><option value="confirmed">confirmed</option><option value="mapping-required">mapping-required</option></select></label></div>
    <label className="field">TEMPORAL ANCHOR<select value={draft.temporalAnchor.kind} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: sourceTemporalAnchor(event.target.value as SourceTemporalAnchor['kind'], draft.temporalAnchor, props.frames, props.shotDurationMs) }); }}><option value="shot-offset">shot-offset</option><option value="frame" disabled={props.frames.length === 0}>frame</option><option value="unresolved">unresolved</option></select></label>
    {draft.temporalAnchor.kind === 'shot-offset' && <div className="pair"><label className="field">ANCHOR START<input type="number" min="0" max={props.shotDurationMs} value={draft.temporalAnchor.startOffsetMs} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'shot-offset' }>, startOffsetMs: Number(event.target.value), basis: 'manual' } }); }} /></label><label className="field">ANCHOR END<input type="number" min="1" max={props.shotDurationMs} value={draft.temporalAnchor.endOffsetMs} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { ...draft.temporalAnchor as Extract<SourceTemporalAnchor, { kind: 'shot-offset' }>, endOffsetMs: Number(event.target.value), basis: 'manual' } }); }} /></label></div>}
    {draft.temporalAnchor.kind === 'frame' && <label className="field">ANCHOR FRAME<select value={draft.temporalAnchor.frameId} onChange={(event): void => { setDraft({ ...draft, temporalAnchor: { kind: 'frame', frameId: event.target.value, basis: 'manual', status: 'confirmed' } }); }}>{props.frames.map((frame: StoryboardFrame): ReactElement => <option key={frame.id} value={frame.id}>{frame.role} · +{frame.offsetMs}ms</option>)}</select></label>}
    <p className="canonical-text">{draft.temporalAnchor.status.toUpperCase()} · {draft.temporalAnchor.basis}</p>
    <small className="source-ref">{props.unit.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}</small>
    <div className="mapping-actions"><button disabled={props.working} onClick={(): void => { void props.onChange(draft); }}>Source Mapping 저장</button>{props.previousShotId !== null && <button disabled={props.working} onClick={(): void => { void props.onMove(props.unit.id, props.previousShotId as string, draft.usage); }}>← 앞 컷으로 이동</button>}{props.nextShotId !== null && <button disabled={props.working} onClick={(): void => { void props.onMove(props.unit.id, props.nextShotId as string, draft.usage); }}>뒤 컷으로 이동 →</button>}</div>
  </article>;
}

function Inspector(props: { project: Project; segment: Segment; shot: Shot | null; draft: ShotContent | null; working: boolean; status: AppStatus | null;
  onDraft: (draft: ShotContent) => void; onSave: () => Promise<void>; onSplit: () => Promise<void>; onMerge: () => Promise<void>;
  onMove: (direction: -1 | 1) => Promise<void>; onLocks: (fields: LockedField[]) => Promise<void>; onApprove: () => Promise<void>;
  onSpeech: (cueId: string) => Promise<void>; onReference: (draft: ReferenceDraft) => Promise<void>;
  onFrameEdit: (frameId: string, input: StoryboardFrameInput) => Promise<void>; onFrameAdd: (shotId: string, input: StoryboardFrameInput) => Promise<void>;
  onFrameGenerate: (frameId: string) => Promise<void>; onFrameReview: (frameId: string, review: StoryboardFrame['visualReview']) => Promise<void>;
  onAudioTiming: (cueId: string, input: AudioCueTimingInput) => Promise<void>; onTextTiming: (cueId: string, input: TextCueTimingInput) => Promise<void>;
  onTextMapping: (decisionId: string, input: TextMappingDecisionInput) => Promise<void>;
  onSourceLinks: (input: ShotSourceLinksInput) => Promise<void>;
  onSourceMove: (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']) => Promise<void>;
  onProfile: (profile: Profile) => Promise<void>; sourceImpact: SourceImpact | null;
  onSourcePreview: (path: string, holdMs: number) => Promise<void>; onSourceApply: (path: string, holdMs: number) => Promise<void>; }): ReactElement {
  const [reference, setReference] = useState<ReferenceDraft>({ kind: 'character', subjectId: '', description: '', file: null });
  const [profileDraft, setProfileDraft] = useState<Profile>(props.project.profile);
  const [sourcePath, setSourcePath] = useState<string>('');
  const [sourceHold, setSourceHold] = useState<string>('2000');
  const shot: Shot | null = props.shot;
  const sourceMappings: { link: ShotSourceLink; unit: SourceUnit }[] = shot === null ? [] : shot.sourceLinks.flatMap((link: ShotSourceLink) => {
    const unit: SourceUnit | undefined = props.project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === link.unitId);
    return unit === undefined ? [] : [{ link, unit }];
  });
  const frames: StoryboardFrame[] = shot === null ? [] : props.project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id).sort((left, right): number => left.offsetMs - right.offsetMs);
  const audio: AudioCue[] = props.project.audioCues.filter((cue: AudioCue): boolean => {
    const unit = props.project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
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
  const previousSegmentShotId: string | null = previousShot !== undefined && shot !== null && previousShot.segmentId === shot.segmentId ? previousShot.id : null;
  const nextSegmentShotId: string | null = nextShot !== undefined && shot !== null && nextShot.segmentId === shot.segmentId ? nextShot.id : null;
  const approvalIssues: Issue[] = shot === null ? [] : approvalIssuesForShot(props.project, shot.id);
  const textMappingIssues: Issue[] = textMappingReviewIssues(props.project, props.segment.id);
  const informationGates: EffectiveInformationGate[] = props.project.dataset.informationRules
    .filter((rule): boolean => rule.segmentId === props.segment.id)
    .map((rule): EffectiveInformationGate => effectiveInformationGate(props.project, rule.id));
  const continuityReview: string[] = props.draft === null ? [] : [
    ...(previousShot === undefined ? [] : continuityNotices(previousShot.continuityAfter, props.draft.continuityBefore, continuityAssets)),
    ...(nextShot === undefined ? [] : continuityNotices(props.draft.continuityAfter, nextShot.continuityBefore, continuityAssets)),
  ];
  const referenceSubjects = reference.kind === 'character' ? props.project.dataset.people : reference.kind === 'location' ? props.project.dataset.locations : [];
  const upload = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void props.onReference(reference); };
  useEffect((): void => { setProfileDraft(props.project.profile); }, [props.project.profile]);
  return <aside className="inspector"><div className="column-head"><span>SHOT INSPECTOR</span><b>{shot === null ? '—' : shot.approvalStatus.toUpperCase()}</b></div>
    {shot !== null && props.draft !== null && <div className="inspector-scroll">
      <div className="inspector-title"><span>{shot.id}</span><time>{clock(shot.startMs)} — {clock(shot.endMs)}</time></div>
      <label className="field wide">ACTION<textarea value={props.draft.action} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, action: event.target.value }); }} /></label>
      <div className="field-grid">
        <label className="field">SIZE<input value={props.draft.camera.size} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, size: event.target.value } }); }} /></label>
        <label className="field">ANGLE<input value={props.draft.camera.angle} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, angle: event.target.value } }); }} /></label>
        <label className="field wide">MOVE<input value={props.draft.camera.move} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, camera: { ...(props.draft as ShotContent).camera, move: event.target.value } }); }} /></label>
      </div>
      <label className="field wide">VISUAL LOCATION<select value={props.draft.visualLocationId ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, visualLocationId: event.target.value || null }); }}><option value="">미정</option>{props.project.dataset.locations.map((location): ReactElement => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
      <section className="inspector-section frame-list"><header>STORYBOARD FRAMES <span>{frames.length}</span></header>{frames.map((frame: StoryboardFrame): ReactElement => <FrameEditor key={frame.id} frame={frame} working={props.working} onEdit={props.onFrameEdit} onReview={props.onFrameReview} onGenerate={props.onFrameGenerate} />)}
        <div className="frame-add-actions">{keyOffset > 0 && keyOffset < duration && !frameOffsets.has(keyOffset) && <button disabled={props.working} onClick={(): void => { void props.onFrameAdd(shot.id, { offsetMs: keyOffset, role: 'key', description: `${shot.action} 중간 동작` }); }}>＋ 키 프레임</button>}{!frames.some((frame: StoryboardFrame): boolean => frame.role === 'end') && !frameOffsets.has(duration) && <button disabled={props.working} onClick={(): void => { void props.onFrameAdd(shot.id, { offsetMs: duration, role: 'end', description: `${shot.action} 종료 상태` }); }}>＋ 끝 프레임</button>}</div>
      </section>
      <div className="pair"><label className="field">CAMERA AXIS<input value={props.draft.cameraAxis ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, cameraAxis: event.target.value || null }); }} /></label><label className="field">DIRECTION<input value={props.draft.screenDirection ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, screenDirection: event.target.value || null }); }} /></label></div>
      <section className="inspector-section transition-edit"><header>TRANSITION OUT <span>{props.draft.transitionOut.kind.toUpperCase()}</span></header><div className="pair"><label className="field">TYPE<select value={props.draft.transitionOut.kind} onChange={(event): void => { const kind = event.target.value as ShotContent['transitionOut']['kind']; const currentDuration: number = (props.draft as ShotContent).transitionOut.durationMs; props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, kind, durationMs: kind === 'cut' ? 0 : currentDuration > 0 ? currentDuration : Math.min(500, duration) } }); }}><option value="cut">CUT</option><option value="dissolve">DISSOLVE</option><option value="fade">FADE</option><option value="wipe">WIPE</option><option value="match-cut">MATCH CUT</option><option value="custom">CUSTOM</option></select></label><label className="field">DURATION MS<input disabled={props.draft.transitionOut.kind === 'cut'} type="number" min="0" value={props.draft.transitionOut.durationMs} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, durationMs: Number(event.target.value) } }); }} /></label></div><label className="field wide">NOTE<input value={props.draft.transitionOut.note} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, transitionOut: { ...(props.draft as ShotContent).transitionOut, note: event.target.value } }); }} /></label></section>
      <section className="inspector-section"><header>ON FRAME <span>{props.draft.presence.length}</span></header>{props.project.dataset.people.map((person): ReactElement => {
        const current = props.draft?.presence.find((presence): boolean => presence.personId === person.id);
        return <div className="presence-row" key={person.id}><label><input type="checkbox" checked={current !== undefined} onChange={(event): void => { const next = event.target.checked ? [...(props.draft as ShotContent).presence, { personId: person.id, mode: 'VISIBLE' as const }] : (props.draft as ShotContent).presence.filter((presence): boolean => presence.personId !== person.id); props.onDraft({ ...props.draft as ShotContent, presence: next }); }} />{person.name}</label>
          {current !== undefined && <select value={current.mode} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, presence: (props.draft as ShotContent).presence.map((presence) => presence.personId === person.id ? { ...presence, mode: event.target.value as typeof presence.mode } : presence) }); }}>{['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'OFFSCREEN_VOICE', 'VOICE_OVER', 'IMPLIED', 'ARCHIVE_IMAGE'].map((mode: string): ReactElement => <option key={mode}>{mode}</option>)}</select>}</div>;
      })}</section>
      <section className="inspector-section"><header>PROP REFERENCES</header>{props.project.assets.filter((asset: Asset): boolean => asset.kind === 'prop').map((asset: Asset): ReactElement => <label className="check-row" key={asset.id}><input type="checkbox" checked={props.draft?.propIds.includes(asset.id) ?? false} onChange={(event): void => { const propIds: string[] = event.target.checked ? [...(props.draft as ShotContent).propIds, asset.id] : (props.draft as ShotContent).propIds.filter((id: string): boolean => id !== asset.id); props.onDraft({ ...props.draft as ShotContent, propIds }); }} />{asset.description} <small>v{asset.version}</small></label>)}</section>
      <section className="inspector-section continuity-block"><header>CONTINUITY STATES <span>{continuityReview.length} REVIEW</span></header>{continuityAssets.length === 0 && <p className="empty-note">인물·장소·소품 기준 자산을 등록하면 전후 상태를 기록할 수 있습니다.</p>}{continuityAssets.map((asset: Asset): ReactElement => <article key={asset.id}><b>{asset.description}</b><div className="pair"><label className="field">BEFORE<input value={props.draft?.continuityBefore.find((entry): boolean => entry.assetId === asset.id)?.state ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, continuityBefore: updateContinuityState((props.draft as ShotContent).continuityBefore, asset.id, event.target.value) }); }} /></label><label className="field">AFTER<input value={props.draft?.continuityAfter.find((entry): boolean => entry.assetId === asset.id)?.state ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, continuityAfter: updateContinuityState((props.draft as ShotContent).continuityAfter, asset.id, event.target.value) }); }} /></label></div></article>)}{continuityReview.length > 0 && <div className="continuity-review">{continuityReview.map((message: string): ReactElement => <p key={message}>{message}</p>)}</div>}</section>
      <div className="edit-actions"><button className="primary" disabled={props.working} onClick={(): void => { void props.onSave(); }}>컷 저장</button><button disabled={props.working} onClick={(): void => { void props.onSplit(); }}>중간 분할</button><button disabled={props.working} onClick={(): void => { void props.onMerge(); }}>다음 컷과 병합</button><button disabled={props.working} onClick={(): void => { void props.onMove(-1); }}>← 이동</button><button disabled={props.working} onClick={(): void => { void props.onMove(1); }}>이동 →</button></div>
      <div className="approval-actions"><button disabled={props.working} onClick={(): void => { void props.onLocks(shot.lockedFields.length === 0 ? allLockedFields : []); }}>{shot.lockedFields.length === 0 ? '전체 잠금' : '잠금 해제'}</button><button className="approve" disabled={props.working} onClick={(): void => { void props.onApprove(); }}>컷 확정</button></div>
      {approvalIssues.length > 0 && <section className="approval-review"><b>APPROVAL BLOCKED · {approvalIssues.length}</b>{approvalIssues.map((item: Issue, index: number): ReactElement => <p key={`${item.code}:${item.entityId}:${index}`}>{item.code} · {item.message}{item.expected === null ? '' : ` · 기대 ${item.expected}`}{item.actual === null ? '' : ` · 현재 ${item.actual}`}{item.sourceRefs.length === 0 ? '' : ` · ${item.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(', ')}`}</p>)}</section>}
      <section className="inspector-section source-block"><header>SOURCE TEMPORAL MAPPING <span>{sourceMappings.length}</span></header>{sourceMappings.map((mapping): ReactElement => <SourceMappingEditor key={mapping.unit.id} link={mapping.link} unit={mapping.unit} frames={frames} shotDurationMs={duration} working={props.working} previousShotId={previousSegmentShotId} nextShotId={nextSegmentShotId}
        onChange={async (nextLink: ShotSourceLink): Promise<void> => { await props.onSourceLinks({ links: (shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => link.unitId === nextLink.unitId ? nextLink : link)) }); }} onMove={props.onSourceMove} />)}</section>
      <section className="inspector-section text-mapping-block"><header>TEXT MAPPING REVIEW <span>{textMappingIssues.length} REVIEW</span></header>{textMappings.map((mapping): ReactElement => <TextMappingEditor key={mapping.decision.id} decision={mapping.decision} placement={mapping.placement} units={props.project.dataset.units.filter((unit: SourceUnit): boolean => unit.segmentId === props.segment.id)} issues={textMappingIssues.filter((item: Issue): boolean => item.entityId === mapping.decision.id)} working={props.working} onSave={props.onTextMapping} />)}</section>
      <section className="inspector-section information-gate-block"><header>INFORMATION GATE <span>{informationGates.filter((gate: EffectiveInformationGate): boolean => gate.reviewRequired).length} REVIEW</span></header>{informationGates.length === 0 && <p className="empty-note">이 구간에는 정보 공개 규칙이 없습니다.</p>}{informationGates.map((gate: EffectiveInformationGate): ReactElement => <article className={gate.reviewRequired ? 'mapping-editor unresolved' : 'mapping-editor'} key={gate.id}><header><b>{gate.id}</b><span>{gate.precision}</span></header><p>BASE {gate.baseNotBeforeMs}ms · EFFECTIVE {gate.effectiveNotBeforeMs}ms</p><p className="canonical-text">{gate.evidenceType} · {gate.evidenceId ?? 'authoritative base'}</p>{gate.reviewReasons.map((reason: string): ReactElement => <p className="mapping-issue" key={reason}>{reason}</p>)}<small className="source-ref">{gate.sourceRefs.map((ref): string => `${ref.fileId}:${ref.locator}`).join(' · ')}</small></article>)}</section>
      <section className="inspector-section audio-block"><header>AUDIO TRACK <span>{audio.filter((cue: AudioCue): boolean => cue.assetId !== null).length}/{audio.length}</span></header><p className="disclosure">{props.status?.aiVoiceDisclosure ?? '가이드 음성은 Codex App 작업에서 생성합니다.'}</p>{audio.map((cue: AudioCue): ReactElement => <AudioCueEditor key={cue.id} cue={cue} text={props.project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId)?.text ?? cue.unitId} working={props.working} disclosure={props.status?.aiVoiceDisclosure ?? 'Codex App 가이드 음성'} onTiming={props.onAudioTiming} onSpeech={props.onSpeech} />)}</section>
      <section className="inspector-section text-block"><header>TEXT TRACK <span>{text.length}</span></header>{text.map((cue: TextCue): ReactElement => <TextCueEditor key={cue.id} cue={cue} working={props.working} placementEndMs={props.project.dataset.textPlacements.find((placement): boolean => placement.id === cue.placementId)?.endMs} onTiming={props.onTextTiming} />)}</section>
      <form className="reference-form" onSubmit={upload}><header>VISUAL REFERENCE</header><select value={reference.kind} onChange={(event): void => { const kind = event.target.value as ReferenceDraft['kind']; setReference({ ...reference, kind, subjectId: '' }); }}><option value="character">인물</option><option value="location">장소</option><option value="prop">소품</option></select>
        {reference.kind !== 'prop' && <select required value={reference.subjectId} onChange={(event): void => { setReference({ ...reference, subjectId: event.target.value }); }}><option value="">대상 선택</option>{referenceSubjects.map((subject): ReactElement => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>}
        <input required placeholder="외형·상태 설명" value={reference.description} onChange={(event): void => { setReference({ ...reference, description: event.target.value }); }} />
        <input required type="file" accept="image/png,image/jpeg,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>): void => { setReference({ ...reference, file: event.target.files?.[0] ?? null }); }} />
        <button disabled={props.working}>기준 이미지 등록</button></form>
      <section className="profile-form"><header>PRODUCTION PROFILE</header><div><label>MODE<select value={profileDraft.medium} onChange={(event): void => { setProfileDraft({ ...profileDraft, medium: event.target.value as Profile['medium'] }); }}><option value="unspecified">미정</option><option value="live-action">실사</option><option value="ai">AI</option><option value="hybrid">혼합</option></select></label><label>WIDTH<input type="number" min="1" value={profileDraft.aspectWidth} onChange={(event): void => { setProfileDraft({ ...profileDraft, aspectWidth: Number(event.target.value) }); }} /></label><label>HEIGHT<input type="number" min="1" value={profileDraft.aspectHeight} onChange={(event): void => { setProfileDraft({ ...profileDraft, aspectHeight: Number(event.target.value) }); }} /></label></div><label>VISUAL STYLE<input value={profileDraft.visualStyle ?? ''} onChange={(event): void => { setProfileDraft({ ...profileDraft, visualStyle: event.target.value || null }); }} /></label><button disabled={props.working} onClick={(): void => { void props.onProfile(profileDraft); }}>프로필 저장 · 전체 프레임 재검토</button></section>
      <section className="source-update-form"><header>SOURCE UPDATE</header><input value={sourcePath} onChange={(event): void => { setSourcePath(event.target.value); }} placeholder="새 handoff 파일 경로" /><input type="number" min="1" value={sourceHold} onChange={(event): void => { setSourceHold(event.target.value); }} />
        <button disabled={props.working || sourcePath.trim() === ''} onClick={(): void => { void props.onSourcePreview(sourcePath, Number(sourceHold)); }}>변경 영향 확인</button>
        {props.sourceImpact !== null && <div className={props.sourceImpact.canApply ? 'impact ready' : 'impact blocked'}><b>{props.sourceImpact.canApply ? 'APPLY READY' : 'LOCKED IMPACT'}</b><span>{props.sourceImpact.changedSourceFileIds.length} FILES · {props.sourceImpact.impactedSegmentIds.length} SEGMENTS · {props.sourceImpact.impactedShotIds.length} CUTS</span>{props.sourceImpact.lockedShotIds.length > 0 && <p>잠긴 컷: {props.sourceImpact.lockedShotIds.join(', ')}</p>}</div>}
        <button className="source-apply" disabled={props.working || props.sourceImpact?.canApply !== true} onClick={(): void => { void props.onSourceApply(sourcePath, Number(sourceHold)); }}>새 원본 적용</button></section>
    </div>}
  </aside>;
}

export default function App(): ReactElement {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [segmentId, setSegmentId] = useState<string>('');
  const [shotId, setShotId] = useState<string>('');
  const [draft, setDraft] = useState<ShotContent | null>(null);
  const [working, setWorking] = useState<boolean>(false);
  const [queuedRequest, setQueuedRequest] = useState<CodexRequest | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [playhead, setPlayhead] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [monitorOpen, setMonitorOpen] = useState<boolean>(false);
  const [sourceImpactReport, setSourceImpactReport] = useState<SourceImpact | null>(null);
  const audioElements = useRef<Map<string, HTMLAudioElement>>(new Map<string, HTMLAudioElement>());
  const playedCues = useRef<Set<string>>(new Set<string>());

  const segment: Segment | null = project?.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId) ?? null;
  const shots: Shot[] = useMemo((): Shot[] => project?.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId) ?? [], [project, segmentId]);
  const shot: Shot | null = shots.find((candidate: Shot): boolean => candidate.id === shotId) ?? shots[0] ?? null;

  const refreshSummaries = async (): Promise<void> => { setSummaries(await listProjects()); };
  const openProject = async (projectId: string): Promise<void> => {
    setWorking(true); setNotice(null); setSourceImpactReport(null);
    try { setProject(await fetchProject(projectId)); } catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  useEffect((): void => {
    void Promise.all([fetchStatus(), listProjects()]).then(async ([nextStatus, nextSummaries]): Promise<void> => {
      setStatus(nextStatus); setSummaries(nextSummaries);
      const first: ProjectSummary | undefined = nextSummaries[0];
      if (first !== undefined) setProject(await fetchProject(first.projectId));
    }).catch((error: unknown): void => { setNotice({ tone: 'error', text: readableError(error) }); });
  }, []);

  useEffect((): void => {
    if (project === null) return;
    const nextSegment: Segment | undefined = project.dataset.segments.find((candidate: Segment): boolean => candidate.id === segmentId) ?? project.dataset.segments[0];
    if (nextSegment === undefined) return;
    setSegmentId(nextSegment.id);
    const nextShot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === shotId && candidate.segmentId === nextSegment.id) ?? project.shots.find((candidate: Shot): boolean => candidate.segmentId === nextSegment.id);
    setShotId(nextShot?.id ?? '');
  }, [project, segmentId, shotId]);

  useEffect((): void => { setDraft(shot === null ? null : contentFromShot(shot)); }, [shot]);

  useEffect((): (() => void) | void => {
    if (!playing || project === null) return;
    const startedAt: number = performance.now();
    const origin: number = playhead;
    const total: number = project.dataset.segments.at(-1)?.endMs ?? 0;
    let requestId: number = 0;
    const tick = (now: number): void => {
      const next: number = Math.min(total, origin + now - startedAt);
      setPlayhead(next);
      if (next >= total) { setPlaying(false); return; }
      requestId = requestAnimationFrame(tick);
    };
    requestId = requestAnimationFrame(tick);
    return (): void => { cancelAnimationFrame(requestId); };
  }, [playing, project]);

  useEffect((): void => {
    if (!playing || project === null) return;
    for (const cue of project.audioCues.filter((candidate: AudioCue): boolean => candidate.assetId !== null && candidate.startMs <= playhead && candidate.endMs > playhead)) {
      if (playedCues.current.has(cue.id) || cue.assetId === null) continue;
      const audioElement = new Audio(assetUrl(project.projectId, cue.assetId));
      audioElement.currentTime = Math.max(0, (playhead - cue.startMs) / 1000);
      audioElements.current.set(cue.id, audioElement); playedCues.current.add(cue.id);
      void audioElement.play().catch((error: unknown): void => { setNotice({ tone: 'error', text: `오디오 재생 실패: ${readableError(error)}` }); });
    }
  }, [playing, playhead, project]);

  useEffect((): void => {
    if (playing) return;
    for (const audioElement of audioElements.current.values()) audioElement.pause();
    audioElements.current.clear();
  }, [playing]);

  const importHandoff = async (path: string, holdMs: number): Promise<void> => {
    setWorking(true); setNotice(null); setSourceImpactReport(null);
    try { const next: Project = await importProject(path, holdMs); setProject(next); await refreshSummaries(); setNotice({ tone: 'info', text: `${next.title} 원본을 검증하고 컷 초안을 만들었습니다.` }); }
    catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  const mutate = async (path: string, method: 'PATCH' | 'POST', body: object): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try { const next: Project = await mutateProject(project.projectId, path, method, body); setProject(next); await refreshSummaries(); }
    catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  const queueGeneration = async (path: string): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const current: CodexRequest = await queueCodexRequest(project.projectId, path, project.revision); setQueuedRequest(current);
      const nextStatus: AppStatus = await fetchStatus(); setStatus(nextStatus);
      setNotice({ tone: 'info', text: `Codex 요청을 저장했습니다. ${nextStatus.generationInstruction} 요청 ID: ${current.id}` });
    } catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  const refreshWorkspace = async (): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      const [nextProject, nextStatus, nextSummaries] = await Promise.all([fetchProject(project.projectId), fetchStatus(), listProjects()]);
      setProject(nextProject); setStatus(nextStatus); setSummaries(nextSummaries); setQueuedRequest(null); setNotice({ tone: 'info', text: 'Codex 결과와 프로젝트 상태를 새로 읽었습니다.' });
    } catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
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

  const inspectSourceUpdate = async (path: string, holdMs: number): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try { const impact: SourceImpact = await previewSourceUpdate(project.projectId, path, holdMs, project.revision); setSourceImpactReport(impact); setNotice({ tone: 'info', text: `원본 변경이 ${impact.impactedShotIds.length}개 컷에 영향을 줍니다.` }); }
    catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  const applySource = async (path: string, holdMs: number): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try { const next: Project = await updateProjectSource(project.projectId, path, holdMs, project.revision); setProject(next); setSourceImpactReport(null); await refreshSummaries(); setNotice({ tone: 'info', text: '새 원본을 적용하고 영향 받은 구간만 편집 초안으로 교체했습니다.' }); }
    catch (error: unknown) { setNotice({ tone: 'error', text: readableError(error) }); }
    finally { setWorking(false); }
  };

  const togglePlayback = (): void => {
    if (project === null) return;
    const total: number = project.dataset.segments.at(-1)?.endMs ?? 0;
    if (!playing && playhead >= total) setPlayhead(0);
    if (!playing) { playedCues.current.clear(); setMonitorOpen(true); }
    setPlaying(!playing);
  };

  if (project === null) return <main className="empty-shell"><ProjectRail summaries={summaries} currentId={null} working={working} onSelect={openProject} onImport={importHandoff} />
    <div className="welcome"><div className="welcome-number">01</div><div className="eyebrow">SOURCE TO SEQUENCE</div><h1>원문에서<br/><em>촬영 가능한 콘티</em>까지.</h1><p>입력 계약을 검증하고, 컷·그림·가이드 음성·자막을 하나의 시간축에서 편집합니다.</p><ImportPanel working={working} onImport={importHandoff} /></div>{notice !== null && <div className={`notice ${notice.tone}`}>{notice.text}</div>}</main>;

  const exportBase: string = `/api/projects/${encodeURIComponent(project.projectId)}`;
  const providerLabel: string = status === null ? 'Codex App 상태를 불러오는 중입니다.' : `Codex App 완료 ${status.completedRequests}건, 대기 ${status.pendingRequests}건, 실패 ${status.failedRequests}건, 평균 처리 ${elapsed(status.averageLatencyMs)}, 반복 생성 ${status.repeatedRequests}건${status.recentFailures.map((failure): string => `, 최근 실패 ${failure.error?.code ?? 'UNKNOWN'}: ${failure.error?.message ?? '오류 설명이 없습니다.'}`).join('')}`;
  return <main className="app-shell">
    <ProjectRail summaries={summaries} currentId={project.projectId} working={working} onSelect={openProject} onImport={importHandoff} />
    <section className="workspace"><header className="topbar"><div><span className="eyebrow">ACTIVE PRODUCTION</span><h1>{project.title}</h1></div><div className="project-facts"><span>REV <b>{project.revision}</b></span><span>{project.profile.aspectWidth}:{project.profile.aspectHeight}</span><span>{project.profile.medium.toUpperCase()}</span></div>
      <div className="top-actions"><a href={`${exportBase}/export.json`}>JSON</a><a href={`${exportBase}/export.csv`}>CSV</a><a href={`${exportBase}/export.pdf`}>PDF</a><button onClick={(): void => { void refreshWorkspace(); }}>REFRESH</button><details className={status !== null && status.failedRequests > 0 ? 'provider-status failed' : 'provider-status'}><summary className="provider ready" aria-label={providerLabel}>CODEX APP · {status?.pendingRequests ?? 0} QUEUED · {status?.failedRequests ?? 0} FAILED</summary>{status !== null && <div className="status-popover"><div className="request-metrics"><span><b>{status.completedRequests}</b> 완료</span><span><b>{elapsed(status.averageLatencyMs)}</b> 평균</span><span><b>{elapsed(status.maximumLatencyMs)}</b> 최대</span><span><b>{status.repeatedRequests}</b> 반복 생성</span><span title={status.costNote}><b>N/A</b> 요청별 비용</span></div>{status.recentFailures.length > 0 && <div className="failure-list">{status.recentFailures.map((failure): ReactElement => <article key={failure.id}><b>{failure.error?.code ?? 'UNKNOWN'}</b><span>{failure.projectId} · {failure.kind} · {failure.targetId}</span><p>{failure.error?.message ?? '오류 설명이 없습니다.'}</p></article>)}</div>}</div>}</details></div></header>
      <div className="edit-grid">{segment !== null && <SceneRail project={project} segmentId={segment.id} onSelect={(id: string): void => { setSegmentId(id); setShotId(''); }} />}
        <section className="board-area">{segment !== null && <><header className="segment-header"><div><span>{segment.mode}</span><h2>{project.dataset.scenes.find((scene): boolean => scene.id === segment.sceneId)?.title}</h2><p>{clock(segment.startMs)} — {clock(segment.endMs)} · {shots.length} CUTS</p></div><button className="propose" disabled={working} onClick={(): void => { void queueGeneration(`/segments/${encodeURIComponent(segment.id)}/propose`); }}>◇ CODEX CUT PROPOSAL</button></header>
          <div className="board-grid">{shots.map((candidate: Shot): ReactElement => <ShotBoard key={candidate.id} project={project} shot={candidate} selected={candidate.id === shot?.id} onSelect={setShotId} busy={working} onGenerate={async (frameId: string): Promise<void> => { await queueGeneration(`/frames/${encodeURIComponent(frameId)}/generate`); }} />)}</div></>}
        </section>
        {segment !== null && <Inspector project={project} segment={segment} shot={shot} draft={draft} working={working} status={status} onDraft={setDraft}
          onSave={async (): Promise<void> => { if (shot !== null && draft !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}`, 'PATCH', { expectedRevision: project.revision, content: draft }); }}
          onSplit={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/split`, 'POST', { expectedRevision: project.revision, atMs: Math.floor((shot.startMs + shot.endMs) / 2) }); }}
          onMerge={merge} onMove={reorder} onLocks={async (fields: LockedField[]): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/locks`, 'POST', { expectedRevision: project.revision, fields }); }}
          onApprove={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/approve`, 'POST', { expectedRevision: project.revision }); }}
          onSpeech={async (cueId: string): Promise<void> => { await queueGeneration(`/audio/${encodeURIComponent(cueId)}/generate`); }} onReference={addReference}
          onFrameEdit={async (frameId: string, frame: StoryboardFrameInput): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}`, 'PATCH', { expectedRevision: project.revision, frame }); }}
          onFrameAdd={async (targetShotId: string, frame: StoryboardFrameInput): Promise<void> => { await mutate(`/shots/${encodeURIComponent(targetShotId)}/frames`, 'POST', { expectedRevision: project.revision, frame }); }}
          onFrameGenerate={async (frameId: string): Promise<void> => { await queueGeneration(`/frames/${encodeURIComponent(frameId)}/generate`); }}
          onFrameReview={async (frameId: string, review: StoryboardFrame['visualReview']): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}/review`, 'POST', { expectedRevision: project.revision, review }); }}
          onAudioTiming={async (cueId: string, timing: AudioCueTimingInput): Promise<void> => { await mutate(`/audio/${encodeURIComponent(cueId)}`, 'PATCH', { expectedRevision: project.revision, timing }); }}
          onTextTiming={async (cueId: string, timing: TextCueTimingInput): Promise<void> => { await mutate(`/text/${encodeURIComponent(cueId)}`, 'PATCH', { expectedRevision: project.revision, timing }); }}
          onTextMapping={async (decisionId: string, decision: TextMappingDecisionInput): Promise<void> => { await mutate(`/text-mappings/${encodeURIComponent(decisionId)}`, 'PATCH', { expectedRevision: project.revision, decision }); }}
          onSourceLinks={async (mapping: ShotSourceLinksInput): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/source-links`, 'PATCH', { expectedRevision: project.revision, mapping }); }}
          onSourceMove={async (unitId: string, targetShotId: string, usage: ShotSourceLink['usage']): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/source-links/move`, 'POST', { expectedRevision: project.revision, move: { unitId, targetShotId, usage } }); }}
          onProfile={async (profile: Profile): Promise<void> => { await mutate('/profile', 'PATCH', { expectedRevision: project.revision, profile }); }} sourceImpact={sourceImpactReport}
          onSourcePreview={inspectSourceUpdate} onSourceApply={applySource} />}
      </div>
      <Timeline project={project} playhead={playhead} playing={playing} onChange={(value: number): void => { setPlaying(false); setPlayhead(value); playedCues.current.clear(); }} onToggle={togglePlayback} />
    </section>
    {monitorOpen && <PlaybackMonitor project={project} playhead={playhead} onClose={(): void => { setPlaying(false); setMonitorOpen(false); }} />}
    {notice !== null && <button className={`notice ${notice.tone}`} onClick={(): void => { setNotice(null); }}>{notice.text}<span>×</span></button>}
    {queuedRequest !== null && <div className="job-strip"><span></span>CODEX {queuedRequest.kind.toUpperCase()} · {queuedRequest.status.toUpperCase()}</div>}
  </main>;
}
