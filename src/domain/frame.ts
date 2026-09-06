import { assertNoErrors, contractError } from './errors.js';
import type { Project, Shot, StoryboardFrame } from './schema.js';
import { FrameSchema, ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

export const StoryboardFrameInputSchema = FrameSchema.pick({ offsetMs: true, role: true, description: true });
export type StoryboardFrameInput = Pick<StoryboardFrame, 'offsetMs' | 'role' | 'description'>;

function finish(before: Project, input: Project): Project {
  const project: Project = ProjectSchema.parse(input);
  assertNoErrors(validateProject(project, before.dataset), 'INVALID_FRAME_EDIT');
  return project;
}

function requireFrame(project: Project, frameId: string): StoryboardFrame {
  const frame: StoryboardFrame | undefined = project.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frameId);
  if (frame === undefined) throw contractError('FRAME_NOT_FOUND', `프레임을 찾을 수 없습니다: ${frameId}`, []);
  return frame;
}

function requireEditableShot(project: Project, shotId: string): Shot {
  const shot: Shot | undefined = project.shots.find((candidate: Shot): boolean => candidate.id === shotId);
  if (shot === undefined) throw contractError('SHOT_NOT_FOUND', `컷을 찾을 수 없습니다: ${shotId}`, []);
  if (shot.lockedFields.includes('frames')) throw contractError('SHOT_FIELD_LOCKED', `${shotId}: frames 필드를 먼저 잠금 해제하세요.`, []);
  return shot;
}

export function addStoryboardFrame(project: Project, shotId: string, frameId: string, input: StoryboardFrameInput): Project {
  const frameInput: StoryboardFrameInput = StoryboardFrameInputSchema.parse(input);
  requireEditableShot(project, shotId);
  if (project.frames.some((frame: StoryboardFrame): boolean => frame.id === frameId)) throw contractError('DUPLICATE_FRAME_ID', `프레임 ID가 이미 존재합니다: ${frameId}`, []);
  const frame: StoryboardFrame = { id: frameId, shotId, ...frameInput, imageAssetId: null, visualReview: 'pending' };
  return finish(project, { ...project, frames: [...project.frames, frame], shots: project.shots.map((shot: Shot): Shot => shot.id === shotId ? { ...shot, approvalStatus: 'proposed' } : shot) });
}

export function updateStoryboardFrame(project: Project, frameId: string, input: StoryboardFrameInput): Project {
  const frameInput: StoryboardFrameInput = StoryboardFrameInputSchema.parse(input);
  const frame: StoryboardFrame = requireFrame(project, frameId);
  requireEditableShot(project, frame.shotId);
  if (frame.offsetMs === frameInput.offsetMs && frame.role === frameInput.role && frame.description === frameInput.description) return project;
  return finish(project, { ...project,
    frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frameId ? { ...candidate, ...frameInput, visualReview: 'pending' } : candidate),
    shots: project.shots.map((candidate: Shot): Shot => candidate.id === frame.shotId ? { ...candidate, approvalStatus: 'proposed' } : candidate),
  });
}

export function setFrameReview(project: Project, frameId: string, review: StoryboardFrame['visualReview']): Project {
  const frame: StoryboardFrame = requireFrame(project, frameId);
  if (review === 'accepted' && frame.imageAssetId === null) throw contractError('FRAME_IMAGE_REQUIRED', `${frameId}: 실제 이미지가 있어야 검토 완료로 표시할 수 있습니다.`, []);
  return finish(project, { ...project, frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frameId ? { ...candidate, visualReview: review } : candidate) });
}

export function updateProjectProfile(project: Project, profile: Project['profile']): Project {
  return finish(project, { ...project, profile,
    frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => ({ ...frame, visualReview: 'pending' })) });
}
