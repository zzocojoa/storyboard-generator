import { assertNoErrors, contractError } from './errors.js';
import type { Project, StoryboardFrame } from './schema.js';
import { ProjectSchema } from './schema.js';
import { validateProject } from './validation.js';

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

export function updateFrameDescription(project: Project, frameId: string, description: string): Project {
  const frame: StoryboardFrame = requireFrame(project, frameId);
  const shot = project.shots.find((candidate): boolean => candidate.id === frame.shotId);
  if (shot?.lockedFields.includes('frames') === true) throw contractError('SHOT_FIELD_LOCKED', `${frame.shotId}: frames 필드를 먼저 잠금 해제하세요.`, []);
  return finish(project, { ...project, frames: project.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frameId ? { ...candidate, description, visualReview: 'pending' } : candidate) });
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
