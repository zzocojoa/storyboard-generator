import { assertNoErrors, contractError } from './errors.js';
import { approvalIssuesForShot, effectiveInformationGate, sourceAnchorRange } from './mapping.js';
import { ProjectSchema, ShotContentSchema } from './schema.js';
import type { Asset, AudioCue, Issue, LockedField, Project, Shot, ShotContent, ShotSourceLink, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement } from './schema.js';
import { validateProject } from './validation.js';

export function shotContent(shot: Shot): ShotContent {
  return { action: shot.action, camera: shot.camera, visualLocationId: shot.visualLocationId, presence: shot.presence, propIds: shot.propIds,
    continuityBefore: shot.continuityBefore, continuityAfter: shot.continuityAfter, cameraAxis: shot.cameraAxis, screenDirection: shot.screenDirection,
    informationIds: shot.informationIds, transitionOut: shot.transitionOut };
}

export function requireShot(project: Project, shotId: string): Shot {
  const shot: Shot | undefined = project.shots.find((value: Shot): boolean => value.id === shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `컷을 찾을 수 없습니다: ${shotId}`, []);
  return shot;
}

function finishEdit(before: Project, after: Project): Project {
  const result: Project = ProjectSchema.parse(after);
  assertNoErrors(validateProject(result, before.dataset), 'INVALID_EDIT');
  return result;
}

function requireUnlocked(shot: Shot, fields: readonly LockedField[]): void {
  const blocked: LockedField[] = fields.filter((field: LockedField): boolean => shot.lockedFields.includes(field));
  if (blocked.length > 0) throw contractError('SHOT_FIELD_LOCKED', `${shot.id}: ${blocked.join(', ')} 필드를 먼저 잠금 해제하세요.`, []);
}

function changedContentFields(before: Shot, after: ShotContent): LockedField[] {
  const mappings: { field: LockedField; keys: (keyof ShotContent)[] }[] = [
    { field: 'action', keys: ['action', 'informationIds'] }, { field: 'camera', keys: ['camera', 'cameraAxis', 'screenDirection'] },
    { field: 'location', keys: ['visualLocationId'] }, { field: 'presence', keys: ['presence'] },
    { field: 'continuity', keys: ['propIds', 'continuityBefore', 'continuityAfter'] },
    { field: 'transition', keys: ['transitionOut'] },
  ];
  return mappings.filter((mapping): boolean => mapping.keys.some((key: keyof ShotContent): boolean => JSON.stringify(before[key]) !== JSON.stringify(after[key]))).map((mapping): LockedField => mapping.field);
}

export function updateShotContent(project: Project, shotId: string, input: ShotContent): Project {
  const content: ShotContent = ShotContentSchema.parse(input);
  const shot: Shot = requireShot(project, shotId);
  const fields: LockedField[] = changedContentFields(shot, content);
  requireUnlocked(shot, fields);
  if (fields.length === 0) return project;
  return finishEdit(project, { ...project,
    shots: project.shots.map((candidate: Shot): Shot => candidate.id === shotId ? { ...candidate, ...content, proposalOrigin: 'manual', approvalStatus: 'proposed' } : candidate),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.shotId === shotId ? { ...frame, visualReview: 'pending' } : frame),
  });
}

export function setShotLocks(project: Project, shotId: string, fields: readonly LockedField[]): Project {
  requireShot(project, shotId);
  return finishEdit(project, { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id === shotId ? { ...shot, lockedFields: [...fields], approvalStatus: 'proposed' } : shot) });
}

export function approveShot(project: Project, shotId: string): Project {
  requireShot(project, shotId);
  const reviewIssues: Issue[] = approvalIssuesForShot(project, shotId);
  if (reviewIssues.length > 0) throw contractError('SHOT_APPROVAL_BLOCKED', reviewIssues.map((value: Issue): string => `${value.code}: ${value.message}`).join('\n'), reviewIssues);
  const fields: LockedField[] = ['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'transition', 'frames'];
  return finishEdit(project, { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id === shotId ? { ...shot, lockedFields: fields, approvalStatus: 'approved' } : shot) });
}

