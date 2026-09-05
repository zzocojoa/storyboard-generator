import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';
import type { Asset, AudioCue, LockedField, Profile, Project, Segment, Shot, ShotContent, StoryboardFrame, TextCue } from '../../src/domain/schema.js';
import { fetchJob, fetchProject, fetchStatus, importProject, listProjects, mutateProject, previewSourceUpdate, startJob, updateProjectSource } from './api.js';
import type { AppStatus, JobRecord, ProjectSummary, SourceImpact } from './api.js';

type Notice = { tone: 'info' | 'error'; text: string };
type ReferenceDraft = { kind: 'character' | 'location' | 'prop'; subjectId: string; description: string; file: File | null };

const allLockedFields: LockedField[] = ['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'frames'];

function contentFromShot(shot: Shot): ShotContent {
  return { action: shot.action, camera: { ...shot.camera }, visualLocationId: shot.visualLocationId, presence: [...shot.presence],
    propIds: [...shot.propIds], continuityBefore: [...shot.continuityBefore], continuityAfter: [...shot.continuityAfter],
    cameraAxis: shot.cameraAxis, screenDirection: shot.screenDirection, informationIds: [...shot.informationIds] };
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

function aspectRatio(project: Project): string {
  return `${project.profile.aspectWidth} / ${project.profile.aspectHeight}`;
}

function isSpeechCue(cue: AudioCue): boolean {
  return ['dialogue', 'voiceover', 'panel'].includes(cue.kind);
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
      {frame !== null && <button className="frame-generate" disabled={props.busy} onClick={(event): void => { event.stopPropagation(); void props.onGenerate(frame.id); }}>{frame.imageAssetId === null ? 'IMAGE' : 'RETAKE'}</button>}
    </div>
    <div className="shot-meta"><div><span>{props.shot.camera.size || 'SIZE TBD'}</span><span>{props.shot.camera.angle || 'ANGLE TBD'}</span></div><time>{((props.shot.endMs - props.shot.startMs) / 1000).toFixed(1)}s</time></div>
    <h3>{props.shot.action || '동작을 입력하세요'}</h3>
    <footer><span>{props.shot.sourceUnitIds.length} SOURCES</span><span>{props.shot.approvalStatus === 'approved' ? 'LOCKED' : props.shot.proposalOrigin.toUpperCase()}</span></footer>
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
  const frame: StoryboardFrame | null = shot === undefined ? null : props.project.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id && candidate.imageAssetId !== null) ?? props.project.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id) ?? null;
  const cues: TextCue[] = props.project.textCues.filter((cue: TextCue): boolean => cue.startMs <= props.playhead && cue.endMs > props.playhead);
  return <div className="monitor" role="dialog" aria-label="콘티 시간순 재생"><div className="monitor-bar"><span>PROGRAM MONITOR</span><time>{clock(props.playhead)}</time><button onClick={props.onClose}>CLOSE</button></div>
    <div className="monitor-frame"><FrameImage project={props.project} frame={frame} alt="현재 재생 프레임" />{cues.map((cue: TextCue): ReactElement => <div className="monitor-text" key={cue.id}>{cue.text}</div>)}</div>
    <div className="monitor-caption"><b>{shot?.id ?? 'END'}</b><span>{shot?.action ?? '재생 종료'}</span></div></div>;
}

