import { assertNoErrors, contractError } from './errors.js';
import { ProjectSchema, ShotContentSchema } from './schema.js';
import type { LockedField, Project, Shot, ShotContent, StoryboardFrame } from './schema.js';
import { validateProject } from './validation.js';

export function shotContent(shot: Shot): ShotContent {
  return { action: shot.action, camera: shot.camera, visualLocationId: shot.visualLocationId, presence: shot.presence, propIds: shot.propIds,
    continuityBefore: shot.continuityBefore, continuityAfter: shot.continuityAfter, cameraAxis: shot.cameraAxis, screenDirection: shot.screenDirection, informationIds: shot.informationIds };
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
  const fields: LockedField[] = ['timing', 'sources', 'action', 'camera', 'location', 'presence', 'continuity', 'frames'];
  return finishEdit(project, { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id === shotId ? { ...shot, lockedFields: fields, approvalStatus: 'approved' } : shot) });
}

export function splitShot(project: Project, shotId: string, atMs: number, newShotId: string, newFrameId: string): Project {
  const original: Shot = requireShot(project, shotId);
  requireUnlocked(original, ['timing', 'sources', 'frames']);
  if (atMs <= original.startMs || atMs >= original.endMs || !Number.isSafeInteger(atMs)) throw contractError('INVALID_SPLIT_TIME', `${shotId}: 컷 안의 정수 밀리초로 분할 위치를 지정하세요.`, []);
  if (project.shots.some((shot: Shot): boolean => shot.id === newShotId) || project.frames.some((frame: StoryboardFrame): boolean => frame.id === newFrameId)) throw contractError('DUPLICATE_EDIT_ID', '새 컷과 프레임 ID가 이미 존재합니다.', []);
  const offset: number = atMs - original.startMs;
  const first: Shot = { ...original, endMs: atMs, proposalOrigin: 'manual', approvalStatus: 'proposed' };
  const second: Shot = { ...original, id: newShotId, startMs: atMs, proposalOrigin: 'manual', approvalStatus: 'proposed' };
  const movedFrames: StoryboardFrame[] = project.frames.map((frame: StoryboardFrame): StoryboardFrame => {
    if (frame.shotId !== shotId) return frame;
    if (frame.offsetMs < offset) return { ...frame, visualReview: 'pending' };
    return { ...frame, shotId: newShotId, offsetMs: frame.offsetMs - offset, visualReview: 'pending' };
  });
  const secondStart: StoryboardFrame = { id: newFrameId, shotId: newShotId, offsetMs: 0, role: 'start', description: original.action, imageAssetId: null, visualReview: 'pending' };
  return finishEdit(project, { ...project, shots: project.shots.flatMap((shot: Shot): Shot[] => shot.id === shotId ? [first, second] : [shot]),
    frames: movedFrames.some((frame: StoryboardFrame): boolean => frame.shotId === newShotId && frame.offsetMs === 0) ? movedFrames : [...movedFrames, secondStart],
  });
}

export function mergeShots(project: Project, firstId: string, secondId: string): Project {
  const first: Shot = requireShot(project, firstId);
  const second: Shot = requireShot(project, secondId);
  requireUnlocked(first, ['timing', 'sources', 'action', 'continuity', 'frames']);
  requireUnlocked(second, ['timing', 'sources', 'action', 'continuity', 'frames']);
  if (first.segmentId !== second.segmentId || first.endMs !== second.startMs || project.shots.indexOf(second) !== project.shots.indexOf(first) + 1) throw contractError('NON_ADJACENT_MERGE', '같은 구간에서 이웃한 두 컷을 시간순으로 선택하세요.', []);
  for (const field of ['camera', 'visualLocationId', 'presence', 'cameraAxis', 'screenDirection'] as const) {
    if (JSON.stringify(first[field]) !== JSON.stringify(second[field])) throw contractError('MERGE_CONTENT_CONFLICT', `${field}: 두 컷의 연출이 다릅니다. 합칠 연출을 먼저 정하세요.`, []);
  }
  const offset: number = first.endMs - first.startMs;
  const merged: Shot = { ...first, endMs: second.endMs, action: [...new Set([first.action, second.action])].filter(Boolean).join('\n'),
    sourceUnitIds: project.dataset.units.filter((unit): boolean => first.sourceUnitIds.includes(unit.id) || second.sourceUnitIds.includes(unit.id)).map((unit): string => unit.id),
    propIds: [...new Set([...first.propIds, ...second.propIds])], informationIds: [...new Set([...first.informationIds, ...second.informationIds])],
    continuityAfter: second.continuityAfter, proposalOrigin: 'manual', approvalStatus: 'proposed', lockedFields: [...new Set([...first.lockedFields, ...second.lockedFields])],
  };
  return finishEdit(project, { ...project, shots: project.shots.filter((shot: Shot): boolean => shot.id !== secondId).map((shot: Shot): Shot => shot.id === firstId ? merged : shot),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => {
      if (frame.shotId === firstId) return { ...frame, role: frame.role === 'end' ? 'key' : frame.role, visualReview: 'pending' };
      if (frame.shotId === secondId) return { ...frame, shotId: firstId, offsetMs: frame.offsetMs + offset, role: frame.role === 'start' ? 'key' : frame.role, visualReview: 'pending' };
      return frame;
    }),
  });
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
    return { ...shot, startMs, endMs: startMs + shot.endMs - shot.startMs, proposalOrigin: 'manual', approvalStatus: 'proposed' };
  });
  const firstId: string | undefined = original[0]?.id;
  return finishEdit(project, { ...project, shots: project.shots.flatMap((shot: Shot): Shot[] => shot.id === firstId ? moved : shot.segmentId === segmentId ? [] : [shot]),
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => moved.some((shot: Shot): boolean => shot.id === frame.shotId && shot.startMs !== requireShot(project, shot.id).startMs) ? { ...frame, visualReview: 'pending' } : frame),
  });
}