type TimedEvidence = { startMs: number; endMs: number; kind: 'audio' | 'text' | 'anchor'; basis: 'manual' | 'text-cue' | 'audio-cue' | 'proposal' | 'native-exact' };

function validMeasuredCue(project: Project, cue: AudioCue): boolean {
  const asset: Asset | undefined = cue.assetId === null ? undefined : project.assets.find((candidate: Asset): boolean => candidate.id === cue.assetId && candidate.kind === 'audio');
  return cue.timingStatus === 'measured' && asset !== undefined && asset.subjectId === cue.id && asset.durationMs === cue.endMs - cue.startMs;
}

function linkEvidence(project: Project, shot: Shot, link: ShotSourceLink): TimedEvidence[] {
  const anchor = sourceAnchorRange(project, shot, link);
  const anchored: TimedEvidence[] = anchor === null || link.temporalAnchor.kind === 'unresolved' ? [] : [{ startMs: anchor.startMs, endMs: anchor.endMs, kind: 'anchor', basis: link.temporalAnchor.basis }];
  const audio: TimedEvidence[] = project.audioCues.filter((cue: AudioCue): boolean => cue.unitId === link.unitId && validMeasuredCue(project, cue))
    .map((cue: AudioCue): TimedEvidence => ({ startMs: cue.startMs, endMs: cue.endMs, kind: 'audio', basis: 'audio-cue' }));
  const directText: TimedEvidence[] = project.textCues.filter((cue: TextCue): boolean => cue.unitId === link.unitId && cue.timingStatus === 'confirmed')
    .map((cue: TextCue): TimedEvidence => ({ startMs: cue.startMs, endMs: cue.endMs, kind: 'text', basis: 'text-cue' }));
  const mappedText: TimedEvidence[] = project.textMappingDecisions.flatMap((decision: TextMappingDecision): TimedEvidence[] => {
    if (decision.canonicalUnitId !== link.unitId || decision.status !== 'confirmed' || decision.relation === 'standalone-placement') return [];
    if (decision.relation === 'separate-element') {
      if (decision.canonicalStartMs === null || decision.canonicalEndMs === null) return [];
      return [{ startMs: decision.canonicalStartMs, endMs: decision.canonicalEndMs, kind: 'text', basis: 'text-cue' }];
    }
    const placement: TextPlacement | undefined = project.dataset.textPlacements.find((value: TextPlacement): boolean => value.id === decision.placementId);
    if (placement === undefined) return [];
    const cue: TextCue | undefined = project.textCues.find((value: TextCue): boolean => value.placementId === placement.id);
    return [{ startMs: placement.startMs, endMs: placement.endMs ?? cue?.endMs ?? placement.startMs + 1, kind: 'text', basis: 'text-cue' }];
  });
  const values: TimedEvidence[] = [...anchored, ...audio, ...directText, ...mappedText];
  const keys: Set<string> = new Set<string>();
  return values.filter((value: TimedEvidence): boolean => {
    const key: string = `${value.startMs}:${value.endMs}:${value.basis}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function anchoredLink(link: ShotSourceLink, evidence: TimedEvidence, startMs: number, endMs: number, continued: boolean): ShotSourceLink {
  const overlapStart: number = Math.max(startMs, evidence.startMs);
  const overlapEnd: number = Math.min(endMs, evidence.endMs);
  const anchorEnd: number = Math.max(overlapStart + 1, overlapEnd);
  const usage: ShotSourceLink['usage'] = continued && (link.usage === 'primary-visual' || link.usage === 'continued-visual') ? 'continued-visual' : link.usage;
  return { ...link, usage, status: 'confirmed', temporalAnchor: {
    kind: 'shot-offset', startOffsetMs: overlapStart - startMs, endOffsetMs: anchorEnd - startMs, basis: evidence.basis, status: 'confirmed',
  } };
}

function estimatedSide(project: Project, shot: Shot, link: ShotSourceLink, atMs: number): 'first' | 'second' {
  const links: { link: ShotSourceLink; unit: SourceUnit }[] = shot.sourceLinks.flatMap((value: ShotSourceLink) => {
    const unit: SourceUnit | undefined = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === value.unitId);
    return unit === undefined ? [] : [{ link: value, unit }];
  }).sort((left, right): number => left.unit.order - right.unit.order);
  const index: number = links.findIndex((entry): boolean => entry.link.unitId === link.unitId);
  const estimate: number = shot.startMs + Math.floor((shot.endMs - shot.startMs) * (index + 0.5) / Math.max(1, links.length));
  return estimate < atMs ? 'first' : 'second';
}

function allocateSplitLinks(project: Project, shot: Shot, atMs: number): { first: ShotSourceLink[]; second: ShotSourceLink[] } {
  return shot.sourceLinks.reduce((result: { first: ShotSourceLink[]; second: ShotSourceLink[] }, link: ShotSourceLink) => {
    const evidence: TimedEvidence[] = linkEvidence(project, shot, link);
    const crosses: TimedEvidence | undefined = evidence.find((value: TimedEvidence): boolean => value.startMs < atMs && value.endMs > atMs);
    if (crosses !== undefined) {
      return { first: [...result.first, anchoredLink(link, crosses, shot.startMs, atMs, false)], second: [...result.second, anchoredLink(link, crosses, atMs, shot.endMs, true)] };
    }
    if (evidence.length > 0 && evidence.every((value: TimedEvidence): boolean => value.endMs <= atMs)) return { ...result, first: [...result.first, anchoredLink(link, evidence[0] as TimedEvidence, shot.startMs, atMs, false)] };
    if (evidence.length > 0 && evidence.every((value: TimedEvidence): boolean => value.startMs >= atMs)) return { ...result, second: [...result.second, anchoredLink(link, evidence[0] as TimedEvidence, atMs, shot.endMs, false)] };
    if (evidence.length > 0) {
      const unresolved: ShotSourceLink = { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } };
      return { first: [...result.first, unresolved], second: [...result.second, { ...unresolved, usage: link.usage === 'primary-visual' ? 'continued-visual' : link.usage }] };
    }
    const uncertain: ShotSourceLink = { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'estimated', status: 'review-required' } };
    return estimatedSide(project, shot, link, atMs) === 'first' ? { ...result, first: [...result.first, uncertain] } : { ...result, second: [...result.second, uncertain] };
  }, { first: [], second: [] });
}

function splitInformationIds(project: Project, links: readonly ShotSourceLink[], startMs: number, ids: readonly string[]): string[] {
  const unitIds: Set<string> = new Set(links.map((link: ShotSourceLink): string => link.unitId));
  return ids.filter((id: string): boolean => project.dataset.units.some((unit: SourceUnit): boolean => unitIds.has(unit.id) && unit.informationIds.includes(id))
    && !effectiveInformationGate(project, id).reviewRequired && effectiveInformationGate(project, id).effectiveNotBeforeMs <= startMs);
}

export function splitShot(project: Project, shotId: string, atMs: number, newShotId: string, newFrameId: string): Project {
  const original: Shot = requireShot(project, shotId);
  requireUnlocked(original, ['timing', 'sources', 'transition', 'frames']);
  if (atMs <= original.startMs || atMs >= original.endMs || !Number.isSafeInteger(atMs)) throw contractError('INVALID_SPLIT_TIME', `${shotId}: 컷 안의 정수 밀리초로 분할 위치를 지정하세요.`, []);
  if (project.shots.some((shot: Shot): boolean => shot.id === newShotId) || project.frames.some((frame: StoryboardFrame): boolean => frame.id === newFrameId)) throw contractError('DUPLICATE_EDIT_ID', '새 컷과 프레임 ID가 이미 존재합니다.', []);
  const offset: number = atMs - original.startMs;
  const links = allocateSplitLinks(project, original, atMs);
  const first: Shot = { ...original, endMs: atMs, sourceLinks: links.first, informationIds: splitInformationIds(project, links.first, original.startMs, original.informationIds), transitionOut: { kind: 'cut', durationMs: 0, note: '' }, proposalOrigin: 'manual', approvalStatus: 'proposed' };
  const second: Shot = { ...original, id: newShotId, startMs: atMs, sourceLinks: links.second, informationIds: splitInformationIds(project, links.second, atMs, original.informationIds), proposalOrigin: 'manual', approvalStatus: 'proposed' };
  const movedFrames: StoryboardFrame[] = project.frames.map((frame: StoryboardFrame): StoryboardFrame => {
    if (frame.shotId !== shotId) return frame;
    if (frame.offsetMs < offset) return { ...frame, visualReview: 'pending' };
    return { ...frame, shotId: newShotId, offsetMs: frame.offsetMs - offset, role: frame.offsetMs === offset ? 'start' : frame.role, visualReview: 'pending' };
  });
  const secondStart: StoryboardFrame = { id: newFrameId, shotId: newShotId, offsetMs: 0, role: 'start', description: original.action, imageAssetId: null, visualReview: 'pending' };
  return finishEdit(project, { ...project, shots: project.shots.flatMap((shot: Shot): Shot[] => shot.id === shotId ? [first, second] : [shot]),
    frames: movedFrames.some((frame: StoryboardFrame): boolean => frame.shotId === newShotId && frame.offsetMs === 0) ? movedFrames : [...movedFrames, secondStart],
  });
}

function mergeSourceLinks(project: Project, first: Shot, second: Shot): ShotSourceLink[] {
  const unitIds: string[] = [...new Set([...first.sourceLinks, ...second.sourceLinks].map((link: ShotSourceLink): string => link.unitId))];
  return unitIds.map((unitId: string): ShotSourceLink => {
    const entries: { shot: Shot; link: ShotSourceLink }[] = [
      ...first.sourceLinks.filter((link: ShotSourceLink): boolean => link.unitId === unitId).map((link: ShotSourceLink) => ({ shot: first, link })),
      ...second.sourceLinks.filter((link: ShotSourceLink): boolean => link.unitId === unitId).map((link: ShotSourceLink) => ({ shot: second, link })),
    ];
    const selected: ShotSourceLink = entries.find((entry): boolean => entry.link.usage === 'primary-visual')?.link ?? (entries[0] as { link: ShotSourceLink }).link;
    const ranges = entries.map((entry) => sourceAnchorRange(project, entry.shot, entry.link));
    const bases = entries.flatMap((entry): string[] => entry.link.temporalAnchor.kind === 'unresolved' ? [] : [entry.link.temporalAnchor.basis]);
    if (ranges.some((range): boolean => range === null) || new Set(bases).size !== 1) return { ...selected, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'mapping-change', status: 'review-required' } };
    const starts: number[] = ranges.map((range): number => (range as { startMs: number }).startMs);
    const ends: number[] = ranges.map((range): number => (range as { endMs: number }).endMs);
    const basis = bases[0] as 'manual' | 'text-cue' | 'audio-cue' | 'proposal' | 'native-exact';
    return { ...selected, status: 'confirmed', temporalAnchor: { kind: 'shot-offset', startOffsetMs: Math.min(...starts) - first.startMs, endOffsetMs: Math.max(...ends) - first.startMs, basis, status: 'confirmed' } };
  });
}

export function mergeShots(project: Project, firstId: string, secondId: string): Project {
  const first: Shot = requireShot(project, firstId);
  const second: Shot = requireShot(project, secondId);
  requireUnlocked(first, ['timing', 'sources', 'action', 'continuity', 'transition', 'frames']);
  requireUnlocked(second, ['timing', 'sources', 'action', 'continuity', 'transition', 'frames']);
  if (first.segmentId !== second.segmentId || first.endMs !== second.startMs || project.shots.indexOf(second) !== project.shots.indexOf(first) + 1) throw contractError('NON_ADJACENT_MERGE', '같은 구간에서 이웃한 두 컷을 시간순으로 선택하세요.', []);
  for (const field of ['camera', 'visualLocationId', 'presence', 'cameraAxis', 'screenDirection'] as const) {
    if (JSON.stringify(first[field]) !== JSON.stringify(second[field])) throw contractError('MERGE_CONTENT_CONFLICT', `${field}: 두 컷의 연출이 다릅니다. 합칠 연출을 먼저 정하세요.`, []);
  }
  const offset: number = first.endMs - first.startMs;
  const merged: Shot = { ...first, endMs: second.endMs, action: [...new Set([first.action, second.action])].filter(Boolean).join('\n'),
    sourceLinks: mergeSourceLinks(project, first, second),
    propIds: [...new Set([...first.propIds, ...second.propIds])], informationIds: [...new Set([...first.informationIds, ...second.informationIds])],
    continuityAfter: second.continuityAfter, transitionOut: second.transitionOut, proposalOrigin: 'manual', approvalStatus: 'proposed', lockedFields: [...new Set([...first.lockedFields, ...second.lockedFields])],
  };
  const boundaryFrame: StoryboardFrame | undefined = project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === firstId && frame.role === 'end')
    ?? project.frames.find((frame: StoryboardFrame): boolean => frame.shotId === secondId && frame.role === 'start');
  const frames: StoryboardFrame[] = project.frames.flatMap((frame: StoryboardFrame): StoryboardFrame[] => {
    if (frame.shotId === firstId && frame.role === 'end') return boundaryFrame?.id === frame.id ? [{ ...frame, role: 'key', visualReview: 'pending' }] : [];
    if (frame.shotId === firstId) return [{ ...frame, visualReview: 'pending' }];
    if (frame.shotId === secondId && frame.role === 'start') return boundaryFrame?.id === frame.id ? [{ ...frame, shotId: firstId, offsetMs: offset, role: 'key', visualReview: 'pending' }] : [];
    if (frame.shotId === secondId) return [{ ...frame, shotId: firstId, offsetMs: frame.offsetMs + offset, visualReview: 'pending' }];
    return [frame];
  });
  return finishEdit(project, { ...project, shots: project.shots.filter((shot: Shot): boolean => shot.id !== secondId).map((shot: Shot): Shot => shot.id === firstId ? merged : shot), frames });
}

export function reorderShots(project: Project, segmentId: string, orderedIds: readonly string[]): Project {
  const original: Shot[] = project.shots.filter((shot: Shot): boolean => shot.segmentId === segmentId);
  if (original.length === 0 || orderedIds.length !== original.length || new Set(orderedIds).size !== original.length || original.some((shot: Shot): boolean => !orderedIds.includes(shot.id))) throw contractError('INVALID_SHOT_ORDER', '해당 구간의 모든 컷 ID를 중복 없이 지정하세요.', []);
  const ordered: Shot[] = orderedIds.map((id: string): Shot => requireShot(project, id));
  const start: number = original[0]?.startMs ?? 0;
  const moved: Shot[] = ordered.map((shot: Shot, index: number): Shot => {
    const startMs: number = start + ordered.slice(0, index).reduce((total: number, value: Shot): number => total + value.endMs - value.startMs, 0);
    if (shot.startMs === startMs) return shot;
    requireUnlocked(shot, ['timing']);
    const sourceLinks: ShotSourceLink[] = shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => {
      if (link.temporalAnchor.kind === 'unresolved' || link.temporalAnchor.basis === 'manual' || link.temporalAnchor.basis === 'proposal') return link;
      const basis: 'mapping-change' | 'audio-change' = link.temporalAnchor.basis === 'audio-cue' ? 'audio-change' : 'mapping-change';
      return { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis, status: 'review-required' } };
    });
    return { ...shot, startMs, endMs: startMs + shot.endMs - shot.startMs, sourceLinks, proposalOrigin: 'manual', approvalStatus: 'proposed' };
  });
  const firstId: string | undefined = original[0]?.id;
  return finishEdit(project, { ...project, shots: project.shots.flatMap((shot: Shot): Shot[] => shot.id === firstId ? moved : shot.segmentId === segmentId ? [] : [shot]),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => moved.some((shot: Shot): boolean => shot.id === frame.shotId && shot.startMs !== requireShot(project, shot.id).startMs) ? { ...frame, visualReview: 'pending' } : frame),
  });
}