function Inspector(props: { project: Project; segment: Segment; shot: Shot | null; draft: ShotContent | null; working: boolean; status: AppStatus | null;
  onDraft: (draft: ShotContent) => void; onSave: () => Promise<void>; onSplit: () => Promise<void>; onMerge: () => Promise<void>;
  onMove: (direction: -1 | 1) => Promise<void>; onLocks: (fields: LockedField[]) => Promise<void>; onApprove: () => Promise<void>;
  onSpeech: (cueId: string) => Promise<void>; onReference: (draft: ReferenceDraft) => Promise<void>;
  onFrameDescription: (frameId: string, description: string) => Promise<void>; onFrameReview: (frameId: string, review: StoryboardFrame['visualReview']) => Promise<void>;
  onProfile: (profile: Profile) => Promise<void>; sourceImpact: SourceImpact | null;
  onSourcePreview: (path: string, holdMs: number) => Promise<void>; onSourceApply: (path: string, holdMs: number) => Promise<void>; }): ReactElement {
  const [reference, setReference] = useState<ReferenceDraft>({ kind: 'character', subjectId: '', description: '', file: null });
  const [profileDraft, setProfileDraft] = useState<Profile>(props.project.profile);
  const [frameDescription, setFrameDescription] = useState<string>('');
  const [sourcePath, setSourcePath] = useState<string>('');
  const [sourceHold, setSourceHold] = useState<string>('2000');
  const shot: Shot | null = props.shot;
  const sourceUnits = shot === null ? [] : props.project.dataset.units.filter((unit): boolean => shot.sourceUnitIds.includes(unit.id));
  const frame: StoryboardFrame | null = shot === null ? null : props.project.frames.filter((candidate: StoryboardFrame): boolean => candidate.shotId === shot.id).sort((left, right): number => left.offsetMs - right.offsetMs)[0] ?? null;
  const audio: AudioCue[] = props.project.audioCues.filter((cue: AudioCue): boolean => {
    const unit = props.project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId);
    return unit?.segmentId === props.segment.id && isSpeechCue(cue);
  });
  const referenceSubjects = reference.kind === 'character' ? props.project.dataset.people : reference.kind === 'location' ? props.project.dataset.locations : [];
  const upload = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void props.onReference(reference); };
  useEffect((): void => { setProfileDraft(props.project.profile); }, [props.project.profile]);
  useEffect((): void => { setFrameDescription(frame?.description ?? ''); }, [frame]);
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
      {frame !== null && <section className="frame-edit"><label className="field wide">FRAME DESCRIPTION<textarea value={frameDescription} onChange={(event): void => { setFrameDescription(event.target.value); }} /></label><div><button disabled={props.working} onClick={(): void => { void props.onFrameDescription(frame.id, frameDescription); }}>설명 저장</button><button disabled={props.working || frame.imageAssetId === null} onClick={(): void => { void props.onFrameReview(frame.id, 'accepted'); }}>이미지 승인</button><button disabled={props.working || frame.imageAssetId === null} onClick={(): void => { void props.onFrameReview(frame.id, 'rejected'); }}>재생성 표시</button></div></section>}
      <div className="pair"><label className="field">CAMERA AXIS<input value={props.draft.cameraAxis ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, cameraAxis: event.target.value || null }); }} /></label><label className="field">DIRECTION<input value={props.draft.screenDirection ?? ''} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, screenDirection: event.target.value || null }); }} /></label></div>
      <section className="inspector-section"><header>ON FRAME <span>{props.draft.presence.length}</span></header>{props.project.dataset.people.map((person): ReactElement => {
        const current = props.draft?.presence.find((presence): boolean => presence.personId === person.id);
        return <div className="presence-row" key={person.id}><label><input type="checkbox" checked={current !== undefined} onChange={(event): void => { const next = event.target.checked ? [...(props.draft as ShotContent).presence, { personId: person.id, mode: 'VISIBLE' as const }] : (props.draft as ShotContent).presence.filter((presence): boolean => presence.personId !== person.id); props.onDraft({ ...props.draft as ShotContent, presence: next }); }} />{person.name}</label>
          {current !== undefined && <select value={current.mode} onChange={(event): void => { props.onDraft({ ...props.draft as ShotContent, presence: (props.draft as ShotContent).presence.map((presence) => presence.personId === person.id ? { ...presence, mode: event.target.value as typeof presence.mode } : presence) }); }}>{['VISIBLE', 'HAND_ONLY', 'SILHOUETTE', 'OFFSCREEN_VOICE', 'VOICE_OVER', 'IMPLIED', 'ARCHIVE_IMAGE'].map((mode: string): ReactElement => <option key={mode}>{mode}</option>)}</select>}</div>;
      })}</section>
      <section className="inspector-section"><header>PROP REFERENCES</header>{props.project.assets.filter((asset: Asset): boolean => asset.kind === 'prop').map((asset: Asset): ReactElement => <label className="check-row" key={asset.id}><input type="checkbox" checked={props.draft?.propIds.includes(asset.id) ?? false} onChange={(event): void => { const propIds: string[] = event.target.checked ? [...(props.draft as ShotContent).propIds, asset.id] : (props.draft as ShotContent).propIds.filter((id: string): boolean => id !== asset.id); props.onDraft({ ...props.draft as ShotContent, propIds }); }} />{asset.description} <small>v{asset.version}</small></label>)}</section>
      <div className="edit-actions"><button className="primary" disabled={props.working} onClick={(): void => { void props.onSave(); }}>컷 저장</button><button disabled={props.working} onClick={(): void => { void props.onSplit(); }}>중간 분할</button><button disabled={props.working} onClick={(): void => { void props.onMerge(); }}>다음 컷과 병합</button><button disabled={props.working} onClick={(): void => { void props.onMove(-1); }}>← 이동</button><button disabled={props.working} onClick={(): void => { void props.onMove(1); }}>이동 →</button></div>
      <div className="approval-actions"><button disabled={props.working} onClick={(): void => { void props.onLocks(shot.lockedFields.length === 0 ? allLockedFields : []); }}>{shot.lockedFields.length === 0 ? '전체 잠금' : '잠금 해제'}</button><button className="approve" disabled={props.working} onClick={(): void => { void props.onApprove(); }}>컷 확정</button></div>
      <section className="inspector-section source-block"><header>SOURCE ANCHORS <span>{sourceUnits.length}</span></header>{sourceUnits.map((unit): ReactElement => <article key={unit.id}><small>{unit.kind} · {unit.speakerId ?? '—'}</small><p>{unit.text}</p></article>)}</section>
      <section className="inspector-section audio-block"><header>GUIDE AUDIO <span>{audio.filter((cue: AudioCue): boolean => cue.assetId !== null).length}/{audio.length}</span></header><p className="disclosure">{props.status?.aiVoiceDisclosure ?? '가이드 음성은 AI가 생성합니다.'}</p>{audio.map((cue: AudioCue): ReactElement => { const unit = props.project.dataset.units.find((candidate): boolean => candidate.id === cue.unitId); return <article key={cue.id}><div><small>{cue.kind} · {clock(cue.startMs)}</small><p>{unit?.text}</p></div><button disabled={props.working || !props.status?.configured} onClick={(): void => { void props.onSpeech(cue.id); }}>{cue.assetId === null ? 'VOICE' : 'RETAKE'}</button></article>; })}</section>
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
  const [job, setJob] = useState<JobRecord | null>(null);
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

  const generate = async (path: string): Promise<void> => {
    if (project === null) return;
    setWorking(true); setNotice(null);
    try {
      let current: JobRecord = await startJob(project.projectId, path, project.revision); setJob(current);
      while (current.status === 'queued' || current.status === 'running') {
        await new Promise<void>((resolve): void => { window.setTimeout(resolve, 700); });
        current = await fetchJob(current.id); setJob(current);
      }
      if (current.status === 'failed') throw new Error(`${current.error?.code ?? 'GENERATION_FAILED'}: ${current.error?.message ?? '생성 작업이 실패했습니다.'}`);
      setProject(await fetchProject(project.projectId)); await refreshSummaries(); setNotice({ tone: 'info', text: '생성 결과를 새 프로젝트 버전으로 저장했습니다.' });
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
  return <main className="app-shell">
    <ProjectRail summaries={summaries} currentId={project.projectId} working={working} onSelect={openProject} onImport={importHandoff} />
    <section className="workspace"><header className="topbar"><div><span className="eyebrow">ACTIVE PRODUCTION</span><h1>{project.title}</h1></div><div className="project-facts"><span>REV <b>{project.revision}</b></span><span>{project.profile.aspectWidth}:{project.profile.aspectHeight}</span><span>{project.profile.medium.toUpperCase()}</span></div>
      <div className="top-actions"><a href={`${exportBase}/export.json`}>JSON</a><a href={`${exportBase}/export.csv`}>CSV</a><a href={`${exportBase}/export.pdf`}>PDF</a><span className={status?.configured ? 'provider ready' : 'provider'}>{status?.configured ? 'OPENAI READY' : 'OPENAI KEY REQUIRED'}</span></div></header>
      <div className="edit-grid">{segment !== null && <SceneRail project={project} segmentId={segment.id} onSelect={(id: string): void => { setSegmentId(id); setShotId(''); }} />}
        <section className="board-area">{segment !== null && <><header className="segment-header"><div><span>{segment.mode}</span><h2>{project.dataset.scenes.find((scene): boolean => scene.id === segment.sceneId)?.title}</h2><p>{clock(segment.startMs)} — {clock(segment.endMs)} · {shots.length} CUTS</p></div><button className="propose" disabled={working || !status?.configured} onClick={(): void => { void generate(`/segments/${encodeURIComponent(segment.id)}/propose`); }}>◇ AI CUT PROPOSAL</button></header>
          <div className="board-grid">{shots.map((candidate: Shot): ReactElement => <ShotBoard key={candidate.id} project={project} shot={candidate} selected={candidate.id === shot?.id} onSelect={setShotId} busy={working || !status?.configured} onGenerate={async (frameId: string): Promise<void> => { await generate(`/frames/${encodeURIComponent(frameId)}/generate`); }} />)}</div></>}
        </section>
        {segment !== null && <Inspector project={project} segment={segment} shot={shot} draft={draft} working={working} status={status} onDraft={setDraft}
          onSave={async (): Promise<void> => { if (shot !== null && draft !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}`, 'PATCH', { expectedRevision: project.revision, content: draft }); }}
          onSplit={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/split`, 'POST', { expectedRevision: project.revision, atMs: Math.floor((shot.startMs + shot.endMs) / 2) }); }}
          onMerge={merge} onMove={reorder} onLocks={async (fields: LockedField[]): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/locks`, 'POST', { expectedRevision: project.revision, fields }); }}
          onApprove={async (): Promise<void> => { if (shot !== null) await mutate(`/shots/${encodeURIComponent(shot.id)}/approve`, 'POST', { expectedRevision: project.revision }); }}
          onSpeech={async (cueId: string): Promise<void> => { await generate(`/audio/${encodeURIComponent(cueId)}/generate`); }} onReference={addReference}
          onFrameDescription={async (frameId: string, description: string): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}`, 'PATCH', { expectedRevision: project.revision, description }); }}
          onFrameReview={async (frameId: string, review: StoryboardFrame['visualReview']): Promise<void> => { await mutate(`/frames/${encodeURIComponent(frameId)}/review`, 'POST', { expectedRevision: project.revision, review }); }}
          onProfile={async (profile: Profile): Promise<void> => { await mutate('/profile', 'PATCH', { expectedRevision: project.revision, profile }); }} sourceImpact={sourceImpactReport}
          onSourcePreview={inspectSourceUpdate} onSourceApply={applySource} />}
      </div>
      <Timeline project={project} playhead={playhead} playing={playing} onChange={(value: number): void => { setPlaying(false); setPlayhead(value); playedCues.current.clear(); }} onToggle={togglePlayback} />
    </section>
    {monitorOpen && <PlaybackMonitor project={project} playhead={playhead} onClose={(): void => { setPlaying(false); setMonitorOpen(false); }} />}
    {notice !== null && <button className={`notice ${notice.tone}`} onClick={(): void => { setNotice(null); }}>{notice.text}<span>×</span></button>}
    {job !== null && working && <div className="job-strip"><span className="spinner"></span>{job.kind.toUpperCase()} · {job.status.toUpperCase()}</div>}
  </main>;
}
